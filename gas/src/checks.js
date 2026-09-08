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
 * 要件4のメール送信の前提を確かめる（to-do/Phase6.md の「着手前に確認すること」）。
 * **CP を叩かない。メールも送らない。**
 *
 * 見るもの:
 *
 * - 管理者アドレス（`MAIL_ADMIN_ADDRESS`）が設定されているか。
 *   **ドライランの寄せ先**なので、これが無いと `runCareerActionDryRun()` は動かない
 * - **1日あたりの送信残量。**`MailApp.getRemainingDailyQuota()` の実測値。
 *   仕様書 11.7節（推測で埋めない）に対する答えがここで取れる
 * - 送信元エイリアス（`MAIL_FROM_ADDRESS`）の指定有無
 *
 * ⚠️ **アドレスそのものはログに出さない**（rules/40-secrets-and-security.md）。
 * 設定されているかどうかだけを出す。
 */
function checkMail() {
  const notifier = MailNotifier.create();
  const props = PropertiesService.getScriptProperties();
  const summary = {
    admin_address_set: !!notifier.adminAddress(),
    admin_address_property: Config.mail.adminAddressProperty,
    from_alias_set: !!props.getProperty(Config.mail.fromAddressProperty),
    sender_name: Config.mail.senderName,
    channel_keys: Config.mail.channelKeys,
    // **実測値。**組織のポリシーで送信そのものが止められている場合は
    // ここが 0 になるか、getRemainingDailyQuota が例外になる
    remaining_daily_quota: notifier.remainingQuota(),
  };
  Log.info('mail_check', summary);
  if (!summary.admin_address_set) {
    Log.warn('mail_admin_address_missing', {
      property: Config.mail.adminAddressProperty,
      hint: 'Project Settings > Script Properties. Dry runs refuse to run without it',
    });
  }
  return summary;
}

/**
 * テストメールを1通送る。**手で1回だけ実行する。トリガーには登録しない。**
 *
 * `MailApp` が組織のポリシーで止められていないかを確かめる唯一の方法
 * （to-do/Phase6.md の確認項目1）。
 *
 * @param to 宛先。**省略時は `MAIL_ADMIN_ADDRESS`。**
 *           ⚠️ 他人のアドレスを指定しないこと。確認は自分宛てで足りる
 */
function sendTestMail(to) {
  const notifier = MailNotifier.create();
  const address = to || notifier.adminAddress();
  if (!MailNotifier.isValidAddress(address)) {
    throw Errors.config(
      'no valid address. Set script property "' + Config.mail.adminAddressProperty +
      '" or pass one to sendTestMail("you@example.com")');
  }
  const before = notifier.remainingQuota();
  notifier.send(Events.notification({
    watcherId: 'check',
    resourceId: 'test',
    eventType: 'test_mail',
    digest: 'test',
    channelKey: Config.mail.channelKeys[0],
    subject: '[CP] テスト送信',
    body: [
      'CP進捗通知（要件4）のテスト送信です。',
      '',
      'この1通が届いていれば、MailApp からの送信が組織のポリシーで',
      '止められていないことが確認できます。',
      '',
      '送信時刻: ' + TimeFmt.nowStore(),
    ].join('\n'),
    to: address,
  }));
  const summary = { remaining_before: before, remaining_after: notifier.remainingQuota() };
  Log.info('test_mail_sent', summary);
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
