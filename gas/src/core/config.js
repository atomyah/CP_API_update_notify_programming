/**
 * 設定値。Python 版の config/app.yaml に対応する。
 *
 * **GAS に YAML パーサはない。**値の意味と既定値は app.yaml から変えていない。
 * 変更するときは app.yaml 側と食い違いが出ないよう、必ず両方を見ること。
 *
 * ⚠️ 秘密情報をここに書かない（rules/40-secrets-and-security.md）。
 *    API キーと Slack Webhook URL はスクリプトプロパティに手で設定する。
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
  },

  // 要件1の監視設定。Python 版 config/watchers.yaml の career_status に対応する。
  // Phase1 では checkSetup() の検証にのみ使う
  careerStatus: {
    resource: 'career',
    updateDateItem: 'CAREER#UPDATE_DATE',
    excludeSuffixes: ['#UPDATE_DATE', '#INSERT_DATE'],
    excludeItems: ['CAREER#LAST_LOGIN'],
    identityItems: ['CAREER#CAREER_ID', 'CAREER#LASTNAME', 'CAREER#FIRSTNAME'],
    // オリつく項目。実在することを起動時に確認する（V-1 で成立を確認済み）
    knownCustomItem: 'CAREER#48002',
  },
};
