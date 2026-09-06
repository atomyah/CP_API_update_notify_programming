/**
 * 要件2 + 要件3 — 進捗フローが進行したら Slack に通知する。
 * Python 版 `app/watchers/progress_flow.py` の移植。
 *
 * 仕様の根拠は仕様書 3.2節。**設定は core/config.js の progressFlow。**
 *
 * **進捗履歴が1行増えたら「フローが進行した」とみなす。**
 * CP はステータス変更を進捗履歴の追加として記録する設計であり、
 * 進捗の新規作成も枝番の最初の進捗履歴として記録される（実測 2026-08-05）。
 *
 * 要件3（求人紹介OK）は**要件2と同一のデータソース**であり、
 * 「進捗ステータスが `社内確認中(16)` → `応募意思確認中(求人)(11)` へ遷移するイベント」だった。
 * 別々に API を叩かず、全遷移の上に「特定の遷移だけ文面とチャンネルを変える」形で乗せる。
 *
 * 検知の流れ:
 *
 * ```
 * 1. progress_history/search（PROGRESS_HISTORY#INSERT_DATE GE カーソル − オーバーラップ）
 *    → 追加された進捗履歴 ID（"{progressId}_{枝番}" 形式）
 * 2. progress_history/select で遷移先ステータスと親の進捗 ID を得る
 * 3. progress/select で「誰の・どの求人か」を得る
 * 4. core/resolver.js で求職者名・求人名・企業名を解決（キャッシュヒット時は0リクエスト）
 * 5. マスタでコード値をラベルに変換し、notified へ追記してから Slack へ送る
 * 6. 遷移先ステータスを「次回の遷移前ステータス」として持ち越す → 最後にカーソル（Runner）
 * ```
 *
 * **モードA（全遷移を通知）で開始する**（仕様書 3.2.2）。
 * マスタの返却順が業務フロー順ではないことが実測で判明しており、
 * フロー定義を推測で埋めると通知漏れになる。まず全遷移を流し、実データを見てから絞る。
 *
 * ## 冪等キーに枝番を含める理由
 *
 * フローは後戻りする（「再面談」で `11` → `16` に戻り、これも履歴の追加として記録される）。
 * `progressId + ステータス値` で冪等キーを作ると、`16 → 11 → 16` と往復したときに
 * 2回目の `16` が重複扱いされて通知が消える（`21_1` と `21_3` は同じステータス値 `16`）。
 * **`resourceId` に進捗履歴 ID（枝番を含む `21_3`）を使う**ことでこれを避ける。
 *
 * ## 遷移前ステータス（`fromStatus`）の持ち方
 *
 * CP は「遷移前のステータス」を返さない。`progress/select` で読める `PROGRESS#STATUS_ID` は
 * **遷移後の値**であり（実測）、遷移前の値はどこにも残っていない。
 * そこで **1つ前に観測したステータスを持ち越す。**追加リクエストは 0。
 *
 * GAS では `snapshot_values` シート（`ctx.rawValues`）を持ち越し領域として使う。
 * ハッシュではなく**生値**が要る（表示に使うため）。行は `watcher_id` で分かれているので
 * 要件1のスナップショットとは混ざらない（仕様書 11.3）。
 *
 * - 枝番の起点（`progress_history` は 1 始まり、`career_action` は 0 始まり）に依存しない。
 *   枝番を判定に一切使っていないため（仕様書 3.2.3）。
 * - **初めて観測する進捗の遷移前は不明。**「(不明)」と表示する。推測で埋めない。
 * - **⚠️ 遷移前ステータスを冪等キーに入れてはいけない。**オーバーラップで再取得したときに
 *   持ち越し済みの値と突き合わせて別のダイジェストになり、二重通知になる（仕様書 3.2.4）。
 *
 * ## 拾えないもの（仕様書 3.2.5）
 *
 * 進捗履歴の**削除**と進捗そのものの削除は検知できない（削除は検索に現れない）。
 * 必要になったら日次で全進捗を棚卸しする低頻度ウォッチャーを足す設計になる。**今回は作らない。**
 */
