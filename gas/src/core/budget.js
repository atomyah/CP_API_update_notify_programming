/**
 * 1サイクルあたりのリクエスト予算。
 *
 * 各ウォッチャーは1サイクルで消費してよいリクエスト数を持ち、使い切ったら処理を打ち切って
 * 進捗を保存し、次サイクルに持ち越す。
 * **打ち切ったサイクルではカーソルを前進させない**（rules/20-rate-limit.md）。
 *
 * GAS では**経過時間でも打ち切る**（1回の実行は最長6分。仕様書 11.6）。
 * 時間切れも予算切れと同じ扱いにして、呼び出し側の分岐を増やさない。
 */
const Budget = (function () {

  class RequestBudget {
    /**
     * @param limit 消費してよいリクエスト数
     * @param watcherId ログ用
     * @param maxRuntimeSeconds これを超えたら残予算があっても打ち切る
     */
    constructor(limit, watcherId, maxRuntimeSeconds) {
      this.limit = limit;
      this.watcherId = watcherId || '-';
      this.used = 0;
      this.startedAt = Date.now();
      // 0 を渡せるよう undefined だけを既定値に落とす（|| だと 0 が既定値に化ける）
      this.maxRuntimeSeconds = maxRuntimeSeconds === undefined
        ? Config.execution.maxRuntimeSeconds : maxRuntimeSeconds;
    }

    get remaining() {
      return Math.max(0, this.limit - this.used);
    }

    get elapsedSeconds() {
      return (Date.now() - this.startedAt) / 1000;
    }

    get exhausted() {
      return this.used >= this.limit || this.elapsedSeconds >= this.maxRuntimeSeconds;
    }

    /** **リトライも消費する。**「リトライだから」と迂回させない。 */
    consume(n) {
      const count = n || 1;
      if (this.elapsedSeconds >= this.maxRuntimeSeconds) {
        throw Errors.budgetExhausted(
          'watcher=' + this.watcherId + ' reason=time elapsed=' +
          Math.round(this.elapsedSeconds) + 's');
      }
      if (this.used + count > this.limit) {
        throw Errors.budgetExhausted(
          'watcher=' + this.watcherId + ' budget=' + this.limit + ' used=' + this.used);
      }
      this.used += count;
    }

    /** 予算を消費せずに余力だけ確認する。ループの継続判定に使う。 */
    canAfford(n) {
      const count = n || 1;
      return this.used + count <= this.limit &&
             this.elapsedSeconds < this.maxRuntimeSeconds;
    }
  }

  /** 起動時チェックやブートストラップ用。件数では止めない（時間では止まる）。 */
  function unlimited(watcherId) {
    return new RequestBudget(1e9, watcherId || '-');
  }

  return { RequestBudget: RequestBudget, unlimited: unlimited };
})();
