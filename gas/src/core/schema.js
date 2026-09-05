/**
 * リソース定義（schema）の取得・キャッシュ・項目 ID の検証。
 * Python 版 `app/core/schema.py` の移植。
 *
 * **項目一覧 xlsx ではなく実環境の schema を正とする**（rules/10-cp-api.md）。
 * 両者に乖離があることは実測で確認済み（docs/design/07-verification-results.md 1章）。
 *
 * 用途は3つ:
 * 1. 設定に書かれた項目 ID の実在検証 → 無ければ**起動を失敗させる**
 * 2. 項目タイプの取得（値の正規化・通知本文の整形に使う）
 * 3. オリつく項目の発見
 *
 * ⚠️ キャッシュの寿命が Python 版と違う（GAS の制約）
 * -----------------------------------------------------
 * rules/10-cp-api.md は「24時間キャッシュ」としているが、**GAS はトリガー実行ごとに
 * 独立したプロセスで、実行をまたいでメモリを保持できない。**よってここでのキャッシュは
 * **1回の実行の中だけ**有効で、実行のたびに1リクエストを使って取り直す。
 *
 * 追加コストは1実行あたり1リクエスト（要件1は15分間隔なので約96 req/日）で、
 * 想定流量 5,000 req/日（仕様書 8.1）に対して十分小さい。
 * CacheService（最長6時間）へ載せる案もあるが、CP から取得したデータを
 * アプリの外へ保存することになるため Phase3 では採らない（仕様書 11.8）。
 */
const Schema = (function () {

  // 実行をまたげないため実質は「この実行の間」。値の意味は Python 版と同じ
  const CACHE_TTL_SECONDS = 24 * 60 * 60;

  // オリつく項目の itemId は `{PREFIX}#{数値}`（実測）。標準項目は英字の記号名
  const CUSTOM_ITEM_PATTERN = /^[A-Z_]+#\d+$/;

  // resource -> { atMs, items }
  let cache = {};

  /**
   * リソースの項目定義。**itemId をキーにしたオブジェクト**を返す。
   * 値は `{ itemId, label, itemType, isReadOnly, isSortable, codeName, isCustom }`。
   */
  function get(resource, budget) {
    const cached = cache[resource];
    if (cached && Date.now() - cached.atMs < CACHE_TTL_SECONDS * 1000) {
      return cached.items;
    }

    const raw = CpClient.getSchema(resource, budget);
    const items = {};
    raw.forEach(function (entry) {
      const itemId = entry.itemId;
      if (!itemId) return;
      // 参照マスタ名は validationRule.codeName に入っている（実測 2026-08-07）。
      // これが取れるので、監視項目ごとにマスタ名を設定へ手書きする必要はない
      const rule = entry.validationRule || {};
      items[itemId] = {
        itemId: itemId,
        label: entry.label || itemId,
        itemType: entry.itemType || '',
        isReadOnly: !!entry.isReadOnly,
        isSortable: !!entry.isSortable,
        codeName: rule.codeName || null,
        isCustom: isCustom(itemId),
      };
    });
    cache[resource] = { atMs: Date.now(), items: items };

    Log.info('schema_loaded', {
      resource: resource,
      item_count: Object.keys(items).length,
      custom_items: customItemIds(items),
    });
    return items;
  }

  /**
   * 設定に書かれた項目 ID が実在するか検証する。
   *
   * 存在しなければ ConfigError を投げて**起動を失敗させる**。
   * 黙って無視すると、通知が出ないことに気づけないまま運用が始まる。
   */
  function validate(resource, itemIds, budget) {
    const items = get(resource, budget);
    const missing = itemIds.filter(function (id) { return !items[id]; });
    if (missing.length) {
      throw Errors.config(
        'unknown itemIds for resource "' + resource + '": ' + missing.join(', ') +
        '. The live schema is authoritative; check core/config.js');
    }
  }

  function describe(resource, itemId, budget) {
    return get(resource, budget)[itemId] || null;
  }

  /** オリつく項目か。 */
  function isCustom(itemId) {
    return CUSTOM_ITEM_PATTERN.test(itemId);
  }

  /** オリつく項目の一覧。起動時にログへ出して、追加に気づけるようにする。 */
  function customItemIds(items) {
    return Object.keys(items).filter(function (id) {
      return items[id].isCustom;
    }).sort();
  }

  /** テストと、明示的に取り直したいときだけ使う。 */
  function clearCache() {
    cache = {};
  }

  return {
    CACHE_TTL_SECONDS: CACHE_TTL_SECONDS,
    get: get,
    validate: validate,
    describe: describe,
    isCustom: isCustom,
    customItemIds: customItemIds,
    clearCache: clearCache,
  };
})();
