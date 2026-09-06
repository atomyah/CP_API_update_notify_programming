/**
 * 1サイクルの実行（Python 版 `app/core/scheduler.py` の GAS 版）。
 *
 * Python は常駐プロセスで、毎秒ポーリングして期限の来たウォッチャーを逐次に回していた。
 * **GAS にメインループは無い。**時間主導トリガーが1ウォッチャーぶんの1サイクルを呼ぶ
 * （仕様書 11.6）。トリガーの登録は Phase5。
 *
 * ここが持つ責務は5つ:
 *
 * 1. **排他** — LockService。取れなければ即座に抜ける（待たない）。
 * 2. **予算** — 件数と経過時間の両方で打ち切る（6分制限）。
 * 3. **コミット点** — カーソルの書き込みを1サイクル最後の単一操作にする（仕様書 11.4）。
 * 4. **連続失敗カウンタ** — 閾値を超えたら自動停止し、**ops チャンネルへ1回だけ警告する。**
 *    壊れたまま回り続けて API 予算を食い潰す方が有害（rules/30）。
 *    GAS はトリガーが黙って止まるので、ログだけでは誰も気づかない（Phase5）。
 * 5. **メトリクス** — 実行をまたぐ集計を残す（core/metrics.js・仕様書 8.6）。
 *    **ここでの失敗はサイクルを落とさない。**
 *
 * ```
 * 差分判定 → notified 追記 → 通知 → snapshots 書き戻し → カーソルを1回書く
 *                                                          ↑ ここがコミット点
 * ```
 *
 * ⚠️ 仕様書 11.4 の並びとは snapshots と通知の前後が逆になっている。**意図的。**
 * GAS では snapshots をメモリ上で溜めて setValues 1回で書くので（11.3）、
 * 書き戻しをコミット直前に寄せた方が「snapshots だけが進む」窓が狭い。
 * 通知の直前に notified を追記する順序（7.3 / 11.5）は変えていないため、
 * コミット前に落ちても二重通知は起きない（次サイクルで冪等除去される）。
 */
