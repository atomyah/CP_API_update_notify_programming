/**
 * 要件4 — 対応履歴が登録・更新・完了したら、**求職者の担当者にメールを送る。**
 *
 * 仕様の根拠は仕様書 3.3節。**設定は core/config.js の careerActionWatch。**
 * **Python 版には実装が無い**（メール送信がペンディングだったため）。ここが初実装。
 *
 * ## ⚠️ なぜ「更新日時で検索する」ができないのか（仕様書 3.3.1）
 *
 * **`career_action` には `INSERT_DATE` も `UPDATE_DATE` も無い。**
 * 持っている日付は3つとも**ユーザが入力した業務上の日付**で、レコードの変更時刻ではない。
 * さらに**対応履歴を操作しても親（求職者）の `CAREER#UPDATE_DATE` は動かない**（実測で確定）。
 *
 * **→「いつ変更されたか」を CP に問い合わせる手段が存在しない。**
 * このため ID 集合の差分と日付窓を組み合わせた**戦略B**を採る。
 *
 * ```
 * A. career_action/search（30日窓）        → ID 集合 S30           …約4 req
 * B. S30 − S30_prev                        → 「新規登録」の候補
 * C. career_action/search（3日窓）          → ID 集合 S3            …約1 req
 * D. (S3 ∪ 新規候補) を1件ずつ select       → 判定材料・本文・宛先が1リクエストで揃う
 * E. snapshots の日付3項目と比べて分類（登録 / 更新 / 完了）
 * F. メール送信。**宛先が空ならスキップして件数を数える**（仕様書 3.3.6）
 * G. snapshots と S30 を書き戻し、最後にカーソル（Runner がコミットする）
 * ```
 *
 * **30日窓を広く取るのは安いから。**ID しか返らないので 1,200件でも12リクエスト。
 * **3日窓を狭くするのは高いから。**`select` は 1リクエスト = 1レコード。
 *
 * ## S30_prev（前回の30日窓）を持つ理由
 *
 * 古いレコードの日付が変更されて窓に入ってきたとき、snapshots に無いため
 * 「新規登録」と誤通知してしまう。**前回の30日窓の ID 集合と突き合わせれば
 * 追加コストゼロで正しく分類できる**（仕様書 3.3.4 の E）。
 * 置き場所は `id_sets` シート（仕様書 11.3・core/state.js の `idSets`）。
 *
 * ## ⚠️ 宛先を取り違えない（仕様書 3.3.5）
 *
 * 宛先は **`CAREER#CHARGE_EMAIL`（求職者の担当者）**であり、
 * `CAREER_ACTION#ACTIONCHARGE_ID`（対応の担当）ではない。
 * **実測で別人のケースを確認している。**取り違えると誤送信になる。
 * 担当者変更の直後に旧担当へ送らないよう、宛先はキャッシュせず毎回 select で取り直す
 * （同じリクエストなので追加コストはゼロ）。
 *
 * ## 拾えないもの（仕様書 3.3.8）
 *
 * - 日付を「古い値」から「別の古い値」に変えた（30日窓には居るが3日窓に入らない）
 * - 3つの日付を1つも入力しない対応履歴（そもそも通知すべき日付が無い）
 * - 対応履歴の**削除**（削除は検索に現れない。要件外）
 *
 * **窓の外にある「間は」見えないだけで永久ではない。**日付が最近の値に変われば入ってくる。
 */
