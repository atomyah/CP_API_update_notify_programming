/**
 * グローバルなトークンバケットと流量メトリクス。
 *
 * **このアプリで唯一絶対に守る不変条件: CP への HTTP リクエストは必ずここを通る**
 * （rules/20-rate-limit.md）。
 *
 * CP の上限は 240 req/分。超えると API サービスを停止される可能性があり、
 * 性能ではなく可用性の問題として扱う。既定は上限の 25%（60 req/分）。
 *
 * トークンが無ければ **待つ。捨てない・スキップしない。**
 *
 * ⚠️ Python 版との唯一の本質的な違い
 * -----------------------------------
 * Python は常駐プロセスなのでバケットがメモリ上にあった。
 * **GAS はトリガー実行ごとに状態が消えるため、永続化しないと
 * トリガーの本数だけ流量が増える**（3本なら合計 180 req/分）。
 * そこで残トークンと最終補充時刻をスクリプトプロパティに保存し、実行をまたいで引き継ぐ。
 *
 * 実行の同時性については Phase2 で LockService により1つに制限する。
 * それまでは「同時に走らせない」ことが前提。
 */
const RateLimit = (function () {

  /**
   * トークンバケット。
   * props / now / sleep は差し替え可能にしてある（テストのため。本番では既定のまま）。
   */
  class Bucket {
    constructor(options) {
      const opts = options || {};
      if (!(opts.tokensPerSecond > 0)) throw Errors.config('tokensPerSecond must be positive');
      if (!(opts.capacity >= 1)) throw Errors.config('capacity must be >= 1');
      this._rate = opts.tokensPerSecond;
      this._capacity = opts.capacity;
      this._key = opts.stateProperty;
      this._props = opts.props || PropertiesService.getScriptProperties();
      this._now = opts.now || function () { return Date.now(); };
      this._sleep = opts.sleep || function (ms) { Utilities.sleep(ms); };
    }

    /** トークンを取得する。取れるまで待ち、待った秒数を返す。 */
    acquire(tokens) {
      const need = tokens || 1;
      if (need > this._capacity) {
        // 容量を超える要求は永久に満たされない。設定不備として即座に止める
        throw Errors.config('requested tokens exceed bucket capacity');
      }
      let waited = 0;
      for (;;) {
        const state = this._load();
        const now = this._now();
        const elapsedSeconds = Math.max(0, (now - state.lastMs) / 1000);
        const filled = Math.min(this._capacity, state.tokens + elapsedSeconds * this._rate);

        if (filled >= need) {
          this._save({ tokens: filled - need, lastMs: now });
          return waited;
        }

        // 足りない分が貯まるまで待つ。補充済みぶんは先に保存しておき、
        // 待っている間に別の実行が消費しても整合が崩れないようにする
        this._save({ tokens: filled, lastMs: now });
        const sleepMs = Math.ceil(((need - filled) / this._rate) * 1000);
        this._sleep(sleepMs);
        waited += sleepMs / 1000;
      }
    }

    /** 現在の残トークン（消費しない）。 */
    available() {
      const state = this._load();
      const elapsedSeconds = Math.max(0, (this._now() - state.lastMs) / 1000);
      return Math.min(this._capacity, state.tokens + elapsedSeconds * this._rate);
    }

    /** 満タンに戻す。テストと、運用で明示的にリセットしたいときだけ使う。 */
    reset() {
      this._save({ tokens: this._capacity, lastMs: this._now() });
    }

    _load() {
      const raw = this._props.getProperty(this._key);
      if (!raw) return { tokens: this._capacity, lastMs: this._now() };
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.tokens !== 'number' || typeof parsed.lastMs !== 'number') {
          throw new Error('malformed');
        }
        return parsed;
      } catch (e) {
        // 壊れていたら満タンから作り直す。ここで例外を投げると全機能が止まる
        Log.warn('rate_bucket_state_reset', { reason: 'unreadable' });
        return { tokens: this._capacity, lastMs: this._now() };
      }
    }

    _save(state) {
      this._props.setProperty(this._key, JSON.stringify(state));
    }
  }

  /**
   * 1分あたりの実リクエスト数を記録する（rules/20-rate-limit.md）。
   * GAS は実行が独立するため、これは**1回の実行の中だけ**の集計。
   * 実行をまたぐ累積は Phase5（メトリクス）で扱う。
   */
  class Metrics {
    constructor(limitPerMinute, warnRatio) {
      this.limitPerMinute = limitPerMinute;
      this.warnRatio = warnRatio || 0.8;
      this.total = 0;
      this.byWatcher = {};
      this.byEndpoint = {};
      this._timestamps = [];
    }

    record(watcherId, endpoint) {
      this.total += 1;
      this.byWatcher[watcherId] = (this.byWatcher[watcherId] || 0) + 1;
      this.byEndpoint[endpoint] = (this.byEndpoint[endpoint] || 0) + 1;
      this._timestamps.push(Date.now());
    }

    /** 直近 windowSeconds 秒の実測レート（req/分）。 */
    ratePerMinute(windowSeconds) {
      const w = windowSeconds || 60;
      const cutoff = Date.now() - w * 1000;
      const count = this._timestamps.filter(function (t) { return t >= cutoff; }).length;
      return (count * 60) / w;
    }

    /** 上限の warnRatio を超えていれば true。実行が短いので継続時間では判定しない。 */
    isOverusing() {
      return this.ratePerMinute(60) >= this.limitPerMinute * this.warnRatio;
    }

    summary() {
      return { total: this.total, by_watcher: this.byWatcher, by_endpoint: this.byEndpoint };
    }
  }

  let defaultBucket = null;

  function bucket() {
    if (!defaultBucket) {
      defaultBucket = new Bucket({
        tokensPerSecond: Config.rateLimit.tokensPerSecond,
        capacity: Config.rateLimit.bucketCapacity,
        stateProperty: Config.rateLimit.stateProperty,
      });
    }
    return defaultBucket;
  }

  return {
    Bucket: Bucket,
    Metrics: Metrics,
    /** 既定のバケット。**アプリ全体でこれ1つだけを使う。** */
    acquire: function (tokens) { return bucket().acquire(tokens); },
    available: function () { return bucket().available(); },
    reset: function () { bucket().reset(); },
  };
})();
