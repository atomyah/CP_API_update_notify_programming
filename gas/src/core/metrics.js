/**
 * 日次メトリクス（仕様書 8.6節）。
 *
 * 「設計との乖離を検出する」ためのもの。**通知の正しさには関与しない。**
 * よって**ここでの失敗はサイクルを落とさない**（記録できなくても業務は続く）。
 *
 * ⚠️ Python 版との違い
 * --------------------
 * Python 版は常駐プロセスで、`core/ratelimit.py` のメトリクスがプロセスの寿命ぶん
 * 累積していた。**GAS はトリガー実行ごとに独立したプロセスで、実行をまたいで
 * メモリを保持できない**（仕様書 11.1節）。`core/ratelimit.js` の `Metrics` は
 * 「1回の実行の中」しか見えないため、**実行をまたぐ累積はここで PropertiesService に置く。**
 *
 * | 置き場所 | 内容 |
 * |---|---|
 * | `metrics:YYYY-MM-DD` | その日の集計（ウォッチャー別・エンドポイント別・汎用カウンタ） |
 * | `metrics:days` | 保持している日付の一覧。**古い日を消すために持つ**（`getKeys()` に依存しない） |
 *
 * **`snapshots` と違い1日ぶんは数百バイト**なので PropertiesService に収まる
 * （1値あたり約9KB・1ストア約500KB の上限。仕様書 11.2節）。
 * 既定で7日ぶん（`Config.monitoring.metricsKeepDays`）だけ残し、古い日は消す。
 */
