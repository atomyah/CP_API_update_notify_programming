/**
 * CP API クライアント。**このアプリで唯一の HTTP 出口。**
 *
 * ウォッチャーや通知モジュールから UrlFetchApp を直接呼ばない
 * （rules/20-rate-limit.md）。
 *
 * 責務:
 * - トークンバケットの消費（例外なく全リクエストが通る）
 * - 予算の消費（**リトライも消費する**）
 * - Authorization ヘッダの付与とトークン期限管理（core/auth.js に委譲）
 * - ステータスコードに応じたリトライ（rules/10-cp-api.md の表に従う）
 * - requestId のログ記録（ベンダー問い合わせに必須）
 * - 例外の正規化
 */
const CpClient = (function () {

  const MAX_LIMIT = 100;            // 仕様上の上限。101 は 400（実測）
  const SERVER_RETRY_MAX = 3;       // 500 / 504 / 接続エラー
  const BACKOFF_BASE_SECONDS = 2;

  // ⚠️ ファイルの読み込み順に依存しないよう、他モジュールを参照する初期化は必ず遅延させる。
  //    GAS の全ファイルは1つのグローバル空間に連結され、トップレベルの式は読み込み順に実行される。
  let _metrics = null;
  function metrics() {
    if (!_metrics) {
      _metrics = new RateLimit.Metrics(
        Config.rateLimit.limitPerMinute, Config.rateLimit.warnThresholdRatio);
    }
    return _metrics;
  }

  // 現在どのウォッチャーが叩いているか。メトリクスの内訳に使う
  let currentWatcher = '-';

  function setCurrentWatcher(watcherId) {
    currentWatcher = watcherId || '-';
  }

  // --- 公開 API ----------------------------------------------------------

  /**
   * 検索。**ID の配列と総件数しか返らない。**項目値は返らない。
   *
   * limit は常に 100 を指定する（rules/20-rate-limit.md）。
   * sort を省くと順序が保証されないので、ページングするなら必ず指定すること。
   */
  function search(resource, options) {
    const opts = options || {};
    const limit = opts.limit === undefined ? MAX_LIMIT : opts.limit;
    if (limit > MAX_LIMIT) throw Errors.config('limit must be <= ' + MAX_LIMIT);

    const body = { limit: limit, offset: opts.offset || 0 };
    if (opts.sort) body.sort = opts.sort;
    if (opts.condition) body.condition = opts.condition;

    const result = post('/v1/ext2/' + resource + '/search', body, opts.budget).result;
    return {
      ids: (result.ids || []).map(String),
      count: Number(result.count || 0),
    };
  }

  /**
   * 取得。**1リクエスト = 1リソース。**
   *
   * itemIds には必要な項目だけを列挙する（レスポンスサイズとタイムアウトのリスク）。
   * 関連リソースの項目 ID も混ぜられる（実測で確認済み）。
   */
  function select(resource, resourceId, itemIds, budget) {
    const path = '/v1/ext2/' + resource + '/select/' + resourceId;
    const result = post(path, { itemIds: itemIds }, budget).result;
    const values = {};
    (result.items || []).forEach(function (item) {
      values[item.itemId] = item.value;
    });
    return values;
  }

  /** リソース定義。**実環境の schema を正とする**（rules/10-cp-api.md）。 */
  function getSchema(resourceCategory, budget) {
    const result = get('/v1/ext2/schema/' + resourceCategory, budget).result;
    return result.items || [];
  }

  /** コード値 → ラベル。selectone 等の値をそのまま通知に出すと読めないため。 */
  function getMaster(codeName, budget) {
    const result = get('/v1/ext2/master/' + codeName, budget).result;
    const labels = {};
    (result.values || []).forEach(function (entry) {
      // 検証スクリプトで value / values の両方が観測されているため両対応にする
      const code = entry.value !== undefined ? entry.value : entry.values;
      if (code === undefined || code === null) return;
      labels[String(code)] = entry.label || '';
    });
    return labels;
  }

  /**
   * トークンエンドポイント。**共通ラッパが無い**のでここだけ生の JSON を返す。
   * 認可も CP へのリクエストなのでトークンバケットを通す。
   */
  function postTokenRequest(payload) {
    return request('post', '/v1/auth/token', payload, null, false);
  }

  // --- 内部 --------------------------------------------------------------

  function get(path, budget) {
    return request('get', path, null, budget, true);
  }

  function post(path, body, budget) {
    return request('post', path, body, budget, true);
  }

  function request(method, path, body, budget, withAuth) {
    const b = budget || Budget.unlimited(currentWatcher);
    let authRetried = false;
    let serverAttempts = 0;

    for (;;) {
      // 予算 → トークンバケットの順。予算切れなら CP を叩く前に止める
      b.consume();
      const waited = RateLimit.acquire();
      metrics().record(currentWatcher, endpointOf(path));

      let response;
      try {
        response = send(method, path, body, withAuth);
      } catch (e) {
        // UrlFetchApp は DNS 失敗・タイムアウト等で例外を投げる
        serverAttempts += 1;
        if (serverAttempts >= SERVER_RETRY_MAX) {
          throw Errors.transport('fetch failed', path);
        }
        backoff(serverAttempts, path, 'transport_error', {});
        continue;
      }

      const status = response.getResponseCode();
      const text = response.getContentText();
      const requestId = extractRequestId(text);

      if (status === 200) {
        if (waited > 1) {
          Log.debug('rate_limited', { path: path, waited_seconds: Math.round(waited * 100) / 100 });
        }
        return JSON.parse(text);
      }

      const error = Errors.fromStatus(status, text, requestId, path);

      // 401 はトークンを取り直して1回だけリトライ。2回目は設定不備として扱う
      if (Errors.is(error, Errors.KIND.AUTH) && withAuth && !authRetried) {
        authRetried = true;
        Log.warn('token_refresh_on_401', { path: path, request_id: requestId });
        Auth.invalidate();
        continue;
      }

      // 500 / 504 は指数バックオフで最大3回
      if (error.retryable) {
        serverAttempts += 1;
        if (serverAttempts < SERVER_RETRY_MAX) {
          backoff(serverAttempts, path, 'server_error',
                  { status: status, request_id: requestId });
          continue;
        }
      }

      Log.error('cp_api_error', {
        path: path, status: status, request_id: requestId, retryable: !!error.retryable,
      });
      throw error;
    }
  }

  function send(method, path, body, withAuth) {
    const options = {
      method: method,
      contentType: 'application/json',
      muteHttpExceptions: true,   // ステータスコードで分岐するため例外にさせない
      headers: {},
    };
    if (withAuth) {
      // `Bearer` は大文字が正。小文字は 401 になる（実測）
      options.headers.Authorization = 'Bearer ' + Auth.getToken();
    }
    if (body !== null && body !== undefined) {
      options.payload = JSON.stringify(body);
    }
    return UrlFetchApp.fetch(Config.cpApi.baseUrl + path, options);
  }

  function backoff(attempt, path, reason, fields) {
    const delaySeconds = Math.pow(BACKOFF_BASE_SECONDS, attempt);
    const entry = { path: path, reason: reason, attempt: attempt, delay_seconds: delaySeconds };
    Object.keys(fields || {}).forEach(function (k) { entry[k] = fields[k]; });
    Log.warn('retrying', entry);
    Utilities.sleep(delaySeconds * 1000);
  }

  function extractRequestId(text) {
    try {
      return JSON.parse(text).requestId || null;
    } catch (e) {
      return null;   // JSON でない応答もありうる
    }
  }

  /**
   * メトリクス集計用にパスを正規化する（末尾の ID を `*` に潰す）。
   * `/v1/ext2/career/select/18` -> `/v1/ext2/career/select/*`
   * `/v1/ext2/schema/career`    -> `/v1/ext2/schema/*`
   */
  function endpointOf(path) {
    const parts = path.split('/').filter(function (p) { return p; });
    if (parts.length >= 4 && (parts[2] === 'schema' || parts[2] === 'master') && parts[3] !== 'list') {
      return '/' + parts.slice(0, 3).join('/') + '/*';
    }
    if (parts.length >= 5 && parts[3] === 'select') {
      return '/' + parts.slice(0, 4).join('/') + '/*';
    }
    return '/' + parts.join('/');
  }

  return {
    MAX_LIMIT: MAX_LIMIT,
    search: search,
    select: select,
    getSchema: getSchema,
    getMaster: getMaster,
    postTokenRequest: postTokenRequest,
    setCurrentWatcher: setCurrentWatcher,
    metrics: metrics,   // 関数。CpClient.metrics().summary() で読む
    endpointOf: endpointOf,
  };
})();
