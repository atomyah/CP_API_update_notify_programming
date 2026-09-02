/**
 * 例外の定義。
 *
 * リトライ可否は呼び出し側でステータスコードを分岐させず、**種別で判断する**
 * （rules/50-code-style.md）。JS には例外の型階層を素直に書けないため、
 * `name` と `retryable` を持つ Error を作り、`Errors.is()` で判定する。
 *
 * requestId はベンダー問い合わせに必須なので必ず保持する。
 * レスポンスボディは個人情報を含みうるため、message には載せない。
 */
const Errors = (function () {

  const KIND = {
    CONFIG: 'ConfigError',            // 設定不備。起動を失敗させる
    BAD_REQUEST: 'CpBadRequestError', // 400。リトライしない
    AUTH: 'CpAuthError',              // 401。取り直して1回だけリトライ
    FORBIDDEN: 'CpForbiddenError',    // 403。権限不足。リトライしない
    NOT_FOUND: 'CpNotFoundError',     // 404。エンドポイント誤り
    SERVER: 'CpServerError',          // 500/504。指数バックオフ
    TRANSPORT: 'CpTransportError',    // 接続エラー・タイムアウト
    BUDGET: 'BudgetExhausted',        // 1サイクルの予算切れ
    NOTIFY: 'NotifyError',            // 通知の送信に失敗した
  };

  /** 設定不備。起動を失敗させる。 */
  function config(message) {
    const err = new Error(message);
    err.name = KIND.CONFIG;
    err.retryable = false;
    return err;
  }

  /** 予算切れ。ウォッチャーはこれを捕捉して exhausted を返し、カーソルを進めない。 */
  function budgetExhausted(message) {
    const err = new Error(message);
    err.name = KIND.BUDGET;
    err.retryable = false;
    return err;
  }

  function notify(message) {
    const err = new Error(message);
    err.name = KIND.NOTIFY;
    err.retryable = false;
    return err;
  }

  /** 接続エラー。スリープ復帰直後などに起きる。 */
  function transport(message, path) {
    const err = new Error(message + ' on ' + path);
    err.name = KIND.TRANSPORT;
    err.retryable = true;
    err.path = path;
    return err;
  }

  /**
   * ステータスコードから CP API エラーを作る（rules/10-cp-api.md のエラーコード表）。
   *
   * ⚠️ 400 は権限の有無を示さない。CP は「ボディ検証 → 認可」の順に処理するため、
   *    権限が無くてもボディが不正なら 400 が返る。
   */
  function fromStatus(status, body, requestId, path) {
    let name;
    let retryable = false;
    if (status === 400) {
      name = KIND.BAD_REQUEST;
    } else if (status === 401) {
      name = KIND.AUTH;
    } else if (status === 403) {
      name = KIND.FORBIDDEN;
    } else if (status === 404) {
      name = KIND.NOT_FOUND;
    } else if (status >= 500) {
      name = KIND.SERVER;
      retryable = true;
    } else {
      name = 'CpApiError';
    }
    // ⚠️ body を message に入れない。個人情報が例外経由でログへ流れる
    const err = new Error('HTTP ' + status + ' on ' + path + ' requestId=' + requestId);
    err.name = name;
    err.retryable = retryable;
    err.statusCode = status;
    err.requestId = requestId || null;
    err.path = path;
    return err;
  }

  function is(err, kind) {
    return !!err && err.name === kind;
  }

  return { KIND: KIND, config: config, budgetExhausted: budgetExhausted,
           notify: notify, transport: transport, fromStatus: fromStatus, is: is };
})();
