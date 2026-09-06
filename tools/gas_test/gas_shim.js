// GAS の組み込みグローバルを node 上で最小限に再現する。
// テストを push 前にローカルで走らせるためだけのもの。gas/src には置かない。
const crypto = require('crypto');

global.Utilities = {
  DigestAlgorithm: { SHA_256: 'SHA_256' },
  Charset: { UTF_8: 'UTF_8' },
  computeDigest: function (algo, text) {
    return Array.from(crypto.createHash('sha256').update(String(text), 'utf8').digest());
  },
  formatDate: function (date, tz, fmt) {
    if (tz !== 'Asia/Tokyo') throw new Error('shim supports Asia/Tokyo only');
    const d = new Date(date.getTime() + 9 * 3600 * 1000);
    const p = function (n, w) { return String(n).padStart(w, '0'); };
    return fmt
      .replace('yyyy', p(d.getUTCFullYear(), 4))
      .replace('MM', p(d.getUTCMonth() + 1, 2))
      .replace('dd', p(d.getUTCDate(), 2))
      .replace('HH', p(d.getUTCHours(), 2))
      .replace('mm', p(d.getUTCMinutes(), 2))
      .replace('ss', p(d.getUTCSeconds(), 2));
  },
  sleep: function () {},
};

function memoryProps() {
  const store = {};
  return {
    getProperty: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setProperty: function (k, v) { store[k] = String(v); return this; },
    deleteProperty: function (k) { delete store[k]; return this; },
  };
}
const scriptProps = memoryProps();
global.PropertiesService = { getScriptProperties: function () { return scriptProps; } };
global.SpreadsheetApp = { getActiveSpreadsheet: function () { return null; } };
global.LockService = {
  getScriptLock: function () {
    return { tryLock: function () { return true; }, releaseLock: function () {} };
  },
};
global.UrlFetchApp = {
  fetch: function () { throw new Error('UrlFetchApp must be stubbed in tests'); },
};
// トリガーのテストは T.fakeScriptApp() を渡す。本物を触るテストを書かせない
global.ScriptApp = {
  newTrigger: function () { throw new Error('ScriptApp must be stubbed in tests'); },
  getProjectTriggers: function () { throw new Error('ScriptApp must be stubbed in tests'); },
};
