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
    // 運用通知（自動停止の警告・日次サマリ）の宛先。**業務通知とは分ける**
    opsChannelKey: 'ops',
    sendRetryMax: 3,
    backoffBaseSeconds: 2,
  },

  /**
   * 時間主導トリガー（`setup.js` の `createTriggers()`）。
   *
   * **⚠️ `everyMinutes` に指定できるのは 1 / 5 / 10 / 15 / 30 だけ**（GAS の制約）。
   * それ以外を書くと作成時に落ちる。
   *
   * **⚠️ トリガーを手で足さない。**`createTriggers()` は自分が作ったものを
   * 消してから作り直すので冪等だが、画面から足したものは管理外になり、
   * 同じ関数が二重に回って流量が倍になる（rules/20-rate-limit.md）。
   */
  triggers: [
    { handler: 'runProgressFlow', everyMinutes: 5, enabled: true, note: '要件2/3。許容遅延5分' },
    { handler: 'runCareerStatus', everyMinutes: 15, enabled: true, note: '要件1。許容遅延15分' },
    // 要件4は Phase6。**関数が存在しないので enabled: false のままにする**
    { handler: 'runCareerAction', everyMinutes: 15, enabled: false, note: '要件4（Phase6 完了後に true）' },
    { handler: 'runDailySummary', atHour: 7, enabled: true, note: '日次サマリ（前日ぶんを ops へ）' },
  ],

  /**
   * 監視（仕様書 8.6節）。**設計との乖離を検出するための閾値。**
   *
   * GAS は常時トリガーが回るので、Python 版で問題だった「断続起動」の制約
   * （仕様書 9.5節）は原則として起きない。**ただしトリガーが止まることはある**
   * （日次実行時間の上限・例外の連続・手で消した等）ので、
   * **止まったことに気づく仕組みは残す。**それが `cursorLagWarnMinutes`。
   */
  monitoring: {
    // 想定流量（仕様書 8.1節）。日次サマリでこれと実測を突き合わせる
    dailyRequestBudget: 5000,
    // 「現在時刻 − カーソル値」がこれを超えたら止まっていると見なす。
    // **単調増加していたら最も危険なシグナル**（仕様書 8.6節）
    cursorLagWarnMinutes: 60,
    // メトリクスを何日ぶん残すか。PropertiesService に1日1キーで置く
    metricsKeepDays: 7,
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

  /**
   * 要件2 + 要件3 の監視設定。Python 版 config/watchers.yaml の progress_flow に対応する。
   *
   * 要件3は要件2と**同一のデータソース**（進捗履歴の追加）。実測で
   * 「進捗ステータス 社内確認中(16) → 応募意思確認中(求人)(11) の遷移」だと確定している。
   * 別々に API を叩かず、全遷移の上に「特定の遷移だけ文面とチャンネルを変える」形で乗せる。
   *
   * ⚠️ 監視する項目 ID は watchers/progressFlow.js の定数にある。
   *    要件1（career）と違い、**項目は固定で設定から変えない**（Python 版と同じ）。
   */
  progressFlow: {
    enabled: true,
    intervalMinutes: 5,           // 最大遅延 5分 + 処理時間（仕様書 3.2.8）
    priority: 1,                  // 要件1（15分間隔）より優先する
    budgetPerCycle: 60,
    overlapSeconds: 60,           // datetime は秒精度で検索できる（実測）

    /**
     * **モードA（全遷移を通知）で開始する**（仕様書 3.2.2）。
     *
     * マスタの返却順が業務フロー順ではないことが実測で判明しているため、
     * フロー定義を推測で埋めず、まず全遷移を流して実データを見てから絞る。
     * false にするときは watchedStatuses に通知したいステータスを列挙する。
     * **両方を空にすると何も通知されない**ので起動時に拒否する。
     */
    notifyAllTransitions: true,
    watchedStatuses: [],

    notify: {
      name: '進捗フローの進行',
      channelKey: 'progress_flow',
      template: 'progress_transition',
    },

    /**
     * 要件3。**先に書いたルールが勝つ。**当たったものは一般チャンネルには出ない
     * （1遷移につき通知は1通）。
     */
    specialTransitions: [
      {
        name: '求人紹介OK',
        toStatus: '11',           // 応募意思確認中(求人)。実測で確定
        fromStatus: '16',         // 社内確認中（省略可。指定すると誤検知が減る）
        // ⚠️ その進捗を初めて観測したときは遷移前のステータスが分からない。
        //    既定ではそれでも一致とみなす（取りこぼしより重複を選ぶ）。
        //    true にすると遷移前が確認できたときだけ job_intro へ送る
        fromStatusRequired: false,
        notify: {
          channelKey: 'job_intro',
          template: 'job_intro_ok',
        },
      },
    ],
  },

  /**
   * 通知本文に出す名前の解決（core/resolver.js・仕様書 5.3）。
   * Python 版 config/app.yaml の name_resolution に対応する。
   *
   * progress / progress_history が持っているのは ID だけなので、別リソースを select して
   * 名前に直す。変化が遅いので TTL 付き LRU でキャッシュする
   * （**GAS では実効の寿命が1回の実行の中だけになる。**core/resolver.js の注記）。
   *
   * ⚠️ ここに担当者メールアドレス（CAREER#CHARGE_EMAIL）を足さないこと。
   *    要件4の宛先であり、担当者変更の直後に旧担当へ送るのは実害がある（仕様書 5.3）。
   */
  nameResolution: {
    career: {
      resource: 'career',
      items: ['CAREER#LASTNAME', 'CAREER#FIRSTNAME'],
      template: '{CAREER#LASTNAME} {CAREER#FIRSTNAME}',
      ttlSeconds: 3600,           // 1時間
      maxEntries: 2000,
    },
    order: {
      resource: 'order',
      items: ['ORDER#POSITIONNAME'],
      template: '{ORDER#POSITIONNAME}',
      ttlSeconds: 21600,          // 6時間
      maxEntries: 1000,
    },
    client: {
      // 進捗は PROGRESS#CLIENT_ID を直接持っているので、求人を経由せず1リクエストで引ける
      resource: 'client',
      items: ['CLIENT#CLIENTNAME'],
      template: '{CLIENT#CLIENTNAME}',
      ttlSeconds: 21600,          // 6時間
      maxEntries: 1000,
    },
  },
};
