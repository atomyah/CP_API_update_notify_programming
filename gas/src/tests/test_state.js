/**
 * Phase2（状態管理と実行基盤）のテスト。
 *
 * rules/50-code-style.md のテスト優先順位のうち、2 と 3 がここ:
 *   2. カーソル前進の条件（失敗時・予算切れ時に進まないこと）
 *   3. 冪等キーによる重複除去
 *
 * **移植で最も事故になりやすいのは `notified` の UNIQUE 制約の喪失**（仕様書 11.5）。
 * 二重通知は発覚が遅れるので、ここを厚く書く。
 *
 * 使い方: Apps Script エディタで `runStateTests`（または `runAllTests`）を実行する。
 * **CP API・本番のシート・本番のプロパティを一切触らない。**
 */
function runStateTests() {
  T.reset();

  // --- 値の正規化とハッシュ -------------------------------------------------

  T.test('選択項目の 0 は未設定として扱う', function () {
    // CP は画面で保存すると未入力の選択項目を null から 0 に書き換える（実測）。
    // ここを潰さないと「(未設定) → (未設定)」の通知が大量に出る
    T.assertEquals(State.valueHash(0, 'selectone'), State.valueHash(null, 'selectone'));
    T.assertEquals(State.valueHash('0', 'select'), State.valueHash('', 'select'));
  });

  T.test('number の 0 は正当な値なので潰さない', function () {
    T.assert(State.valueHash(0, 'number') !== State.valueHash(null, 'number'),
             'number の 0 が未設定と同一視されている');
  });

  T.test('number と文字列の 18 は同じ値', function () {
    // CP は number を JSON の数値で返す（付録A-4）
    T.assertEquals(State.valueHash(18, 'number'), State.valueHash('18', 'number'));
  });

  T.test('空配列と null は同じ（未設定）', function () {
    T.assertEquals(State.valueHash([], 'select'), State.valueHash(null, 'select'));
    T.assertEquals(State.canonicalValue(['0', ''], 'select'), null);
  });

  T.test('配列の中身が変われば別の値', function () {
    T.assert(State.valueHash(['8', '9'], 'select') !== State.valueHash(['8'], 'select'),
             'select の要素数の違いが無視されている');
  });

  T.test('payloadHash は本文が変われば変わる', function () {
    const a = State.payloadHash({ item: 'CAREER#48002', from: '1', to: '2' });
    const b = State.payloadHash({ item: 'CAREER#48002', from: '1', to: '3' });
    T.assert(a !== b, '通知本文が違うのに冪等キーが同じ');
    T.assertEquals(a, State.payloadHash({ to: '2', from: '1', item: 'CAREER#48002' }),
                   'キーの順序で冪等キーが変わってはいけない');
  });

  // --- snapshots ------------------------------------------------------------

  T.test('初めて見た項目は変化として扱わない', function () {
    // 前回値がない状態で通知すると、既存の全レコードが「変化した」と誤判定される
    const snapshots = newState().snapshots('w1');
    T.assertEquals(snapshots.hasChanged('18', 'CAREER#48002', '米国', 'selectone'), false);
  });

  T.test('値が変われば検知し、同じなら検知しない', function () {
    const snapshots = newState().snapshots('w1');
    snapshots.put('18', 'CAREER#48002', '1', 'selectone');
    T.assertEquals(snapshots.hasChanged('18', 'CAREER#48002', '1', 'selectone'), false);
    T.assertEquals(snapshots.hasChanged('18', 'CAREER#48002', '2', 'selectone'), true);
  });

  T.test('書き戻しは setValues 1回（項目がいくつあっても）', function () {
    // シート操作の回数がそのまま実行時間になる（仕様書 11.3）
    const sheets = T.fakeSheets();
    const snapshots = newState({ sheets: sheets }).snapshots('w1');
    for (let i = 0; i < 50; i++) {
      snapshots.put('18', 'CAREER#' + i, 'v' + i, 'text');
      snapshots.put('17', 'CAREER#' + i, 'v' + i, 'text');
    }
    T.assertEquals(sheets.counts.write, 0, 'flush 前に書いてはいけない');
    snapshots.flush();
    T.assertEquals(sheets.counts.write, 1);
    T.assertEquals(sheets.counts.read, 1, '読みも1回で済むはず');
    T.assertEquals(snapshots.count(), 2, '1リソース = 1行');
  });

  T.test('flush しなければシートに残らない', function () {
    const sheets = T.fakeSheets();
    newState({ sheets: sheets }).snapshots('w1').put('18', 'CAREER#48002', '1', 'selectone');
    T.assertEquals(sheets.dataRowCount(Sheets.NAMES.SNAPSHOTS), 0);
  });

  T.test('他のウォッチャーの行を壊さない', function () {
    const sheets = T.fakeSheets();
    const first = newState({ sheets: sheets }).snapshots('w1');
    first.put('18', 'CAREER#48002', '1', 'selectone');
    first.flush();

    const second = newState({ sheets: sheets }).snapshots('w2');
    second.put('18', 'PROGRESS#STATUS', '16', 'selectone');
    second.flush();

    const reloaded = newState({ sheets: sheets });
    T.assertEquals(reloaded.snapshots('w1').hashOf('18', 'PROGRESS#STATUS'), null,
                   'ウォッチャー間で状態が混ざっている');
    T.assert(reloaded.snapshots('w1').hashOf('18', 'CAREER#48002') !== null,
             'w1 の行が失われた');
    T.assert(reloaded.snapshots('w2').hashOf('18', 'PROGRESS#STATUS') !== null,
             'w2 の行が失われた');
  });

  T.test('書き戻した内容が次の実行で読める', function () {
    const sheets = T.fakeSheets();
    const first = newState({ sheets: sheets }).snapshots('w1');
    first.put('18', 'CAREER#48002', '1', 'selectone');
    first.flush();

    const next = newState({ sheets: sheets }).snapshots('w1');
    T.assertEquals(next.hasChanged('18', 'CAREER#48002', '1', 'selectone'), false);
    T.assertEquals(next.hasChanged('18', 'CAREER#48002', '2', 'selectone'), true);
    T.assertEquals(next.has('18'), true);
    T.assertEquals(next.has('99'), false);
  });

  // --- notified（⚠️ UNIQUE 制約の代替。最重要） ------------------------------

  T.test('⚠️ 同じ冪等キーの2回目は除去される', function () {
    const state = newState();
    T.assertEquals(state.claimNotification('w1', '18', 'item_changed', 'h1'), true);
    T.assertEquals(state.claimNotification('w1', '18', 'item_changed', 'h1'), false);
  });

  T.test('⚠️ サイクルをまたいでも除去される（シートから復元する）', function () {
    const sheets = T.fakeSheets();
    T.assertEquals(
      newState({ sheets: sheets }).claimNotification('w1', '18', 'item_changed', 'h1'), true);
    // 別のトリガー実行を模して作り直す
    T.assertEquals(
      newState({ sheets: sheets }).claimNotification('w1', '18', 'item_changed', 'h1'), false);
    T.assertEquals(sheets.dataRowCount(Sheets.NAMES.NOTIFIED), 1, '行が二重に増えている');
  });

  T.test('⚠️ 予約はシートに追記されてから true になる（通知より先）', function () {
    // 送信後に追記すると、送信成功・追記失敗のときに二重送信する
    const sheets = T.fakeSheets();
    newState({ sheets: sheets }).claimNotification('w1', '18', 'item_changed', 'h1');
    const rows = sheets.dump(Sheets.NAMES.NOTIFIED);
    T.assertEquals(rows.length, 2, '見出し + 1行');
    T.assertEquals(String(rows[1][0]), 'w1');
    T.assertEquals(String(rows[1][3]), 'h1');
    T.assert(String(rows[1][4]).length > 0, 'notified_at が空');
  });

  T.test('冪等キーは4つ組。1つでも違えば別イベント', function () {
    const state = newState();
    T.assertEquals(state.claimNotification('w1', '18', 'item_changed', 'h1'), true);
    T.assertEquals(state.claimNotification('w2', '18', 'item_changed', 'h1'), true);
    T.assertEquals(state.claimNotification('w1', '17', 'item_changed', 'h1'), true);
    T.assertEquals(state.claimNotification('w1', '18', 'status_changed', 'h1'), true);
    T.assertEquals(state.claimNotification('w1', '18', 'item_changed', 'h2'), true);
    T.assertEquals(state.claimNotification('w1', '18', 'item_changed', 'h1'), false);
  });

  // --- cursors --------------------------------------------------------------

  T.test('カーソルは秒精度で往復する', function () {
    const state = newState();
    const value = TimeFmt.fromStore('2026-09-04 15:20:48');
    state.setCursor('w1', { value: value, pageOffset: 3, bootstrapped: true });
    const cursor = state.getCursor('w1');
    T.assertEquals(TimeFmt.toStore(cursor.value), '2026-09-04 15:20:48');
    T.assertEquals(cursor.pageOffset, 3);
    T.assertEquals(cursor.bootstrapped, true);
  });

  T.test('カーソルが無ければ null（ブートストラップ未了）', function () {
    T.assertEquals(newState().getCursor('w1'), null);
  });

  T.test('bootstrapped は省略すると引き継がれる', function () {
    const state = newState();
    state.setCursor('w1', { value: TimeFmt.now(), bootstrapped: true });
    state.setCursor('w1', { value: TimeFmt.now() });
    T.assertEquals(state.getCursor('w1').bootstrapped, true);
  });

  T.test('壊れたカーソルは黙って巻き戻さず ConfigError', function () {
    const props = T.fakeProperties();
    props.setProperty('cursor:w1', 'not json');
    T.assertThrows(Errors.KIND.CONFIG, function () { newState({ props: props }).getCursor('w1'); });
  });

  T.test('ウォッチャー間でカーソルを共有しない', function () {
    const state = newState();
    state.setCursor('w1', { value: TimeFmt.fromStore('2026-09-04 10:00:00') });
    T.assertEquals(state.getCursor('w2'), null);
  });

  // --- dead_letter ----------------------------------------------------------

  T.test('dead_letter に落とせる', function () {
    const sheets = T.fakeSheets();
    newState({ sheets: sheets }).addDeadLetter('w1', 'payload', 'NotifyError: boom');
    T.assertEquals(sheets.dataRowCount(Sheets.NAMES.DEAD_LETTER), 1);
  });

  // --- Runner（⚠️ コミット点。Phase2 の核心） --------------------------------

  T.test('⚠️ 失敗したサイクルではカーソルが進まない', function () {
    const env = newEnv();
    const watcher = testWatcher({
      execute: function (ctx) {
        ctx.snapshots.put('18', 'CAREER#48002', '2', 'selectone');
        throw new Error('boom');
      },
    });
    const result = Runner.execute(watcher, env.options);

    T.assertEquals(result.ok, false);
    T.assertEquals(env.state.getCursor('test_watcher'), null, 'カーソルが進んでいる');
    T.assertEquals(env.sheets.counts.write, 0, 'snapshots が書き戻されている');
    T.assertEquals(env.state.getFailureCount('test_watcher'), 1);
  });

  T.test('⚠️ 予算切れではカーソルも snapshots も進まない', function () {
    const env = newEnv();
    const watcher = testWatcher({
      execute: function (ctx) {
        ctx.snapshots.put('18', 'CAREER#48002', '2', 'selectone');
        ctx.budget.consume();
        ctx.budget.consume();   // budgetPerCycle=1 なのでここで BudgetExhausted
        return Events.result({ ok: true, cursor: { value: ctx.startedAt } });
      },
    }, { budgetPerCycle: 1 });
    const result = Runner.execute(watcher, env.options);

    T.assertEquals(result.exhausted, true);
    T.assertEquals(result.ok, true, '予算切れは異常ではない');
    T.assertEquals(env.state.getCursor('test_watcher'), null, 'カーソルが進んでいる');
    T.assertEquals(env.sheets.counts.write, 0, 'snapshots だけが進むと通知漏れになる');
    T.assertEquals(env.state.getFailureCount('test_watcher'), 0, '予算切れは失敗ではない');
  });

  T.test('経過時間で打ち切っても進まない（6分制限への対応）', function () {
    const env = newEnv();
    const watcher = testWatcher({
      execute: function (ctx) {
        ctx.budget.consume();
        return Events.result({ ok: true, cursor: { value: ctx.startedAt } });
      },
    });
    // maxRuntimeSeconds=0 なので最初の consume で時間切れになる
    const options = { state: env.state, lock: env.lock, maxRuntimeSeconds: 0 };
    const result = Runner.execute(watcher, options);

    T.assertEquals(result.exhausted, true);
    T.assertEquals(env.state.getCursor('test_watcher'), null);
  });

  T.test('成功したサイクルでだけカーソルと snapshots が進む', function () {
    const env = newEnv();
    const watcher = testWatcher({
      execute: function (ctx) {
        ctx.snapshots.put('18', 'CAREER#48002', '2', 'selectone');
        return Events.result({
          ok: true,
          eventsDetected: 1,
          eventsNotified: 1,
          cursor: { value: TimeFmt.fromStore('2026-09-04 12:00:00'), bootstrapped: true },
        });
      },
    });
    const result = Runner.execute(watcher, env.options);

    T.assertEquals(result.ok, true);
    T.assertEquals(env.sheets.counts.write, 1, 'snapshots は setValues 1回');
    const cursor = env.state.getCursor('test_watcher');
    T.assertEquals(TimeFmt.toStore(cursor.value), '2026-09-04 12:00:00');
    T.assertEquals(cursor.bootstrapped, true);
  });

  T.test('カーソルを返さないサイクルは前進しない', function () {
    // ページ上限で打ち切ったときなど。ウォッチャー側が「進めない」と表明できる
    const env = newEnv();
    const watcher = testWatcher({
      execute: function () { return Events.result({ ok: true }); },
    });
    Runner.execute(watcher, env.options);
    T.assertEquals(env.state.getCursor('test_watcher'), null);
  });

  T.test('⚠️ ロックが取れなければ何もせず抜ける', function () {
    const env = newEnv({ lockAcquired: false });
    let ran = false;
    const watcher = testWatcher({ execute: function () { ran = true; return Events.result({}); } });
    const result = Runner.execute(watcher, env.options);

    T.assertEquals(result.skipped, 'lock_busy');
    T.assertEquals(ran, false, 'ロックが取れていないのに実行された');
    T.assertEquals(env.sheets.counts.read, 0, 'シートを読んでいる');
    T.assertEquals(env.sheets.counts.write, 0);
    T.assertEquals(Object.keys(env.props._dump()).length, 0, 'プロパティを触っている');
  });

  T.test('連続失敗が閾値に達したら自動停止する', function () {
    const env = newEnv();
    for (let i = 0; i < Runner.MAX_CONSECUTIVE_FAILURES; i++) {
      env.state.recordFailure('test_watcher');
    }
    let ran = false;
    const watcher = testWatcher({ execute: function () { ran = true; return Events.result({}); } });
    const result = Runner.execute(watcher, env.options);

    T.assertEquals(result.skipped, 'auto_stopped');
    T.assertEquals(ran, false, '壊れたまま回り続けて API 予算を食い潰す');
  });

  T.test('成功すると失敗カウンタが戻る', function () {
    const env = newEnv();
    env.state.recordFailure('test_watcher');
    const watcher = testWatcher({
      execute: function (ctx) {
        return Events.result({ ok: true, cursor: { value: ctx.startedAt } });
      },
    });
    Runner.execute(watcher, env.options);
    T.assertEquals(env.state.getFailureCount('test_watcher'), 0);
  });

  T.test('ウォッチャーの例外は Runner の外に出ない', function () {
    const env = newEnv();
    const watcher = testWatcher({ execute: function () { throw new Error('boom'); } });
    const result = Runner.execute(watcher, env.options);
    T.assertEquals(result.ok, false);
    T.assert(String(result.error).indexOf('boom') >= 0);
  });

  T.test('⚠️ 通知後にコミットできなくても、次サイクルで二重通知しない', function () {
    // 通知は送れたがコミット前に落ちた、という最も危ないケース。
    // notified への追記は済んでいるので、再処理されても冪等除去される
    const env = newEnv();
    const sent = [];
    function watcherThatNotifies(crash) {
      return testWatcher({
        execute: function (ctx) {
          if (ctx.state.claimNotification('test_watcher', '18', 'item_changed', 'h1')) {
            sent.push('18');
          }
          if (crash) throw new Error('crashed after notifying');
          return Events.result({ ok: true, eventsNotified: 1, cursor: { value: ctx.startedAt } });
        },
      });
    }
    Runner.execute(watcherThatNotifies(true), env.options);
    T.assertEquals(sent.length, 1);
    T.assertEquals(env.state.getCursor('test_watcher'), null, 'カーソルが進んでいる');

    // 次のトリガー実行（State を作り直す）
    const next = newEnv({ props: env.props, sheets: env.sheets });
    Runner.execute(watcherThatNotifies(false), next.options);
    T.assertEquals(sent.length, 1, '⚠️ 二重通知が起きている');
  });

  // --- ダミーウォッチャーで一連の流れ ---------------------------------------

  T.test('ダミーウォッチャーが基準づくり → 検知 → 冪等除去まで通る', function () {
    const props = T.fakeProperties();
    const sheets = T.fakeSheets();

    // 1. 基準づくり。通知しない
    const first = newEnv({ props: props, sheets: sheets });
    const bootstrapResult = Runner.execute(
      DummyWatcher.create({ enabled: true, budgetPerCycle: 10, marker: 'A' }),
      { state: first.state, lock: first.lock, bootstrap: true });
    T.assertEquals(bootstrapResult.eventsNotified, 0, 'ブートストラップで通知してはいけない');
    T.assertEquals(sheets.dataRowCount(Sheets.NAMES.NOTIFIED), 0);
    T.assert(first.state.getCursor('dummy') !== null, 'カーソルが記録されていない');

    // 2. 値が変わったサイクル。2件検知して2件通知する
    const second = newEnv({ props: props, sheets: sheets });
    const changedResult = Runner.execute(
      DummyWatcher.create({ enabled: true, budgetPerCycle: 10, marker: 'B' }),
      { state: second.state, lock: second.lock });
    T.assertEquals(changedResult.eventsDetected, 2);
    T.assertEquals(changedResult.eventsNotified, 2);
    T.assertEquals(sheets.dataRowCount(Sheets.NAMES.NOTIFIED), 2);

    // 3. 同じ値のまま回しても何も出ない（snapshots が進んでいる）
    const third = newEnv({ props: props, sheets: sheets });
    const quietResult = Runner.execute(
      DummyWatcher.create({ enabled: true, budgetPerCycle: 10, marker: 'B' }),
      { state: third.state, lock: third.lock });
    T.assertEquals(quietResult.eventsDetected, 0);
    T.assertEquals(quietResult.eventsNotified, 0);
  });

  return T.run('state');
}

