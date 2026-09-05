# GAS のテストをローカルで走らせる

`gas/src` の単体テスト（`runAllTests`）を **`clasp push` せずに** node で走らせる。
Apps Script エディタで実行するのと同じテストが同じ順序で走る。

```powershell
node tools/gas_test/run_tests.js
```

```
{"ts":"...","event":"tests_passed","suite":"core","total":22,"failed":0}
{"ts":"...","event":"tests_passed","suite":"state","total":33,"failed":0}
{"ts":"...","event":"tests_passed","suite":"watchers","total":33,"failed":0}
SUMMARY {"total":88,"failed":0}
```

1件でも落ちれば終了コード 1。

## なぜ要るか

`clasp push` → エディタで関数を選んで実行、という往復は遅く、
**push した内容がそのまま検証されないまま実環境に載る**リスクがある。
push 前にここで落としておく。

## 仕組みと限界

- `gas/src` の `.js` を全て連結し、1つの関数として評価する。
  **Apps Script も全ファイルを1つのグローバル空間に連結する**ので、
  読み込み順に依存するバグ（トップレベルで他モジュールを参照する等）はここでも再現する。
- `gas_shim.js` が GAS の組み込みグローバルを最小限だけ模している
  （`Utilities.computeDigest` / `Utilities.formatDate` / `PropertiesService` など）。
  **`SpreadsheetApp` は `null` を返すだけ**で、実物のシート操作は再現しない。
  テスト側が `T.fakeSheets()` などに差し替えている前提。
- したがって**ここが通っても実環境で動く保証にはならない。**
  シート・トリガー・認可まわりは実機で確認すること（各 Phase の「完了条件」）。
- **CP API・Slack を叩かない。**実 API を叩くテストは置かない（`rules/50-code-style.md`）。

## 注意

- これは `app/` の実装ではなく、`gas/src` にも入らない（`clasp` の `rootDir` の外なので push されない）。
- node が要る（開発機に入っていること）。CI には置いていない。
