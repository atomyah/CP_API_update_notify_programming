/**
 * 設定値。Python 版の config/app.yaml と config/watchers.yaml に対応する。
 *
 * **GAS に YAML パーサはない。**値の意味と既定値は YAML から変えていない。
 * 変更するときは YAML 側と食い違いが出ないよう、必ず両方を見ること。
 *
 * ⚠️ 秘密情報をここに書かない（rules/40-secrets-and-security.md）。
 *    API キーと Slack Webhook URL はスクリプトプロパティに手で設定する。
 *    ここにあるのは**プロパティのキー名だけ**で、値そのものではない。
 */
const Config = {
  cpApi: {
    baseUrl: 'https://api.careerplus.jp',
    // スクリプトプロパティのキー名。値そのものは書かない
    apiKeyProperty: 'CP_NOTIFY_API_KEY',
  },

  rateLimit: {
    // CP の上限は 240 req/分。超えると API サービスを停止される可能性がある。
    // 既定は上限の 25%（60 req/分）。240 がキー単位かテナント単位かは未確認のため
    // 余裕を大きく取る（docs/design/06-open-questions.md Q-1）。
    tokensPerSecond: 1.0,       // = 60 req/分
    bucketCapacity: 20,         // 瞬間的に 20 連続まで
    limitPerMinute: 60,
    warnThresholdRatio: 0.8,
    // ⚠️ トークンバケットの状態を実行をまたいで持つためのプロパティキー。
    //    GAS はトリガー実行ごとに状態が消えるため、永続化しないと
    //    トリガーの本数だけ流量が増える（仕様書 11章 / to-do/Phase1.md）
    stateProperty: 'RATE_BUCKET',
  },

  limits: {
    maxNotificationsPerCycle: 50,
    maxPagesPerCycle: 10,
    // UrlFetchApp のタイムアウトは指定できない（GAS 側が固定）。
    // Python 版の http_timeout_seconds: 60 に相当する設定は存在しない
    httpTimeoutSeconds: null,
  },

  execution: {
    // 1回の実行は最長6分。リクエスト予算に加えて経過時間でも中断する（仕様書 11.6）
    maxRuntimeSeconds: 240,
    // 上の値に達する前に処理を切り上げる余裕。CP の1リクエストとシートの
    // 書き戻しが入りきるだけの幅を残す。**0 にしない**（書き戻し前に強制終了される）
    stopMarginSeconds: 20,
  },

  // Slack Incoming Webhook（notifiers/slack.js）。
  // **URL はチャンネルを特定する秘密情報。**ここにはプロパティのキー名だけを書く。
  slack: {
    webhookProperties: {
      career_status: 'SLACK_WEBHOOK_CAREER_STATUS',   // 要件1
      progress_flow: 'SLACK_WEBHOOK_PROGRESS_FLOW',   // 要件2（Phase4）
      job_intro: 'SLACK_WEBHOOK_JOB_INTRO',           // 要件3（Phase4）
      ops: 'SLACK_WEBHOOK_OPS',                       // 運用アラート・ドライラン
    },
    // ドライランのときに全通知を寄せるチャンネル。
    // 本番相当のデータで動かす前の確認用（rules/40-secrets-and-security.md）
    dryRunChannelKey: 'ops',
    sendRetryMax: 3,
    backoffBaseSeconds: 2,
  },

  // 要件1の監視設定。Python 版 config/watchers.yaml の career_status に対応する。
  careerStatus: {
    resource: 'career',
    enabled: true,
    intervalMinutes: 15,          // 最大遅延 15分 + 処理時間（仕様書 3.1.5）
    priority: 2,
    budgetPerCycle: 60,
    // ブートストラップは全求職者を1件ずつ select する。1回の実行では終わらない
    // 前提で、途中まででコミットして次の実行へ持ち越す（仕様書 11.4）
    bootstrapBudgetPerCycle: 500,
    overlapSeconds: 60,           // datetime は秒精度で検索できる（実測）

    updateDateItem: 'CAREER#UPDATE_DATE',
    // "*" は schema の全項目 − 除外。監視項目を絞るなら項目IDの配列を書く
    watchedItems: '*',
    excludeSuffixes: ['#UPDATE_DATE', '#INSERT_DATE'],
    excludeItems: ['CAREER#LAST_LOGIN'],   // マイページのログインで動く。業務上の変化ではない
    identityItems: ['CAREER#CAREER_ID', 'CAREER#LASTNAME', 'CAREER#FIRSTNAME'],
    nameTemplate: '{CAREER#LASTNAME} {CAREER#FIRSTNAME}',
    // オリつく項目。実在することを起動時に確認する（V-1 で成立を確認済み）
    knownCustomItem: 'CAREER#48002',
    maxItemsInBody: 20,           // 1通に載せる項目数の上限。超えたら「ほか N 項目」

    /**
     * **遷移前後の値を通知する項目。この項目だけ生値をシートに保存する。**
     *
     * 既定はハッシュのみ（rules/40-secrets-and-security.md）。ここに挙げた項目は
     * 個人情報を含みうる値がスプレッドシートに平文で入ることを承知で保存する。
     * 挙げていない項目の変化は「(記録なし) → 新しい値」として通知される。
     *
     * 既定値は仕様書 3.1.1 の監視項目表（オリつく項目 + ステータス系7項目）。
     * `"*"` にすると全監視項目の生値を保存する（Python 版 keep_raw_values: true 相当）。
     */
    rawValueItems: [
      'CAREER#48002',            // 国籍（オリつく項目）
      'CAREER#REGSTATUS_ID',     // 登録ステータス
      'CAREER#CNSLSTATUS_ID',    // 面談ステータス
      'CAREER#WKSTATUS_ID',      // 現在の状況
      'CAREER#RANK_ID',          // ランク
      'CAREER#MYPAGE_STATUS',    // マイページステータス
      'CAREER#CHARGE_ID',        // 担当者
      'CAREER#CHARGETEAM_ID',    // 担当チーム
    ],

    // 監視対象を絞りたくなったらここに検索条件を足す。
    // 例（惣流アスカだけを見る場合）:
    //   targetCondition: { itemId: 'CAREER#CAREER_ID', searchType: 'EQ', value: '18' }
    targetCondition: null,

    notify: {
      channelKey: 'career_status',
      template: 'record_changed',
      resourceLabel: '求職者',
    },
  },
};
