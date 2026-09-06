/**
 * 手動実行・トリガーから呼ぶ入口。
 *
 * ここにあるのは実行する関数そのもの。Apps Script エディタで選んで手動実行するか、
 * **`createTriggers()`（setup.js）で時間主導トリガーに登録する。**
 * 構成は `core/config.js` の `triggers`（要件2/3: 5分 / 要件1: 15分 / 日次サマリ）。
 *
 * **⚠️ トリガーを画面から手で足さない。**同じ関数が二重に回り、流量が倍になる。
 * **⚠️ エディタでコードを直接編集しない。**clasp push が唯一の反映経路。
 *
 * 実行の順序（初回）:
 *
 * ```
 * 1. initSheets()              シートを作る（setup.js）
 * 2. checkSetup()              疎通・権限・項目IDの検証（checks.js）
 * 3. checkCareerStatus()       要件1の設定が実環境と合っているか
 *    checkProgressFlow()       要件2/3 の設定が実環境と合っているか
 * 4. bootstrapCareerStatus()   ⚠️ 基準づくり。通知は出ない。完了するまで繰り返す
 *    bootstrapProgressFlow()   ⚠️ 同上（こちらは1回で終わる。リクエストも使わない）
 * 5. runCareerStatusDryRun()   1サイクル。通知はドライラン用チャンネルへ寄る
 *    runProgressFlowDryRun()
 * 6. runCareerStatus()         1サイクル。本来のチャンネルへ送る
 *    runProgressFlow()
 * 7. createTriggers()          自動運転を開始する（冪等。何回実行してもよい）
 * ```
 *
 * **4 を飛ばして 5・6 を実行しない。**要件1は前回値が無いと全求職者が「変化した」と
 * 判定され、要件2/3 は既存の進捗履歴が全部「新しい遷移」になる
 * （rules/30-state-and-idempotency.md）。飛ばした場合は ConfigError で止まるようにしてある。
 *
 * **⚠️ 2つのトリガーは同時に走らない。**`LockService` を取れなかった実行は
 * 何もせず抜ける（core/runner.js）。トークンバケットはスクリプトプロパティで
 * 共有されるので、合計の流量も 60 req/分 を超えない（rules/20-rate-limit.md）。
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

// --- 要件2 / 要件3（progress_flow） ----------------------------------------

/** 要件2/3 を1サイクル実行する。**本来のチャンネルへ送る。** */
function runProgressFlow() {
  return Runner.execute(ProgressFlowWatcher.create());
}

/**
 * 要件2/3 を1サイクル実行し、**通知をドライラン用チャンネル（ops）へ寄せる。**
 * 本番相当のデータで動かす前の確認用（rules/40-secrets-and-security.md）。
 */
function runProgressFlowDryRun() {
  return Runner.execute(ProgressFlowWatcher.create(), { dryRun: true });
}

/**
 * 要件2/3 の基準づくり。**通知しない。CP も叩かない。**
 *
 * 「ここから先に増えた進捗履歴を見る」というカーソルを置くだけなので、
 * 要件1と違って1回で完了する。**これを実行するまで runProgressFlow() は動かない**
 * （既存の進捗履歴が全部「新しい遷移」として通知されるのを防ぐため）。
 */
function bootstrapProgressFlow() {
  const result = Runner.execute(ProgressFlowWatcher.create(), { bootstrap: true });
  const cursor = State.create().getCursor(ProgressFlowWatcher.WATCHER_ID);
  Log.info('bootstrap_state', {
    watcher_id: ProgressFlowWatcher.WATCHER_ID,
    bootstrapped: cursor ? cursor.bootstrapped : false,
    cursor: cursor ? TimeFmt.toStore(cursor.value) : null,
    hint: 'progress histories inserted after this point will be notified',
  });
  return result;
}

/**
 * 要件2/3 の設定が実環境と合っているかを確かめる。**CP を読むだけ。通知しない。**
 *
 * - 進捗履歴・進捗・名前解決の項目が schema に実在するか（実環境の schema が正）
 * - テンプレートの変数が実在するか（未定義の変数は通知の組み立て時ではなくここで落とす）
 * - 通知チャンネル（progress_flow / job_intro）が解決できるか
 */
function checkProgressFlow() {
  const watcher = ProgressFlowWatcher.create();
  const state = State.create();
  return watcher.validate({
    config: watcher.config,
    budget: Budget.unlimited(watcher.id),
    schema: Schema,
    master: Master,
    resolver: Resolver,
    templates: Templates,
    dispatcher: Dispatcher.create({ state: state }),
  });
}

// --- 日次サマリ（仕様書 9.3節）----------------------------------------------

/**
 * 日次サマリを ops チャンネルへ送る。**CP を1回も叩かない。**
 *
 * **既定は「前日」ぶん。**日次トリガーは朝に走るので、当日を集計しても
 * ほとんど空になる。手で今日ぶんを見たいときは `runDailySummaryToday()`。
 *
 * ⚠️ **時間主導トリガーは第1引数にイベントオブジェクトを渡す。**
 * 日付として使えるのは文字列（`"2026-09-06"`）を明示的に渡したときだけ。
 *
 * 出るもの: ウォッチャー別の実行回数・検知件数・通知件数・リクエスト数、
 * カーソルの遅れ、自動停止、dead_letter の件数、汎用カウンタ
 * （要件4の「宛先未設定で送れなかった件数」は Phase6 でここに乗る）。
 */
function runDailySummary(triggerEventOrDate) {
  return sendDailySummary(summaryDate(triggerEventOrDate, -1));
}

/** 今日ぶんの日次サマリ。**動作確認用。**トリガーには登録しない。 */
function runDailySummaryToday() {
  return sendDailySummary(TimeFmt.today());
}

/**
 * 日次サマリの本体。
 *
 * ⚠️ ウォッチャーと同じ `LockService` を取る。`notified` シートへの追記が
 * サイクルの追記と重なると行が壊れうるため。1日1回の処理なので**待ってよい。**
 */
function sendDailySummary(date) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    Log.warn('lock_busy', { event: 'daily_summary', hint: 'a cycle is still running' });
    return null;
  }
  try {
    const state = State.create();
    const report = Metrics.report({
      state: state,
      metrics: Metrics.create({ props: state.properties() }),
      date: date,
      watchers: activeWatchers(),
    });
    Ops.dailySummary(Dispatcher.create({ state: state }), report);
    Log.info('daily_summary_sent', {
      date: report.date,
      requests_total: report.requestsTotal,
      request_budget: report.requestBudget,
      peak_rate_per_minute: report.peakRatePerMinute,
      dead_letter_rows: report.deadLetterRows,
      has_problem: report.hasProblem,
    });
    return report;
  } finally {
    lock.releaseLock();
  }
}

/**
 * 集計対象の日付。
 * 文字列（`yyyy-MM-dd`）が渡されればそれ、そうでなければ今日から `offsetDays` 日。
 */
function summaryDate(value, offsetDays) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return TimeFmt.toStoreDate(TimeFmt.shiftDays(TimeFmt.now(), offsetDays));
}

/**
 * 日次サマリに行を出すウォッチャー。**CP は叩かない**（設定を読むだけ）。
 * 要件4（Phase6）を実装したらここに足す。
 */
function activeWatchers() {
  return [CareerStatusWatcher.create(), ProgressFlowWatcher.create()];
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
