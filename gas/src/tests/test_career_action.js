/**
 * Phase6（要件4 career_action_watch + メール送信）のテスト。
 *
 * ここで厚く見るのは**このウォッチャー固有の事故**:
 *
 *   - ⚠️ **誤送信。**宛先は CP 上の実在アドレスで、間違えると人に届く
 *     （求職者の担当 `CAREER#CHARGE_EMAIL` と対応の担当 `ACTIONCHARGE_ID` は別人）
 *   - ⚠️ **宛先が空のときに黙って捨てない**（件数が数えられること。仕様書 3.3.6）
 *   - ⚠️ **S30_prev による分類。**窓に入ってきた古いレコードを「新規」と誤通知しない
 *   - ⚠️ **中断したサイクルで S30_prev を書き換えない。**書き換えると、見えなかった
 *     ID が次のサイクルで「新規」に化けて誤送信になる
 *   - 冪等除去（同じ変化で2通目が出ない）
 *   - 走査量が**総件数ではなく活動量**に比例すること（設計の要）
 *
 * 使い方: Apps Script エディタで `runCareerActionTests`（または `runAllTests`）を実行する。
 * **CP API・メール・本番のシート・本番のプロパティを一切触らない。**
 */

/** テスト用の schema。実環境と同じ形（validationRule.codeName を持つ）。 */
function fakeActionSchemas() {
  return {
    career_action: [
      { itemId: 'CAREER_ACTION#ACTION_DATE', label: '求職者対応：対応日', itemType: 'date' },
      { itemId: 'CAREER_ACTION#COMPLETE_DATE', label: '求職者対応：完了日', itemType: 'date' },
      { itemId: 'CAREER_ACTION#NEXTACTION_DATE', label: '求職者対応：次回コンタクト日', itemType: 'datetime' },
      {
        itemId: 'CAREER_ACTION#ACTION_ID', label: '求職者対応：アクションID',
        itemType: 'selectone', validationRule: { codeName: 'MSTACTION' },
      },
      { itemId: 'CAREER_ACTION#ACTIONMEMO', label: '求職者対応：内容', itemType: 'textarea' },
      {
        itemId: 'CAREER_ACTION#ACTIONCHARGE_ID', label: '求職者対応：担当',
        itemType: 'selectone', validationRule: { codeName: 'MSTUSER' },
      },
      { itemId: 'CAREER_ACTION#CAREER_ID', label: '求職者対応：求職者ID', itemType: 'number' },
      { itemId: 'CAREER_ACTION#HISTSEQ', label: '求職者対応：対応番号', itemType: 'number' },
    ],
    career: [
      { itemId: 'CAREER#LASTNAME', label: '姓', itemType: 'text' },
      { itemId: 'CAREER#FIRSTNAME', label: '名', itemType: 'text' },
      { itemId: 'CAREER#CHARGE_EMAIL', label: '担当者メール', itemType: 'text' },
      {
        itemId: 'CAREER#CHARGE_ID', label: '担当者', itemType: 'selectone',
        validationRule: { codeName: 'MSTUSER' },
      },
    ],
  };
}

/**
 * 対応履歴を1件作る。CLAUDE.md の検証用レコード（式波アスカ 18 / 葛城ミサト 17）に沿う。
 *
 * @param dates { action, complete, next } — 省略した日付は null（未入力）
 * @param extra { email: 担当者メール（空にすると「担当者未設定」）, charge: 対応の担当 }
 */
function actionRecord(id, dates, extra) {
  const d = dates || {};
  const e = extra || {};
  const careerId = Number(String(id).split('_')[0]);
  const names = { 18: ['式波', 'アスカ'], 17: ['葛城', 'ミサト'] };
  const name = names[careerId] || ['山田', '太郎'];
  return {
    'CAREER_ACTION#ACTION_DATE': d.action === undefined ? null : d.action,
    'CAREER_ACTION#COMPLETE_DATE': d.complete === undefined ? null : d.complete,
    'CAREER_ACTION#NEXTACTION_DATE': d.next === undefined ? null : d.next,
    'CAREER_ACTION#ACTION_ID': e.actionId === undefined ? '7' : e.actionId,
    'CAREER_ACTION#ACTIONMEMO': e.memo === undefined ? 'ご本人からお電話ありました。' : e.memo,
    // ⚠️ 対応の担当（8）は求職者の担当（7）と別人でありうる。宛先に使わない
    'CAREER_ACTION#ACTIONCHARGE_ID': e.charge === undefined ? '8' : e.charge,
    'CAREER_ACTION#CAREER_ID': careerId,
    'CAREER_ACTION#HISTSEQ': Number(String(id).split('_')[1]),
    'CAREER#LASTNAME': name[0],
    'CAREER#FIRSTNAME': name[1],
    'CAREER#CHARGE_EMAIL': e.email === undefined ? 'a.yahara@mybrainlab.net' : e.email,
    'CAREER#CHARGE_ID': e.chargeId === undefined ? '7' : e.chargeId,
  };
}

