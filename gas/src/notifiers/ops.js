/**
 * 運用通知（ops チャンネル）。
 *
 * 業務の通知（要件1〜3）とは別で、**アプリが壊れたことに人が気づくため**のもの。
 * Python 版は常駐プロセスのログと `--check` で足りていたが、
 * **GAS はトリガーが黙って止まる**（日次実行時間の上限・例外の連続・手で消した等）ので、
 * 止まったことを Slack で知らせる経路が要る（仕様書 8.6節）。
 *
 * ここも通常の通知と同じ経路（`notifiers/dispatcher.js`）を通す。
 * **冪等キーが効くので、同じ状態が続いても同じ通知は1回しか出ない。**
 * 自動停止の警告が5分ごとに鳴り続けることはない。
 *
 * **文言はすべて templates.js に置く**（rules/50-code-style.md）。
 */
const Ops = (function () {

  const WATCHER_ID = 'ops';

  /**
   * ウォッチャーが連続失敗で自動停止したことを知らせる。
   *
   * **呼ぶのは「停止した瞬間」の1回だけ**（core/runner.js の commit）。
   * 停止中は5分ごとに実行がスキップされるが、そこでは呼ばない。呼ぶと鳴り続ける。
   *
   * 冪等キーに**通算の停止回数**を含める（`State.recordStop()`）。
   * 内容だけ（ウォッチャー + 失敗回数）で作ると、復旧して再び停止したときに
   * 前回と同じキーになり、2度目の停止が通知されない。
   * 時刻ではなく回数を使うのは、秒の粒度に依存しないため。
   */
  function watcherStopped(dispatcher, watcherId, failures, stopCount) {
    return send(dispatcher, 'ops_watcher_stopped', {
      watcher_id: watcherId,
      failures: failures,
      stop_count: stopCount,
    }, {
      resourceId: watcherId,
      eventType: 'watcher_stopped',
      digest: State.payloadHash([watcherId, failures, stopCount]),
    });
  }

  /**
   * 日次サマリ（仕様書 9.3節）。`Metrics.report()` の結果を1通に畳む。
   *
   * 冪等キーは**中身から取る。**同じ内容なら再送しない（手で2回叩いても1通）が、
   * 件数が動いていれば新しい1通が出る。
   */
  function dailySummary(dispatcher, report) {
    const template = Templates.get('ops_daily_summary');
    const lines = report.watchers.map(function (w) {
      return Templates.renderField(template, 'watcher_line', {
        watcher_id: w.id,
        cycles: w.cycles,
        detected: w.detected,
        notified: w.notified,
        requests: w.requests,
        failed: w.failed,
        exhausted: w.exhausted,
      });
    });

    const problems = [];
    report.watchers.forEach(function (w) {
      if (w.autoStopped) {
        problems.push(Templates.renderField(template, 'stopped_line',
          { watcher_id: w.id, failures: w.consecutiveFailures }));
      }
      if (w.stale) {
        problems.push(Templates.renderField(template, 'stale_line', {
          watcher_id: w.id,
          lag_minutes: w.lagMinutes === null ? '?' : w.lagMinutes,
          cursor: w.cursor || '-',
        }));
      }
      if (!w.bootstrapped) {
        problems.push(Templates.renderField(template, 'no_baseline_line',
          { watcher_id: w.id }));
      }
    });
    if (report.deadLetterRows > 0) {
      problems.push(Templates.renderField(template, 'dead_letter_line',
        { rows: report.deadLetterRows }));
    }
    Object.keys(report.counters).sort().forEach(function (name) {
      problems.push(Templates.renderField(template, 'counter_line',
        { name: name, count: report.counters[name] }));
    });

    const fields = {
      date: report.date,
      status: Templates.render(
        report.hasProblem || problems.length
          ? Templates.LABELS.STATUS_PROBLEM : Templates.LABELS.STATUS_OK, {}),
      watcher_lines: lines.join('\n'),
      problem_lines: problems.length
        ? problems.join('\n') : Templates.render(Templates.LABELS.NO_PROBLEM, {}),
      requests_total: report.requestsTotal,
      request_budget: report.requestBudget,
      request_ratio: report.requestBudget
        ? Math.round((report.requestsTotal / report.requestBudget) * 1000) / 10 : 0,
      peak_rate: report.peakRatePerMinute,
      rate_limit: report.rateLimitPerMinute,
      dead_letter_rows: report.deadLetterRows,
      notified_rows: report.notifiedRows,
    };

    return send(dispatcher, 'ops_daily_summary', fields, {
      resourceId: report.date,
      eventType: 'daily_summary',
      digest: State.payloadHash([
        report.date, report.requestsTotal, report.deadLetterRows,
        report.watchers.map(function (w) {
          return [w.id, w.cycles, w.detected, w.notified, w.failed, w.stale];
        }),
      ]),
    });
  }

  function send(dispatcher, templateName, fields, key) {
    const template = Templates.get(templateName);
    if (!template) throw Errors.config('template "' + templateName + '" not found');
    return dispatcher.dispatchOne(Events.notification({
      watcherId: WATCHER_ID,
      resourceId: key.resourceId,
      eventType: key.eventType,
      digest: key.digest,
      channelKey: Config.slack.opsChannelKey,
      subject: Templates.renderField(template, 'subject', fields, ''),
      body: Templates.renderField(template, 'body', fields),
      meta: { kind: key.eventType },
    }));
  }

  return {
    WATCHER_ID: WATCHER_ID,
    watcherStopped: watcherStopped,
    dailySummary: dailySummary,
  };
})();