const ProgressFlowWatcher = (function () {

  const WATCHER_ID = 'progress_flow';
  const EVENT_TYPE = 'status_changed';

  // 項目 ID をコードに直書きせず1箇所に集約する（rules/10-cp-api.md）。
  // 要件1（career）と違い監視項目は固定なので、設定ではなくここに置く（Python 版と同じ）。
  // 起動時に実環境の schema と突き合わせ、存在しなければ**起動を失敗させる。**
  const HISTORY_RESOURCE = 'progress_history';
  const PROGRESS_RESOURCE = 'progress';

  const HISTORY_INSERT_DATE = 'PROGRESS_HISTORY#INSERT_DATE';
  const HISTORY_PROGRESS_ID = 'PROGRESS_HISTORY#PROGRESS_ID';
  const HISTORY_PROGRESS_ID_SUB = 'PROGRESS_HISTORY#PROGRESS_ID_SUB';
  const HISTORY_STATUS = 'PROGRESS_HISTORY#PROGRESS_STATUS_ID';
  const HISTORY_PROGRESS_DATE = 'PROGRESS_HISTORY#PROGRESS_DATE';
  const HISTORY_CAREER_CHARGE = 'PROGRESS_HISTORY#CAREER_CHARGE_ID';
  const HISTORY_ORDER_CHARGE = 'PROGRESS_HISTORY#ORDER_CHARGE_ID';
  // 「求人紹介OK」の小画面で入力する3項目（実測。仕様書 3.2.9）。
  // 入力されなければ null のままなので、通知本文では「(未設定)」になる
  const HISTORY_ESTIMATED_AMOUNT = 'PROGRESS_HISTORY#ESTIMATED_SALES_AMOUNT';
  const HISTORY_ESTIMATED_ACCURACY = 'PROGRESS_HISTORY#ESTIMATED_SALES_ACCURACY';
  const HISTORY_ESTIMATED_MONTH = 'PROGRESS_HISTORY#ESTIMATED_SALES_MONTH';

  const PROGRESS_CAREER_ID = 'PROGRESS#CAREER_ID';
  const PROGRESS_ORDER_ID = 'PROGRESS#ORDER_ID';
  const PROGRESS_CLIENT_ID = 'PROGRESS#CLIENT_ID';
  const PROGRESS_STATUS = 'PROGRESS#STATUS_ID';
  const PROGRESS_CHARGE = 'PROGRESS#PROGRESS_CHARGE_ID';

  /**
   * 進捗履歴から取る項目（仕様書 3.2.3 手順2）。
   *
   * **項目を足しても1リクエストのまま。**select は 1リクエスト = 1リソースで、
   * itemIds の数はリクエスト数に影響しない（レスポンスサイズだけ増える）。
   * PROGRESS_ID / PROGRESS_ID_SUB は ID 文字列の分解でも得られるが、
   * 同じリクエストに含められるので追加コストなしで確実な値を使う。
   */
  const HISTORY_ITEMS = [
    HISTORY_PROGRESS_ID,
    HISTORY_PROGRESS_ID_SUB,
    HISTORY_STATUS,
    HISTORY_PROGRESS_DATE,
    HISTORY_CAREER_CHARGE,
    HISTORY_ORDER_CHARGE,
    HISTORY_ESTIMATED_AMOUNT,
    HISTORY_ESTIMATED_ACCURACY,
    HISTORY_ESTIMATED_MONTH,
  ];

  /**
   * 進捗から取る項目（仕様書 3.2.3 手順4）。
   * `PROGRESS#PROGRESS_CHARGE_ID` は項目一覧 xlsx に無いが実環境には存在する（実測）。
   */
  const PROGRESS_ITEMS = [
    PROGRESS_CAREER_ID,
    PROGRESS_ORDER_ID,
    PROGRESS_CLIENT_ID,
    PROGRESS_STATUS,
    PROGRESS_CHARGE,
  ];

  // 持ち越し（前回観測したステータス）を置く列。項目値のスナップショットではなく、
  // このウォッチャー専用の持ち越し領域として snapshot_values を使う
  const LAST_STATUS_KEY = HISTORY_STATUS;

  // 通知本文で使える変数。**起動時にテンプレートを検査するために使う**
  const TEMPLATE_FIELDS = [
    'transition_name', 'resource_id', 'progress_id', 'progress_sub',
    'from_status', 'to_status', 'from_label', 'to_label', 'progress_date',
    'career_name', 'order_name', 'client_name',
    'progress_charge', 'career_charge', 'order_charge',
    'estimated_amount', 'estimated_accuracy', 'estimated_month',
  ];

  // 名前解決する種別（core/resolver.js）。求職者・求人・企業
  const NAME_KINDS = ['career', 'order', 'client'];

  /**
   * ウォッチャーを1つ作る。
   * @param overrides 設定の上書き（テストと予算の差し替えに使う）
   */
  function create(overrides) {
    const config = merge(Config.progressFlow, overrides);
    // 設定不備は**作った時点で**落とす。1サイクル走らせてから気づくことにしない
    const rules = buildRules(config);
    return Watchers.define(WATCHER_ID, config, {
      execute: execute,
      bootstrap: bootstrap,
      validate: validate,
      channelKeys: function () {
        return rules.specials.concat([rules.general]).map(function (r) {
          return r.channelKey;
        });
      },
    });
  }

  // --- 設定 → 遷移ルール ----------------------------------------------------

  /**
   * 設定から遷移ルールを組み立てる。**先に書いた特別ルールが勝つ。**
   *
   * `notifyAllTransitions: false` かつ `watchedStatuses: []` は
   * **何も通知されない設定**なので拒否する（仕様書 3.2.7）。
   */
  function buildRules(cfg) {
    if (!cfg.notifyAllTransitions && !(cfg.watchedStatuses || []).length) {
      throw Errors.config(
        WATCHER_ID + ': notifyAllTransitions is false but watchedStatuses is empty. ' +
        'Nothing would ever be notified');
    }
    const notify = cfg.notify || {};
    ['channelKey', 'template'].forEach(function (key) {
      if (!notify[key]) throw Errors.config(WATCHER_ID + ': notify.' + key + ' is required');
    });

    return {
      general: {
        name: notify.name || Templates.LABELS.TRANSITION,
        channelKey: notify.channelKey,
        template: notify.template,
        toStatus: null,
        fromStatus: null,
        fromStatusRequired: false,
        isSpecial: false,
      },
      specials: (cfg.specialTransitions || []).map(buildSpecial),
    };
  }

  function buildSpecial(entry) {
    const notify = (entry || {}).notify || {};
    ['channelKey', 'template'].forEach(function (key) {
      if (!notify[key]) {
        throw Errors.config(
          WATCHER_ID + ': specialTransitions[].notify.' + key + ' is required');
      }
    });
    if (!entry.toStatus && !entry.fromStatus) {
      throw Errors.config(
        WATCHER_ID + ': specialTransitions[] needs toStatus or fromStatus; ' +
        'a rule that matches everything would shadow the general channel');
    }
    return {
      name: entry.name || Templates.LABELS.TRANSITION,
      channelKey: notify.channelKey,
      template: notify.template,
      toStatus: asCode(entry.toStatus),
      fromStatus: asCode(entry.fromStatus),
      // 遷移前が不明（その進捗を初めて観測した）ときに一致とみなすか。
      // 既定は「一致とみなす」。取りこぼしは通知漏れであり、重複通知より重い
      // （rules/30-state-and-idempotency.md）
      fromStatusRequired: !!entry.fromStatusRequired,
      isSpecial: true,
    };
  }

  /** 特別ルールに当たるか。 */
  function ruleMatches(rule, toStatus, fromStatus) {
    if (rule.toStatus !== null && toStatus !== rule.toStatus) return false;
    if (rule.fromStatus === null) return true;
    if (fromStatus === null) return !rule.fromStatusRequired;
    return fromStatus === rule.fromStatus;
  }

  /** 先に書かれた特別ルールが勝つ。どれにも当たらなければ一般ルール。 */
  function matchRule(cfg, rules, toStatus, fromStatus) {
    for (let i = 0; i < rules.specials.length; i++) {
      if (ruleMatches(rules.specials[i], toStatus, fromStatus)) return rules.specials[i];
    }
    if (cfg.notifyAllTransitions) return rules.general;
    if (toStatus !== null && (cfg.watchedStatuses || []).indexOf(toStatus) >= 0) {
      return rules.general;
    }
    return null;
  }

  // --- 起動時チェック ------------------------------------------------------

  /**
   * 設定が実環境と合っているかを確かめる。**合っていなければ起動を失敗させる。**
   * 黙って無視すると、通知が出ないことに気づけないまま運用が始まる。
   */
  function validate(ctx) {
    const cfg = ctx.config;
    const rules = buildRules(cfg);

    ctx.schema.validate(HISTORY_RESOURCE, [HISTORY_INSERT_DATE].concat(HISTORY_ITEMS),
      ctx.budget);
    ctx.schema.validate(PROGRESS_RESOURCE, PROGRESS_ITEMS, ctx.budget);

    // 名前解決に使う項目も実在検証の対象にする。
    // 存在しない項目 ID を書くと、通知が届いてから初めて気づくことになる
    NAME_KINDS.forEach(function (kind) {
      const resource = ctx.resolver.resourceOf(kind);
      if (!resource) {
        Log.warn('name_resolution_missing', {
          watcher_id: WATCHER_ID, kind: kind,
          hint: 'add it to nameResolution in core/config.js',
        });
        return;
      }
      ctx.schema.validate(resource, ctx.resolver.itemIds(kind), ctx.budget);
      ctx.resolver.validateTemplate(kind);
    });

    rules.specials.concat([rules.general]).forEach(function (rule) {
      const template = ctx.templates.get(rule.template);
      if (!template) {
        throw Errors.config(WATCHER_ID + ': template "' + rule.template + '" not found');
      }
      checkTemplate(rule, template);
      if (!ctx.dispatcher.supports(rule.channelKey)) {
        throw Errors.config(
          WATCHER_ID + ': no notifier handles channel "' + rule.channelKey + '"');
      }
    });

    const summary = {
      watcher_id: WATCHER_ID,
      resource: HISTORY_RESOURCE,
      notify_all_transitions: !!cfg.notifyAllTransitions,
      watched_statuses: cfg.watchedStatuses || [],
      channel_key: rules.general.channelKey,
      special_transitions: rules.specials.map(function (r) {
        return { name: r.name, to_status: r.toStatus, from_status: r.fromStatus,
                 channel_key: r.channelKey };
      }),
    };
    Log.info('watcher_validated', summary);
    return summary;
  }

  /**
   * テンプレートに未定義の変数が書かれていないかを**起動時に**確かめる。
   *
   * 通知の組み立て時に落ちると、そのイベントは dead letter にすら載らずに
   * 1サイクル丸ごと失敗する。設定不備は起動時に出す。
   */
  function checkTemplate(rule, template) {
    const probe = {};
    TEMPLATE_FIELDS.forEach(function (key) { probe[key] = ''; });
    if (template.body === undefined) {
      throw Errors.config(WATCHER_ID + ': template "' + rule.template + '" has no body');
    }
    ['subject', 'body'].forEach(function (field) {
      if (template[field] === undefined) return;
      try {
        Templates.render(template[field], probe);
      } catch (e) {
        throw Errors.config(
          WATCHER_ID + ': template "' + rule.template + '".' + field + ' uses an unknown ' +
          'variable (' + e.message + '). Available: ' + TEMPLATE_FIELDS.join(', '));
      }
    });
  }

  // --- 本体 ----------------------------------------------------------------

  function execute(ctx) {
    const cfg = ctx.config;
    if (!ctx.cursor || !ctx.cursor.bootstrapped) {
      throw Errors.config(
        WATCHER_ID + ': no baseline yet. Run bootstrapProgressFlow() first ' +
        '(without it, every existing progress history would be notified)');
    }
    const rules = buildRules(cfg);
    const overlapSeconds = cfg.overlapSeconds === undefined
      ? Watchers.DEFAULTS.overlapSeconds : cfg.overlapSeconds;
    const since = TimeFmt.shiftSeconds(ctx.cursor.value, -overlapSeconds);

    const found = Paging.searchIds(HISTORY_RESOURCE, {
      condition: {
        compoundType: 'and',
        items: [{
          itemId: HISTORY_INSERT_DATE,
          searchType: 'GE',
          // datetime は YYYY/MM/DD HH:MM:SS。秒精度は実際に効く（実測）
          value: TimeFmt.toCpDatetime(since),
        }],
      },
      // 古い順に処理する。**同一進捗で複数の遷移が同時に来たとき、
      // 順序が狂うと遷移前ステータスの持ち越しが壊れる**
      sort: [{ itemId: HISTORY_INSERT_DATE, order: 'asc' }],
      budget: ctx.budget,
      watcherId: WATCHER_ID,
      maxPages: Config.limits.maxPagesPerCycle,
    });
    Log.info('search_done', {
      watcher_id: WATCHER_ID, resource: HISTORY_RESOURCE,
      candidate_count: found.ids.length, since: TimeFmt.toStore(since),
    });

    let detected = 0;
    let notified = 0;
    ctx.dispatcher.beginCycle();
    try {
      for (let i = 0; i < found.ids.length; i++) {
        if (processOne(ctx, rules, found.ids[i])) detected += 1;
      }
    } finally {
      notified = ctx.dispatcher.endCycle();
      // キャッシュの効きを見る。ヒット率が低いと流量が跳ねる（仕様書 3.2.8）
      Log.info('name_cache', ctx.resolver.stats());
    }

    if (found.capped) {
      // 全件を見きれていない。**カーソルも持ち越しも進めない**（仕様書 11.4）
      return Events.exhausted({ eventsDetected: detected, eventsNotified: notified });
    }
    return Events.result({
      ok: true,
      eventsDetected: detected,
      eventsNotified: notified,
      // サイクルの開始時刻を入れる。終了時刻だと走査中の追加が次の検索から漏れる
      cursor: { value: ctx.startedAt, pageOffset: 0, bootstrapped: true },
    });
  }

  /**
   * 基準を作るだけ。**通知しない。リクエストも使わない。**
   *
   * このウォッチャーは「履歴が増えたこと」自体がイベントなので、
   * 項目値のスナップショットは要らない（仕様書 3.2.3 手順7）。
   * 必要なのは「ここから先を見る」というカーソルだけ。
   *
   * 既存の進捗履歴（検証テナントで27件、本番では相応の件数）を全部通知して
   * しまわないよう、**現在時刻をカーソルに置く。**
   */
  function bootstrap(ctx) {
    if (ctx.cursor && ctx.cursor.bootstrapped) {
      Log.info('bootstrap_skipped', { watcher_id: WATCHER_ID, reason: 'already done' });
      return Events.result({ ok: true });
    }
    Log.info('bootstrap_done', {
      watcher_id: WATCHER_ID, resource: HISTORY_RESOURCE,
      cursor_value: TimeFmt.toStore(ctx.startedAt),
      note: 'no snapshot needed; history rows are the events',
    });
    return Events.result({
      ok: true,
      cursor: { value: ctx.startedAt, pageOffset: 0, bootstrapped: true },
    });
  }

  // --- 1件ぶんの処理 --------------------------------------------------------

  /**
   * 進捗履歴1件を通知に変える。通知したら true。
   *
   * 順序: select → 判定 → **通知 → 遷移前ステータスの持ち越し更新。**
   * 持ち越しを先に更新すると、通知に失敗したときに遷移前の値が失われる。
   */
  function processOne(ctx, rules, historyId) {
    const history = CpClient.select(HISTORY_RESOURCE, historyId, HISTORY_ITEMS, ctx.budget);
    const identity = identify(historyId, history);

    if (identity.progressId === null) {
      // ID の形式が想定と違う。ここで例外にすると同じ行で毎サイクル止まるので、
      // 人が見る dead letter に落として先へ進む（rules/10-cp-api.md の 400 相当）
      ctx.state.addDeadLetter(WATCHER_ID, JSON.stringify({ history_id: historyId }),
        'cannot determine progress id from history id');
      Log.error('history_id_unparsed', { watcher_id: WATCHER_ID, resource_id: historyId });
      return false;
    }

    const toStatus = asCode(history[HISTORY_STATUS]);
    const fromStatus = loadLastStatus(ctx, identity.progressId);

    const rule = matchRule(ctx.config, rules, toStatus, fromStatus);
    if (!rule) {
      Log.debug('transition_filtered', {
        watcher_id: WATCHER_ID, resource_id: historyId, to_status: toStatus,
      });
      // **通知しなかった遷移でも持ち越しは更新する。**
      // 飛ばすと次の通知の「遷移前」が古い値になる（仕様書 3.2.3）
      storeLastStatus(ctx, identity.progressId, toStatus);
      return false;
    }

    const progress = CpClient.select(
      PROGRESS_RESOURCE, identity.progressId, PROGRESS_ITEMS, ctx.budget);
    const transition = {
      historyId: historyId,
      progressId: identity.progressId,
      progressSub: identity.progressSub,
      fromStatus: fromStatus,
      toStatus: toStatus,
      history: history,
      progress: progress,
    };

    // ⚠️ 値そのものはログに出さない（rules/40-secrets-and-security.md）
    Log.info('transition_detected', {
      watcher_id: WATCHER_ID, resource_id: historyId, progress_id: identity.progressId,
      from_status: fromStatus, to_status: toStatus, rule: rule.name, special: rule.isSpecial,
    });
    ctx.dispatcher.dispatchOne(buildNotification(ctx, rule, transition));

    storeLastStatus(ctx, identity.progressId, toStatus);
    return true;
  }

  /**
   * 遷移前ステータスの持ち越し。**シートへの書き戻しは Runner がコミットするときだけ。**
   * 差分検知のためではないので、値はハッシュではなく生で持つ（表示に使うため）。
   */
  function loadLastStatus(ctx, progressId) {
    const raw = ctx.rawValues.rawOf(progressId, LAST_STATUS_KEY);
    if (!raw.hasRaw) return null;
    return asCode(raw.value);
  }

  function storeLastStatus(ctx, progressId, status) {
    ctx.rawValues.putRaw(progressId, LAST_STATUS_KEY, status);
  }

  function buildNotification(ctx, rule, transition) {
    const template = ctx.templates.get(rule.template);
    if (!template) {
      throw Errors.config(WATCHER_ID + ': template "' + rule.template + '" not found');
    }
    const progress = transition.progress;
    const history = transition.history;

    const fields = {
      transition_name: rule.name,
      resource_id: transition.historyId,
      progress_id: transition.progressId,
      progress_sub: transition.progressSub,
      from_status: transition.fromStatus === null ? '' : transition.fromStatus,
      to_status: transition.toStatus === null ? '' : transition.toStatus,
      from_label: statusLabel(ctx, transition.fromStatus),
      to_label: statusLabel(ctx, transition.toStatus),
      progress_date: asText(history[HISTORY_PROGRESS_DATE]) || Templates.LABELS.UNSET,
      career_name: ctx.resolver.resolve('career', progress[PROGRESS_CAREER_ID], ctx.budget),
      order_name: ctx.resolver.resolve('order', progress[PROGRESS_ORDER_ID], ctx.budget),
      client_name: ctx.resolver.resolve('client', progress[PROGRESS_CLIENT_ID], ctx.budget),
      progress_charge: codeLabel(ctx, PROGRESS_RESOURCE, PROGRESS_CHARGE,
        progress[PROGRESS_CHARGE]),
      career_charge: codeLabel(ctx, HISTORY_RESOURCE, HISTORY_CAREER_CHARGE,
        history[HISTORY_CAREER_CHARGE]),
      order_charge: codeLabel(ctx, HISTORY_RESOURCE, HISTORY_ORDER_CHARGE,
        history[HISTORY_ORDER_CHARGE]),
      // 「求人紹介OK」の小画面で入力する3項目。単位（万円）は文言なので
      // テンプレート側のラベルに書く（rules/50-code-style.md）
      estimated_amount: asNumber(history[HISTORY_ESTIMATED_AMOUNT]),
      estimated_accuracy: codeLabel(ctx, HISTORY_RESOURCE, HISTORY_ESTIMATED_ACCURACY,
        history[HISTORY_ESTIMATED_ACCURACY]),
      estimated_month: asText(history[HISTORY_ESTIMATED_MONTH]) || Templates.LABELS.UNSET,
    };

    // ⚠️ **遷移前ステータスをダイジェストに入れない**（仕様書 3.2.4）。
    // オーバーラップで同じ履歴を再取得したとき、持ち越し済みの値と突き合わせると
    // 別のダイジェストになり、重複除去をすり抜けて二重通知になる。
    // 進捗履歴は追記専用なので、履歴 ID と自身の内容だけで一意に決まる
    const digest = State.payloadHash([
      transition.toStatus,
      asText(history[HISTORY_PROGRESS_DATE]),
      history[HISTORY_ESTIMATED_AMOUNT],
      history[HISTORY_ESTIMATED_ACCURACY],
      history[HISTORY_ESTIMATED_MONTH],
    ]);

    return Events.notification({
      watcherId: WATCHER_ID,
      // 枝番を含む履歴 ID。後戻り（16 → 11 → 16）を別イベントとして区別できる
      resourceId: transition.historyId,
      eventType: EVENT_TYPE,
      digest: digest,
      channelKey: rule.channelKey,
      subject: Templates.renderField(template, 'subject', fields, '[CP] 進捗が動きました'),
      body: Templates.renderField(template, 'body', fields),
      meta: { resource: HISTORY_RESOURCE, progress_id: transition.progressId,
              rule: rule.name },
    });
  }

  /**
   * 進捗ステータスのコードをラベルにする。
   *
   * 参照マスタ名（`MST_PROGRESS_STATUS`）は schema の validationRule.codeName から
   * 取れるので、設定にもコードにも書かない。
   */
  function statusLabel(ctx, status) {
    // 初めて観測する進捗には遷移前の値が存在しない。推測で埋めない
    if (status === null) return Templates.LABELS.UNKNOWN;
    return codeLabel(ctx, HISTORY_RESOURCE, HISTORY_STATUS, status);
  }

  /** コード値をラベルにする。参照マスタ名は schema から解決するので書かない。 */
  function codeLabel(ctx, resource, itemId, value) {
    const definition = ctx.schema.describe(resource, itemId, ctx.budget);
    return ctx.master.label(definition ? definition.codeName : null, value, ctx.budget);
  }

  // --- 小物 ----------------------------------------------------------------

  /**
   * 進捗 ID と枝番を決める。
   *
   * レスポンスに含まれる値を優先し、無ければ ID 文字列を分解する（`{progressId}_{枝番}`）。
   * **枝番の起点はリソースによって違う**（progress_history は 1 始まり、
   * career_action は 0 始まり）ので、起点を前提にした判定を書かないこと。
   */
  function identify(historyId, history) {
    let progressId = asCode(history[HISTORY_PROGRESS_ID]);
    // 枝番は number。**`0` を未設定に潰してはいけない**
    // （career_action は 0 始まり。同じ分解処理を将来使い回すため）
    const subValue = State.canonicalValue(history[HISTORY_PROGRESS_ID_SUB], 'number');
    let progressSub = subValue === null ? null : String(subValue);

    const at = String(historyId).lastIndexOf('_');
    if (at > 0) {
      if (progressId === null) progressId = String(historyId).slice(0, at);
      if (progressSub === null) progressSub = String(historyId).slice(at + 1);
    }
    return { progressId: progressId, progressSub: progressSub || '' };
  }

  /**
   * CP の値をコード文字列に揃える。
   *
   * number は JSON 数値で返るので `21` / `21.0` / `"21"` を同じ ID として扱う。
   * 未設定（null / 空 / 選択項目の `0`）は null。
   */
  function asCode(value) {
    const normalized = State.canonicalValue(value, 'selectone');
    return normalized === null ? null : String(normalized);
  }

  function asText(value) {
    return (value === null || value === undefined) ? '' : String(value);
  }

  /**
   * number を通知用の文字列にする。
   * CP は number を JSON 数値で返すので `300.0` を `300` に直す。
   * **`0` は正当な値なので潰さない**（未設定は null）。
   */
  function asNumber(value) {
    const normalized = State.canonicalValue(value, 'number');
    return normalized === null ? Templates.LABELS.UNSET : String(normalized);
  }

  /** 設定の浅いマージ。notify だけは中身も引き継ぐ。 */
  function merge(base, overrides) {
    const out = {};
    Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    Object.keys(overrides || {}).forEach(function (k) { out[k] = overrides[k]; });
    out.notify = {};
    Object.keys(base.notify).forEach(function (k) { out.notify[k] = base.notify[k]; });
    Object.keys((overrides || {}).notify || {}).forEach(function (k) {
      out.notify[k] = overrides.notify[k];
    });
    return out;
  }

  return {
    WATCHER_ID: WATCHER_ID,
    EVENT_TYPE: EVENT_TYPE,
    HISTORY_RESOURCE: HISTORY_RESOURCE,
    PROGRESS_RESOURCE: PROGRESS_RESOURCE,
    HISTORY_ITEMS: HISTORY_ITEMS,
    PROGRESS_ITEMS: PROGRESS_ITEMS,
    LAST_STATUS_KEY: LAST_STATUS_KEY,
    create: create,
    // テストから直接呼ぶ内部
    buildRules: buildRules,
    matchRule: matchRule,
    identify: identify,
    validate: validate,
  };
})();
