/**
 * 検索のページングを1箇所にまとめる。
 * Python 版 `app/core/paging.py` の移植。
 *
 * ウォッチャー同士は参照し合わない。共有したいものは core/ に上げる
 * （rules/50-code-style.md）。
 *
 * 守るべき点は3つ:
 *
 * 1. limit は常に 100。小さくするとページ数＝リクエスト数が増える
 *    （rules/20-rate-limit.md）。
 * 2. sort を必ず指定する。未指定だと並び順が保証されずページングが壊れる。
 * 3. **ページ数に上限を設ける。**深い offset はタイムアウトの可能性があると
 *    原典に明記されている。打ち切ったら呼び出し側は
 *    **カーソルを前進させてはいけない。**
 */
const Paging = (function () {

  /**
   * 条件に一致する ID を集める。
   *
   * @param options { condition, sort, budget, watcherId, maxPages }
   * @return { ids, capped }。**capped が true なら全件を見きれていない。**
   *         呼び出し側はカーソルを進めず、次サイクルで続きを拾う
   */
  function searchIds(resource, options) {
    const opts = options || {};
    const maxPages = opts.maxPages || Config.limits.maxPagesPerCycle;
    const ids = [];
    let offset = 0;

    for (let page = 0; page < maxPages; page++) {
      const result = CpClient.search(resource, {
        condition: opts.condition,
        sort: opts.sort,
        limit: CpClient.MAX_LIMIT,
        offset: offset,
        budget: opts.budget,
      });
      result.ids.forEach(function (id) { ids.push(id); });
      offset += result.ids.length;
      if (!result.ids.length || result.ids.length < CpClient.MAX_LIMIT ||
          offset >= result.count) {
        return { ids: ids, capped: false };
      }
    }

    Log.warn('paging_capped', {
      watcher_id: opts.watcherId || '-', resource: resource,
      max_pages: maxPages, collected: ids.length,
    });
    return { ids: ids, capped: true };
  }

  return { searchIds: searchIds };
})();
