/**
 * 求職者名・求人名・企業名の解決キャッシュ。
 * Python 版 `app/core/resolver.py` の移植（仕様書 5.3）。
 *
 * 通知本文には人が読める名前が要るが、`progress_history` / `progress` が持っているのは
 * ID だけなので、別リソースを `select` して名前に直す必要がある。
 * これらは**変化が遅い**ので TTL 付きの LRU でキャッシュする。
 *
 * **このキャッシュがリクエスト数に直結する。**要件2では進捗が動くたびに
 * 求職者・求人・企業の名前が要る。キャッシュが効かなければ通知1件あたり
 * 3リクエストが上乗せされ、効けば 0 になる。
 *
 * > ⚠️ **担当者メールアドレス（`CAREER#CHARGE_EMAIL`）をここでキャッシュしてはいけない。**
 * > 要件4の宛先であり、担当者変更の直後に旧担当へ送るのは実害がある（仕様書 5.3）。
 * > このモジュールは**設定に列挙された表示用の項目しか取得しない**ので、
 * > `Config.nameResolution` に宛先を足さない限り事故は起きない。
 *
 * ⚠️ キャッシュの寿命が Python 版と違う（GAS の制約）
 * -----------------------------------------------------
 * **GAS はトリガー実行ごとに独立したプロセスで、実行をまたいでメモリを保持できない**
 * （仕様書 11.1 / 11.8）。TTL（1〜6時間）を設定として残してあるが、
 * **実効の寿命は「1回の実行の中」**であり、次のトリガーでは必ず取り直しになる。
 *
 * 1サイクルで動く進捗はふつう数件なので、効くのは「同じ求職者・同じ求人が
 * 続けて動いたとき」と「同じ企業の求人が複数動いたとき」。
 * 想定は約3 req/サイクル・約860 req/日（仕様書 3.2.8）で、この前提で足りている。
 *
 * 項目 ID はコードに直書きせず `core/config.js` の `nameResolution` から受け取る
 * （rules/10-cp-api.md）。
 */
const Resolver = (function () {

  // kind -> { entries: { id: { name, fetchedAt } }, order: [id...] }
  let cache = {};
  let hits = 0;
  let misses = 0;

  function sourceOf(kind) {
    const sources = Config.nameResolution || {};
    return Object.prototype.hasOwnProperty.call(sources, kind) ? sources[kind] : null;
  }

  /**
   * `kind`（`career` / `order` / `client`）の ID を表示名にする。
   *
   * ID が未設定（`null` / `0` / 空）なら**1リクエストも使わずに** `(未設定)` を返す。
   * 解決に失敗しても**通知そのものは落とさない。**名前が出ないより
   * 「名前が引けなかった」と書いてでも通知が届く方が業務上の価値が高い。
   */
  function resolve(kind, resourceId, budget) {
    const source = sourceOf(kind);
    const key = normalizeId(resourceId);
    if (!source || key === null) return Templates.LABELS.UNSET;

    const cached = lookup(kind, key, source);
    if (cached !== null) {
      hits += 1;
      return cached;
    }
    misses += 1;

    let values;
    try {
      values = CpClient.select(source.resource, key, source.items, budget);
    } catch (e) {
      // 削除済みのレコードを参照している。通知は落とさず、その旨を本文に出す
      if (!Errors.is(e, Errors.KIND.NOT_FOUND)) throw e;
      Log.warn('name_unresolved', {
        resource: source.resource, resource_id: key, reason: 'not_found',
      });
      return Templates.render(Templates.LABELS.UNRESOLVED, {
        resource: source.resource, resource_id: key,
      });
    }

    const name = render(source, values) || (source.resource + ' ' + key);
    store(kind, key, name, source);
    return name;
  }

  /** 起動時に schema と突き合わせるための項目 ID。 */
  function itemIds(kind) {
    const source = sourceOf(kind);
    return source ? source.items.slice() : [];
  }

  function resourceOf(kind) {
    const source = sourceOf(kind);
    return source ? source.resource : null;
  }

  /**
   * 名前テンプレートが**設定に挙げた項目だけ**で埋まるかを確かめる。
   *
   * 通知の組み立て時に落ちると、そのイベントは dead letter にすら載らずに
   * 1サイクル丸ごと失敗する。設定不備は起動時に出す（rules/00-scope-and-phase.md）。
   */
  function validateTemplate(kind) {
    const source = sourceOf(kind);
    if (!source) return;
    const probe = {};
    source.items.forEach(function (itemId) { probe[itemId] = ''; });
    try {
      Templates.render(source.template, probe);
    } catch (e) {
      throw Errors.config(
        'nameResolution.' + kind + '.template uses a variable that is not in items: ' +
        e.message);
    }
  }

  /** キャッシュの効きをログに出すため。ヒット率が低いと流量が跳ねる。 */
  function stats() {
    let entries = 0;
    Object.keys(cache).forEach(function (kind) {
      entries += cache[kind].order.length;
    });
    return { name_cache_hits: hits, name_cache_misses: misses, name_cache_entries: entries };
  }

  /** テストと、明示的に取り直したいときだけ使う。 */
  function clearCache() {
    cache = {};
    hits = 0;
    misses = 0;
  }

  // --- 内部 ----------------------------------------------------------------

  function render(source, values) {
    // **設定に挙げた項目だけ**を差し込む。CP が値を返さなかった項目は空文字にする
    // （キーが無いまま render すると ConfigError で1サイクル落ちる）
    const fields = {};
    source.items.forEach(function (itemId) {
      const value = values[itemId];
      fields[itemId] = (value === null || value === undefined) ? '' : String(value);
    });
    return Templates.render(source.template, fields).trim();
  }

  function bucketOf(kind) {
    if (!cache[kind]) cache[kind] = { entries: {}, order: [] };
    return cache[kind];
  }

  /** 生きているエントリなら名前、無ければ null。期限切れはここで捨てる。 */
  function lookup(kind, key, source) {
    const bucket = bucketOf(kind);
    const entry = bucket.entries[key];
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt >= source.ttlSeconds * 1000) {
      drop(bucket, key);
      return null;
    }
    touch(bucket, key);
    return entry.name;
  }

  function store(kind, key, name, source) {
    const bucket = bucketOf(kind);
    bucket.entries[key] = { name: name, fetchedAt: Date.now() };
    touch(bucket, key);
    while (bucket.order.length > source.maxEntries) {
      drop(bucket, bucket.order[0]);   // 最も古く使われたものから捨てる
    }
  }

  function touch(bucket, key) {
    const at = bucket.order.indexOf(key);
    if (at >= 0) bucket.order.splice(at, 1);
    bucket.order.push(key);
  }

  function drop(bucket, key) {
    delete bucket.entries[key];
    const at = bucket.order.indexOf(key);
    if (at >= 0) bucket.order.splice(at, 1);
  }

  /**
   * CP の ID は number で返る（`18` / `18.0` / `"18"` を同じ ID として扱う）。
   * `null` / 空 / `0` は「未設定」。**CP は未設定の参照 ID を `0` で表す**（実測）。
   */
  function normalizeId(resourceId) {
    const normalized = State.canonicalValue(resourceId, 'selectone');
    return normalized === null ? null : String(normalized);
  }

  return {
    resolve: resolve,
    itemIds: itemIds,
    resourceOf: resourceOf,
    validateTemplate: validateTemplate,
    stats: stats,
    clearCache: clearCache,
    normalizeId: normalizeId,
  };
})();
