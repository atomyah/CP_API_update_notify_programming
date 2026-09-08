/**
 * Phase5（運用: トリガー・メトリクス・日次サマリ）のテスト。
 *
 * ここで潰すのは**自動運転にしたときに初めて起きる事故**:
 *
 *   - ⚠️ トリガーの二重登録。同じ関数が2本回ると**流量が倍**になる（rules/20）
 *   - ⚠️ 自動停止の警告が5分ごとに鳴り続ける（冪等キーで1回に抑える）
 *   - ⚠️ 通知が溢れたときに**溜めたぶんを既送信にしてしまう**（＝通知漏れ）
 *   - メトリクスの記録に失敗してサイクルが落ちる（記録は業務より優先されない）
 *   - 日次トリガーが渡すイベントオブジェクトを日付として使ってしまう
 *
 * 使い方: Apps Script エディタで `runOpsTests`（または `runAllTests`）を実行する。
 * **CP API・Slack・本番のシート・本番のプロパティ・本番のトリガーを一切触らない。**
 */

/** メトリクス付きのテスト環境。**本番のプロパティを触らない。** */
function newOpsEnv(options) {
  const env = newEnv(options);
  env.metrics = Metrics.create({ props: env.props });
  env.options.metrics = env.metrics;
  Metrics.resetExecutionState();
  return env;
}

/** `CpClient.metrics()` の代わり。実行の中で累積し続ける本物と同じ形。 */
function fakeClientMetrics(total, byEndpoint, rate) {
  return {
    summary: function () {
      return { total: total, by_watcher: {}, by_endpoint: byEndpoint || {} };
    },
    ratePerMinute: function () { return rate || 0; },
  };
}

