/**
 * GAS のテストをローカルで走らせる。**clasp push する前に落とすため。**
 *
 *   node tools/gas_test/run_tests.js            # 既定で gas/src を見る
 *   node tools/gas_test/run_tests.js gas/src
 *
 * Apps Script は全ファイルを1つのグローバル空間に連結して実行する。
 * ここでも同じ形（連結して1つの関数として評価）にしてある。読み込み順に依存する
 * バグがあればここでも再現する。
 *
 * ⚠️ これは `gas/src` の実装ではない。**push されない**（rootDir の外）。
 * ⚠️ CP API・Slack・スプレッドシートは一切叩かない。`gas_shim.js` が
 *    GAS の組み込みグローバルを最小限に模しているだけで、
 *    テスト側は Sheets / Properties / Lock / UrlFetchApp を自前の偽物に差し替えている。
 */
const fs = require('fs');
const path = require('path');
require('./gas_shim.js');

const root = process.argv[2] || path.join(__dirname, '..', '..', 'gas', 'src');
if (!fs.existsSync(root)) {
  console.error('not found: ' + root);
  process.exit(2);
}

const files = [];
(function walk(dir) {
  fs.readdirSync(dir).sort().forEach(function (name) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) return walk(full);
    if (name.endsWith('.js')) files.push(full);
  });
})(root);

const source = files.map(function (f) { return fs.readFileSync(f, 'utf8'); }).join('\n');
const run = new Function(source + '\nreturn runAllTests();');

try {
  const summary = run();
  console.log('SUMMARY ' + JSON.stringify(summary));
  process.exitCode = summary.failed ? 1 : 0;
} catch (e) {
  console.log('FAILED: ' + e.message);
  process.exitCode = 1;
}
