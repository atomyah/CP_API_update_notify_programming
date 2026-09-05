/**
 * 要件1 — 求職者の項目が変わったら Slack に通知する。
 * Python 版 `app/watchers/resource_watch.py`（career_status インスタンス）の移植。
 *
 * 仕様の根拠は仕様書 3.1節。**設定は core/config.js の careerStatus。**
 *
 * | | |
 * |---|---|
 * | 対象 | **全求職者。**絞るなら targetCondition を足す |
 * | 監視項目 | **schema の全項目**（232 − 除外3 = 229件）。オリつく項目 CAREER#48002 を含む |
 * | 通知条件 | **値が前回と変われば通知。**遷移先の値では絞らない |
 *
 * 検知の流れ:
 *
 * ```
 * 1. career/search（CAREER#UPDATE_DATE GE カーソル − オーバーラップ）→ 変化した ID
 * 2. 各 ID を career/select して現在値を取る（1リクエスト = 1求職者）
 * 3. snapshots の前回値（ハッシュ）と比較し、異なる項目だけをイベントにする
 *    - 前回値が無い求職者・項目は通知しない。基準値を作るだけ
 * 4. コード値をマスタでラベルに変換し、notified へ追記してから Slack へ送る
 * 5. snapshots を更新 → 最後にカーソルを前進（Runner が行う）
 * ```
 *
 * **⚠️ ブートストラップ（基準づくり）を先に済ませること。**
 * 前回値が無い状態で通知すると、既存の全求職者が「変化した」と誤判定されて
 * Slack が溢れる（rules/30-state-and-idempotency.md）。execute() はカーソルが
 * bootstrapped でなければ ConfigError で止まる。
 *
 * **⚠️ Python 版との違い: 途中終了時の扱い。**
 * Python は1求職者ずつ SQLite にスナップショットを書いていたので、予算切れで
 * 中断しても処理済みの求職者ぶんは残った。GAS は setValues 1回で書き戻すため
 * （仕様書 11.3）、中断したサイクルは**丸ごと捨てて次サイクルでやり直す**
 * （仕様書 11.4）。送信済みの通知は冪等キーで除去されるので二重通知にはならない。
 */
