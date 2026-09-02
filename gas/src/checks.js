/**
 * 起動時チェック（Python 版の `py -3 -m app.main --check` に相当）。
 *
 * **CP に書き込まない。**読み取りだけで、疎通・権限・項目 ID の実在を確認する。
 * 失敗したら例外を投げる。黙って続けない（rules/00-scope-and-phase.md）。
 *
 * 使い方: Apps Script エディタで `checkSetup` を選んで実行する。
 */
function checkSetup() {
  const started = Date.now();
  CpClient.setCurrentWatcher('check');

  // 1. APIキー（スクリプトプロパティ）
  if (!Auth.hasApiKey()) {
    throw Errors.config(
      'script property "' + Config.cpApi.apiKeyProperty + '" is not set. ' +
      'Set it from the Apps Script editor: Project Settings > Script Properties');
  }
  Log.info('api_key_found', { property: Config.cpApi.apiKeyProperty });

  // 2. 疎通（トークン取得）。失敗したらここで止まる
  Auth.clear();
  Auth.getToken();
  Log.info('auth_ok', { base_url: Config.cpApi.baseUrl });

  // 3. schema の取得。**実環境の schema を正とする**（rules/10-cp-api.md）
  const cfg = Config.careerStatus;
  const budget = Budget.unlimited('check');
  const schema = CpClient.getSchema(cfg.resource, budget);
  const items = {};
  schema.forEach(function (entry) {
    if (entry.itemId) items[entry.itemId] = entry;
  });
  const total = Object.keys(items).length;

  // 4. 設定に書かれた項目 ID が実在するか。無ければ**起動を失敗させる**
  const required = [cfg.updateDateItem, cfg.knownCustomItem]
    .concat(cfg.identityItems).concat(cfg.excludeItems);
  const missing = required.filter(function (id) { return !items[id]; });
  if (missing.length) {
    throw Errors.config(
      'unknown itemIds for resource "' + cfg.resource + '": ' + missing.join(', ') +
      '. The live schema is authoritative; check core/config.js');
  }

  // 5. 監視対象の件数。仕様書の想定は 229 件（232 − 除外3）
  const watched = Object.keys(items).filter(function (id) {
    if (cfg.excludeItems.indexOf(id) >= 0) return false;
    return !cfg.excludeSuffixes.some(function (suffix) {
      return id.length >= suffix.length && id.slice(-suffix.length) === suffix;
    });
  });

  // 6. オリつく項目の一覧。新しく追加されたときに気づける
  const customPattern = /^[A-Z_]+#\d+$/;
  const customs = Object.keys(items).filter(function (id) {
    return customPattern.test(id);
  }).sort();

  const summary = {
    resource: cfg.resource,
    schema_item_count: total,
    watched_item_count: watched.length,
    custom_items: customs,
    requests_used: CpClient.metrics().total,
    rate_bucket_available: Math.round(RateLimit.available() * 10) / 10,
    elapsed_seconds: Math.round((Date.now() - started) / 100) / 10,
  };
  Log.info('check_ok', summary);

  // 想定と件数がずれたら黙って通さない。schema が変わった可能性がある
  if (watched.length !== 229) {
    Log.warn('watched_item_count_differs_from_spec', {
      expected: 229, actual: watched.length,
      note: 'update docs and core/config.js if the schema really changed',
    });
  }
  return summary;
}

/**
 * トークンバケットの現在値を見る。CP は叩かない。
 * 流量がおかしいと感じたときの確認用。
 */
function showRateBucket() {
  const available = RateLimit.available();
  Log.info('rate_bucket', {
    available: Math.round(available * 100) / 100,
    capacity: Config.rateLimit.bucketCapacity,
    tokens_per_second: Config.rateLimit.tokensPerSecond,
  });
  return available;
}