const Runner = (function () {

  // これを超えたら自動停止する（Python 版 scheduler.MAX_CONSECUTIVE_FAILURES と同じ）
  const MAX_CONSECUTIVE_FAILURES = 5;

  /**
   * ウォッチャーを1サイクルだけ実行する。**例外を投げない。**
   *
   * @param watcher  Watchers.define() で作ったもの
   * @param options  { state, lock, props, sheets, dispatcher, bootstrap, dryRun,
   *                   maxRuntimeSeconds }
   *                 state / lock / props / sheets / dispatcher はテストのために差し替えられる。
   *                 dryRun を立てると全通知がドライラン用チャンネルへ寄る（rules/40）
   * @return CycleResult
   */
  function execute(watcher, options) {
    const opts = options || {};
    const watcherId = watcher.id;
    const state = opts.state || State.create({ props: opts.props, sheets: opts.sheets });
    const lock = opts.lock || LockService.getScriptLock();

    // **待たない。**前回の実行が終わっていなければ、このトリガーは何もせず抜ける。
    // 待つとトリガーの実行時間を食うだけで、次のトリガーが同じ仕事をする
    if (!lock.tryLock(0)) {
      Log.warn('lock_busy', { watcher_id: watcherId, hint: 'previous execution is still running' });
      return Events.skipped('lock_busy');
    }

    const startedMs = Date.now();
    const dispatcher = opts.dispatcher ||
      Dispatcher.create({ state: state, dryRun: !!opts.dryRun });
    const metrics = opts.metrics || Metrics.create({ props: state.properties() });

    try {
      const failures = state.getFailureCount(watcherId);
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        Log.error('watcher_auto_stopped', {
          watcher_id: watcherId,
          consecutive_failures: failures,
          hint: 'fix the cause, then clear the failure counter; the cursor was not advanced',
        });
        // ⚠️ ここでは ops へ送らない。停止中は5分ごとにこの経路を通るため、
        // 送ると同じ警告が鳴り続ける。**警告は停止した瞬間に1回だけ**（commit）。
        // 止まったままであることは日次サマリが報告する（notifiers/ops.js）
        const skipped = Events.skipped('auto_stopped');
        metrics.recordCycle(watcherId, skipped, CpClient.metrics());
        return skipped;
      }

      const budget = new Budget.RequestBudget(
        watcher.budgetPerCycle, watcherId, opts.maxRuntimeSeconds);

      const ctx = {
        watcherId: watcherId,
        state: state,
        snapshots: state.snapshots(watcherId),
        // 遷移前後を通知する項目の生値。書き戻しは snapshots と同じコミット点
        rawValues: state.rawValues(watcherId),
        cursor: state.getCursor(watcherId),
        budget: budget,
        bootstrap: !!opts.bootstrap,
        config: watcher.config || {},
        schema: Schema,
        master: Master,
        // ID → 表示名。**キャッシュは1回の実行の中だけ**（core/resolver.js）
        resolver: opts.resolver || Resolver,
        templates: Templates,
        dispatcher: dispatcher,
        // 日次サマリ用の汎用カウンタ（宛先未設定の件数など）を足せるようにする
        metrics: metrics,
        // サイクルの開始時刻。カーソルにはこれを入れる（終了時刻を入れると、
        // 走査中に変更されたレコードが次サイクルの検索から漏れる）
        startedAt: TimeFmt.now(),
      };

      const result = Watchers.run(watcher, ctx);
      commit(state, watcherId, result, dispatcher);

      // 実行をまたぐ集計。**ここで失敗してもサイクルは落とさない**（core/metrics.js）
      metrics.recordCycle(watcherId, result, CpClient.metrics());

      // 「何件取得して何件通知したか」を1行で出す（rules/50-code-style.md）
      const fields = Events.logFields(result);
      fields.watcher_id = watcherId;
      fields.duration_seconds = Math.round((Date.now() - startedMs) / 100) / 10;
      Log.info('cycle_done', fields);
      return result;
    } finally {
      lock.releaseLock();
    }
  }

  /**
   * 自動停止を ops チャンネルへ知らせる。**通知の失敗でサイクルを落とさない。**
   * Slack が死んでいるときに、そのせいで業務側の処理まで止まるのは筋が悪い。
   */
  function alertStopped(dispatcher, watcherId, failures, stopCount) {
    try {
      Ops.watcherStopped(dispatcher, watcherId, failures, stopCount);
    } catch (e) {
      Log.error('ops_alert_failed', {
        watcher_id: watcherId, error: e.name + ': ' + e.message,
      });
    }
  }

  /**
   * コミット。**ここだけがカーソルを書く。**
   *
   * - 失敗 → 何も書かない。失敗カウンタだけ進める
   * - 予算切れ・時間切れ → **カーソルも snapshots も書かない。**次サイクルで再処理する
   * - 成功 → snapshots を書き戻し、最後にカーソルを1回書く
   */
  function commit(state, watcherId, result, dispatcher) {
    if (result.skipped) return;

    if (!result.ok) {
      // ⚠️ snapshots を書き戻さない。snapshots だけが進むと差分を取りこぼす（通知漏れ）
      const failures = state.recordFailure(watcherId);
      Log.error('cycle_failed', {
        watcher_id: watcherId,
        error: result.error,
        consecutive_failures: failures,
        committed: false,
      });
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        Log.error('watcher_auto_stopped', {
          watcher_id: watcherId,
          consecutive_failures: failures,
          hint: 'fix the cause, then clear the failure counter',
        });
        // **止まったことに人が気づけるようにする**（仕様書 8.6節）。
        // GAS はトリガーが黙って止まるので、ログだけでは誰も見ない。
        // **ここが「停止した瞬間」。**以降のトリガーは実行ごと飛ぶので鳴らない
        alertStopped(dispatcher, watcherId, failures, state.recordStop(watcherId));
      }
      return;
    }

    // 予算切れ・時間切れは異常ではないので失敗カウンタは戻す。
    // ただし**進めない。**取りこぼしを避けるため、次サイクルで同じ範囲をやり直す
    if (result.exhausted || !result.cursor) {
      state.clearFailures(watcherId);
      Log.info('cycle_not_committed', {
        watcher_id: watcherId,
        reason: result.exhausted ? 'exhausted' : 'no_cursor',
        events_notified: result.eventsNotified,
      });
      return;
    }

    const flushed = state.flushSnapshots();
    state.clearFailures(watcherId);
    // ⚠️ これを最後の単一操作にする。ここより後ろに書き込みを足さないこと
    state.setCursor(watcherId, result.cursor);
    Log.info('cycle_committed', {
      watcher_id: watcherId,
      cursor: TimeFmt.toStore(result.cursor.value),
      page_offset: result.cursor.pageOffset || 0,
      snapshot_sheets_written: flushed,
    });
  }

  return {
    MAX_CONSECUTIVE_FAILURES: MAX_CONSECUTIVE_FAILURES,
    execute: execute,
  };
})();