const Metrics = (function () {

  const KEY_PREFIX = 'metrics:';
  const INDEX_KEY = 'metrics:days';

  /**
   * ⚠️ `CpClient.metrics()` は**1回の実行の中で累積し続ける。**
   * 同じ実行で2つのウォッチャーを回すと2回目に前の値を二重計上するため、
   * 前回記録した時点との差分だけを足す。**モジュール変数の寿命 = 1回の実行。**
   */
  let lastTotal = 0;
  let lastByEndpoint = {};

  function emptyWatcher() {
    return { cycles: 0, requests: 0, detected: 0, notified: 0,
             failed: 0, exhausted: 0, skipped: 0 };
  }

  function emptyDay(date) {
    return { date: date, watchers: {}, endpoints: {}, counters: {},
             peak_rate_per_minute: 0, updated_at: null };
  }

  class DailyMetrics {
    /** @param options { props } — テストのために差し替える。本番では既定のまま */
    constructor(options) {
      const opts = options || {};
      this._props = opts.props || PropertiesService.getScriptProperties();
      this._keepDays = opts.keepDays || Config.monitoring.metricsKeepDays;
    }

    /**
     * 1サイクルの結果を今日ぶんに足す。**例外を投げない。**
     *
     * メトリクスの記録に失敗しても通知とカーソルには影響させない
     * （記録できないことより、記録のために業務が止まる方が有害）。
     *
     * @param clientMetrics `CpClient.metrics()`。省略時は実リクエスト数を数えない
     */
    recordCycle(watcherId, result, clientMetrics) {
      try {
        const date = TimeFmt.today();
        const day = this.read(date) || emptyDay(date);
        const w = day.watchers[watcherId] || emptyWatcher();

        w.cycles += 1;
        w.detected += result.eventsDetected || 0;
        w.notified += result.eventsNotified || 0;
        if (!result.ok) w.failed += 1;
        if (result.exhausted) w.exhausted += 1;
        if (result.skipped) w.skipped += 1;

        if (clientMetrics) {
          const delta = this._delta(clientMetrics);
          w.requests += delta.total;
          Object.keys(delta.byEndpoint).forEach(function (endpoint) {
            day.endpoints[endpoint] = (day.endpoints[endpoint] || 0) + delta.byEndpoint[endpoint];
          });
          const rate = clientMetrics.ratePerMinute(60);
          if (rate > day.peak_rate_per_minute) {
            day.peak_rate_per_minute = Math.round(rate * 10) / 10;
          }
        }

        day.watchers[watcherId] = w;
        this._write(date, day);
      } catch (e) {
        Log.warn('metrics_not_recorded', {
          watcher_id: watcherId, error: e.name + ': ' + e.message,
        });
      }
    }

    /**
     * 汎用カウンタを足す。**例外を投げない。**
     *
     * 「宛先未設定でメールを送れなかった件数」（要件4・仕様書 3.3.6 / 9.3節）のように、
     * 日次でまとめて報告したいものをここに入れる。**日次サマリは 0 でない
     * カウンタを自動で列挙する**ので、足す側はこれを呼ぶだけでよい。
     */
    count(name, delta) {
      try {
        const date = TimeFmt.today();
        const day = this.read(date) || emptyDay(date);
        day.counters[name] = (day.counters[name] || 0) + (delta === undefined ? 1 : delta);
        this._write(date, day);
      } catch (e) {
        Log.warn('metrics_not_recorded', { counter: name, error: e.name + ': ' + e.message });
      }
    }

    /** その日の集計。無ければ null。 */
    read(date) {
      const raw = this._props.getProperty(KEY_PREFIX + date);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch (e) {
        // 壊れていても業務は続ける。次の書き込みで作り直される
        Log.warn('metrics_unreadable', { date: date });
        return null;
      }
    }

    /** 保持している日付（古い順）。 */
    days() {
      const raw = this._props.getProperty(INDEX_KEY);
      if (!raw) return [];
      try {
        return JSON.parse(raw);
      } catch (e) {
        return [];
      }
    }

    /** テストと、明示的に消したいときだけ使う。 */
    clear() {
      const self = this;
      this.days().forEach(function (date) {
        self._props.deleteProperty(KEY_PREFIX + date);
      });
      this._props.deleteProperty(INDEX_KEY);
    }

    _write(date, day) {
      day.updated_at = TimeFmt.nowStore();
      this._props.setProperty(KEY_PREFIX + date, JSON.stringify(day));
      this._touchIndex(date);
    }

    /** 日付の索引を更新し、保持期間を超えた日を消す。 */
    _touchIndex(date) {
      const days = this.days();
      if (days.indexOf(date) >= 0) return;
      days.push(date);
      days.sort();
      const self = this;
      while (days.length > this._keepDays) {
        self._props.deleteProperty(KEY_PREFIX + days.shift());
      }
      this._props.setProperty(INDEX_KEY, JSON.stringify(days));
    }

    _delta(clientMetrics) {
      const summary = clientMetrics.summary();
      const byEndpoint = {};
      Object.keys(summary.by_endpoint).forEach(function (endpoint) {
        const delta = summary.by_endpoint[endpoint] - (lastByEndpoint[endpoint] || 0);
        if (delta > 0) byEndpoint[endpoint] = delta;
      });
      const total = Math.max(0, summary.total - lastTotal);
      lastTotal = summary.total;
      lastByEndpoint = summary.by_endpoint;
      return { total: total, byEndpoint: byEndpoint };
    }
  }

  /**
   * 日次サマリに出す材料を集める（仕様書 8.6 / 9.3節）。**CP は叩かない。**
   *
   * @param options { state, metrics, date, watchers }
   *   watchers は `[{ id, intervalMinutes }]`。メトリクスに現れないウォッチャー
   *   （1度も動いていない = **これ自体が異常**）も行として出すために渡す
   * @return 送信用の素材。整形は notifiers/ops.js
   */
  function report(options) {
    const opts = options || {};
    const state = opts.state;
    const metrics = opts.metrics;
    const date = opts.date || TimeFmt.today();
    const day = metrics.read(date) || emptyDay(date);
    const now = TimeFmt.now();
    const lagLimit = Config.monitoring.cursorLagWarnMinutes;

    const ids = {};
    (opts.watchers || []).forEach(function (w) { ids[w.id] = w; });
    Object.keys(day.watchers).forEach(function (id) {
      if (!ids[id]) ids[id] = { id: id, intervalMinutes: null };
    });

    let requestsTotal = 0;
    const watchers = Object.keys(ids).sort().map(function (id) {
      const counts = day.watchers[id] || emptyWatcher();
      requestsTotal += counts.requests;
      const cursor = state.getCursor(id);
      const lagMinutes = cursor
        ? Math.round((now.getTime() - cursor.value.getTime()) / 60000) : null;
      const failures = state.getFailureCount(id);
      return {
        id: id,
        cycles: counts.cycles,
        requests: counts.requests,
        detected: counts.detected,
        notified: counts.notified,
        failed: counts.failed,
        exhausted: counts.exhausted,
        skipped: counts.skipped,
        cursor: cursor ? TimeFmt.toStore(cursor.value) : null,
        bootstrapped: cursor ? cursor.bootstrapped : false,
        lagMinutes: lagMinutes,
        // **カーソルの遅れが単調増加していたら最も危険なシグナル**（仕様書 8.6節）
        stale: lagMinutes !== null && lagMinutes > lagLimit,
        consecutiveFailures: failures,
        autoStopped: failures >= Runner.MAX_CONSECUTIVE_FAILURES,
      };
    });

    const counters = {};
    Object.keys(day.counters).forEach(function (name) {
      if (day.counters[name]) counters[name] = day.counters[name];
    });

    return {
      date: date,
      watchers: watchers,
      endpoints: day.endpoints,
      counters: counters,
      requestsTotal: requestsTotal,
      requestBudget: Config.monitoring.dailyRequestBudget,
      peakRatePerMinute: day.peak_rate_per_minute,
      rateLimitPerMinute: Config.rateLimit.limitPerMinute,
      deadLetterRows: state.sheetRowCount(Sheets.NAMES.DEAD_LETTER),
      notifiedRows: state.sheetRowCount(Sheets.NAMES.NOTIFIED),
      // 1つでも該当があれば「異常あり」。件名に出す
      hasProblem: watchers.some(function (w) {
        return w.autoStopped || w.stale || w.failed > 0;
      }),
    };
  }

  function create(options) {
    return new DailyMetrics(options);
  }

  /** テスト用。実行をまたぐ差分計算の状態を戻す。 */
  function resetExecutionState() {
    lastTotal = 0;
    lastByEndpoint = {};
  }

  return {
    KEY_PREFIX: KEY_PREFIX,
    INDEX_KEY: INDEX_KEY,
    DailyMetrics: DailyMetrics,
    create: create,
    report: report,
    resetExecutionState: resetExecutionState,
  };
})();
