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

    // 要件2 / 要件3（progress_transition / job_intro_ok）は Phase4 で足す
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