/** Phase1〜Phase3 のテストをまとめて走らせる。 */
function runAllTests() {
  const core = runCoreTests();
  const state = runStateTests();
  const watchers = runWatcherTests();
  const summary = {
    total: core.total + state.total + watchers.total,
    failed: core.failed + state.failed + watchers.failed,
  };
  Log.info('all_tests_passed', summary);
  return summary;
}

/** テスト用の State。**本番のプロパティとシートを触らない。** */
function newState(options) {
  const opts = options || {};
  return State.create({
    props: opts.props || T.fakeProperties(),
    sheets: opts.sheets || T.fakeSheets(),
  });
}

/** Runner のテスト用の一式（プロパティ・シート・ロック・State）。 */
function newEnv(options) {
  const opts = options || {};
  const props = opts.props || T.fakeProperties();
  const sheets = opts.sheets || T.fakeSheets();
  const state = State.create({ props: props, sheets: sheets });
  const lock = T.fakeLock(opts.lockAcquired !== false);
  return {
    props: props,
    sheets: sheets,
    state: state,
    lock: lock,
    options: { state: state, lock: lock },
  };
}

/** CP を叩かないテスト用ウォッチャー。 */
function testWatcher(handlers, config) {
  const cfg = config || {};
  return Watchers.define('test_watcher', {
    enabled: true,
    budgetPerCycle: cfg.budgetPerCycle || 10,
  }, handlers);
}
