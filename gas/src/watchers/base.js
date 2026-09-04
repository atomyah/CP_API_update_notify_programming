/**
 * ウォッチャーの契約（Python 版 `app/watchers/base.py` の移植）。
 *
 * - `watchers/` 同士は参照し合わない。共有したいものは `core/` に上げる（rules/50-code-style.md）。
 * - **run() は例外を外に出さない。**捕捉してログに残し、失敗を戻り値（CycleResult）で返す。
 * - **ウォッチャーはカーソルを書かない。**進めたいカーソルを CycleResult に載せて返し、
 *   実際に書くのは Runner。コミット点を1箇所に閉じるため（仕様書 11.4）。
 *
 * ctx に入っているもの（Phase2 時点）:
 *
 * | キー | 中身 |
 * |---|---|
 * | `watcherId` | ウォッチャーID |
 * | `state` | 状態管理（core/state.js） |
 * | `snapshots` | このウォッチャーの SnapshotSet。**書き戻しは Runner が行う** |
 * | `cursor` | 実行開始時のカーソル。無ければ null |
 * | `budget` | 1サイクルのリクエスト予算（件数と経過時間の両方で切れる） |
 * | `bootstrap` | 基準づくりだけを行うか。**true のとき通知しない** |
 * | `config` | ウォッチャー個別の設定 |
 *
 * CP クライアント・schema・マスタ・通知は Phase3 で足す。
 */
const Watchers = (function () {

  const DEFAULTS = {
    enabled: false,
    intervalMinutes: 15,
    priority: 100,
    budgetPerCycle: 60,
    // オーバーラップ幅の既定は60秒（rules/30-state-and-idempotency.md）。
    // 取りこぼし（通知漏れ）は重複通知より重い
    overlapSeconds: 60,
  };

  /**
   * ウォッチャーを1つ定義する。
   *
   * @param watcherId 一意なID。カーソル・スナップショット・冪等キーの名前空間になる
   * @param config    ウォッチャー個別の設定
   * @param handlers  { execute(ctx), bootstrap(ctx), validate(ctx), requiredMasters(), channelKeys() }
   */
  function define(watcherId, config, handlers) {
    const cfg = config || {};
    const h = handlers || {};
    if (typeof h.execute !== 'function') {
      throw Errors.config('watcher ' + watcherId + ' must implement execute(ctx)');
    }
    return {
      id: watcherId,
      config: cfg,
      enabled: cfg.enabled === undefined ? DEFAULTS.enabled : !!cfg.enabled,
      intervalMinutes: cfg.intervalMinutes || DEFAULTS.intervalMinutes,
      priority: cfg.priority === undefined ? DEFAULTS.priority : cfg.priority,
      budgetPerCycle: cfg.budgetPerCycle || DEFAULTS.budgetPerCycle,
      overlapSeconds: cfg.overlapSeconds === undefined
        ? DEFAULTS.overlapSeconds : cfg.overlapSeconds,
      execute: h.execute,
      bootstrap: h.bootstrap || null,
      validate: h.validate || function () {},
      requiredMasters: h.requiredMasters || function () { return []; },
      channelKeys: h.channelKeys || function () { return []; },
    };
  }

  /**
   * 1サイクルを実行する。**例外を外に出さない**（rules/50-code-style.md）。
   *
   * - 予算切れ・時間切れ（BudgetExhausted）は異常ではない。`exhausted` を返し、
   *   Runner がカーソルも snapshots も進めないことで次サイクルに持ち越す。
   * - それ以外の例外は失敗として返す。1つのウォッチャーの失敗が他を巻き込まない。
   */
  function run(watcher, ctx) {
    CpClient.setCurrentWatcher(watcher.id);
    try {
      if (ctx.bootstrap && !watcher.bootstrap) {
        throw Errors.config('watcher ' + watcher.id + ' does not support bootstrap');
      }
      const result = ctx.bootstrap ? watcher.bootstrap(ctx) : watcher.execute(ctx);
      if (!result) {
        throw Errors.config('watcher ' + watcher.id + ' returned no CycleResult');
      }
      result.requestsUsed = ctx.budget.used;
      return result;
    } catch (e) {
      if (Errors.is(e, Errors.KIND.BUDGET)) {
        Log.info('cycle_exhausted', {
          watcher_id: watcher.id,
          requests_used: ctx.budget.used,
          elapsed_seconds: Math.round(ctx.budget.elapsedSeconds),
        });
        return Events.exhausted({ requestsUsed: ctx.budget.used });
      }
      Log.error('cycle_crashed', {
        watcher_id: watcher.id,
        error: e.name + ': ' + e.message,
        request_id: e.requestId || null,
      });
      return Events.failed(e.name + ': ' + e.message, { requestsUsed: ctx.budget.used });
    } finally {
      CpClient.setCurrentWatcher('-');
    }
  }

  /**
   * 検索の下限時刻。**前回サイクルの開始時刻からオーバーラップ幅を引く**
   * （rules/30-state-and-idempotency.md）。
   * カーソルが無いときは null を返す。呼び出し側でブートストラップ未了として扱うこと。
   */
  function since(watcher, ctx) {
    if (!ctx.cursor) return null;
    return TimeFmt.shiftSeconds(ctx.cursor.value, -watcher.overlapSeconds);
  }

  return { DEFAULTS: DEFAULTS, define: define, run: run, since: since };
})();
