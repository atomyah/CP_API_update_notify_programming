/**
 * 手動実行・トリガーから呼ぶ入口。
 *
 * **Phase3 では手動実行だけ。**時間主導トリガーの本設定は Phase5。
 * Apps Script エディタで関数を選んで実行する。
 * **⚠️ エディタでコードを直接編集しない。**clasp push が唯一の反映経路。
 *
 * 実行の順序（初回）:
 *
 * ```
 * 1. initSheets()              シートを作る（setup.js）
 * 2. checkSetup()              疎通・権限・項目IDの検証（checks.js）
 * 3. checkCareerStatus()       要件1の設定が実環境と合っているか
 * 4. bootstrapCareerStatus()   ⚠️ 基準づくり。通知は出ない。完了するまで繰り返す
 * 5. runCareerStatusDryRun()   1サイクル。通知はドライラン用チャンネルへ寄る
 * 6. runCareerStatus()         1サイクル。本来のチャンネルへ送る
 * ```
 *
 * **4 を飛ばして 5・6 を実行しない。**前回値が無い状態では全求職者が
 * 「変化した」と判定される（rules/30-state-and-idempotency.md）。
 * 飛ばした場合は ConfigError で止まるようにしてある。
 */

/** 要件1を1サイクル実行する。**本来のチャンネルへ送る。** */
function runCareerStatus() {
  return Runner.execute(CareerStatusWatcher.create());
}

/**
 * 要件1を1サイクル実行し、**通知をドライラン用チャンネル（ops）へ寄せる。**
 * 本番相当のデータで動かす前の確認用（rules/40-secrets-and-security.md）。
 */
function runCareerStatusDryRun() {
  return Runner.execute(CareerStatusWatcher.create(), { dryRun: true });
}

/**
 * 要件1の基準づくり。**通知しない。**
 *
 * 全求職者を1件ずつ取得するので、1回の実行（最長6分）で終わらないことがある。
 * **ログの `bootstrap_paused` が出たら、`bootstrap_done` になるまで繰り返し実行する。**
 * 途中まででコミットされているので、実行するたびに続きから進む。
 */
function bootstrapCareerStatus() {
  const config = { budgetPerCycle: Config.careerStatus.bootstrapBudgetPerCycle };
  const result = Runner.execute(CareerStatusWatcher.create(config), { bootstrap: true });
  const cursor = State.create().getCursor(CareerStatusWatcher.WATCHER_ID);
  Log.info('bootstrap_state', {
    watcher_id: CareerStatusWatcher.WATCHER_ID,
    bootstrapped: cursor ? cursor.bootstrapped : false,
    page_offset: cursor ? cursor.pageOffset : null,
    hint: cursor && cursor.bootstrapped
      ? 'baseline is ready; runCareerStatus() will now notify'
      : 'run bootstrapCareerStatus() again to continue',
  });
  return result;
}

/**
 * 要件1の設定が実環境と合っているかを確かめる。**CP を読むだけ。通知しない。**
 *
 * - 監視項目が schema に実在するか（実環境の schema が正）
 * - テンプレートと通知チャンネルが解決できるか
 */
function checkCareerStatus() {
  const watcher = CareerStatusWatcher.create();
  const state = State.create();
  return watcher.validate({
    config: watcher.config,
    budget: Budget.unlimited(watcher.id),
    schema: Schema,
    master: Master,
    templates: Templates,
    dispatcher: Dispatcher.create({ state: state }),
  });
}

/**
 * Slack の Webhook がどのチャンネルぶん設定されているかを見る。
 * **URL は出さない**（rules/40-secrets-and-security.md）。
 */
function showSlackChannels() {
  const configured = SlackNotifier.create().configuredChannels();
  Log.info('slack_channels', {
    configured: configured,
    missing: Object.keys(Config.slack.webhookProperties).filter(function (key) {
      return configured.indexOf(key) < 0;
    }),
    hint: 'set the missing ones in Project Settings > Script Properties',
  });
  return configured;
}
