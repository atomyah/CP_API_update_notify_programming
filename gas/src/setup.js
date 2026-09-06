/**
 * 手動実行する運用スクリプト。
 *
 * Apps Script エディタで関数を選んで実行する。トリガーからは呼ばない（Phase5）。
 * **⚠️ エディタでコードを直接編集しない。**`clasp push` が唯一の反映経路。
 */

/**
 * 時間主導トリガーを設定する（仕様書 11.6節）。**冪等。何回実行してもよい。**
 *
 * ⚠️ **必ず既存のトリガーを消してから作る。**繰り返し実行すると同じ関数の
 * トリガーが増殖し、**流量がその本数だけ倍になる**（rules/20-rate-limit.md）。
 * 消すのは `Config.triggers` に載っている関数のぶんだけで、
 * 他の用途で作られたトリガーには触らない。
 *
 * ⚠️ **Apps Script の画面からトリガーを手で足さない。**ここの管理外になり、
 * 二重に回っていることに気づけない。構成を変えるときは `core/config.js` を直す。
 *
 * @param options { scriptApp } — テストのために差し替える。本番では既定のまま
 */
function createTriggers(options) {
  const opts = options || {};
  const scriptApp = opts.scriptApp || ScriptApp;
  // GAS が受け付ける分間隔はこの5つだけ。それ以外は作成時に落ちる
  const ALLOWED_MINUTES = [1, 5, 10, 15, 30];

  const removed = deleteTriggers({ scriptApp: scriptApp });
  const created = [];
  const skipped = [];

  Config.triggers.forEach(function (entry) {
    if (!entry.enabled) {
      skipped.push(entry.handler);
      return;
    }
    const builder = scriptApp.newTrigger(entry.handler).timeBased();
    if (entry.everyMinutes) {
      if (ALLOWED_MINUTES.indexOf(entry.everyMinutes) < 0) {
        throw Errors.config(
          'trigger ' + entry.handler + ': everyMinutes must be one of ' +
          ALLOWED_MINUTES.join(' / ') + ' (got ' + entry.everyMinutes + ')');
      }
      builder.everyMinutes(entry.everyMinutes).create();
      created.push(entry.handler + ' every ' + entry.everyMinutes + 'min');
    } else if (entry.atHour !== undefined && entry.atHour !== null) {
      builder.everyDays(1).atHour(entry.atHour).create();
      created.push(entry.handler + ' daily at ' + entry.atHour);
    } else {
      throw Errors.config(
        'trigger ' + entry.handler + ' needs everyMinutes or atHour');
    }
  });

  Log.info('triggers_created', {
    created: created,
    removed: removed,
    // enabled: false のもの。要件4は Phase6 まで関数が存在しない
    skipped: skipped,
  });
  return created;
}

/**
 * このアプリが作ったトリガーを消す。**他のトリガーには触らない。**
 * 止めたいときと、`createTriggers()` から呼ばれる。
 */
function deleteTriggers(options) {
  const opts = options || {};
  const scriptApp = opts.scriptApp || ScriptApp;
  const managed = {};
  Config.triggers.forEach(function (entry) { managed[entry.handler] = true; });

  const removed = [];
  scriptApp.getProjectTriggers().forEach(function (trigger) {
    const handler = trigger.getHandlerFunction();
    if (!managed[handler]) return;   // 管理外のトリガーは残す
    scriptApp.deleteTrigger(trigger);
    removed.push(handler);
  });
  if (removed.length) Log.info('triggers_deleted', { removed: removed });
  return removed;
}

/** 今どのトリガーが動いているかを見る。**管理外のものも含めて全部出す。** */
function showTriggers(options) {
  const opts = options || {};
  const scriptApp = opts.scriptApp || ScriptApp;
  const managed = {};
  Config.triggers.forEach(function (entry) { managed[entry.handler] = true; });

  const handlers = scriptApp.getProjectTriggers().map(function (trigger) {
    return trigger.getHandlerFunction();
  });
  const counts = {};
  handlers.forEach(function (h) { counts[h] = (counts[h] || 0) + 1; });
  // 同じ関数のトリガーが2本以上あれば流量が倍になっている
  const duplicated = Object.keys(counts).filter(function (h) { return counts[h] > 1; });
  const unmanaged = Object.keys(counts).filter(function (h) { return !managed[h]; });

  Log.info('triggers', {
    total: handlers.length,
    by_handler: counts,
    duplicated: duplicated,
    unmanaged: unmanaged,
    hint: duplicated.length
      ? 'run createTriggers() to rebuild them; duplicates double the request rate'
      : 'ok',
  });
  return counts;
}

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
  const ids = watcherIds ||
    [CareerStatusWatcher.WATCHER_ID, ProgressFlowWatcher.WATCHER_ID, DummyWatcher.WATCHER_ID];
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
