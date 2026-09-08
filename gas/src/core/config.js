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
    // 要件4。メール送信の実機確認は済んでいる（仕様書 11.14節）
    { handler: 'runCareerAction', everyMinutes: 15, enabled: true, note: '要件4。許容遅延15分' },
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
    // 例（式波アスカだけを見る場合）:
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
   * 要件4の監視設定。Python 版 config/watchers.yaml の career_action_watch に対応する。
   * **Python 版には実装が無い**（メール送信がペンディングのため）。GAS が初実装。
   *
   * | | |
   * |---|---|
   * | 対象 | **担当者が設定されている求職者の対応履歴だけ**（走査量を直接決める） |
   * | トリガー | **日付3項目の変化のみ。**メモ本文が変わっても通知しない |
   * | 宛先 | `CAREER#CHARGE_EMAIL`（求職者の担当者）。**空なら送らず件数を数える** |
   *
   * ✅ **有効**（2026-09-08）。メール送信の前提は実機で確認済み
   * （`MailApp` は組織のポリシーで止められていない / 日次上限 1,500通 / 送信元は
   * スクリプト所有者。仕様書 8.4 / 11.14節）。
   *
   * ⚠️ **false に戻すと `execute()` は何もせず抜ける**（`skipped: disabled`）。
   * 止めたいときはここを false にするか、`deleteTriggers()` でトリガーを外す。
   * 本物の担当者へ送らずに検知だけ確かめたいときは `runCareerActionDryRun()`
   * （宛先が管理者へ寄る）。
   */
  careerActionWatch: {
    enabled: true,
    resource: 'career_action',
    // 宛先・求職者名は**関連リソース経由**で同じ select から取れる（実測 V-3a）
    careerResource: 'career',
    intervalMinutes: 15,          // 最大遅延 15分 + 処理時間（仕様書 3.3.10）
    priority: 3,
    budgetPerCycle: 120,
    bootstrapBudgetPerCycle: 500,
    // ⚠️ このウォッチャーはカーソルからの相対検索をしない。走査窓は「今日 − N日」の
    // 絶対値なので、オーバーラップ幅は使わない（3日窓が rules/30 の「要件4は1日」より広い）。
    // カーソルは「どこまで見終わったか」の目印とコミット点としてだけ使う
    overlapSeconds: 0,

    /**
     * 母集団の絞り込み（仕様書 3.3.3）。**走査量を直接決める最重要の設定。**
     * 担当者が未設定の求職者には通知しない。それなら走査もしない。
     *
     * ⚠️ `CAREER#CHARGE_EMAIL` は検索条件に使えない（400。実測）。
     *    絞り込みは `CAREER#CHARGE_ID ENTERED` を使う。
     */
    populationCondition: {
      itemId: 'CAREER#CHARGE_ID',
      searchType: 'ENTERED',
      value: '',
      // 抹消済みも除きたくなったら and でくくって次を足す（動作確認済み）:
      //   { itemId: 'CAREER#REGSTATUS_ID', searchType: 'NOT_EQ', value: '5' }
    },

    // 3つの日付の OR 和集合。**1リクエストで取れることを実測済み**（V-3e）
    discoveryWindowDays: 30,      // 新規検知の網。ID だけなので広くても安い
    changeWindowDays: 3,          // 日付変更の検知。select するのでコストに直結
                                  // 参考: 7日=5.6 / 14日=11 / 30日=24 req/分

    /**
     * 変化を検知する項目（仕様書 3.3.2）。**ここに無い項目が変わっても通知しない。**
     * ラベルは通知本文の「変更内容」に出る。schema のラベルは
     * 「求職者対応：完了日」のように接頭辞が付くので、読みやすい名前を明示する。
     */
    triggerItems: [
      { itemId: 'CAREER_ACTION#ACTION_DATE', labelOverride: '対応日' },
      { itemId: 'CAREER_ACTION#COMPLETE_DATE', labelOverride: '完了日' },
      { itemId: 'CAREER_ACTION#NEXTACTION_DATE', labelOverride: '次回コンタクト日' },
    ],
    // 「対応完了」を判定する項目。null → 値 になったら「完了」として文面を変える
    completeItem: 'CAREER_ACTION#COMPLETE_DATE',

    // 通知本文に載せる項目。**トリガーではない**（変わっても通知しない）
    bodyItems: [
      'CAREER_ACTION#ACTION_ID',        // アクション種別（MSTACTION でラベル化）
      'CAREER_ACTION#ACTIONMEMO',       // メモ本文
      'CAREER_ACTION#ACTIONCHARGE_ID',  // 対応担当（MSTUSER でラベル化）
    ],
    // 対応履歴の ID は `{求職者ID}_{対応番号}`。**対応番号は 0 始まり**（実測）
    identityItems: ['CAREER_ACTION#CAREER_ID', 'CAREER_ACTION#HISTSEQ'],
    // 求職者名（関連リソース）。宛先と同じ select で取れるので追加コストは無い
    careerNameItems: ['CAREER#LASTNAME', 'CAREER#FIRSTNAME'],
    nameTemplate: '{CAREER#LASTNAME} {CAREER#FIRSTNAME}',

    /**
     * 生値を保存する項目（rules/40-secrets-and-security.md）。
     * **日付3項目だけ。**「完了日: (未設定) → 2026/08/05」を出すために要る。
     * メモ本文・氏名・メールアドレスは**保存しない。**
     */
    rawValueItems: [
      'CAREER_ACTION#ACTION_DATE',
      'CAREER_ACTION#COMPLETE_DATE',
      'CAREER_ACTION#NEXTACTION_DATE',
    ],
    maxItemsInBody: 10,

    notify: {
      channelKey: 'career_action',
      // 求職者の担当者。**対応の担当（ACTIONCHARGE_ID）ではない。**
      // 取り違えると誤送信になる（実測で別人のケースを確認済み。仕様書 3.3.5）
      toItem: 'CAREER#CHARGE_EMAIL',
      // 送らない。ただし**黙って捨てない。**件数を数えて日次サマリで報告する
      // （仕様書 3.3.6）。**業務側の決定なので "skip" 以外は受け付けない**
      onMissingAddress: 'skip',
      templates: {
        created: 'action_created',
        updated: 'action_updated',
        completed: 'action_completed',
      },
    },
  },

  /**
   * メール送信（要件4・notifiers/mail.js）。
   *
   * **GAS では `MailApp` を使う。**SMTP サーバもアプリパスワードも要らない
   * （Python 版がペンディングになっていた理由が GAS では消える。仕様書 8.4）。
   *
   * ⚠️ **送信元はスクリプトを承認したアカウント。**別のアドレスから送りたい場合は、
   * そのアカウントの Gmail に確認済みエイリアスとして登録したうえで
   * `fromAddressProperty` のプロパティに設定する（未設定なら指定しない）。
   *
   * ⚠️ **1日あたりの送信上限がある。**残量は `checkMail()` で見る（checks.js）。
   * 残量が尽きた状態で送ると例外になるので、送る前に必ず確認する。
   */
  mail: {
    // このチャンネルの通知をメールで送る。Slack の webhookProperties と重ねない
    channelKeys: ['career_action'],
    // 宛先未設定・ドライラン・送信失敗の受け皿。**スクリプトプロパティに設定する**
    // （個人のメールアドレスをリポジトリに書かない。rules/40）
    adminAddressProperty: 'MAIL_ADMIN_ADDRESS',
    // 任意。承認アカウントの確認済みエイリアスのみ有効
    fromAddressProperty: 'MAIL_FROM_ADDRESS',
    senderName: 'CP進捗通知',
    // 残りの送信可能数がこれを下回ったら警告ログを出す
    quotaWarnThreshold: 20,
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
