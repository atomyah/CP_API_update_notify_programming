/**
 * スプレッドシートの初期化とバッチ読み書き。
 *
 * SQLite の `snapshots` / `notified` / `dead_letter` の置き場所（仕様書 11.2）。
 * `cursors` はここではなく PropertiesService（core/state.js）。
 *
 * **⚠️ GAS ではシート操作の呼び出し回数がそのまま実行時間になる。**
 * 1シートにつき `getValues()` / `setValues()` 各1回で済ませる（仕様書 11.3）。
 * 「1行ずつ読む・1セルずつ書く」コードを足さないこと。6分制限（11.6）に当たる。
 *
 * 例外は `notified` の追記だけ。**通知送信より先に1件ずつ追記する**という順序
 * （仕様書 7.3 / 11.5）を守るため、ここだけはバッチにできない。
 */
const Sheets = (function () {

  const NAMES = {
    SNAPSHOTS: 'snapshots',
    SNAPSHOT_VALUES: 'snapshot_values',
    ID_SETS: 'id_sets',
    NOTIFIED: 'notified',
    DEAD_LETTER: 'dead_letter',
  };

  /**
   * 固定列の見出し。
   *
   * `snapshots` は **3列目以降が項目ID**で、監視項目の数だけ動的に増える（仕様書 11.3）。
   * **列位置をコードに直書きしない。**項目IDで引く（core/state.js の SnapshotSet）。
   *
   * `watcher_id` 列は SQLite の主キー `(watcher_id, resource_id, item_id)` に由来する。
   * ウォッチャー間で状態を共有しないという不変条件（rules/30）をシートでも保つために要る。
   *
   * `snapshot_values` は `snapshots` と同じレイアウトで、**遷移前後を通知したい項目の
   * 生値だけ**を持つ（SQLite の `snapshots.value_raw` に相当。仕様書 11.3）。
   * ⚠️ ここには個人情報が平文で入る。対象項目は設定で明示したものだけに限る
   * （rules/40-secrets-and-security.md / core/config.js の rawValueItems）。
   *
   * `id_sets` も同じレイアウトで、**前回サイクルで走査窓に入っていた ID の集合**を持つ
   * （要件4の `S30_prev`。仕様書 11.3 / 3.3.4）。値は項目値ではなく在／不在の印だけで、
   * 3列目以降は「集合の名前」（例 `discovery_window`）。**書き戻しは snapshots と
   * 同じコミット点**なので、中断したサイクルでは集合も進まない（仕様書 11.4）。
   */
  const HEADERS = {};
  HEADERS[NAMES.SNAPSHOTS] = ['watcher_id', 'resource_id'];
  HEADERS[NAMES.SNAPSHOT_VALUES] = ['watcher_id', 'resource_id'];
  HEADERS[NAMES.ID_SETS] = ['watcher_id', 'resource_id'];
  HEADERS[NAMES.NOTIFIED] = ['watcher_id', 'resource_id', 'event_type', 'payload_hash', 'notified_at'];
  HEADERS[NAMES.DEAD_LETTER] = ['created_at', 'watcher_id', 'payload', 'error'];

  /**
   * バインド先のスプレッドシート。
   * **コンテナバインドのスクリプトであることが前提**（仕様書 11.2 / CLAUDE.md）。
   */
  function spreadsheet() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) {
      throw Errors.config(
        'no container-bound spreadsheet. This script must be bound to a spreadsheet ' +
        '(Extensions > Apps Script from the sheet), not standalone');
    }
    return ss;
  }

  /**
   * バインド先を人が特定できる情報。**URL は出さない**（ログの秘匿ルールに合わせる）。
   * ID があれば `https://docs.google.com/spreadsheets/d/<id>/edit` で開ける。
   */
  function location() {
    const ss = spreadsheet();
    return { spreadsheet_name: ss.getName(), spreadsheet_id: ss.getId() };
  }

  /** 3シートを作る。既にあれば見出しだけ確認する。手動実行の initSheets() から呼ぶ。 */
  function ensureAll() {
    const created = [];
    Object.keys(NAMES).forEach(function (key) {
      const name = NAMES[key];
      if (ensure(name)) created.push(name);
    });
    return created;
  }

  /** 1シートを用意する。新規に作ったら true。 */
  function ensure(name) {
    const ss = spreadsheet();
    let sh = ss.getSheetByName(name);
    if (sh) {
      writeHeaderIfMissing(sh, name);
      return false;
    }
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]);
    sh.setFrozenRows(1);
    return true;
  }

  function writeHeaderIfMissing(sh, name) {
    if (sh.getLastRow() >= 1 && sh.getLastColumn() >= 1) return;
    sh.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]);
    sh.setFrozenRows(1);
  }

  function sheet(name) {
    const sh = spreadsheet().getSheetByName(name);
    if (!sh) {
      throw Errors.config('sheet "' + name + '" not found. Run initSheets() first');
    }
    return sh;
  }

  /**
   * シート全体を1回の getValues() で読む。**見出し行を含む。**
   * 空のシート（見出しだけ）なら見出し1行だけが返る。
   */
  function readAll(name) {
    const sh = sheet(name);
    const lastRow = sh.getLastRow();
    const lastCol = sh.getLastColumn();
    if (lastRow < 1 || lastCol < 1) return [HEADERS[name].slice()];
    return sh.getRange(1, 1, lastRow, lastCol).getValues();
  }

  /**
   * シート全体を1回の setValues() で書く。**見出し行を含めて渡すこと。**
   * 行・列が減る場合に前の内容が残らないよう、書く前に中身を消す。
   */
  function writeAll(name, values) {
    const sh = sheet(name);
    if (!values.length) throw Errors.config('writeAll needs at least a header row');
    const cols = values[0].length;
    ensureGrid(sh, values.length, cols);
    sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).clearContent();
    sh.getRange(1, 1, values.length, cols).setValues(values);
  }

  /** 末尾に追記する。`notified` / `dead_letter` 用。 */
  function append(name, rows) {
    if (!rows || !rows.length) return;
    const sh = sheet(name);
    const startRow = sh.getLastRow() + 1;
    ensureGrid(sh, startRow + rows.length - 1, rows[0].length);
    sh.getRange(startRow, 1, rows.length, rows[0].length).setValues(rows);
  }

  /** 見出しを除いたデータ行数。 */
  function dataRowCount(name) {
    return Math.max(0, sheet(name).getLastRow() - 1);
  }

  /** setValues は既存のグリッドを超えると失敗する。足りなければ広げる。 */
  function ensureGrid(sh, rows, cols) {
    const needRows = rows - sh.getMaxRows();
    if (needRows > 0) sh.insertRowsAfter(sh.getMaxRows(), needRows);
    const needCols = cols - sh.getMaxColumns();
    if (needCols > 0) sh.insertColumnsAfter(sh.getMaxColumns(), needCols);
  }

  return {
    NAMES: NAMES,
    HEADERS: HEADERS,
    location: location,
    ensureAll: ensureAll,
    readAll: readAll,
    writeAll: writeAll,
    append: append,
    dataRowCount: dataRowCount,
  };
})();
