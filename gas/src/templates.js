/**
 * 通知本文のテンプレート。Python 版 config/templates.yaml の移植。
 *
 * **文言はコードに直書きしない**（rules/50-code-style.md）。表示に出る日本語は
 * すべてこのファイルに集める。GAS に YAML パーサはないのでオブジェクトで持つ。
 *
 * ⚠️ 全項目監視では、変化した項目の値がそのまま本文に載る。
 *    氏名・連絡先・年収などの個人情報が Slack に流れることを前提に、
 *    チャンネルの参加者を絞ること（rules/40-secrets-and-security.md）。
 *
 * 変数は `{name}` で埋める。**未定義の変数を書くと組み立て時に ConfigError になる。**
 * 黙って空文字にすると、変数名の打ち間違いに気づけないまま通知が出続ける。
 */
const Templates = (function () {

  /** 値そのものではない表示用の文言。ここ以外に直書きしない。 */
  const LABELS = {
    UNSET: '(未設定)',        // 値が空・未設定
    NO_RECORD: '(記録なし)',  // 生値を保存していない項目の「変化前」
    MORE_ITEMS: '… ほか {count} 項目',
    // 初めて観測する進捗の「遷移前ステータス」。**推測で埋めない**（仕様書 3.2.3）
    UNKNOWN: '(不明)',
    // 参照先が削除済み等で名前を引けなかった（core/resolver.js）
    UNRESOLVED: '(取得できません: {resource} {resource_id})',
    // 一般の遷移ルール名。設定（progressFlow.notify.name）が無いときの既定
    TRANSITION: '進捗フローの進行',
    // 日次サマリの見出し（notifiers/ops.js）
    STATUS_OK: '正常',
    STATUS_PROBLEM: '⚠️ 要確認',
    NO_PROBLEM: '（なし）',
  };

  const TEMPLATES = {

    // 汎用: リソースの項目が変化した（要件1）
    //   変数: resource / resource_label / resource_id / record_name / changes / change_count
    record_changed: {
      subject: '[CP] {resource_label}「{record_name}」の項目が変更されました',
      change_line: '• {label}: {old} → {new}',
      body: [
        '*{resource_label}の項目が変更されました*（{change_count} 件）',
        '{record_name}（{resource} / ID {resource_id}）',
        '',
        '{changes}',
      ].join('\n'),
    },

    // --- 要件2 / 要件3: 進捗フローの進行 ------------------------------------
    // 使える変数（未定義の変数を書くと**起動時に**失敗する）:
    //   transition_name   ルール名（"求人紹介OK" など）
    //   career_name       求職者名        order_name    求人名（ポジション名）
    //   client_name       企業名
    //   from_label        遷移前ステータスのラベル。**初めて観測する進捗では「(不明)」**
    //   to_label          遷移後ステータスのラベル
    //   from_status       遷移前のコード値   to_status     遷移後のコード値
    //   progress_date     進捗日
    //   progress_charge   進捗の担当者      career_charge 求職者担当  order_charge 求人担当
    //   progress_id       進捗ID           progress_sub  枝番
    //   resource_id       進捗履歴ID（"21_3" 形式）
    //   estimated_amount     見込回収金額（**単位は万円。**CP 画面のラベルが「（万円）」）
    //   estimated_accuracy   見込確度（マスタでラベル化済み）
    //   estimated_month      見込計上月
    //
    // 見込3項目は「求人紹介OK」の小画面で入力するもの。入力されなければ「(未設定)」。
    // 単位や見出しの文言はここに書く（コードに持たせない）。

    // 要件2: すべての遷移
    progress_transition: {
      subject: '[CP] 進捗が動きました: {career_name}',
      body: [
        '*進捗フローが進行しました*',
        '{career_name} × {order_name}（{client_name}）',
        '',
        'ステータス: {from_label} → {to_label}',
        '進捗日: {progress_date}',
        '進捗担当: {progress_charge}',
        '（進捗 {progress_id} / 履歴 {resource_id}）',
      ].join('\n'),
    },

    // --- 運用通知（ops チャンネル・notifiers/ops.js）------------------------
    // **業務の通知ではない。**アプリが壊れたことに人が気づくためのもの。

    // 連続失敗でウォッチャーが自動停止した（仕様書 8.6節 / rules/30）
    //   変数: watcher_id / failures / stop_count
    ops_watcher_stopped: {
      subject: '[CP] ウォッチャーを自動停止しました: {watcher_id}',
      body: [
        '*⚠️ ウォッチャーを自動停止しました*',
        '`{watcher_id}` が {failures} 回連続で失敗しました（通算 {stop_count} 回目の停止）。',
        '',
        '*カーソルは進んでいません。*原因を直してから',
        '`clearWatcherFailures("{watcher_id}")` で再開すると、失敗した範囲から処理し直します。',
        '止めたままにすると、その間の変化は次の再開時にまとめて通知されます。',
      ].join('\n'),
    },

    // 日次サマリ（仕様書 9.3節）。1日1通、ops チャンネルへ
    //   変数: date / status / watcher_lines / problem_lines / requests_total /
    //         request_budget / request_ratio / peak_rate / rate_limit /
    //         dead_letter_rows / notified_rows
    ops_daily_summary: {
      subject: '[CP] 日次サマリ {date}（{status}）',
      watcher_line:
        '• `{watcher_id}` 実行 {cycles} / 検知 {detected} / 通知 {notified} / ' +
        'リクエスト {requests}（失敗 {failed} / 中断 {exhausted}）',
      stopped_line: '• ⚠️ `{watcher_id}` が自動停止しています（連続失敗 {failures} 回）',
      stale_line: '• ⚠️ `{watcher_id}` のカーソルが {lag_minutes} 分遅れています（{cursor}）',
      no_baseline_line: '• ⚠️ `{watcher_id}` は基準づくりが済んでいません（通知は出ません）',
      dead_letter_line: '• ⚠️ dead_letter が {rows} 件あります（自動再送はしません）',
      counter_line: '• {name}: {count} 件',
      body: [
        '*CP進捗通知 日次サマリ*（{date} / {status}）',
        '',
        '{watcher_lines}',
        '',
        '*要確認*',
        '{problem_lines}',
        '',
        'リクエスト: {requests_total} / {request_budget} 件（{request_ratio}%）',
        'ピーク: {peak_rate} req/分（設計上限 {rate_limit} req/分）',
        'dead_letter: {dead_letter_rows} 行 / notified: {notified_rows} 行',
      ].join('\n'),
    },

    // 1サイクルの通知件数が上限を超えた（一括更新でチャンネルが溢れるのを防ぐ）
    //   変数: total / suppressed / limit / resources
    notification_flood: {
      subject: '[CP] {total} 件の変更',
      body: [
        '*{total} 件の変更が検出されました*',
        'うち {suppressed} 件は詳細を省略しました（1サイクルの通知上限 {limit} 件）。',
        '対象リソース: {resources} 件',
      ].join('\n'),
    },

    // 要件3: 求人紹介OK（社内確認中 → 応募意思確認中(求人)）
    job_intro_ok: {
      subject: '[CP] {transition_name}: {career_name}',
      body: [
        '*{transition_name}*',
        '{career_name} を「{order_name}」（{client_name}）へ紹介しました。',
        '',
        'ステータス: {from_label} → {to_label}',
        '進捗日: {progress_date}',
        '進捗担当: {progress_charge}',
        '',
        '見込回収金額（万円）: {estimated_amount}',
        '見込確度: {estimated_accuracy}',
        '見込計上月: {estimated_month}',
        '（進捗 {progress_id} / 履歴 {resource_id}）',
      ].join('\n'),
    },
  };

  /** テンプレートを1つ取る。無ければ null（呼び出し側が起動時に弾く）。 */
  function get(name) {
    return Object.prototype.hasOwnProperty.call(TEMPLATES, name) ? TEMPLATES[name] : null;
  }

  /**
   * `{name}` を埋める。**未定義の変数は ConfigError。**
   *
   * 値に `{...}` が含まれていても再帰的に展開しない（1パスで置換する）。
   * CP から来た値に中括弧が入っていても壊れないようにするため。
   */
  function render(text, fields) {
    const values = fields || {};
    return String(text).replace(/\{([A-Za-z0-9_#]+)\}/g, function (whole, key) {
      if (!Object.prototype.hasOwnProperty.call(values, key)) {
        throw Errors.config('unknown template variable "' + key + '"');
      }
      const value = values[key];
      return value === null || value === undefined ? '' : String(value);
    });
  }

  /** テンプレートの1フィールドを埋める。フィールドが無ければ既定値を使う。 */
  function renderField(template, field, fields, fallback) {
    const text = (template && template[field] !== undefined) ? template[field] : fallback;
    if (text === undefined || text === null) {
      throw Errors.config('template has no "' + field + '"');
    }
    return render(text, fields);
  }

  return {
    LABELS: LABELS,
    TEMPLATES: TEMPLATES,
    get: get,
    render: render,
    renderField: renderField,
  };
})();