const CareerActionWatcher = (function () {

  const WATCHER_ID = 'career_action_watch';

  // 冪等キーの event_type。**文面だけを出し分ける。検知機構は1つ**（仕様書 3.3.2）
  const EVENT = {
    CREATED: 'created',
    UPDATED: 'updated',
    COMPLETED: 'completed',
  };

  // 項目 ID をコードに直書きせず1箇所に集約する（rules/10-cp-api.md）。
  // 起動時に実環境の schema と突き合わせ、存在しなければ**起動を失敗させる。**
  const RESOURCE = 'career_action';
  const CAREER_RESOURCE = 'career';

  const ACTION_DATE = 'CAREER_ACTION#ACTION_DATE';
  const COMPLETE_DATE = 'CAREER_ACTION#COMPLETE_DATE';
  const NEXTACTION_DATE = 'CAREER_ACTION#NEXTACTION_DATE';
  const ACTION_ID = 'CAREER_ACTION#ACTION_ID';
  const ACTIONMEMO = 'CAREER_ACTION#ACTIONMEMO';
  const ACTIONCHARGE_ID = 'CAREER_ACTION#ACTIONCHARGE_ID';
  const CAREER_ID = 'CAREER_ACTION#CAREER_ID';
  const HISTSEQ = 'CAREER_ACTION#HISTSEQ';

  /**
   * `id_sets` シートで「前回の30日窓に居た」印を置く列（仕様書 3.3.4 の B）。
   * **列位置ではなく名前で引く**（core/state.js の SnapshotSet）。
   */
  const DISCOVERY_SET = 'discovery_window';

  /**
   * ページングのソート。**必ず2キーで指定する。**
   * `HISTSEQ` は求職者ごとの連番でグローバルには一意にならないため、
   * 1キーだけではページングが安定しない（実測で2キーの動作を確認済み）。
   */
  const SORT = [
    { itemId: CAREER_ID, order: 'asc' },
    { itemId: HISTSEQ, order: 'asc' },
  ];

  // 通知本文で使える変数。**起動時にテンプレートを検査するために使う**
  const TEMPLATE_FIELDS = [
    'career_name', 'career_id', 'resource_id', 'histseq',
    'action_type', 'action_charge', 'action_memo', 'changes',
  ];

  // メモ本文が長いとメールが読みにくい。全文が要るなら CP の画面を見る
  const MEMO_CLIP = 2000;

  /**
   * ウォッチャーを1つ作る。
   * @param overrides 設定の上書き（テストとブートストラップの予算差し替えに使う）
   */
  function create(overrides) {
    const config = merge(Config.careerActionWatch, overrides);
    return Watchers.define(WATCHER_ID, config, {
      execute: execute,
      bootstrap: bootstrap,
      validate: validate,
      channelKeys: function () { return [config.notify.channelKey]; },
    });
  }

  // --- 起動時チェック ------------------------------------------------------

  /**
   * 設定が実環境と合っているかを確かめる。**合っていなければ起動を失敗させる。**
   * 黙って無視すると、通知が出ないことに気づけないまま運用が始まる。
   */
  function validate(ctx) {
    const cfg = ctx.config;

    if (!(cfg.discoveryWindowDays > 0) || !(cfg.changeWindowDays > 0)) {
      throw Errors.config(WATCHER_ID + ': discoveryWindowDays and changeWindowDays must be > 0');
    }
    if (cfg.changeWindowDays > cfg.discoveryWindowDays) {
      // 変更検知の窓が新規検知の網より広いと、S30_prev による分類が意味を失う
      throw Errors.config(
        WATCHER_ID + ': changeWindowDays must not exceed discoveryWindowDays ' +
        '(the discovery window is what classifies new records)');
    }
    if (cfg.notify.onMissingAddress !== 'skip') {
      // 業務側の決定（仕様書 3.3.6）。勝手に別の宛先へ送らない
      throw Errors.config(
        WATCHER_ID + ': notify.onMissingAddress must be "skip" (see the spec 3.3.6)');
    }

    // 対応履歴側の項目
    ctx.schema.validate(RESOURCE, unique(
      itemIdsOf(cfg.triggerItems)
        .concat(cfg.bodyItems)
        .concat(cfg.identityItems)
        .concat([cfg.completeItem])), ctx.budget);

    // 関連リソース（求職者）側の項目。**同じ select に混ぜられる**（実測 V-3a）が、
    // schema は別リソースなので検証も別に行う
    ctx.schema.validate(CAREER_RESOURCE, unique(
      cfg.careerNameItems
        .concat([cfg.notify.toItem])
        .concat(conditionItemIds(cfg.populationCondition))), ctx.budget);

    const items = resolveItems(ctx);
    Object.keys(cfg.notify.templates).forEach(function (kind) {
      const name = cfg.notify.templates[kind];
      const template = ctx.templates.get(name);
      if (!template) {
        throw Errors.config(WATCHER_ID + ': template "' + name + '" not found');
      }
      checkTemplate(name, template);
    });
    if (!ctx.dispatcher.supports(cfg.notify.channelKey)) {
      throw Errors.config(
        WATCHER_ID + ': no notifier handles channel "' + cfg.notify.channelKey + '"');
    }

    const summary = {
      watcher_id: WATCHER_ID,
      resource: RESOURCE,
      trigger_items: items.map(function (i) { return i.itemId; }),
      body_items: cfg.bodyItems,
      to_item: cfg.notify.toItem,
      discovery_window_days: cfg.discoveryWindowDays,
      change_window_days: cfg.changeWindowDays,
      population_condition: !!cfg.populationCondition,
      channel_key: cfg.notify.channelKey,
      enabled: !!cfg.enabled,
    };
    Log.info('watcher_validated', summary);
    return summary;
  }

  /**
   * テンプレートに未定義の変数が書かれていないかを**起動時に**確かめる。
   * 通知の組み立て時に落ちると1サイクル丸ごと失敗する。
   */
  function checkTemplate(name, template) {
    const probe = {};
    TEMPLATE_FIELDS.forEach(function (key) { probe[key] = ''; });
    if (template.body === undefined) {
      throw Errors.config(WATCHER_ID + ': template "' + name + '" has no body');
    }
    ['subject', 'body'].forEach(function (field) {
      if (template[field] === undefined) return;
      try {
        Templates.render(template[field], probe);
      } catch (e) {
        throw Errors.config(
          WATCHER_ID + ': template "' + name + '".' + field + ' uses an unknown variable (' +
          e.message + '). Available: ' + TEMPLATE_FIELDS.join(', '));
      }
    });
    if (template.change_line !== undefined) {
      try {
        Templates.render(template.change_line, { label: '', old: '', new: '' });
      } catch (e) {
        throw Errors.config(
          WATCHER_ID + ': template "' + name + '".change_line uses an unknown variable (' +
          e.message + '). Available: label, old, new');
      }
    }
  }

  // --- 本体 ----------------------------------------------------------------

  function execute(ctx) {
    const cfg = ctx.config;

    // ⚠️ **送信可否の確認が取れていない状態で本物の担当者へ送らない**
    // （to-do/Phase6.md の「やらないこと」）。検知ロジックの確認は
    // runCareerActionDryRun()（管理者アドレスへ寄る）で行う。
    // 失敗ではないので `skipped` で抜ける（連続失敗カウンタを進めない）
    if (!cfg.enabled && !ctx.dryRun) {
      Log.warn('watcher_disabled', {
        watcher_id: WATCHER_ID,
        hint: 'confirm mail sending (checkMail / sendTestMail), then set ' +
              'careerActionWatch.enabled = true. Until then use runCareerActionDryRun()',
      });
      return Events.skipped('disabled');
    }

    if (!ctx.cursor || !ctx.cursor.bootstrapped) {
      throw Errors.config(
        WATCHER_ID + ': no baseline yet. Run bootstrapCareerAction() first ' +
        '(without it, every action in the window would be mailed out)');
    }

    const items = resolveItems(ctx);
    const idSets = ctx.state.idSets(WATCHER_ID);

    // A. 30日窓（新規検知の広い網）。**ID しか返らないので広くても安い**
    const discovery = searchWindow(ctx, cfg, cfg.discoveryWindowDays, 'discovery');
    if (discovery.capped) {
      // 集合が不完全。**ここで S30_prev を作り替えると、見えなかった ID が
      // 次サイクルで「新規」に化ける。**何も書かずに次サイクルへ持ち越す
      return Events.exhausted();
    }

    // C. 3日窓（日付変更の検知）
    const change = searchWindow(ctx, cfg, cfg.changeWindowDays, 'change');
    if (change.capped) return Events.exhausted();

    // B. 前回の30日窓に居なかった ID が「新規登録」の候補
    const wasInWindow = {};
    idSets.resourceIds().forEach(function (id) {
      if (idSets.getCell(id, DISCOVERY_SET) !== null) wasInWindow[id] = true;
    });
    const fresh = discovery.ids.filter(function (id) { return !wasInWindow[id]; });

    // D. 3日窓 ∪ 新規候補。**この件数がそのまま select の回数**
    const targets = unique(change.ids.concat(fresh));
    Log.info('scan_planned', {
      watcher_id: WATCHER_ID,
      discovery_ids: discovery.ids.length,
      change_ids: change.ids.length,
      fresh_ids: fresh.length,
      select_targets: targets.length,
      budget_remaining: ctx.budget.remaining,
    });

    let detected = 0;
    let notified = 0;
    ctx.dispatcher.beginCycle();
    try {
      for (let i = 0; i < targets.length; i++) {
        if (processOne(ctx, targets[i], items, wasInWindow, true)) detected += 1;
      }
    } finally {
      notified = ctx.dispatcher.endCycle();
    }

    // G. 今回の30日窓を S30_prev として持ち越す。**書き戻しは Runner のコミット点。**
    rememberWindow(idSets, discovery.ids);

    return Events.result({
      ok: true,
      eventsDetected: detected,
      eventsNotified: notified,
      // サイクルの開始時刻を入れる。窓は絶対値なのでカーソルは検索に使わないが、
      // 「どこまで見終わったか」の目印になる（日次サマリの遅れ検知・仕様書 8.6）
      cursor: { value: ctx.startedAt, pageOffset: 0, bootstrapped: true },
    });
  }

  /**
   * 基準を作るだけ。**通知しない。**
   *
   * 作るものは2つ:
   *
   * 1. **30日窓の ID 集合**（S30_prev）。これが無いと、既に存在する対応履歴が
   *    すべて「新規登録」として通知される
   * 2. **3日窓の各レコードの日付3項目**。これが無いと、次のサイクルで
   *    3日窓の全件が「更新」として通知される
   *
   * ⚠️ 予算切れ・時間切れは例外にせず、**そこまでの結果を持ってコミットさせる。**
   * 例外にすると Runner が何も書かず、何回実行しても進まない。
   */
  function bootstrap(ctx) {
    const cfg = ctx.config;
    if (ctx.cursor && ctx.cursor.bootstrapped) {
      Log.info('bootstrap_skipped', { watcher_id: WATCHER_ID, reason: 'already done' });
      return Events.result({ ok: true });
    }

    const items = resolveItems(ctx);
    const idSets = ctx.state.idSets(WATCHER_ID);
    const startedAt = ctx.cursor ? ctx.cursor.value : ctx.startedAt;

    const discovery = searchWindow(ctx, cfg, cfg.discoveryWindowDays, 'discovery');
    if (discovery.capped) return Events.exhausted();
    const change = searchWindow(ctx, cfg, cfg.changeWindowDays, 'change');
    if (change.capped) return Events.exhausted();

    let processed = 0;
    let done = true;
    try {
      for (let i = 0; i < change.ids.length; i++) {
        if (!canContinue(ctx.budget)) { done = false; break; }
        // 既に基準がある ID は飛ばす（再開時の再取得を避ける）
        if (ctx.snapshots.has(change.ids[i])) continue;
        processOne(ctx, change.ids[i], items, {}, false);
        processed += 1;
      }
    } catch (e) {
      if (!Errors.is(e, Errors.KIND.BUDGET)) throw e;
      done = false;
      Log.info('bootstrap_interrupted', {
        watcher_id: WATCHER_ID, processed_this_cycle: processed,
      });
    }

    // ID 集合は検索が完走しているので、途中で切り上げても記録してよい
    rememberWindow(idSets, discovery.ids);

    Log.info(done ? 'bootstrap_done' : 'bootstrap_paused', {
      watcher_id: WATCHER_ID,
      resource: RESOURCE,
      discovery_ids: discovery.ids.length,
      change_ids: change.ids.length,
      processed_this_cycle: processed,
      snapshot_rows: ctx.snapshots.count(),
      note: done ? 'actions changed after this point will be mailed'
                 : 'run bootstrapCareerAction() again to continue',
    });
    return Events.result({
      ok: true,
      // ⚠️ bootstrapped が true になるまで execute() は動かない（誤送信の防止）
      cursor: { value: startedAt, pageOffset: 0, bootstrapped: done },
    });
  }

  // --- 検索 ----------------------------------------------------------------

  /** 走査窓の ID 集合を取る。**capped なら全件を見きれていない。** */
  function searchWindow(ctx, cfg, days, label) {
    const since = TimeFmt.shiftDays(ctx.startedAt, -days);
    const found = Paging.searchIds(RESOURCE, {
      condition: buildCondition(cfg, since),
      sort: SORT,
      budget: ctx.budget,
      watcherId: WATCHER_ID,
      maxPages: Config.limits.maxPagesPerCycle,
    });
    Log.info('search_done', {
      watcher_id: WATCHER_ID, resource: RESOURCE, window: label,
      window_days: days, since: TimeFmt.toStore(since),
      candidate_count: found.ids.length, capped: found.capped,
    });
    return found;
  }

  /**
   * 走査窓の検索条件（仕様書 3.3.4 の A / C）。
   *
   * **3つの日付の OR 和集合。**1リクエストで取れることを実測済み（V-3e）。
   * 窓は `GE <今日 − N日>` なので**未来日は常に含まれる**（`ACTION_DATE` は
   * 未来日を取りうる。実測）。下限だけを気にすればよい。
   *
   * 母集団の絞り込み（`CAREER#CHARGE_ID ENTERED`）を and で重ねる。
   * **通知しない求職者は走査もしない**のが走査量を決める最重要の設定（仕様書 3.3.3）。
   */
  function buildCondition(cfg, since) {
    const window = {
      compoundType: 'or',
      items: [
        { itemId: ACTION_DATE, searchType: 'GE', value: TimeFmt.toCpDate(since) },
        { itemId: COMPLETE_DATE, searchType: 'GE', value: TimeFmt.toCpDate(since) },
        // datetime。日付だけでも 00:00:00 として扱われるが、下限であることを明示する
        { itemId: NEXTACTION_DATE, searchType: 'GE', value: TimeFmt.toCpDayStart(since) },
      ],
    };
    if (!cfg.populationCondition) return window;
    return { compoundType: 'and', items: [cfg.populationCondition, window] };
  }

  /**
   * 今回の30日窓を S30_prev として持ち越す。**窓から外れた ID は落とす。**
   *
   * 落とさないと集合が「かつて一度でも窓に入った ID」になり、
   * 30日窓の意味（＝直近の活動量に比例させる）が失われて無限に伸びる。
   * **シートへの書き戻しは Runner がコミットすると決めたときだけ**（仕様書 11.4）。
   */
  function rememberWindow(idSets, ids) {
    const current = {};
    ids.forEach(function (id) {
      current[id] = true;
      idSets.setCell(id, DISCOVERY_SET, '1');
    });
    idSets.resourceIds().forEach(function (id) {
      if (!current[id]) idSets.remove(id);
    });
  }

  // --- 1レコードぶんの処理 --------------------------------------------------

  /**
   * 対応履歴1件を取得し、分類し、通知してからスナップショットを更新する。
   *
   * 順序: select → 分類 → **通知 → スナップショット更新（メモリ上）。**
   * スナップショットを先に更新して通知に失敗すると、その変化は永久に通知されない。
   *
   * @param wasInWindow 前回の30日窓に居た ID の集合（分類に使う）
   * @param notify      false ならブートストラップ（基準を作るだけ）
   * @return 変化を検知したか
   */
  function processOne(ctx, resourceId, items, wasInWindow, notify) {
    const cfg = ctx.config;
    // ⚠️ **重複した itemId は 400 になる**（実測）。順序を保って一意化する
    const values = CpClient.select(RESOURCE, resourceId, selectItemIds(cfg), ctx.budget);
    const event = notify ? classify(ctx, resourceId, values, items, wasInWindow) : null;

    if (event) {
      // ⚠️ 値そのものはログに出さない（rules/40-secrets-and-security.md）
      Log.info('action_detected', {
        watcher_id: WATCHER_ID, resource: RESOURCE, resource_id: resourceId,
        event_type: event.eventType, changed_count: event.changes.length,
      });
      dispatch(ctx, resourceId, values, event);
    }

    // **メモリ上のスナップショットを更新するだけ。**シートへの書き戻しは Runner。
    // ⚠️ **宛先の有無に関わらず更新する**（仕様書 3.3.6）。担当者が後から
    // 設定されても過去分は遡って通知しない
    items.forEach(function (item) {
      const value = values[item.itemId];
      ctx.snapshots.put(resourceId, item.itemId, value, item.itemType);
      if (keepsRaw(cfg, item.itemId)) {
        ctx.rawValues.putRaw(resourceId, item.itemId, value);
      }
    });
    return !!event;
  }

  /**
   * 何が起きたのかを決める（仕様書 3.3.4 の E）。
   *
   * ```
   * snapshots に日付がある:
   *     COMPLETE_DATE が null → 値            → 「対応完了」
   *     それ以外で日付3項目のいずれかが変化   → 「更新」
   *     変化なし                              → 通知しない
   * snapshots に無い:
   *     S30_prev にも居なかった               → 「新規登録」
   *     S30_prev には居た                     → 「更新」（日付が変わって窓に入った）
   * ```
   *
   * @return null なら通知しない
   */
  function classify(ctx, resourceId, values, items, wasInWindow) {
    if (ctx.snapshots.has(resourceId)) {
      const changes = detectChanges(ctx, resourceId, values, items);
      if (!changes.length) return null;
      return { eventType: completedNow(changes, ctx.config) ? EVENT.COMPLETED : EVENT.UPDATED,
               changes: changes };
    }
    // 初めて見るレコード。**日付の前後は出せない**ので現在値だけを並べる
    const initial = items.map(function (item) {
      return {
        item: item,
        oldDisplay: Templates.LABELS.NO_RECORD,
        newDisplay: display(values[item.itemId], item.itemType),
        oldRaw: null,
        newRaw: normalizeRaw(values[item.itemId]),
      };
    });
    return {
      eventType: wasInWindow[resourceId] ? EVENT.UPDATED : EVENT.CREATED,
      changes: initial,
    };
  }

  /** 日付3項目のうち、前回値と変わったものだけを返す。 */
  function detectChanges(ctx, resourceId, values, items) {
    const cfg = ctx.config;
    const changes = [];
    items.forEach(function (item) {
      const current = values[item.itemId];
      const previousHash = ctx.snapshots.hashOf(resourceId, item.itemId);
      // 記録が無い項目は基準が無い。初めて見たものは通知しない（rules/30）
      if (previousHash === null) return;
      if (previousHash === State.valueHash(current, item.itemType)) return;

      const previous = keepsRaw(cfg, item.itemId)
        ? ctx.rawValues.rawOf(resourceId, item.itemId)
        : { hasRaw: false, value: null };
      changes.push({
        item: item,
        oldDisplay: previous.hasRaw
          ? display(previous.value, item.itemType) : Templates.LABELS.NO_RECORD,
        newDisplay: display(current, item.itemType),
        oldRaw: previous.hasRaw ? normalizeRaw(previous.value) : null,
        newRaw: normalizeRaw(current),
      });
    });
    return changes;
  }

  /**
   * 「対応完了」か。**完了日が null → 値 に変わったときだけ。**
   * 完了日の付け替え（値 → 別の値）は「更新」として扱う（仕様書 3.3.2）。
   */
  function completedNow(changes, cfg) {
    for (let i = 0; i < changes.length; i++) {
      const change = changes[i];
      if (change.item.itemId !== cfg.completeItem) continue;
      return change.oldRaw === null && change.newRaw !== null;
    }
    return false;
  }

  // --- 通知 ----------------------------------------------------------------

  /**
   * 宛先を解決して送る。**宛先が空なら送らず、件数を数える**（仕様書 3.3.6）。
   *
   * ⚠️ **黙って捨てない。**構造化ログに残し、日次サマリで管理者に報告する。
   * 検証テナントでは18人中13人が担当者未設定だった。本番でも同じ割合なら
   * 通知の大半が消えるため、「動いているのに通知が来ない」ことに気づける必要がある。
   */
  function dispatch(ctx, resourceId, values, event) {
    const cfg = ctx.config;
    const to = addressOf(values, cfg);
    if (!to) {
      // ⚠️ メールアドレスそのものはログに出さない（rules/40）
      Log.info('mail_skipped_no_address', {
        watcher_id: WATCHER_ID,
        resource_id: resourceId,
        career_id: careerIdOf(resourceId, values),
        event_type: event.eventType,
      });
      ctx.metrics.count(Templates.LABELS.COUNTER_NO_ADDRESS);
      return;
    }
    ctx.dispatcher.dispatchOne(buildNotification(ctx, resourceId, values, event, to));
  }

  /** 求職者の担当者メールアドレス。**空・不正なら null。** */
  function addressOf(values, cfg) {
    const raw = values[cfg.notify.toItem];
    if (raw === null || raw === undefined) return null;
    const address = String(raw).trim();
    return MailNotifier.isValidAddress(address) ? address : null;
  }

  function buildNotification(ctx, resourceId, values, event, to) {
    const cfg = ctx.config;
    const name = cfg.notify.templates[event.eventType];
    const template = ctx.templates.get(name);
    if (!template) {
      throw Errors.config(WATCHER_ID + ': template "' + name + '" not found');
    }

    const shown = event.changes.slice(0, cfg.maxItemsInBody);
    const lines = shown.map(function (c) {
      return Templates.renderField(template, 'change_line', {
        label: c.item.label, old: c.oldDisplay, new: c.newDisplay,
      }, '  {label}: {old} → {new}');
    });
    if (event.changes.length > shown.length) {
      lines.push(Templates.render(Templates.LABELS.MORE_ITEMS,
        { count: event.changes.length - shown.length }));
    }

    const fields = {
      career_name: careerName(cfg, values) || Templates.LABELS.UNSET,
      career_id: careerIdOf(resourceId, values),
      resource_id: resourceId,
      // **対応番号は 0 始まり。**0 を「未設定」に潰さない（実測）
      histseq: histseqOf(resourceId, values),
      action_type: codeLabel(ctx, RESOURCE, ACTION_ID, values[ACTION_ID]),
      action_charge: codeLabel(ctx, RESOURCE, ACTIONCHARGE_ID, values[ACTIONCHARGE_ID]),
      action_memo: memo(values[ACTIONMEMO]),
      changes: lines.join('\n'),
    };

    // 冪等キーは「何がどう変わったか」で決める。同じ変化を再取得しても再送されず、
    // 次の変化は別イベントとして通知される（rules/30-state-and-idempotency.md）。
    // **前後の両方を入れる。**片方だけだと「A → B → A」と戻したときに
    // 2回目の A が重複扱いで消える（＝通知漏れ）
    const digest = State.payloadHash(event.changes.map(function (c) {
      return [c.item.itemId, c.oldRaw, c.newRaw];
    }));

    return Events.notification({
      watcherId: WATCHER_ID,
      resourceId: resourceId,
      eventType: event.eventType,
      digest: digest,
      channelKey: cfg.notify.channelKey,
      subject: Templates.renderField(template, 'subject', fields, '[CP] 対応履歴が更新されました'),
      body: Templates.renderField(template, 'body', fields),
      // **宛先はここだけに載せる。**meta に入れると dead_letter に残る
      to: to,
      meta: { resource: RESOURCE, changed_count: event.changes.length },
    });
  }

  // --- 監視項目の解決 ------------------------------------------------------

  /**
   * トリガー項目を schema から解決する。ラベルと項目タイプもここで決まる。
   * **項目 ID をコードに直書きしない**（rules/10-cp-api.md）。
   *
   * ラベルは設定の `labelOverride` を優先する。schema のラベルは
   * 「求職者対応：完了日」のように接頭辞が付いていて、メール本文には長い。
   */
  function resolveItems(ctx) {
    const cfg = ctx.config;
    const schema = ctx.schema.get(RESOURCE, ctx.budget);
    return cfg.triggerItems.map(function (entry) {
      const itemId = typeof entry === 'string' ? entry : entry.itemId;
      const definition = schema[itemId];
      if (!definition) {
        throw Errors.config(
          WATCHER_ID + ': unknown itemId "' + itemId + '" for resource "' + RESOURCE + '"');
      }
      return {
        itemId: itemId,
        label: (typeof entry !== 'string' && entry.labelOverride)
          ? entry.labelOverride : definition.label,
        itemType: definition.itemType,
      };
    });
  }

  /**
   * 1リクエストで取る項目（仕様書 3.3.4 の D）。
   *
   * **関連リソース（`CAREER#*`）を混ぜられる**ので、宛先も求職者名も同じ
   * レスポンスで揃う（実測 V-3a）。`career/select` は要らない。
   * **項目を足してもリクエスト数は増えない**（レスポンスサイズだけ増える）。
   */
  function selectItemIds(cfg) {
    return unique(
      itemIdsOf(cfg.triggerItems)
        .concat(cfg.bodyItems)
        .concat(cfg.identityItems)
        .concat(cfg.careerNameItems)
        .concat([cfg.notify.toItem]));
  }

  /** 生値を保存する項目か。**既定はハッシュのみ**（rules/40-secrets-and-security.md）。 */
  function keepsRaw(cfg, itemId) {
    if (cfg.rawValueItems === '*') return true;
    return (cfg.rawValueItems || []).indexOf(itemId) >= 0;
  }

  // --- 小物 ----------------------------------------------------------------

  /** 通知の見出しに使う求職者名。nameTemplate に項目 ID を差し込む。 */
  function careerName(cfg, values) {
    let text = cfg.nameTemplate;
    cfg.careerNameItems.forEach(function (itemId) {
      const value = values[itemId];
      text = text.split('{' + itemId + '}')
        .join(value === null || value === undefined ? '' : String(value));
    });
    return text.trim();
  }

  /**
   * 求職者 ID。レスポンスの値を優先し、無ければ対応履歴 ID を分解する
   * （`{求職者ID}_{対応番号}`）。
   */
  function careerIdOf(resourceId, values) {
    const value = State.canonicalValue(values[CAREER_ID], 'number');
    if (value !== null) return String(value);
    const at = String(resourceId).lastIndexOf('_');
    return at > 0 ? String(resourceId).slice(0, at) : String(resourceId);
  }

  /** 対応番号。**0 始まりなので 0 を未設定に潰さない**（実測）。 */
  function histseqOf(resourceId, values) {
    const value = State.canonicalValue(values[HISTSEQ], 'number');
    if (value !== null) return String(value);
    const at = String(resourceId).lastIndexOf('_');
    return at > 0 ? String(resourceId).slice(at + 1) : '';
  }

  /** 日付・日時を本文用の表記にする。変換は core/timefmt.js に閉じる。 */
  function display(value, itemType) {
    const text = TimeFmt.toDisplay(value, itemType);
    return text === null ? Templates.LABELS.UNSET : text;
  }

  /**
   * 冪等キーに入れる値。**表示のゆらぎを持ち込まない。**
   * 未設定（null / 空文字）は null に揃える。
   */
  function normalizeRaw(value) {
    return State.canonicalValue(value, 'date');
  }

  /** メモ本文。長すぎるメールを作らない。 */
  function memo(value) {
    if (value === null || value === undefined || String(value) === '') {
      return Templates.LABELS.UNSET;
    }
    const text = String(value);
    return text.length <= MEMO_CLIP ? text : text.slice(0, MEMO_CLIP) + '…';
  }

  /** コード値をラベルにする。参照マスタ名は schema から解決するので書かない。 */
  function codeLabel(ctx, resource, itemId, value) {
    const definition = ctx.schema.describe(resource, itemId, ctx.budget);
    return ctx.master.label(definition ? definition.codeName : null, value, ctx.budget);
  }

  /** 設定の triggerItems は文字列でもオブジェクトでもよい。 */
  function itemIdsOf(entries) {
    return (entries || []).map(function (entry) {
      return typeof entry === 'string' ? entry : entry.itemId;
    });
  }

  /** 検索条件に登場する項目 ID を再帰的に集める。起動時の実在検証に使う。 */
  function conditionItemIds(condition) {
    if (!condition || typeof condition !== 'object') return [];
    let found = condition.itemId ? [condition.itemId] : [];
    (condition.items || []).forEach(function (entry) {
      found = found.concat(conditionItemIds(entry));
    });
    return found;
  }

  /**
   * 予算にも時間にも余裕があるか。**余裕を残して止める。**
   * 書き戻しの前に6分制限へ当たると、そのサイクルの成果が丸ごと消える（仕様書 11.4）。
   */
  function canContinue(budget) {
    return budget.canAfford(1) &&
      budget.elapsedSeconds < budget.maxRuntimeSeconds - Config.execution.stopMarginSeconds;
  }

  /** 順序を保って重複を除く。CP は itemIds の重複を 400 で拒否する。 */
  function unique(values) {
    const seen = {};
    const out = [];
    values.forEach(function (value) {
      if (seen[value]) return;
      seen[value] = true;
      out.push(value);
    });
    return out;
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
    EVENT: EVENT,
    RESOURCE: RESOURCE,
    CAREER_RESOURCE: CAREER_RESOURCE,
    DISCOVERY_SET: DISCOVERY_SET,
    SORT: SORT,
    create: create,
    // テストから直接呼ぶ内部
    buildCondition: buildCondition,
    selectItemIds: selectItemIds,
    resolveItems: resolveItems,
    addressOf: addressOf,
    careerIdOf: careerIdOf,
    histseqOf: histseqOf,
    validate: validate,
  };
})();