/**
 * CP クライアントを差し替える。**CP は一切叩かない。**
 *
 * 検索は**実際に走査窓の条件を解釈する。**条件の形（母集団の and + 日付3項目の or）が
 * 壊れたらテストが落ちるようにするため。
 */
function fakeActionCp(options) {
  const opts = options || {};
  const saved = {
    search: CpClient.search, select: CpClient.select,
    getSchema: CpClient.getSchema, getMaster: CpClient.getMaster,
  };
  const cp = {
    schemas: opts.schemas || fakeActionSchemas(),
    records: opts.records || {},
    masters: opts.masters || {
      MSTACTION: { '7': '電話', '1': '面談' },
      MSTUSER: { '7': '【BL】矢原アトム', '8': '【BL】川端' },
    },
    calls: { search: 0, select: 0, schema: 0, master: 0 },
    searches: [],
    lastItemIds: null,
    restore: function () {
      CpClient.search = saved.search;
      CpClient.select = saved.select;
      CpClient.getSchema = saved.getSchema;
      CpClient.getMaster = saved.getMaster;
    },
  };

  /** 条件から走査窓の下限（`yyyy-MM-dd`）を取り出す。無ければ null。 */
  function windowSince(condition) {
    if (!condition) return null;
    let found = null;
    (condition.items || []).forEach(function (entry) {
      if (entry.compoundType === 'or') {
        entry.items.forEach(function (leaf) {
          if (leaf.itemId === 'CAREER_ACTION#ACTION_DATE' && leaf.searchType === 'GE') {
            found = String(leaf.value).slice(0, 10).split('/').join('-');
          }
        });
      }
    });
    return found;
  }

  /** 母集団の絞り込み（CAREER#CHARGE_ID ENTERED）が付いているか。 */
  function hasPopulation(condition) {
    return !!(condition && (condition.items || []).some(function (entry) {
      return entry.itemId === 'CAREER#CHARGE_ID' && entry.searchType === 'ENTERED';
    }));
  }

  function dateOf(record, itemId) {
    const value = record[itemId];
    return value === null || value === undefined ? null : String(value).slice(0, 10);
  }

  CpClient.getSchema = function (resource, budget) {
    cp.calls.schema += 1;
    if (budget) budget.consume();
    return cp.schemas[resource] || [];
  };
  CpClient.getMaster = function (codeName, budget) {
    cp.calls.master += 1;
    if (budget) budget.consume();
    return cp.masters[codeName] || {};
  };
  CpClient.search = function (resource, params) {
    cp.calls.search += 1;
    if (params && params.budget) params.budget.consume();
    const condition = (params || {}).condition;
    cp.searches.push({ resource: resource, params: params, since: windowSince(condition) });

    const since = windowSince(condition);
    const population = hasPopulation(condition);
    const matched = Object.keys(cp.records).filter(function (id) {
      const record = cp.records[id];
      // 母集団: 担当者が設定されている求職者だけ
      if (population && !record['CAREER#CHARGE_ID']) return false;
      if (since === null) return true;
      return ['CAREER_ACTION#ACTION_DATE', 'CAREER_ACTION#COMPLETE_DATE',
              'CAREER_ACTION#NEXTACTION_DATE'].some(function (itemId) {
        const value = dateOf(record, itemId);
        return value !== null && value >= since;
      });
    }).sort();

    const offset = (params && params.offset) || 0;
    const limit = (params && params.limit) || 100;
    return { ids: matched.slice(offset, offset + limit), count: matched.length };
  };
  CpClient.select = function (resource, resourceId, itemIds, budget) {
    cp.calls.select += 1;
    if (budget) budget.consume();
    cp.lastItemIds = itemIds;
    const record = cp.records[String(resourceId)] || {};
    const values = {};
    itemIds.forEach(function (itemId) {
      values[itemId] = Object.prototype.hasOwnProperty.call(record, itemId)
        ? record[itemId] : null;
    });
    return values;
  };

  Schema.clearCache();
  Master.clearCache();
  return cp;
}

