/**
 * 構造化ログ（1行1 JSON）。
 *
 * - ログメッセージは英語、コメントとドキュメントは日本語（rules/50-code-style.md）。
 * - **個人情報を出さない。**値はマスクし、項目 ID とリソース ID のみを出す
 *   （rules/40-secrets-and-security.md）。
 * - 最低限 watcher_id / event / resource_id / request_id を含める。
 *
 * GAS では console.log が Cloud Logging に流れる。ファイル出力は行わない
 * （Python 版の var/logs/ に相当するものは GAS にない）。
 */
const Log = (function () {

  // ログに絶対に出さないキー。値が渡されても伏せる
  const SECRET_KEYS = [
    'api_key', 'apikey', 'access_token', 'accesstoken', 'refresh_token',
    'refreshtoken', 'authorization', 'password', 'webhook', 'url', 'token',
  ];

  function write(level, event, fields) {
    const record = { ts: TimeFmt.nowStore(), level: level, event: event };
    const scrubbed = scrub(fields || {});
    Object.keys(scrubbed).forEach(function (k) { record[k] = scrubbed[k]; });
    const line = JSON.stringify(record);
    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  function scrub(fields) {
    const out = {};
    Object.keys(fields).forEach(function (key) {
      const value = fields[key];
      if (SECRET_KEYS.indexOf(String(key).toLowerCase()) >= 0) {
        out[key] = '***';
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        out[key] = scrub(value);
      } else {
        out[key] = value;
      }
    });
    return out;
  }

  /** 個人情報になりうる値をログ用に潰す。長さと型だけを残す。 */
  function maskValue(value) {
    if (value === null || value === undefined) return '<none>';
    if (Array.isArray(value)) return '<list len=' + value.length + '>';
    return '<' + (typeof value) + ' len=' + String(value).length + '>';
  }

  return {
    info: function (event, fields) { write('info', event, fields); },
    warn: function (event, fields) { write('warn', event, fields); },
    error: function (event, fields) { write('error', event, fields); },
    debug: function (event, fields) { write('debug', event, fields); },
    maskValue: maskValue,
  };
})();
