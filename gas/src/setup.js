/**
 * 手動実行する運用スクリプト。
 *
 * Apps Script エディタで関数を選んで実行する。トリガーからは呼ばない（Phase5）。
 * **⚠️ エディタでコードを直接編集しない。**`clasp push` が唯一の反映経路。
 */

/**
 * 状態管理用のシートを作る。**最初に1回だけ実行する。**
 * 既にあるシートは触らない（データを消さない）。
 */
function initSheets() {
  const created = Sheets.ensureAll();
  const where = Sheets.location();
  Log.info('sheets_ready', {
    // 3シートはバインド先のスプレッドシートの中にタブとしてできる。
    // https://docs.google.com/spreadsheets/d/<spreadsheet_id>/edit で開ける
    spreadsheet_name: where.spreadsheet_name,
    spreadsheet_id: where.spreadsheet_id,
    created: created,
    snapshots_rows: Sheets.dataRowCount(Sheets.NAMES.SNAPSHOTS),
    snapshot_values_rows: Sheets.dataRowCount(Sheets.NAMES.SNAPSHOT_VALUES),
    notified_rows: Sheets.dataRowCount(Sheets.NAMES.NOTIFIED),
    dead_letter_rows: Sheets.dataRowCount(Sheets.NAMES.DEAD_LETTER),
  });
  return created;
}

/**
 * 今の状態を1行で出す。カーソルが進んだかどうかを目で確かめるため。
 * @param watcherIds 見たいウォッチャーID。省略時はダミーだけ
 */
function showState(watcherIds) {
  const state = State.create();
  const ids = watcherIds || [CareerStatusWatcher.WATCHER_ID, DummyWatcher.WATCHER_ID];
  ids.forEach(function (watcherId) {
    const cursor = state.getCursor(watcherId);
    Log.info('watcher_state', {
      watcher_id: watcherId,
      cursor: cursor ? TimeFmt.toStore(cursor.value) : null,
      page_offset: cursor ? cursor.pageOffset : null,
      bootstrapped: cursor ? cursor.bootstrapped : false,
      consecutive_failures: state.getFailureCount(watcherId),
      snapshot_rows: state.snapshots(watcherId).count(),
      raw_value_rows: state.rawValues(watcherId).count(),
    });
  });
  Log.info('sheet_rows', {
    notified_rows: Sheets.dataRowCount(Sheets.NAMES.NOTIFIED),
    dead_letter_rows: Sheets.dataRowCount(Sheets.NAMES.DEAD_LETTER),
  });
}

/**
 * 自動停止したウォッチャーを再開させる（連続失敗カウンタを戻す）。
 *
 * **原因を直してから実行すること。**カウンタだけ戻すと、壊れたまま回り続けて
 * API 予算を食い潰す（rules/30-state-and-idempotency.md）。
 * カーソルは進んでいないので、再開すれば失敗した範囲から処理し直される。
 */
function clearWatcherFailures(watcherId) {
  const id = watcherId || CareerStatusWatcher.WATCHER_ID;
  State.create().clearFailures(id);
  Log.info('failure_counter_cleared', { watcher_id: id });
}