function runOpsTests() {
  T.reset();

  // --- トリガー（setup.js） -------------------------------------------------

  /** 設定上 enabled になっているトリガーの関数名。**期待値を直書きしない。** */
  function enabledHandlers() {
    return Config.triggers.filter(function (entry) { return entry.enabled; })
      .map(function (entry) { return entry.handler; });
  }

  T.test('createTriggers は enabled のものだけ作る', function () {
    const scriptApp = T.fakeScriptApp();
    createTriggers({ scriptApp: scriptApp });
    const handlers = scriptApp.handlers();
    const expected = enabledHandlers();
    T.assertEquals(handlers.length, expected.length, '止めているトリガーまで作っている');
    expected.forEach(function (handler) {
      T.assert(handlers.indexOf(handler) >= 0, handler + ' のトリガーが無い');
    });
    // enabled: false のものは作らない（回っていることに気づかないまま流量が増える）
    Config.triggers.filter(function (entry) { return !entry.enabled; })
      .forEach(function (entry) {
        T.assertEquals(handlers.indexOf(entry.handler), -1,
          entry.handler + ' は止めているのに作られている');
      });
  });

  T.test('⚠️ createTriggers を2回実行してもトリガーが重複しない', function () {
    // 重複すると同じ関数が2本回り、**流量がその本数だけ倍になる**
    const scriptApp = T.fakeScriptApp();
    createTriggers({ scriptApp: scriptApp });
    createTriggers({ scriptApp: scriptApp });
    T.assertEquals(scriptApp.handlers().length, enabledHandlers().length,
                   'トリガーが増殖している');
  });

  T.test('間隔と時刻が設定どおりに渡る', function () {
    const scriptApp = T.fakeScriptApp();
    createTriggers({ scriptApp: scriptApp });
    const byHandler = {};
    scriptApp.getProjectTriggers().forEach(function (t) {
      byHandler[t.getHandlerFunction()] = t.spec;
    });
    // 要件2の許容遅延は5分（仕様書 3.2.8）
    T.assertEquals(byHandler.runProgressFlow.everyMinutes, 5);
    T.assertEquals(byHandler.runCareerStatus.everyMinutes, 15);
    // 要件4の許容遅延は15分（仕様書 3.3.10）
    T.assertEquals(byHandler.runCareerAction.everyMinutes, 15);
    T.assertEquals(byHandler.runDailySummary.days, 1);
    T.assertEquals(byHandler.runDailySummary.atHour, 7);
  });

  T.test('GAS が受け付けない分間隔は ConfigError', function () {
    // everyMinutes は 1 / 5 / 10 / 15 / 30 のみ。7 を書くと作成時に落ちる
    const scriptApp = T.fakeScriptApp();
    const saved = Config.triggers;
    Config.triggers = [{ handler: 'runProgressFlow', everyMinutes: 7, enabled: true }];
    try {
      T.assertThrows(Errors.KIND.CONFIG, function () {
        createTriggers({ scriptApp: scriptApp });
      });
    } finally { Config.triggers = saved; }
  });

  T.test('管理外のトリガーは消さない', function () {
    const scriptApp = T.fakeScriptApp();
    scriptApp.newTrigger('someoneElsesJob').timeBased().everyMinutes(30).create();
    createTriggers({ scriptApp: scriptApp });
    T.assert(scriptApp.handlers().indexOf('someoneElsesJob') >= 0,
             '他の用途のトリガーを消している');
    T.assertEquals(scriptApp.handlers().length, enabledHandlers().length + 1);
  });

  T.test('deleteTriggers は自分のぶんだけ消す', function () {
    const scriptApp = T.fakeScriptApp();
    scriptApp.newTrigger('someoneElsesJob').timeBased().everyMinutes(30).create();
    createTriggers({ scriptApp: scriptApp });
    const removed = deleteTriggers({ scriptApp: scriptApp });
    T.assertEquals(removed.length, enabledHandlers().length);
    T.assertEquals(scriptApp.handlers().length, 1);
  });

  T.test('showTriggers は重複を見つける', function () {
    // 画面から手で足したときに気づけるようにする
    const scriptApp = T.fakeScriptApp();
    createTriggers({ scriptApp: scriptApp });
    scriptApp.newTrigger('runProgressFlow').timeBased().everyMinutes(5).create();
    const counts = showTriggers({ scriptApp: scriptApp });
    T.assertEquals(counts.runProgressFlow, 2, '重複を数えられていない');
  });

  // --- メトリクス（core/metrics.js） ---------------------------------------

  T.test('サイクルの結果が日別に積み上がる', function () {
    const env = newOpsEnv();
    env.metrics.recordCycle('progress_flow',
      Events.result({ ok: true, eventsDetected: 2, eventsNotified: 1 }),
      fakeClientMetrics(11, { '/v1/ext2/progress_history/search': 1 }, 4));
    env.metrics.recordCycle('progress_flow',
      Events.result({ ok: true, eventsDetected: 1, eventsNotified: 1 }),
      fakeClientMetrics(13, { '/v1/ext2/progress_history/search': 2 }, 6));

    const day = env.metrics.read(TimeFmt.today());
    const w = day.watchers.progress_flow;
    T.assertEquals(w.cycles, 2);
    T.assertEquals(w.detected, 3);
    T.assertEquals(w.notified, 2);
    // ⚠️ CpClient.metrics() は実行の中で累積し続ける。差分だけを足す
    T.assertEquals(w.requests, 13, '累積値を二重計上している');
    T.assertEquals(day.endpoints['/v1/ext2/progress_history/search'], 2);
    T.assertEquals(day.peak_rate_per_minute, 6, 'ピークが更新されていない');
  });

  T.test('失敗・中断・スキップを数える', function () {
    const env = newOpsEnv();
    env.metrics.recordCycle('w1', Events.failed('boom'));
    env.metrics.recordCycle('w1', Events.exhausted({}));
    env.metrics.recordCycle('w1', Events.skipped('lock_busy'));
    const w = env.metrics.read(TimeFmt.today()).watchers.w1;
    T.assertEquals(w.failed, 1);
    T.assertEquals(w.exhausted, 1);
    T.assertEquals(w.skipped, 1);
    T.assertEquals(w.cycles, 3);
  });

  T.test('汎用カウンタが足せる（要件4の宛先未設定件数はここに乗る）', function () {
    const env = newOpsEnv();
    env.metrics.count('mail_skipped_no_address', 2);
    env.metrics.count('mail_skipped_no_address');
    T.assertEquals(env.metrics.read(TimeFmt.today()).counters.mail_skipped_no_address, 3);
  });

  T.test('保持期間を超えた日は消える', function () {
    const props = T.fakeProperties();
    const metrics = Metrics.create({ props: props, keepDays: 2 });
    ['2026-09-01', '2026-09-02', '2026-09-03'].forEach(function (date) {
      props.setProperty(Metrics.KEY_PREFIX + date, JSON.stringify({ date: date }));
      metrics._touchIndex(date);
    });
    T.assertEquals(metrics.days().length, 2);
    T.assertEquals(props.getProperty(Metrics.KEY_PREFIX + '2026-09-01'), null,
                   '古い日が消えていない（PropertiesService の上限に当たる）');
    T.assert(props.getProperty(Metrics.KEY_PREFIX + '2026-09-03') !== null);
  });

  T.test('⚠️ メトリクスの記録に失敗してもサイクルを落とさない', function () {
    // 記録できないことより、記録のために業務が止まる方が有害
    const broken = {
      getProperty: function () { return null; },
      setProperty: function () { throw new Error('quota exceeded'); },
      deleteProperty: function () {},
    };
    const metrics = Metrics.create({ props: broken });
    metrics.recordCycle('w1', Events.result({ ok: true }));   // 例外が漏れたら失敗
    metrics.count('x');
  });

  T.test('壊れた保存値からでも読み直せる', function () {
    const props = T.fakeProperties();
    props.setProperty(Metrics.KEY_PREFIX + TimeFmt.today(), '{壊れた');
    const metrics = Metrics.create({ props: props });
    T.assertEquals(metrics.read(TimeFmt.today()), null);
    metrics.recordCycle('w1', Events.result({ ok: true, eventsDetected: 1 }));
    T.assertEquals(metrics.read(TimeFmt.today()).watchers.w1.detected, 1);
  });

  T.test('Runner が1サイクルぶんを自動で記録する', function () {
    const env = newOpsEnv();
    const watcher = testWatcher({
      execute: function (ctx) {
        return Events.result({
          ok: true, eventsDetected: 1, eventsNotified: 1,
          cursor: { value: ctx.startedAt },
        });
      },
    });
    Runner.execute(watcher, env.options);
    const w = env.metrics.read(TimeFmt.today()).watchers.test_watcher;
    T.assertEquals(w.cycles, 1);
    T.assertEquals(w.notified, 1);
  });

  // --- 日次サマリの材料（Metrics.report） -----------------------------------

  T.test('⚠️ カーソルの遅れを検出する（止まったことに気づく唯一の手段）', function () {
    const env = newOpsEnv();
    env.state.setCursor('progress_flow', {
      value: TimeFmt.shiftSeconds(TimeFmt.now(), -3 * 3600),   // 3時間前
      bootstrapped: true,
    });
    env.state.setCursor('career_status', {
      value: TimeFmt.shiftSeconds(TimeFmt.now(), -60), bootstrapped: true,
    });
    const report = Metrics.report({
      state: env.state, metrics: env.metrics,
      watchers: [{ id: 'progress_flow' }, { id: 'career_status' }],
    });
    const stale = report.watchers.filter(function (w) { return w.stale; });
    T.assertEquals(stale.length, 1);
    T.assertEquals(stale[0].id, 'progress_flow');
    T.assert(stale[0].lagMinutes >= 179, '遅れが分で出ていない: ' + stale[0].lagMinutes);
    T.assertEquals(report.hasProblem, true);
  });

  T.test('自動停止・dead_letter・基準未了を拾う', function () {
    const env = newOpsEnv();
    for (let i = 0; i < Runner.MAX_CONSECUTIVE_FAILURES; i++) {
      env.state.recordFailure('career_status');
    }
    env.state.addDeadLetter('career_status', '{}', 'NotifyError: boom');
    const report = Metrics.report({
      state: env.state, metrics: env.metrics, watchers: [{ id: 'career_status' }],
    });
    T.assertEquals(report.watchers[0].autoStopped, true);
    T.assertEquals(report.watchers[0].bootstrapped, false, '基準未了を見落としている');
    T.assertEquals(report.deadLetterRows, 1);
    T.assertEquals(report.hasProblem, true);
  });

  T.test('問題が無ければ hasProblem は false', function () {
    const env = newOpsEnv();
    env.state.setCursor('progress_flow', { value: TimeFmt.now(), bootstrapped: true });
    env.metrics.recordCycle('progress_flow', Events.result({ ok: true }));
    const report = Metrics.report({
      state: env.state, metrics: env.metrics, watchers: [{ id: 'progress_flow' }],
    });
    T.assertEquals(report.hasProblem, false);
    T.assertEquals(report.watchers[0].cycles, 1);
  });

  T.test('メトリクスに現れないウォッチャーも行に出る（1度も動いていない）', function () {
    const env = newOpsEnv();
    const report = Metrics.report({
      state: env.state, metrics: env.metrics,
      watchers: [{ id: 'career_status' }, { id: 'progress_flow' }],
    });
    T.assertEquals(report.watchers.length, 2);
    T.assertEquals(report.watchers[0].cycles, 0);
  });

  // --- 日次サマリの送信（notifiers/ops.js） ---------------------------------

  T.test('日次サマリが ops へ1通届く', function () {
    const env = newOpsEnv();
    env.state.setCursor('progress_flow', { value: TimeFmt.now(), bootstrapped: true });
    env.metrics.recordCycle('progress_flow',
      Events.result({ ok: true, eventsDetected: 3, eventsNotified: 2 }),
      fakeClientMetrics(24, {}, 5));

    const report = Metrics.report({
      state: env.state, metrics: env.metrics, watchers: [{ id: 'progress_flow' }],
    });
    Ops.dailySummary(env.dispatcher, report);

    T.assertEquals(env.notifier.sent.length, 1);
    const sent = env.notifier.sent[0];
    T.assertEquals(sent.channelKey, 'ops');
    T.assert(sent.body.indexOf('実行 1 / 検知 3 / 通知 2 / リクエスト 24') >= 0, sent.body);
    T.assert(sent.body.indexOf('24 / 5000 件') >= 0, '流量の見積りと実測が出ていない');
    T.assert(sent.subject.indexOf('正常') >= 0, sent.subject);
  });

  T.test('要確認があれば件名と本文に出る', function () {
    const env = newOpsEnv();
    env.state.setCursor('career_status', {
      value: TimeFmt.shiftSeconds(TimeFmt.now(), -7200), bootstrapped: true,
    });
    env.state.addDeadLetter('career_status', '{}', 'boom');
    env.metrics.count('mail_skipped_no_address', 4);

    const report = Metrics.report({
      state: env.state, metrics: env.metrics, watchers: [{ id: 'career_status' }],
    });
    Ops.dailySummary(env.dispatcher, report);

    const sent = env.notifier.sent[0];
    T.assert(sent.subject.indexOf('要確認') >= 0, sent.subject);
    T.assert(sent.body.indexOf('カーソルが') >= 0, 'カーソルの遅れが本文に無い');
    T.assert(sent.body.indexOf('dead_letter が 1 件') >= 0, sent.body);
    T.assert(sent.body.indexOf('mail_skipped_no_address: 4 件') >= 0,
             '汎用カウンタが出ていない');
  });

  T.test('同じ内容の日次サマリは再送しない。中身が動けば送る', function () {
    const env = newOpsEnv();
    env.state.setCursor('progress_flow', { value: TimeFmt.now(), bootstrapped: true });
    const build = function () {
      return Metrics.report({
        state: env.state, metrics: env.metrics, watchers: [{ id: 'progress_flow' }],
      });
    };
    Ops.dailySummary(env.dispatcher, build());
    Ops.dailySummary(env.dispatcher, build());
    T.assertEquals(env.notifier.sent.length, 1, '同じ内容で2通出ている');

    env.metrics.recordCycle('progress_flow', Events.result({ ok: true, eventsNotified: 1 }));
    Ops.dailySummary(env.dispatcher, build());
    T.assertEquals(env.notifier.sent.length, 2, '中身が動いたのに出ていない');
  });

  // --- 自動停止の警告（Runner + Ops） --------------------------------------

  T.test('⚠️ 自動停止で ops へ警告が出る。**鳴り続けない**', function () {
    const env = newOpsEnv();
    const watcher = testWatcher({ execute: function () { throw new Error('boom'); } });

    // 5回失敗させる。5回目で自動停止に達する
    for (let i = 0; i < Runner.MAX_CONSECUTIVE_FAILURES; i++) {
      Runner.execute(watcher, env.options);
    }
    T.assertEquals(env.state.getFailureCount('test_watcher'),
                   Runner.MAX_CONSECUTIVE_FAILURES);
    T.assertEquals(env.notifier.sent.length, 1, '自動停止の警告が出ていない');
    T.assert(env.notifier.sent[0].body.indexOf('自動停止') >= 0,
             env.notifier.sent[0].body);

    // 以降のトリガーは実行そのものが飛ぶ。**同じ警告を鳴らし続けない**
    Runner.execute(watcher, env.options);
    Runner.execute(watcher, env.options);
    T.assertEquals(env.notifier.sent.length, 1, '⚠️ 5分ごとに警告が鳴っている');
  });

  T.test('復旧して再び停止すればまた警告が出る', function () {
    const env = newOpsEnv();
    const watcher = testWatcher({ execute: function () { throw new Error('boom'); } });
    for (let i = 0; i < Runner.MAX_CONSECUTIVE_FAILURES; i++) {
      Runner.execute(watcher, env.options);
    }
    T.assertEquals(env.notifier.sent.length, 1);

    // 原因を直して再開したが、また壊れた
    env.state.clearFailures('test_watcher');
    for (let i = 0; i < Runner.MAX_CONSECUTIVE_FAILURES; i++) {
      Runner.execute(watcher, env.options);
    }
    T.assertEquals(env.notifier.sent.length, 2, '2度目の停止が通知されていない');
  });

  T.test('ops への通知が失敗してもサイクルの扱いは変わらない', function () {
    const notifier = recordingNotifier(['ops']);
    notifier.failWith = 'slack down';
    const env = newOpsEnv({ notifier: notifier });
    const watcher = testWatcher({ execute: function () { throw new Error('boom'); } });
    for (let i = 0; i < Runner.MAX_CONSECUTIVE_FAILURES; i++) {
      Runner.execute(watcher, env.options);
    }
    // Slack が死んでいても、失敗カウンタとカーソルの扱いは変わらない
    T.assertEquals(env.state.getFailureCount('test_watcher'),
                   Runner.MAX_CONSECUTIVE_FAILURES);
    T.assertEquals(env.state.getCursor('test_watcher'), null);
  });

  // --- 通知の洪水（dispatcher） --------------------------------------------

  T.test('1サイクルの上限を超えたぶんはサマリ1通に畳まれる', function () {
    const env = newEnv();
    const dispatcher = Dispatcher.create({
      state: env.state, notifiers: [env.notifier], maxPerCycle: 2,
    });
    dispatcher.beginCycle();
    for (let i = 0; i < 5; i++) {
      dispatcher.dispatchOne(Events.notification({
        watcherId: 'career_status', resourceId: String(i), eventType: 'item_changed',
        digest: 'h' + i, channelKey: 'ops', body: 'b' + i,
      }));
    }
    const sent = dispatcher.endCycle();

    T.assertEquals(sent, 3, '2通 + サマリ1通のはず');
    T.assertEquals(env.notifier.sent.length, 3);
    const summary = env.notifier.sent[2];
    T.assertEquals(summary.resourceId, '__summary__');
    T.assert(summary.body.indexOf('5 件の変更が検出されました') >= 0, summary.body);
    T.assert(summary.body.indexOf('3 件は詳細を省略') >= 0, summary.body);
  });

  T.test('⚠️ 省略したぶんを既送信にしない（次サイクルで通知できる）', function () {
    // 予約してしまうと「送っていないのに送信済み」になり、二度と出なくなる
    const env = newEnv();
    const first = Dispatcher.create({
      state: env.state, notifiers: [env.notifier], maxPerCycle: 1,
    });
    first.beginCycle();
    for (let i = 0; i < 3; i++) {
      first.dispatchOne(Events.notification({
        watcherId: 'career_status', resourceId: String(i), eventType: 'item_changed',
        digest: 'h' + i, channelKey: 'ops', body: 'b' + i,
      }));
    }
    first.endCycle();

    // 次のサイクル（上限を上げた）。省略された 1 と 2 が送れるはず
    const second = Dispatcher.create({
      state: env.state, notifiers: [env.notifier], maxPerCycle: 50,
    });
    second.beginCycle();
    const resent = [1, 2].map(function (i) {
      return second.dispatchOne(Events.notification({
        watcherId: 'career_status', resourceId: String(i), eventType: 'item_changed',
        digest: 'h' + i, channelKey: 'ops', body: 'b' + i,
      }));
    });
    T.assertEquals(second.endCycle(), 2, '⚠️ 省略したぶんが通知漏れになっている');
    T.assertEquals(resent[0], true);
    T.assertEquals(resent[1], true);
  });

  T.test('上限内なら今までどおり全部送る', function () {
    const env = newEnv();
    const dispatcher = Dispatcher.create({ state: env.state, notifiers: [env.notifier] });
    dispatcher.beginCycle();
    for (let i = 0; i < 3; i++) {
      dispatcher.dispatchOne(Events.notification({
        watcherId: 'career_status', resourceId: String(i), eventType: 'item_changed',
        digest: 'h' + i, channelKey: 'ops', body: 'b' + i,
      }));
    }
    T.assertEquals(dispatcher.endCycle(), 3);
    T.assertEquals(env.notifier.sent.length, 3, 'サマリが混ざっている');
  });

  // --- 日付の決め方（triggers.js） -----------------------------------------

  T.test('⚠️ トリガーが渡すイベントオブジェクトを日付として使わない', function () {
    // 時間主導トリガーは第1引数にイベントオブジェクトを渡す。
    // これを日付として扱うと、存在しない日を集計して毎日空のサマリが出る
    const yesterday = TimeFmt.toStoreDate(TimeFmt.shiftDays(TimeFmt.now(), -1));
    T.assertEquals(summaryDate({ triggerUid: '123', 'day-of-month': 6 }, -1), yesterday);
    T.assertEquals(summaryDate(undefined, -1), yesterday);
    T.assertEquals(summaryDate('2026-09-01', -1), '2026-09-01', '明示した日付が無視された');
    T.assertEquals(summaryDate('きのう', -1), yesterday, '形式不正を日付として使っている');
  });

  return T.run('ops');
}
