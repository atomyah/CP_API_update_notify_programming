/**
 * アクセストークンの取得とキャッシュ。
 *
 * 実測で判明している挙動（docs/design/07-verification-results.md 4章）:
 *
 * - トークンエンドポイントのレスポンスには **code/result の共通ラッパが無い。**
 *   {accessToken, refreshToken, expiresIn} のフラットな JSON が返る。
 *   他のエンドポイントと同じパーサを使い回さないこと。
 * - **refresh_token で取り直すと、同系列の直前のアクセストークンが即座に無効化される。**
 *   猶予期間はない。
 * - ヘッダは `Bearer <token>`。**`bearer`（小文字）は 401。**
 *
 * ⚠️ GAS では refreshToken を使わない（Python 版からの変更）
 * ---------------------------------------------------------
 * GAS はトリガー実行ごとに独立したプロセスであり、実行間でトークンの差し替え順序を
 * 保証できない。refresh を使うと「別の実行が直前に取得したトークンを殺す」事故が起きうる。
 * **APIキーから取得したトークンは別系列として扱われ同時に有効**（実測）なので、
 * 実行ごとに api_key で取り直す方が安全で、かつ実装も単純になる。
 *
 * 1回の実行は最長6分、トークンの寿命は60分なので、実行中に期限切れは起こらない。
 * 追加コストは実行あたり1リクエストだけ。
 *
 * トークンは **この実行のメモリ上のみ。**プロパティにもシートにもログにも書かない
 * （rules/40-secrets-and-security.md）。
 */
const Auth = (function () {

  // 有効期限の何秒前に取り直すか（仕様は expiresIn: 3600）
  const REFRESH_MARGIN_SECONDS = 300;

  let accessToken = null;
  let expiresAtMs = 0;
  let postToken = null;   // core/client.js から注入する

  /** HTTP の実体は client.js が持つ。ここは寿命だけを見る。 */
  function attach(postTokenFn) {
    postToken = postTokenFn;
  }

  /** 有効なアクセストークンを返す。期限が近ければ取り直す。 */
  function getToken() {
    if (accessToken && Date.now() < expiresAtMs - REFRESH_MARGIN_SECONDS * 1000) {
      return accessToken;
    }
    acquire();
    return accessToken;
  }

  /**
   * 401 を受けたときに呼ぶ。強制的に取り直す。
   * リトライは1回だけ（rules/10-cp-api.md）。2回目の 401 は設定不備として扱う。
   */
  function invalidate() {
    accessToken = null;
    acquire();
    return accessToken;
  }

  function acquire() {
    // 既定は core/client.js。attach() は主にテストで差し替えるためにある。
    // ファイルの読み込み順に依存しないよう、参照は呼び出し時まで遅らせる
    const send = postToken || CpClient.postTokenRequest;
    const response = send({ grantType: 'api_key', apiKey: apiKey() });
    // 共通ラッパが無いのが正だが、将来 API 側が揃えてきても壊れないようにしておく
    const body = (response && typeof response.result === 'object' && response.result)
      ? response.result : response;
    if (!body || !body.accessToken) {
      throw Errors.config('token response has no accessToken');
    }
    accessToken = body.accessToken;
    const expiresIn = Number(body.expiresIn) || 3600;
    expiresAtMs = Date.now() + expiresIn * 1000;
  }

  /** APIキーはスクリプトプロパティから読む。**コードにも clasp にも入れない。** */
  function apiKey() {
    const key = PropertiesService.getScriptProperties()
      .getProperty(Config.cpApi.apiKeyProperty);
    if (!key) {
      throw Errors.config(
        'script property "' + Config.cpApi.apiKeyProperty + '" is not set. ' +
        'Set it from the Apps Script editor: Project Settings > Script Properties');
    }
    return key;
  }

  /** テストと、実行をまたいだ状態を明示的に捨てたいときだけ使う。 */
  function clear() {
    accessToken = null;
    expiresAtMs = 0;
  }

  return { attach: attach, getToken: getToken, invalidate: invalidate,
           hasApiKey: function () { try { apiKey(); return true; } catch (e) { return false; } },
           clear: clear };
})();