const CareerStatusWatcher = (function () {

  const WATCHER_ID = 'career_status';
  const EVENT_TYPE = 'item_changed';

  // 値が長いと Slack で読めなくなる（textarea 等）
  const VALUE_CLIP = 120;

  /**
   * ウォッチャーを1つ作る。
   * @param overrides 設定の上書き（テストとブートストラップの予算差し替えに使う）
   */
  function create(overrides) {
    const config = merge(Config.careerStatus, overrides);
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
    const schema = ctx.schema.get(cfg.resource, ctx.budget);

    if (!schema[cfg.updateDateItem]) {
      throw Errors.config(
        WATCHER_ID + ': "' + cfg.updateDateItem + '" does not exist in resource "' +
        cfg.resource + '". This resource cannot be watched by update date');
    }

    const required = unique(
      [cfg.updateDateItem]
        .concat(cfg.identityItems)
        .concat(explicitItemIds(cfg))
        .concat(conditionItemIds(cfg.targetCondition)));
    ctx.schema.validate(cfg.resource, required, ctx.budget);

    const items = resolveItems(ctx);
    if (!items.length) {
      throw Errors.config(WATCHER_ID + ': no item remains after exclusions');
    }
    if (!ctx.templates.get(cfg.notify.template)) {
      throw Errors.config(
        WATCHER_ID + ': template "' + cfg.notify.template + '" not found');
    }
    if (!ctx.dispatcher.supports(cfg.notify.channelKey)) {
      throw Errors.config(
        WATCHER_ID + ': no notifier handles channel "' + cfg.notify.channelKey + '"');
    }

    const summary = {
      watcher_id: WATCHER_ID,
      resource: cfg.resource,
      schema_item_count: Object.keys(schema).length,
      watched_item_count: items.length,
      custom_items: items.filter(function (i) { return Schema.isCustom(i.itemId); })
        .map(function (i) { return i.itemId; }),
      raw_value_items: cfg.rawValueItems === '*' ? '*' : cfg.rawValueItems.length,
      channel_key: cfg.notify.channelKey,
    };
    Log.info('watcher_validated', summary);
    return summary;
  }

  // --- 本体 ----------------------------------------------------------------

  function execute(ctx) {
    const cfg = ctx.config;
    if (!ctx.cursor || !ctx.cursor.bootstrapped) {
      throw Errors.config(
        WATCHER_ID + ': no snapshot yet. Run bootstrapCareerStatus() first ' +
        '(notifying without a baseline would flood the channel)');
    }

    const items = resolveItems(ctx);
    const overlapSeconds = cfg.overlapSeconds === undefined
      ? Watchers.DEFAULTS.overlapSeconds : cfg.overlapSeconds;
    const since = TimeFmt.shiftSeconds(ctx.cursor.value, -overlapSeconds);

    const found = Paging.searchIds(cfg.resource, {
      condition: buildCondition(cfg, since),
      // sort は必ず指定する。未指定だと順序が保証されずページングが壊れる
      sort: [{ itemId: cfg.updateDateItem, order: 'asc' }],
      budget: ctx.budget,
      watcherId: WATCHER_ID,
      maxPages: Config.limits.maxPagesPerCycle,
    });
    Log.info('search_done', {
      watcher_id: WATCHER_ID, resource: cfg.resource,
      candidate_count: found.ids.length, since: TimeFmt.toStore(since),
    });

    let detected = 0;
    let notified = 0;
    ctx.dispatcher.beginCycle();
    try {
      for (let i = 0; i < found.ids.length; i++) {
        if (processOne(ctx, found.ids[i], items, true)) detected += 1;
      }
    } finally {
      notified = ctx.dispatcher.endCycle();
    }

    if (found.capped) {
      // 全件を見きれていない。**カーソルも snapshots も進めない**（仕様書 11.4）
      return Events.exhausted({ eventsDetected: detected, eventsNotified: notified });
    }
    return Events.result({
      ok: true,
      eventsDetected: detected,
      eventsNotified: notified,
      // サイクルの開始時刻を入れる。終了時刻だと走査中の変更が次の検索から漏れる
      cursor: { value: ctx.startedAt, pageOffset: 0, bootstrapped: true },
    });
  }

  /**
   * スナップショットを作るだけ。**通知しない。**
   *
   * 全求職者を1件ずつ select するため、1回の実行（最長6分）では終わらないことがある。
   * **ページ単位で再開できるようにしてある**ので、複数回に分けて完了させる。
   *
   * ⚠️ 予算切れ・時間切れは例外にせず、**そこまでの結果を持ってコミットさせる。**
   * 例外にすると Runner が snapshots もカーソルも書かず、何回実行しても進まない。
   */
  function bootstrap(ctx) {
    const cfg = ctx.config;
    if (ctx.cursor && ctx.cursor.bootstrapped) {
      Log.info('bootstrap_skipped', { watcher_id: WATCHER_ID, reason: 'already done' });
      return Events.result({ ok: true });
    }

    const items = resolveItems(ctx);
    // 完了後のカーソルには**最初のブートストラップ開始時刻**を使う。
    // 走査に複数回かかるため、終了時刻を入れると走査中の変更が初回サイクルから漏れる
    const startedAt = ctx.cursor ? ctx.cursor.value : ctx.startedAt;
    const condition = buildCondition(cfg, null);
    const sort = [{ itemId: cfg.updateDateItem, order: 'asc' }];

    let offset = ctx.cursor ? ctx.cursor.pageOffset : 0;
    let processed = 0;
    let done = false;

    try {
      while (canContinue(ctx.budget)) {
        const page = CpClient.search(cfg.resource, {
          condition: condition, sort: sort,
          limit: CpClient.MAX_LIMIT, offset: offset, budget: ctx.budget,
        });
        if (!page.ids.length) { done = true; break; }

        let consumed = 0;
        for (let i = 0; i < page.ids.length; i++) {
          if (!canContinue(ctx.budget)) break;
          // 既にスナップショットがある ID は飛ばす（再開時の再取得を避ける）
          if (!ctx.snapshots.has(page.ids[i])) {
            processOne(ctx, page.ids[i], items, false);
            processed += 1;
          }
          consumed += 1;
        }
        // ページを最後まで見きれていなければ offset を進めない。
        // 処理済みの ID は snapshots にあるので次回は select し直さない
        if (consumed < page.ids.length) break;

        offset += page.ids.length;
        Log.info('bootstrap_progress', {
          watcher_id: WATCHER_ID, resource: cfg.resource,
          offset: offset, total: page.count, processed_this_cycle: processed,
        });
        if (offset >= page.count) { done = true; break; }
      }
    } catch (e) {
      // 予算切れ・時間切れは異常ではない。ここまでの結果をコミットして次回に続ける
      if (!Errors.is(e, Errors.KIND.BUDGET)) throw e;
      Log.info('bootstrap_interrupted', {
        watcher_id: WATCHER_ID, offset: offset, processed_this_cycle: processed,
      });
    }

    Log.info(done ? 'bootstrap_done' : 'bootstrap_paused', {
      watcher_id: WATCHER_ID, resource: cfg.resource,
      offset: done ? 0 : offset, processed_this_cycle: processed,
      snapshot_rows: ctx.snapshots.count(),
    });
    return Events.result({
      ok: true,
      // ⚠️ bootstrapped が true になるまで execute() は動かない（通知洪水の防止）
      cursor: { value: startedAt, pageOffset: done ? 0 : offset, bootstrapped: done },
    });
  }

  // --- 1レコードぶんの処理 --------------------------------------------------

  /**
   * 1求職者を取得し、差分を検出し、通知してからスナップショットを更新する。
   *
   * 順序: select → 差分検出 → **通知 → スナップショット更新（メモリ上）。**
   * スナップショットを先に更新して通知に失敗すると、その変化は永久に通知されない。
   *
   * @return 変化を検知したか
   */
  function processOne(ctx, resourceId, items, notify) {
    const cfg = ctx.config;
    // ⚠️ **重複した itemId は 400 になる**（itemIdが重複しています。実測 2026-08-07）。
    // 全項目監視では identityItems が必ず重複するので、順序を保って一意化する
    const itemIds = unique(items.map(function (i) { return i.itemId; })
      .concat(cfg.identityItems));
    const values = CpClient.select(cfg.resource, resourceId, itemIds, ctx.budget);

    const changes = notify ? detectChanges(ctx, resourceId, values, items) : [];

    if (changes.length) {
      // ⚠️ 値そのものはログに出さない（rules/40-secrets-and-security.md）
      Log.info('change_detected', {
        watcher_id: WATCHER_ID, resource: cfg.resource, resource_id: resourceId,
        changed_count: changes.length,
        item_ids: changes.map(function (c) { return c.item.itemId; }),
      });
      ctx.dispatcher.dispatchOne(buildNotification(ctx, resourceId, values, changes));
    }

    // **メモリ上のスナップショットを更新するだけ。**
    // シートへの書き戻しは Runner がコミットすると決めたときだけ行われる
    items.forEach(function (item) {
      const value = values[item.itemId];
      ctx.snapshots.put(resourceId, item.itemId, value, item.itemType);
      if (keepsRaw(cfg, item.itemId)) {
        ctx.rawValues.putRaw(resourceId, item.itemId, value);
      }
    });
    return changes.length > 0;
  }

  function detectChanges(ctx, resourceId, values, items) {
    const cfg = ctx.config;
    const changes = [];
    items.forEach(function (item) {
      const current = values[item.itemId];
      const previousHash = ctx.snapshots.hashOf(resourceId, item.itemId);
      // 初めて見たレコード・項目は通知しない。基準値を作るだけ
      if (previousHash === null) return;
      if (previousHash === State.valueHash(current, item.itemType)) return;

      const previous = keepsRaw(cfg, item.itemId)
        ? ctx.rawValues.rawOf(resourceId, item.itemId)
        : { hasRaw: false, value: null };
      const change = {
        item: item,
        oldDisplay: previous.hasRaw
          ? ctx.master.label(item.master, previous.value, ctx.budget)
          : Templates.LABELS.NO_RECORD,
        newDisplay: ctx.master.label(item.master, current, ctx.budget),
        oldRaw: previous.hasRaw ? previous.value : null,
        newRaw: current === undefined ? null : current,
      };
      if (change.oldDisplay === change.newDisplay) {
        // 正規化しきれていない値が残っているサイン。読み手には「変わっていない」
        // ようにしか見えないので、握りつぶさずログに残して原因を追えるようにする
        Log.warn('change_without_visible_difference', {
          watcher_id: WATCHER_ID, resource_id: resourceId,
          item_id: item.itemId, item_type: item.itemType,
        });
      }
      changes.push(change);
    });
    return changes;
  }

  function buildNotification(ctx, resourceId, values, changes) {
    const cfg = ctx.config;
    const template = ctx.templates.get(cfg.notify.template);
    if (!template) {
      throw Errors.config(
        WATCHER_ID + ': template "' + cfg.notify.template + '" not found');
    }

    const shown = changes.slice(0, cfg.maxItemsInBody);
    const lines = shown.map(function (c) {
      return Templates.renderField(template, 'change_line', {
        label: c.item.label,
        old: clip(c.oldDisplay),
        new: clip(c.newDisplay),
      }, '• {label}: {old} → {new}');
    });
    if (changes.length > shown.length) {
      lines.push(Templates.render(Templates.LABELS.MORE_ITEMS,
        { count: changes.length - shown.length }));
    }

    const fields = {
      resource: cfg.resource,
      resource_label: cfg.notify.resourceLabel || cfg.resource,
      resource_id: resourceId,
      record_name: displayName(cfg, values) || (cfg.resource + ' ' + resourceId),
      changes: lines.join('\n'),
      change_count: changes.length,
    };

    // 冪等キーは「何がどう変わったか」で決める。同じ変化を再取得しても再送されず、
    // 次の変化は別イベントとして通知される（rules/30-state-and-idempotency.md）
    const sorted = changes.slice().sort(function (a, b) {
      return a.item.itemId < b.item.itemId ? -1 : (a.item.itemId > b.item.itemId ? 1 : 0);
    });
    const digest = State.payloadHash(sorted.map(function (c) {
      return [c.item.itemId, c.oldRaw, c.newRaw];
    }));

    return Events.notification({
      watcherId: WATCHER_ID,
      resourceId: resourceId,
      eventType: EVENT_TYPE,
      digest: digest,
      channelKey: cfg.notify.channelKey,
      subject: Templates.renderField(template, 'subject', fields, '[CP] 変更がありました'),
      body: Templates.renderField(template, 'body', fields),
      meta: { resource: cfg.resource, change_count: changes.length },
    });
  }

  /** 通知の見出しに使う名前。nameTemplate に項目 ID を差し込む。 */
  function displayName(cfg, values) {
    if (!cfg.nameTemplate) return '';
    let text = cfg.nameTemplate;
    cfg.identityItems.forEach(function (itemId) {
      const value = values[itemId];
      text = text.split('{' + itemId + '}')
        .join(value === null || value === undefined ? '' : String(value));
    });
    return text.trim();
  }

  // --- 監視項目の解決 ------------------------------------------------------

  /**
   * 監視対象の項目を schema から解決する。ラベルと参照マスタもここで決まる。
   * **項目 ID をコードに直書きしない**（rules/10-cp-api.md）。
   */
  function resolveItems(ctx) {
    const cfg = ctx.config;
    const schema = ctx.schema.get(cfg.resource, ctx.budget);
    const resolved = [];

    if (cfg.watchedItems === '*') {
      Object.keys(schema).forEach(function (itemId) {
        if (isExcluded(cfg, schema[itemId])) return;
        resolved.push(toWatchedItem(schema[itemId]));
      });
    } else {
      cfg.watchedItems.forEach(function (entry) {
        const itemId = typeof entry === 'string' ? entry : entry.itemId;
        const definition = schema[itemId];
        if (!definition) {
          throw Errors.config(
            WATCHER_ID + ': unknown itemId "' + itemId + '" for resource "' +
            cfg.resource + '"');
        }
        const item = toWatchedItem(definition);
        if (typeof entry !== 'string') {
          if (entry.labelOverride) item.label = entry.labelOverride;
          if (entry.master) item.master = entry.master;
        }
        resolved.push(item);
      });
    }

    resolved.sort(function (a, b) {
      return a.itemId < b.itemId ? -1 : (a.itemId > b.itemId ? 1 : 0);
    });
    return resolved;
  }

  function toWatchedItem(definition) {
    return {
      itemId: definition.itemId,
      label: definition.label,
      // 参照マスタ名は schema の validationRule.codeName から取れる（実測）
      master: definition.codeName,
      itemType: definition.itemType,
    };
  }

  function isExcluded(cfg, definition) {
    if (cfg.excludeItems.indexOf(definition.itemId) >= 0) return true;
    return cfg.excludeSuffixes.some(function (suffix) {
      return definition.itemId.length >= suffix.length &&
             definition.itemId.slice(-suffix.length) === suffix;
    });
  }

  function explicitItemIds(cfg) {
    if (cfg.watchedItems === '*') return [];
    return cfg.watchedItems.map(function (entry) {
      return typeof entry === 'string' ? entry : entry.itemId;
    });
  }

  /** 生値を保存する項目か。**既定はハッシュのみ**（rules/40-secrets-and-security.md）。 */
  function keepsRaw(cfg, itemId) {
    if (cfg.rawValueItems === '*') return true;
    return (cfg.rawValueItems || []).indexOf(itemId) >= 0;
  }

  // --- 検索条件 ------------------------------------------------------------

  function buildCondition(cfg, since) {
    const items = [];
    if (cfg.targetCondition) items.push(cfg.targetCondition);
    if (since !== null && since !== undefined) {
      items.push({
        itemId: cfg.updateDateItem,
        searchType: 'GE',
        // datetime は YYYY/MM/DD HH:MM:SS。秒精度は実際に効く（実測）
        value: TimeFmt.toCpDatetime(since),
      });
    }
    if (!items.length) return null;
    if (items.length === 1) {
      return items[0].compoundType ? items[0] : { compoundType: 'and', items: items };
    }
    return { compoundType: 'and', items: items };
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

  // --- 小物 ----------------------------------------------------------------

  /**
   * 予算にも時間にも余裕があるか。**余裕を残して止める。**
   * 書き戻しの前に6分制限へ当たると、そのサイクルの成果が丸ごと消える（仕様書 11.4）。
   */
  function canContinue(budget) {
    return budget.canAfford(1) &&
      budget.elapsedSeconds < budget.maxRuntimeSeconds - Config.execution.stopMarginSeconds;
  }

  /** 順序を保って重複を除く。CP は itemIds の重複を 400 で拒否する。 */
  function unique(itemIds) {
    const seen = {};
    const out = [];
    itemIds.forEach(function (itemId) {
      if (seen[itemId]) return;
      seen[itemId] = true;
      out.push(itemId);
    });
    return out;
  }

  function clip(text) {
    const value = String(text).split('\n').join(' ');
    return value.length <= VALUE_CLIP ? value : value.slice(0, VALUE_CLIP) + '…';
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
    create: create,
    // テストから直接呼ぶ内部
    resolveItems: resolveItems,
    buildCondition: buildCondition,
    keepsRaw: keepsRaw,
    displayName: displayName,
    validate: validate,
  };
})();
