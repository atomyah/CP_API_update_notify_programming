/**
 * コードマスタの取得・キャッシュ・ラベル変換。
 * Python 版 `app/core/master.py` の移植。
 *
 * `selectone` / `select` / `search` 型の値はコード値であり、そのまま通知に出すと
 * 意味が読めない（rules/10-cp-api.md）。
 *
 * どのマスタを参照するかは **schema の validationRule.codeName から取れる**ので、
 * 設定に手書きしない（core/schema.js）。
 *
 * ⚠️ キャッシュの寿命は core/schema.js と同じ理由で「1回の実行の中だけ」。
 * 全項目監視では参照しうるマスタが多いため、**先読みせず参照時に取得する。**
 * 1サイクルで実際に引くのは「変化した項目のマスタ」だけなので、通常は数リクエスト。
 */
const Master = (function () {

  const CACHE_TTL_SECONDS = 24 * 60 * 60;

  // CP は selectone の「未設定」をコード 0 で表す。マスタには載っていない
  // （実測: CAREER#CHARGE_ID = 0 は担当者なし / MSTPREF に 0 は無い）
  const UNSET_CODES = ['0'];

  // codeName -> { atMs, labels }
  let cache = {};

  function get(codeName, budget) {
    const cached = cache[codeName];
    if (cached && Date.now() - cached.atMs < CACHE_TTL_SECONDS * 1000) {
      return cached.labels;
    }
    const labels = CpClient.getMaster(codeName, budget);
    cache[codeName] = { atMs: Date.now(), labels: labels };
    Log.info('master_loaded', {
      code_name: codeName, value_count: Object.keys(labels).length,
    });
    return labels;
  }

  function preload(codeNames, budget) {
    const seen = {};
    codeNames.forEach(function (name) {
      if (!name || seen[name]) return;
      seen[name] = true;
      get(name, budget);
    });
  }

  /**
   * コード値を通知用のラベルにする。解決の順序:
   *
   * 1. 空・null → (未設定)
   * 2. 配列 → 要素ごとに解決して " / " で連結
   * 3. 参照マスタが無い項目（text 等）→ 値をそのまま
   * 4. マスタに載っているコード → ラベル
   * 5. **マスタに無い 0** → (未設定)。CP は selectone の未設定を 0 で表す
   * 6. それ以外 → **値をそのまま出す。**CAREER#ZIP_ID（郵便番号）のように
   *    codeName を持ちながらマスタが列挙を返さない項目がある。この値は
   *    「コード」ではなくデータなので、注釈を付けずにそのまま見せる。
   *    解決できなかった事実はログにのみ残す（値は出さない）
   */
  function label(codeName, value, budget) {
    if (value === null || value === undefined || value === '') {
      return Templates.LABELS.UNSET;
    }
    if (Array.isArray(value)) {
      if (!value.length) return Templates.LABELS.UNSET;
      return value.map(function (v) { return label(codeName, v, budget); }).join(' / ');
    }
    if (!codeName) return String(value);

    const labels = get(codeName, budget);
    const key = String(value);
    if (Object.prototype.hasOwnProperty.call(labels, key)) return labels[key];
    if (UNSET_CODES.indexOf(key) >= 0) return Templates.LABELS.UNSET;

    // 値そのものは個人情報になりうるのでログに出さない
    Log.debug('master_code_unresolved', {
      code_name: codeName, master_size: Object.keys(labels).length,
    });
    return key;
  }

  /** テストと、明示的に取り直したいときだけ使う。 */
  function clearCache() {
    cache = {};
  }

  return {
    CACHE_TTL_SECONDS: CACHE_TTL_SECONDS,
    UNSET_CODES: UNSET_CODES,
    get: get,
    preload: preload,
    label: label,
    clearCache: clearCache,
  };
})();