/** 要件4のチャンネルを扱える通知先を持つ一式。 */
function newActionEnv(options) {
  const opts = options || {};
  return newWatcherEnv({
    props: opts.props, sheets: opts.sheets,
    notifier: opts.notifier || recordingNotifier(['career_action', 'ops']),
  });
}

/** テストで使うウォッチャー。**enabled: true**（既定は false で送信を止めてある）。 */
function actionWatcher(overrides) {
  const config = { enabled: true };
  Object.keys(overrides || {}).forEach(function (k) { config[k] = overrides[k]; });
  return CareerActionWatcher.create(config);
}

/** 基準づくりまで済ませた状態を作る（通知は出ない）。 */
function bootstrappedActionEnv(options) {
  const env = newActionEnv(options);
  Runner.execute(actionWatcher(), {
    state: env.state, lock: env.lock, dispatcher: env.dispatcher, bootstrap: true,
  });
  return advance(env);
}

/** 今日から n 日前の日付（`yyyy-MM-dd`）。走査窓のテストデータを作るのに使う。 */
function daysAgo(n) {
  return TimeFmt.toStoreDate(TimeFmt.shiftDays(TimeFmt.now(), -n));
}

function runCareerActionTests() {
  T.reset();

  // --- 設定の検証 -----------------------------------------------------------

  T.test('変更窓が新規窓より広い設定は ConfigError', function () {
    // S30_prev による分類が意味を失う（新規と更新を区別できない）
    const cp = fakeActionCp();
    try {
      T.assertThrows(Errors.KIND.CONFIG, function () {
        CareerActionWatcher.validate(actionValidateCtx({ discoveryWindowDays: 3, changeWindowDays: 30 }));
      });
    } finally { cp.restore(); }
  });

  T.test('宛先が無いときの扱いを skip 以外にすると ConfigError', function () {
    const cp = fakeActionCp();
    try {
      T.assertThrows(Errors.KIND.CONFIG, function () {
        CareerActionWatcher.validate(
          actionValidateCtx({ notify: { onMissingAddress: 'send_to_admin' } }));
      });
    } finally { cp.restore(); }
  });

  T.test('起動時チェックは対応履歴と求職者の両方の schema を見る', function () {
    const cp = fakeActionCp();
    try {
      const summary = CareerActionWatcher.validate(actionValidateCtx());
      T.assertEquals(summary.trigger_items.length, 3);
      T.assertEquals(summary.to_item, 'CAREER#CHARGE_EMAIL');
      // career_action と career の2リソースぶん
      T.assertEquals(cp.calls.schema, 2);
    } finally { cp.restore(); }
  });

  // --- 検索条件 -------------------------------------------------------------

  T.test('走査窓は母集団の and と日付3項目の or', function () {
    const cfg = actionWatcher().config;
    const condition = CareerActionWatcher.buildCondition(cfg, TimeFmt.now());
    T.assertEquals(condition.compoundType, 'and');
    T.assertEquals(condition.items[0].itemId, 'CAREER#CHARGE_ID');
    T.assertEquals(condition.items[0].searchType, 'ENTERED');
    T.assertEquals(condition.items[1].compoundType, 'or');
    T.assertEquals(condition.items[1].items.length, 3);
    // date は YYYY/MM/DD、datetime は下限を明示する
    T.assert(/^\d{4}\/\d{2}\/\d{2}$/.test(condition.items[1].items[0].value));
    T.assert(/ 00:00:00$/.test(condition.items[1].items[2].value));
  });

  T.test('1リクエストで宛先・求職者名・本文・トリガーが揃う', function () {
    // 関連リソース（CAREER#*）を同じ itemIds に混ぜられる（実測 V-3a）
    const itemIds = CareerActionWatcher.selectItemIds(actionWatcher().config);
    ['CAREER_ACTION#ACTION_DATE', 'CAREER_ACTION#ACTIONMEMO',
     'CAREER#LASTNAME', 'CAREER#CHARGE_EMAIL'].forEach(function (itemId) {
      T.assert(itemIds.indexOf(itemId) >= 0, itemId + ' が itemIds に無い');
    });
    // ⚠️ 重複した itemId は 400 になる
    const seen = {};
    itemIds.forEach(function (itemId) {
      T.assert(!seen[itemId], '重複した itemId: ' + itemId);
      seen[itemId] = true;
    });
  });

  // --- 送信の抑止 -----------------------------------------------------------

  T.test('⚠️ enabled が false のときは実行しない（ドライランは通る）', function () {
    const cp = fakeActionCp();
    try {
      cp.records['18_0'] = actionRecord('18_0', { action: daysAgo(0) });
      const env = newActionEnv();
      // 止めたウォッチャーは skipped で抜ける＝失敗カウンタも進まない
      const result = Runner.execute(CareerActionWatcher.create({ enabled: false }), env.options);
      T.assertEquals(result.skipped, 'disabled');
      T.assertEquals(env.notifier.sent.length, 0);
      T.assertEquals(env.state.getFailureCount('career_action_watch'), 0);

      // ドライランは通す（本物の宛先へは行かないため）
      const dry = Runner.execute(CareerActionWatcher.create({ enabled: false }), {
        state: env.state, lock: env.lock, dispatcher: env.dispatcher, dryRun: true,
      });
      T.assertEquals(dry.skipped, null, 'ドライランまで止めている');
    } finally { cp.restore(); }
  });

  // --- ブートストラップ -----------------------------------------------------

  T.test('⚠️ 基準づくりの前に実行しても通知は出ない', function () {
    const cp = fakeActionCp();
    try {
      cp.records['18_0'] = actionRecord('18_0', { action: daysAgo(0) });
      const env = newActionEnv();
      const result = Runner.execute(actionWatcher(), env.options);
      T.assertEquals(result.ok, false, '失敗として扱われるはず');
      T.assertEquals(env.notifier.sent.length, 0);
      T.assertEquals(env.state.getCursor('career_action_watch'), null, 'カーソルが進んでいる');
    } finally { cp.restore(); }
  });

  T.test('基準づくりは通知せず、30日窓の ID 集合と日付を記録する', function () {
    const cp = fakeActionCp();
    try {
      cp.records['18_0'] = actionRecord('18_0', { action: daysAgo(0) });      // 3日窓の中
      cp.records['17_0'] = actionRecord('17_0', { action: daysAgo(20) });     // 30日窓だけ
      cp.records['17_1'] = actionRecord('17_1', { action: daysAgo(90) });     // 窓の外
      const env = bootstrappedActionEnv();
      T.assertEquals(env.notifier.sent.length, 0, '基準づくりで通知が出ている');
      // 3日窓の1件だけを select する（30日窓は ID だけで足りる）
      T.assertEquals(cp.calls.select, 1);
      const idSets = env.state.idSets('career_action_watch');
      T.assertEquals(idSets.count(), 2, '30日窓の2件が記録されているはず');
      T.assertEquals(idSets.getCell('17_1', 'discovery_window'), null, '窓の外が入っている');
      T.assertEquals(env.state.snapshots('career_action_watch').count(), 1);
    } finally { cp.restore(); }
  });

  // --- 分類（登録 / 更新 / 完了）--------------------------------------------

  T.test('新規登録を検知して担当者へ送る', function () {
    const cp = fakeActionCp();
    try {
      const env = bootstrappedActionEnv();
      // 基準づくりの後に登録された（＝ S30_prev に居ない）
      cp.records['18_0'] = actionRecord('18_0', { action: daysAgo(0) });
      Runner.execute(actionWatcher(), env.options);

      T.assertEquals(env.notifier.sent.length, 1);
      const sent = env.notifier.sent[0];
      T.assertEquals(sent.eventType, 'created');
      T.assertEquals(sent.resourceId, '18_0');
      // ⚠️ 宛先は求職者の担当。対応の担当（ACTIONCHARGE_ID = 8）ではない
      T.assertEquals(sent.to, 'a.yahara@mybrainlab.net');
      T.assert(sent.subject.indexOf('式波 アスカ') >= 0, '件名に求職者名が無い');
      T.assert(sent.body.indexOf('電話') >= 0, 'アクション種別がラベル化されていない');
      // 新規登録には「前の値」が無い。`(記録なし) → (未設定)` は読めないので出さない
      T.assertEquals(sent.body.indexOf(Templates.LABELS.NO_RECORD), -1,
        '新規登録なのに遷移前の値を出している');
      T.assert(sent.body.indexOf('対応日: ' + TimeFmt.toCpDate(TimeFmt.now())) >= 0,
        '日付が CP 画面と同じ表記で出ていない');
    } finally { cp.restore(); }
  });

  T.test('完了日が入ったら「完了」、日付の付け替えは「更新」', function () {
    const cp = fakeActionCp();
    try {
      cp.records['18_0'] = actionRecord('18_0', { action: daysAgo(1) });
      const env = bootstrappedActionEnv();

      // 完了日を入力した
      cp.records['18_0']['CAREER_ACTION#COMPLETE_DATE'] = daysAgo(0);
      Runner.execute(actionWatcher(), env.options);
      T.assertEquals(env.notifier.sent.length, 1);
      T.assertEquals(env.notifier.sent[0].eventType, 'completed');
      T.assert(env.notifier.sent[0].body.indexOf('完了日') >= 0, '変更内容に完了日が無い');

      // 完了日を別の日に付け替えた → 「更新」
      advance(env);
      cp.records['18_0']['CAREER_ACTION#COMPLETE_DATE'] = daysAgo(1);
      Runner.execute(actionWatcher(), env.options);
      T.assertEquals(env.notifier.sent.length, 2);
      T.assertEquals(env.notifier.sent[1].eventType, 'updated');
    } finally { cp.restore(); }
  });

  T.test('⚠️ 窓に入ってきた古いレコードは「新規」ではなく「更新」', function () {
    const cp = fakeActionCp();
    try {
      // 20日前の対応履歴。30日窓には居るが3日窓には入らない
      cp.records['17_0'] = actionRecord('17_0', { action: daysAgo(20) });
      const env = bootstrappedActionEnv();
      T.assertEquals(cp.calls.select, 0, '30日窓だけの ID を select している');

      // 次回コンタクト日を今日に変更した → 3日窓に入ってくる
      advance(env);
      cp.records['17_0']['CAREER_ACTION#NEXTACTION_DATE'] = daysAgo(0) + 'T10:00:00';
      Runner.execute(actionWatcher(), env.options);

      T.assertEquals(env.notifier.sent.length, 1);
      // S30_prev に居たので「新規登録」ではない
      T.assertEquals(env.notifier.sent[0].eventType, 'updated');
    } finally { cp.restore(); }
  });

  T.test('変化が無ければ何も送らない（3日窓に居続けても静か）', function () {
    const cp = fakeActionCp();
    try {
      cp.records['18_0'] = actionRecord('18_0', { action: daysAgo(1) });
      const env = bootstrappedActionEnv();
      const result = Runner.execute(actionWatcher(), env.options);
      T.assertEquals(result.eventsDetected, 0);
      T.assertEquals(env.notifier.sent.length, 0);
      T.assertEquals(cp.calls.select, 2, '3日窓の1件を基準づくりと本番で1回ずつ');
    } finally { cp.restore(); }
  });

  // --- 宛先が空（仕様書 3.3.6）----------------------------------------------

  T.test('⚠️ 宛先が空なら送らない。ただし件数を数える', function () {
    const cp = fakeActionCp();
    try {
      const env = bootstrappedActionEnv();
      // CHARGE_ID はあるが CHARGE_EMAIL が空（検証テナントで実在した状態）
      cp.records['18_0'] = actionRecord('18_0', { action: daysAgo(0) }, { email: '' });
      const result = Runner.execute(actionWatcher(), env.options);

      T.assertEquals(env.notifier.sent.length, 0, '宛先が無いのに送っている');
      T.assertEquals(result.eventsDetected, 1, '検知そのものは行われるはず');
      const day = Metrics.create({ props: env.props }).read(TimeFmt.today());
      T.assertEquals(day.counters[Templates.LABELS.COUNTER_NO_ADDRESS], 1,
        '日次サマリに出す件数が数えられていない');
      // 宛先が無くてもスナップショットは進む（後から担当者が付いても遡らない）
      T.assertEquals(env.state.snapshots('career_action_watch').has('18_0'), true);
    } finally { cp.restore(); }
  });

  T.test('壊れたアドレスも「宛先なし」として扱う', function () {
    const cfg = actionWatcher().config;
    T.assertEquals(CareerActionWatcher.addressOf({ 'CAREER#CHARGE_EMAIL': ' a@b.co ' }, cfg), 'a@b.co');
    T.assertEquals(CareerActionWatcher.addressOf({ 'CAREER#CHARGE_EMAIL': '未設定' }, cfg), null);
    T.assertEquals(CareerActionWatcher.addressOf({ 'CAREER#CHARGE_EMAIL': null }, cfg), null);
  });

  // --- 冪等除去（仕様書 11.5）-----------------------------------------------

  T.test('⚠️ 中断して再処理しても同じ変化で2通目が出ない', function () {
    // 中断したサイクルは snapshots を書き戻さないので、次サイクルで**同じ変化を
    // もう一度検知する。**二重送信を止めているのは冪等キーだけ（仕様書 11.5）
    const cp = fakeActionCp();
    try {
      cp.records['18_0'] = actionRecord('18_0', { action: daysAgo(1) });
      cp.records['18_1'] = actionRecord('18_1', { action: daysAgo(1) });
      const env = bootstrappedActionEnv();
      cp.records['18_0']['CAREER_ACTION#COMPLETE_DATE'] = daysAgo(0);
      cp.records['18_1']['CAREER_ACTION#COMPLETE_DATE'] = daysAgo(0);

      // 検索2回 + select 1回 + マスタ2回ぶんの予算。
      // **1件目を送った直後に予算切れになる**（2件目の select で落ちる）
      const first = Runner.execute(actionWatcher({ budgetPerCycle: 5 }), env.options);
      T.assertEquals(first.exhausted, true);
      T.assertEquals(env.notifier.sent.length, 1);
      T.assertEquals(env.notifier.sent[0].resourceId, '18_0');

      advance(env);
      Runner.execute(actionWatcher(), env.options);
      T.assertEquals(env.notifier.sent.length, 2, '18_0 に2通目が出ている');
      T.assertEquals(env.notifier.sent[1].resourceId, '18_1');
    } finally { cp.restore(); }
  });

  T.test('日付を戻したときは別のイベントとして通知される', function () {
    const cp = fakeActionCp();
    try {
      cp.records['18_0'] = actionRecord('18_0', { action: daysAgo(2) });
      const env = bootstrappedActionEnv();

      cp.records['18_0']['CAREER_ACTION#ACTION_DATE'] = daysAgo(1);
      Runner.execute(actionWatcher(), env.options);
      advance(env);
      // 元の日付に戻す。冪等キーに前後の両方を入れているので別イベントになる
      cp.records['18_0']['CAREER_ACTION#ACTION_DATE'] = daysAgo(2);
      Runner.execute(actionWatcher(), env.options);
      T.assertEquals(env.notifier.sent.length, 2, '戻した変更が消えている');
    } finally { cp.restore(); }
  });

  // --- 中断（仕様書 11.4）---------------------------------------------------

  T.test('⚠️ 中断したサイクルでは S30_prev もカーソルも進めない', function () {
    const cp = fakeActionCp();
    try {
      cp.records['18_0'] = actionRecord('18_0', { action: daysAgo(1) });
      const env = bootstrappedActionEnv();
      const before = env.state.getCursor('career_action_watch').value.getTime();

      // 30日窓の検索すら終わらない予算で回す
      cp.records['18_1'] = actionRecord('18_1', { action: daysAgo(0) });
      const result = Runner.execute(actionWatcher({ budgetPerCycle: 1 }), env.options);
      T.assertEquals(result.exhausted, true);
      T.assertEquals(env.notifier.sent.length, 0);

      const after = State.create({ props: env.props, sheets: env.sheets });
      T.assertEquals(after.getCursor('career_action_watch').value.getTime(), before,
        'カーソルが進んでいる');
      T.assertEquals(after.idSets('career_action_watch').getCell('18_1', 'discovery_window'),
        null, '⚠️ 見きれていない ID を S30_prev に入れている（次サイクルで誤分類する）');
    } finally { cp.restore(); }
  });

  // --- 走査量（設計の要）----------------------------------------------------

  T.test('走査量は総件数ではなく直近の活動量に比例する', function () {
    const cp = fakeActionCp();
    try {
      // 窓の外の対応履歴を50件置く（本番は約3万件）
      for (let i = 0; i < 50; i++) {
        cp.records['9_' + i] = actionRecord('9_' + i, { action: daysAgo(100 + i) });
      }
      cp.records['18_0'] = actionRecord('18_0', { action: daysAgo(1) });
      const env = bootstrappedActionEnv();
      const selectsAfterBootstrap = cp.calls.select;

      cp.records['18_1'] = actionRecord('18_1', { action: daysAgo(0) });
      Runner.execute(actionWatcher(), env.options);

      // 窓の中の2件だけを select する。50件は ID にも現れない
      T.assertEquals(cp.calls.select - selectsAfterBootstrap, 2);
      T.assertEquals(env.notifier.sent.length, 1);
    } finally { cp.restore(); }
  });

  T.test('担当者未設定の求職者は走査もしない（母集団の絞り込み）', function () {
    const cp = fakeActionCp();
    try {
      // CHARGE_ID が無い＝担当者未設定。検証テナントでは18人中13人がこれ
      cp.records['6_0'] = actionRecord('6_0', { action: daysAgo(0) },
        { chargeId: null, email: '' });
      const env = bootstrappedActionEnv();
      T.assertEquals(cp.calls.select, 0, '通知しない求職者を走査している');
    } finally { cp.restore(); }
  });

  T.test('30日窓から外れた ID は S30_prev から落ちる', function () {
    const cp = fakeActionCp();
    try {
      cp.records['18_0'] = actionRecord('18_0', { action: daysAgo(29) });
      const env = bootstrappedActionEnv();
      T.assertEquals(env.state.idSets('career_action_watch').count(), 1);

      // 窓の外へ出す（日付を書き換えて再走査する）
      advance(env);
      cp.records['18_0']['CAREER_ACTION#ACTION_DATE'] = daysAgo(40);
      Runner.execute(actionWatcher(), env.options);
      const after = State.create({ props: env.props, sheets: env.sheets });
      T.assertEquals(after.idSets('career_action_watch').count(), 0,
        '集合が「かつて窓に入った ID」になって無限に伸びる');
    } finally { cp.restore(); }
  });

  // --- 対応番号（0 始まり）--------------------------------------------------

  T.test('対応番号の 0 を未設定に潰さない', function () {
    T.assertEquals(CareerActionWatcher.histseqOf('18_0', { 'CAREER_ACTION#HISTSEQ': 0 }), '0');
    // レスポンスに無ければ ID を分解する
    T.assertEquals(CareerActionWatcher.histseqOf('18_3', {}), '3');
    T.assertEquals(CareerActionWatcher.careerIdOf('18_3', {}), '18');
  });

  // --- メール送信（notifiers/mail.js）---------------------------------------

  T.test('メールは宛先・件名・本文をそのまま MailApp へ渡す', function () {
    const mailApp = T.fakeMailApp();
    const notifier = MailNotifier.create({ mailApp: mailApp, props: T.fakeProperties() });
    notifier.send(Events.notification({
      watcherId: 'career_action_watch', resourceId: '18_0', eventType: 'created',
      digest: 'd', channelKey: 'career_action',
      subject: '件名', body: '本文', to: 'a.yahara@mybrainlab.net',
    }));
    T.assertEquals(mailApp.sent.length, 1);
    T.assertEquals(mailApp.sent[0].to, 'a.yahara@mybrainlab.net');
    T.assertEquals(mailApp.sent[0].subject, '件名');
    T.assertEquals(mailApp.sent[0].body, '本文');
  });

  T.test('⚠️ ドライランでは本物の宛先へ送らない', function () {
    const mailApp = T.fakeMailApp();
    const props = T.fakeProperties();
    props.setProperty('MAIL_ADMIN_ADDRESS', 'admin@mybrainlab.net');
    const notifier = MailNotifier.create({ mailApp: mailApp, props: props, dryRun: true });
    notifier.send(Events.notification({
      watcherId: 'career_action_watch', resourceId: '18_0', eventType: 'created',
      digest: 'd', channelKey: 'career_action',
      subject: '件名', body: '本文', to: 'honmono@example.com',
    }));
    T.assertEquals(mailApp.sent[0].to, 'admin@mybrainlab.net');
    T.assert(mailApp.sent[0].body.indexOf('honmono@example.com') >= 0,
      '本来の宛先が本文に出ていない');
  });

  T.test('⚠️ 寄せ先が設定されていなければドライランを拒否する', function () {
    // ここで通してしまうと本物の担当者へ送ってしまう
    T.assertThrows(Errors.KIND.CONFIG, function () {
      MailNotifier.create({ mailApp: T.fakeMailApp(), props: T.fakeProperties(), dryRun: true });
    });
  });

  T.test('宛先を持たない通知（サマリ）は管理者へ送る', function () {
    // 1サイクルの上限を超えたぶんのサマリには個別の宛先が無い。
    // **業務の通知がここへ来ることはない**（宛先が無ければウォッチャーが先に弾く）
    const mailApp = T.fakeMailApp();
    const props = T.fakeProperties();
    props.setProperty('MAIL_ADMIN_ADDRESS', 'admin@mybrainlab.net');
    MailNotifier.create({ mailApp: mailApp, props: props }).send(Events.notification({
      watcherId: 'career_action_watch', resourceId: '__summary__', eventType: 'summary',
      digest: 'd', channelKey: 'career_action', subject: 's', body: 'b',
    }));
    T.assertEquals(mailApp.sent[0].to, 'admin@mybrainlab.net');
  });

  T.test('宛先が壊れていたら送らずに NotifyError', function () {
    const mailApp = T.fakeMailApp();
    const notifier = MailNotifier.create({ mailApp: mailApp, props: T.fakeProperties() });
    T.assertThrows(Errors.KIND.NOTIFY, function () {
      notifier.send(Events.notification({
        watcherId: 'w', resourceId: '1', eventType: 'created', digest: 'd',
        channelKey: 'career_action', subject: 's', body: 'b', to: 'not-an-address',
      }));
    });
    T.assertEquals(mailApp.sent.length, 0);
  });

  T.test('日次上限を使い切っていたら送らない', function () {
    const mailApp = T.fakeMailApp({ quota: 0 });
    const notifier = MailNotifier.create({ mailApp: mailApp, props: T.fakeProperties() });
    T.assertThrows(Errors.KIND.NOTIFY, function () {
      notifier.send(Events.notification({
        watcherId: 'w', resourceId: '1', eventType: 'created', digest: 'd',
        channelKey: 'career_action', subject: 's', body: 'b', to: 'a@b.co',
      }));
    });
    T.assertEquals(mailApp.sent.length, 0);
  });

  T.test('送信に失敗した通知は dead_letter に残る', function () {
    const sheets = T.fakeSheets();
    const state = newState({ sheets: sheets });
    const mailApp = T.fakeMailApp({ failWith: 'blocked by policy' });
    const dispatcher = Dispatcher.create({
      state: state,
      notifiers: [MailNotifier.create({ mailApp: mailApp, props: T.fakeProperties() })],
    });
    dispatcher.beginCycle();
    dispatcher.dispatchOne(Events.notification({
      watcherId: 'career_action_watch', resourceId: '18_0', eventType: 'created',
      digest: 'd', channelKey: 'career_action', subject: 's', body: 'b', to: 'a@b.co',
    }));
    T.assertEquals(dispatcher.endCycle(), 0);
    T.assertEquals(sheets.dataRowCount(Sheets.NAMES.DEAD_LETTER), 1);
    // ⚠️ dead_letter に宛先を残さない（シートの共有範囲が広がる）
    const row = sheets.dump(Sheets.NAMES.DEAD_LETTER)[1];
    T.assertEquals(String(row[2]).indexOf('a@b.co'), -1, 'dead_letter に宛先が載っている');
  });

  T.test('メールと Slack はチャンネルで棲み分ける', function () {
    const mail = MailNotifier.create({ props: T.fakeProperties() });
    const slack = SlackNotifier.create({ props: T.fakeProperties() });
    T.assertEquals(mail.supports('career_action'), true);
    T.assertEquals(mail.supports('progress_flow'), false);
    T.assertEquals(slack.supports('career_action'), false);
    T.assertEquals(slack.supports('progress_flow'), true);
  });

  // --- 日次サマリ -----------------------------------------------------------

  T.test('日次サマリに出すのは有効なウォッチャーだけ', function () {
    // 止めているウォッチャーを毎日「基準づくりが済んでいない」⚠️ として報告すると、
    // 本物の異常が埋もれる（core/metrics.js の report）
    const watchers = activeWatchers();
    watchers.forEach(function (w) {
      T.assertEquals(w.enabled, true, w.id + ' は止まっているのに日次サマリに出る');
    });
    const ids = watchers.map(function (w) { return w.id; });
    T.assert(ids.indexOf('career_status') >= 0);
    T.assert(ids.indexOf('progress_flow') >= 0);
  });

  // --- 日付の表記 -----------------------------------------------------------

  T.test('日付はCP画面と同じスラッシュ区切りで出す', function () {
    T.assertEquals(TimeFmt.toDisplay('2026-08-05', 'date'), '2026/08/05');
    // 時刻が 00:00:00 の datetime は日付だけにする
    T.assertEquals(TimeFmt.toDisplay('2026-08-09T00:00:00', 'datetime'), '2026/08/09');
    T.assertEquals(TimeFmt.toDisplay('2026-08-09T10:30:00', 'datetime'), '2026/08/09 10:30:00');
    T.assertEquals(TimeFmt.toDisplay(null, 'date'), null);
    // 想定外の形式でも例外にしない（通知の組み立てで落ちると1サイクル失敗する）
    T.assertEquals(TimeFmt.toDisplay('こわれた値', 'date'), 'こわれた値');
  });

  return T.run('career_action');
}

/** validate() に渡す ctx。Runner を通さずに起動時チェックだけを走らせる。 */
function actionValidateCtx(overrides) {
  const opts = overrides || {};
  const state = newState();
  const watcher = CareerActionWatcher.create(opts);
  return {
    config: watcher.config,
    budget: Budget.unlimited('career_action_watch'),
    schema: Schema,
    master: Master,
    templates: Templates,
    dispatcher: Dispatcher.create({
      state: state, notifiers: [recordingNotifier(['career_action'])],
    }),
  };
}
