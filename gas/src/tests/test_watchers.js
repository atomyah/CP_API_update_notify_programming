/**
 * Phase3（要件1 + Slack 通知）のテスト。
 *
 * rules/50-code-style.md のテスト優先順位のうち、ここで厚く見るのは 3（冪等除去）。
 * **移植で最も事故になりやすいのは notified の UNIQUE 制約の喪失**（仕様書 11.5）で、
 * 二重通知は発覚が遅れる。
 *
 * それに加えて Phase3 固有の事故を潰す:
 *   - ブートストラップ前に通知が出ないこと（出ると Slack が溢れる）
 *   - コード値がラベルに変換されること
 *   - 中断したサイクルでカーソルも snapshots も進まないこと（仕様書 11.4）
 *
 * 使い方: Apps Script エディタで `runWatcherTests`（または `runAllTests`）を実行する。
 * **CP API・Slack・本番のシート・本番のプロパティを一切触らない。**
 */

/** テスト用の schema。実環境の career は 232 項目だが、形は同じ。 */
function fakeSchemaItems() {
  return [
    { itemId: 'CAREER#CAREER_ID', label: '求職者ID', itemType: 'number' },
    { itemId: 'CAREER#LASTNAME', label: '姓', itemType: 'text' },
    { itemId: 'CAREER#FIRSTNAME', label: '名', itemType: 'text' },
    { itemId: 'CAREER#48002', label: '国籍（氏名・生年月日）', itemType: 'text' },
    {
      itemId: 'CAREER#CNSLSTATUS_ID', label: '面談ステータス', itemType: 'selectone',
      validationRule: { codeName: 'MSTCNSLSTATUS' },
    },
    { itemId: 'CAREER#MEMO', label: 'メモ', itemType: 'textarea' },
    // 以下3件は除外される（保存のたびに動く・業務上の変化ではない）
    { itemId: 'CAREER#UPDATE_DATE', label: '更新日時', itemType: 'datetime' },
    { itemId: 'CAREER#INSERT_DATE', label: '登録日時', itemType: 'datetime' },
    { itemId: 'CAREER#LAST_LOGIN', label: '最終ログイン', itemType: 'datetime' },
  ];
}

function fakeRecords() {
  return {
    // CLAUDE.md の検証用レコードに合わせてある
    '18': {
      'CAREER#CAREER_ID': 18, 'CAREER#LASTNAME': '式波', 'CAREER#FIRSTNAME': 'アスカ',
      'CAREER#48002': '米国', 'CAREER#CNSLSTATUS_ID': '1', 'CAREER#MEMO': '',
    },
    '17': {
      'CAREER#CAREER_ID': 17, 'CAREER#LASTNAME': '葛城', 'CAREER#FIRSTNAME': 'ミサト',
      'CAREER#48002': '日本', 'CAREER#CNSLSTATUS_ID': '3', 'CAREER#MEMO': '',
    },
  };
}

/**
 * CP クライアントを差し替える。**CP は一切叩かない。**
 * 予算は本物と同じように消費させる（予算切れの挙動を検証するため）。
 */
function fakeCp(options) {
  const opts = options || {};
  const saved = {
    search: CpClient.search, select: CpClient.select,
    getSchema: CpClient.getSchema, getMaster: CpClient.getMaster,
  };
  const cp = {
    schema: opts.schema || fakeSchemaItems(),
    records: opts.records || fakeRecords(),
    masters: opts.masters || { MSTCNSLSTATUS: { '1': '未対応', '3': '面談待ち' } },
    // search が返す ID。省略時は records の全件
    ids: opts.ids || null,
    calls: { search: 0, select: 0, schema: 0, master: 0 },
    lastItemIds: null,
    restore: function () {
      CpClient.search = saved.search;
      CpClient.select = saved.select;
      CpClient.getSchema = saved.getSchema;
      CpClient.getMaster = saved.getMaster;
    },
  };

  CpClient.getSchema = function (resource, budget) {
    cp.calls.schema += 1;
    if (budget) budget.consume();
    return cp.schema;
  };
  CpClient.getMaster = function (codeName, budget) {
    cp.calls.master += 1;
    if (budget) budget.consume();
    return cp.masters[codeName] || {};
  };
  CpClient.search = function (resource, params) {
    cp.calls.search += 1;
    if (params && params.budget) params.budget.consume();
    const all = cp.ids || Object.keys(cp.records);
    const offset = (params && params.offset) || 0;
    const limit = (params && params.limit) || 100;
    return { ids: all.slice(offset, offset + limit), count: all.length };
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

/** 送信内容を記録するだけの通知先。Slack を叩かない。 */
function recordingNotifier(channelKeys) {
  const keys = channelKeys || ['career_status'];
  return {
    sent: [],
    failWith: null,
    supports: function (channelKey) { return keys.indexOf(channelKey) >= 0; },
    send: function (notification) {
      if (this.failWith) throw Errors.notify(this.failWith);
      this.sent.push(notification);
    },
  };
}

/** Runner・通知先・CP を差し替えた一式。**本番の状態を触らない。** */
function newWatcherEnv(options) {
  const opts = options || {};
  const env = newEnv({ props: opts.props, sheets: opts.sheets });
  env.notifier = opts.notifier || recordingNotifier();
  env.dispatcher = Dispatcher.create({ state: env.state, notifiers: [env.notifier] });
  env.options = { state: env.state, lock: env.lock, dispatcher: env.dispatcher };
  return env;
}

/**
 * 次のトリガー実行を模す。**State を作り直す。**
 *
 * GAS はトリガー実行ごとに独立したプロセスで、メモリ上の snapshots は引き継がれない
 * （仕様書 11.1）。同じ State を使い回すと、書き戻していない変更が次サイクルに
 * 残ってしまい、**中断時の挙動を検証できない。**
 */
function advance(env) {
  env.state = State.create({ props: env.props, sheets: env.sheets });
  env.dispatcher = Dispatcher.create({ state: env.state, notifiers: [env.notifier] });
  env.options = { state: env.state, lock: env.lock, dispatcher: env.dispatcher };
  return env;
}

/** ブートストラップ済みの状態を作る（通知は出ない）。 */
function bootstrappedEnv(cp, options) {
  const env = newWatcherEnv(options);
  Runner.execute(CareerStatusWatcher.create(), {
    state: env.state, lock: env.lock, dispatcher: env.dispatcher, bootstrap: true,
  });
  return advance(env);
}

function runWatcherTests() {
  T.reset();

  // --- テンプレート ---------------------------------------------------------

  T.test('テンプレートの未定義変数は ConfigError', function () {
    // 黙って空文字にすると、変数名の打ち間違いに気づけないまま通知が出続ける
    T.assertThrows(Errors.KIND.CONFIG, function () {
      Templates.render('{unknown_variable}', { resource: 'career' });
    });
  });

  T.test('change_line が埋まる', function () {
    const template = Templates.get('record_changed');
    T.assertEquals(
      Templates.renderField(template, 'change_line',
        { label: '面談ステータス', old: '未対応', new: '面談待ち' }),
      '• 面談ステータス: 未対応 → 面談待ち');
  });

  // --- マスタ（コード値 → ラベル） ------------------------------------------

  T.test('コード値がラベルになる', function () {
    const cp = fakeCp();
    try {
      T.assertEquals(Master.label('MSTCNSLSTATUS', '3'), '面談待ち');
    } finally { cp.restore(); }
  });

  T.test('未設定・空・マスタに無い 0 は (未設定)', function () {
    const cp = fakeCp();
    try {
      T.assertEquals(Master.label('MSTCNSLSTATUS', null), '(未設定)');
      T.assertEquals(Master.label('MSTCNSLSTATUS', ''), '(未設定)');
      // CP は selectone の未設定を 0 で表す。マスタには載っていない（実測）
      T.assertEquals(Master.label('MSTCNSLSTATUS', '0'), '(未設定)');
    } finally { cp.restore(); }
  });

  T.test('マスタで解決できない値は注釈を付けずそのまま出す', function () {
    // CAREER#ZIP_ID のように codeName を持ちながら列挙を返さないマスタがある
    const cp = fakeCp({ masters: { MSTZIPCODE: {} } });
    try {
      T.assertEquals(Master.label('MSTZIPCODE', '2250013'), '2250013');
      T.assertEquals(Master.label(null, '米国'), '米国');
    } finally { cp.restore(); }
  });

  T.test('select（複数選択）は / で連結する', function () {
    const cp = fakeCp({ masters: { M: { '8': '英語', '9': '中国語' } } });
    try {
      T.assertEquals(Master.label('M', ['8', '9']), '英語 / 中国語');
    } finally { cp.restore(); }
  });

  // --- schema ---------------------------------------------------------------

  T.test('設定に無い項目IDは ConfigError（実環境の schema が正）', function () {
    const cp = fakeCp();
    try {
      T.assertThrows(Errors.KIND.CONFIG, function () {
        Schema.validate('career', ['CAREER#NO_SUCH_ITEM']);
      });
      Schema.validate('career', ['CAREER#48002']);   // 実在するものは通る
    } finally { cp.restore(); }
  });

  T.test('オリつく項目を判別する', function () {
    T.assertEquals(Schema.isCustom('CAREER#48002'), true);
    T.assertEquals(Schema.isCustom('CAREER#LASTNAME'), false);
  });

  T.test('同じ実行の中では schema を1回しか取らない', function () {
    const cp = fakeCp();
    try {
      Schema.get('career');
      Schema.get('career');
      T.assertEquals(cp.calls.schema, 1);
    } finally { cp.restore(); }
  });

  // --- 監視項目の解決 -------------------------------------------------------

  T.test('除外サフィックスと除外項目が効く', function () {
    // UPDATE_DATE / INSERT_DATE を含めると「更新された」だけで毎回通知が出る。
    // LAST_LOGIN はマイページのログインで動く（業務上の変化ではない）
    const cp = fakeCp();
    try {
      const items = CareerStatusWatcher.resolveItems({
        config: Config.careerStatus, schema: Schema, budget: Budget.unlimited('t'),
      });
      const ids = items.map(function (i) { return i.itemId; });
      T.assertEquals(ids.length, 6, '9項目 − 除外3');
      T.assertEquals(ids.indexOf('CAREER#UPDATE_DATE'), -1);
      T.assertEquals(ids.indexOf('CAREER#LAST_LOGIN'), -1);
      T.assert(ids.indexOf('CAREER#48002') >= 0, 'オリつく項目が落ちている');
    } finally { cp.restore(); }
  });

  T.test('参照マスタは schema の validationRule.codeName から取れる', function () {
    const cp = fakeCp();
    try {
      const items = CareerStatusWatcher.resolveItems({
        config: Config.careerStatus, schema: Schema, budget: Budget.unlimited('t'),
      });
      const status = items.filter(function (i) {
        return i.itemId === 'CAREER#CNSLSTATUS_ID';
      })[0];
      T.assertEquals(status.master, 'MSTCNSLSTATUS');
      T.assertEquals(status.itemType, 'selectone');
    } finally { cp.restore(); }
  });

  T.test('検索条件は CP の datetime 形式（秒まで）', function () {
    // YYYY/MM/DD HH:MM（分まで）は 400 で拒否される（実測）
    const condition = CareerStatusWatcher.buildCondition(
      Config.careerStatus, TimeFmt.fromStore('2026-09-05 15:20:48'));
    T.assertEquals(condition.compoundType, 'and');
    T.assertEquals(condition.items[0].itemId, 'CAREER#UPDATE_DATE');
    T.assertEquals(condition.items[0].searchType, 'GE');
    T.assertEquals(condition.items[0].value, '2026/09/05 15:20:48');
  });

  T.test('targetCondition を足すと and で結合される', function () {
    const cfg = { updateDateItem: 'CAREER#UPDATE_DATE',
      targetCondition: { itemId: 'CAREER#CAREER_ID', searchType: 'EQ', value: '18' } };
    const condition = CareerStatusWatcher.buildCondition(cfg, TimeFmt.now());
    T.assertEquals(condition.items.length, 2);
    // 絞り込みが無ければ全求職者が対象（現在の決定）
    T.assertEquals(CareerStatusWatcher.buildCondition(
      { updateDateItem: 'CAREER#UPDATE_DATE', targetCondition: null }, null), null);
  });

  T.test('生値を保存するのは設定に挙げた項目だけ', function () {
    // 既定はハッシュのみ（rules/40-secrets-and-security.md）
    T.assertEquals(CareerStatusWatcher.keepsRaw(Config.careerStatus, 'CAREER#48002'), true);
    T.assertEquals(CareerStatusWatcher.keepsRaw(Config.careerStatus, 'CAREER#MEMO'), false);
    T.assertEquals(CareerStatusWatcher.keepsRaw({ rawValueItems: '*' }, 'CAREER#MEMO'), true);
  });

  // --- ブートストラップ -----------------------------------------------------

  T.test('⚠️ ブートストラップ前に execute しても通知は出ない', function () {
    // 前回値が無い状態で通知すると、既存の全求職者が「変化した」と誤判定される
    const cp = fakeCp();
    try {
      const env = newWatcherEnv();
      const result = Runner.execute(CareerStatusWatcher.create(), env.options);
      T.assertEquals(result.ok, false, '失敗として扱われるはず');
      T.assertEquals(env.notifier.sent.length, 0);
      T.assertEquals(env.state.getCursor('career_status'), null, 'カーソルが進んでいる');
    } finally { cp.restore(); }
  });

  T.test('ブートストラップは通知せずに基準を作る', function () {
    const cp = fakeCp();
    try {
      const env = bootstrappedEnv(cp);
      T.assertEquals(env.notifier.sent.length, 0, 'ブートストラップで通知が出ている');
      const cursor = env.state.getCursor('career_status');
      T.assertEquals(cursor.bootstrapped, true);
      T.assertEquals(cursor.pageOffset, 0);
      T.assertEquals(env.state.snapshots('career_status').count(), 2, '1求職者 = 1行');
      T.assertEquals(cp.calls.select, 2);
    } finally { cp.restore(); }
  });

  T.test('itemIds は重複しない（重複は 400 になる）', function () {
    // 全項目監視では identityItems が必ず監視項目と重複する（実測 2026-08-07）
    const cp = fakeCp();
    try {
      bootstrappedEnv(cp);
      const seen = {};
      cp.lastItemIds.forEach(function (id) {
        T.assert(!seen[id], 'itemIds に重複がある: ' + id);
        seen[id] = true;
      });
    } finally { cp.restore(); }
  });

  // --- 差分検知と通知（要件1の本体） ---------------------------------------

  T.test('変化した項目だけが1通の通知になる', function () {
    const cp = fakeCp();
    try {
      const env = bootstrappedEnv(cp);
      cp.records['18']['CAREER#48002'] = '日本';   // CP 画面で1項目を変えた想定

      const result = Runner.execute(CareerStatusWatcher.create(), env.options);
      T.assertEquals(result.ok, true);
      T.assertEquals(result.eventsDetected, 1);
      T.assertEquals(result.eventsNotified, 1);
      T.assertEquals(env.notifier.sent.length, 1, '1通だけ届くはず');

      const body = env.notifier.sent[0].body;
      T.assert(body.indexOf('国籍（氏名・生年月日）: 米国 → 日本') >= 0,
               '遷移前後が読めない: ' + body);
      T.assert(body.indexOf('式波 アスカ') >= 0, '見出しに名前が出ていない');
      T.assert(body.indexOf('CAREER#MEMO') < 0, '変わっていない項目が載っている');
    } finally { cp.restore(); }
  });

  T.test('⚠️ 通知後に中断したサイクルを再実行しても2通目は出ない（冪等除去）', function () {
    // GAS で最も起きやすい二重通知の経路。通知は送信済み、snapshots は
    // 書き戻されていない（中断したので）状態で次のサイクルが同じ変化を再検知する。
    // **シートに UNIQUE 制約は無い。アプリ側の冪等キーだけがこれを防いでいる**（仕様書 11.5）
    const cp = fakeCp({ ids: ['18', '17'] });
    try {
      const env = bootstrappedEnv(cp);
      cp.records['18']['CAREER#48002'] = '日本';

      // search(1) + select#18(1) で 18 の通知だけ送り、17 の手前で切れる
      // （schema はブートストラップで取得済み。同じ実行の中では取り直さない）
      const interrupted = Runner.execute(
        CareerStatusWatcher.create({ budgetPerCycle: 2 }), env.options);
      T.assertEquals(interrupted.exhausted, true);
      T.assertEquals(env.notifier.sent.length, 1, '中断前の通知は送られているはず');
      T.assertEquals(env.state.getCursor('career_status').bootstrapped, true);

      // 中断したのでカーソルも snapshots も進んでいない。同じ変化を再検知する
      const again = Runner.execute(CareerStatusWatcher.create(), advance(env).options);
      T.assertEquals(again.eventsDetected, 1, '差分としては再検知される');
      T.assertEquals(again.eventsNotified, 0, '⚠️ 二重通知が出ている');
      T.assertEquals(env.notifier.sent.length, 1);
    } finally { cp.restore(); }
  });

  T.test('変化が無ければ何も出ない', function () {
    const cp = fakeCp();
    try {
      const env = bootstrappedEnv(cp);
      const result = Runner.execute(CareerStatusWatcher.create(), env.options);
      T.assertEquals(result.eventsDetected, 0);
      T.assertEquals(env.notifier.sent.length, 0);
      T.assertEquals(result.cursor === null, false, 'カーソルは進むはず');
    } finally { cp.restore(); }
  });

  T.test('コード値はラベルに変換されて本文に載る', function () {
    const cp = fakeCp();
    try {
      const env = bootstrappedEnv(cp);
      cp.records['17']['CAREER#CNSLSTATUS_ID'] = '1';   // 3（面談待ち）→ 1（未対応）
      Runner.execute(CareerStatusWatcher.create(), env.options);
      const body = env.notifier.sent[0].body;
      T.assert(body.indexOf('面談ステータス: 面談待ち → 未対応') >= 0,
               'コード値のまま出ている: ' + body);
    } finally { cp.restore(); }
  });

  T.test('生値を保存していない項目は (記録なし) → 新しい値', function () {
    const cp = fakeCp();
    try {
      const env = bootstrappedEnv(cp);
      cp.records['18']['CAREER#MEMO'] = '面談メモ';   // rawValueItems に無い項目
      Runner.execute(CareerStatusWatcher.create(), env.options);
      const body = env.notifier.sent[0].body;
      T.assert(body.indexOf('メモ: (記録なし) → 面談メモ') >= 0, body);
    } finally { cp.restore(); }
  });

  T.test('選択項目の 0 は未設定として扱い、誤検知しない', function () {
    // CP は保存時に未入力の選択項目を null から 0 に書き換える（実測 2026-08-07）
    const cp = fakeCp();
    try {
      cp.records['18']['CAREER#CNSLSTATUS_ID'] = null;
      const env = bootstrappedEnv(cp);
      cp.records['18']['CAREER#CNSLSTATUS_ID'] = '0';
      const result = Runner.execute(CareerStatusWatcher.create(), env.options);
      T.assertEquals(result.eventsDetected, 0, '(未設定) → (未設定) が通知されている');
    } finally { cp.restore(); }
  });

  // --- 中断とコミット点（仕様書 11.4） -------------------------------------

  T.test('⚠️ 予算切れではカーソルも snapshots も進めない', function () {
    const cp = fakeCp();
    try {
      const env = bootstrappedEnv(cp);
      const before = TimeFmt.toStore(env.state.getCursor('career_status').value);
      cp.records['18']['CAREER#48002'] = '日本';

      // search(1) + 1件目の select(1) で使い切り、変化した 18 に届く前に切れる
      const result = Runner.execute(
        CareerStatusWatcher.create({ budgetPerCycle: 2 }), env.options);

      T.assertEquals(result.exhausted, true);
      T.assertEquals(result.cursor, null, '⚠️ 打ち切ったサイクルでカーソルを返している');
      T.assertEquals(TimeFmt.toStore(env.state.getCursor('career_status').value), before,
                     '⚠️ カーソルが前進している');
      // snapshots が進むと差分を取りこぼす（＝通知漏れ）
      const reloaded = State.create({ props: env.props, sheets: env.sheets });
      T.assertEquals(
        reloaded.snapshots('career_status').hashOf('18', 'CAREER#48002'),
        State.valueHash('米国', 'text'), '⚠️ snapshots だけが進んでいる');
    } finally { cp.restore(); }
  });

  T.test('中断した次のサイクルで取りこぼさずに通知される', function () {
    const cp = fakeCp();
    try {
      const env = bootstrappedEnv(cp);
      cp.records['18']['CAREER#48002'] = '日本';
      Runner.execute(CareerStatusWatcher.create({ budgetPerCycle: 2 }), env.options);
      T.assertEquals(env.notifier.sent.length, 0);

      const result = Runner.execute(CareerStatusWatcher.create(), advance(env).options);
      T.assertEquals(result.eventsNotified, 1, '中断ぶんが取りこぼされている');
    } finally { cp.restore(); }
  });

  T.test('ブートストラップは途中で切れてもコミットし、次回続きから進む', function () {
    const cp = fakeCp();
    try {
      const env = newWatcherEnv();
      // schema(1) + search(1) + select(1) で1件だけ処理して切れる
      const first = Runner.execute(CareerStatusWatcher.create({ budgetPerCycle: 3 }),
        { state: env.state, lock: env.lock, dispatcher: env.dispatcher, bootstrap: true });
      T.assertEquals(first.ok, true);
      const paused = env.state.getCursor('career_status');
      T.assertEquals(paused.bootstrapped, false, '未完了なのに完了扱いになっている');
      T.assertEquals(env.state.snapshots('career_status').count(), 1,
                     '途中までの基準がコミットされていない');

      // 続きから。処理済みの ID は select し直さない
      const selectsBefore = cp.calls.select;
      advance(env);
      const second = Runner.execute(CareerStatusWatcher.create(),
        { state: env.state, lock: env.lock, dispatcher: env.dispatcher, bootstrap: true });
      T.assertEquals(second.ok, true);
      T.assertEquals(env.state.getCursor('career_status').bootstrapped, true);
      T.assertEquals(env.state.snapshots('career_status').count(), 2);
      T.assertEquals(cp.calls.select - selectsBefore, 1, '処理済みを取り直している');
    } finally { cp.restore(); }
  });

  T.test('ブートストラップ完了後の再実行は何もしない', function () {
    const cp = fakeCp();
    try {
      const env = bootstrappedEnv(cp);
      const before = cp.calls.select;
      Runner.execute(CareerStatusWatcher.create(),
        { state: env.state, lock: env.lock, dispatcher: env.dispatcher, bootstrap: true });
      T.assertEquals(cp.calls.select, before, '全件を取り直している');
    } finally { cp.restore(); }
  });

  // --- 通知の送出（dispatcher） --------------------------------------------

  T.test('⚠️ 送信に失敗しても通知は再送されず dead_letter に残る', function () {
    // 予約（notified への追記）が先。落ちたことは dead_letter で検出する
    const cp = fakeCp();
    try {
      const notifier = recordingNotifier();
      notifier.failWith = 'slack send failed';
      const env = bootstrappedEnv(cp, { notifier: notifier });
      cp.records['18']['CAREER#48002'] = '日本';

      const result = Runner.execute(CareerStatusWatcher.create(), env.options);
      T.assertEquals(result.ok, true, '通知の失敗でサイクルを落としてはいけない');
      T.assertEquals(result.eventsNotified, 0);
      T.assertEquals(env.sheets.dataRowCount(Sheets.NAMES.DEAD_LETTER), 1);
      T.assertEquals(env.sheets.dataRowCount(Sheets.NAMES.NOTIFIED), 1,
                     '予約は通知より先に入っているはず');
    } finally { cp.restore(); }
  });

  T.test('扱える通知先が無いチャンネルは dead_letter に落ちる', function () {
    const state = newState();
    const dispatcher = Dispatcher.create({
      state: state, notifiers: [recordingNotifier(['ops'])],
    });
    const sent = dispatcher.dispatchOne(Events.notification({
      watcherId: 'w1', resourceId: '18', eventType: 'item_changed', digest: 'h1',
      channelKey: 'career_status', body: 'x',
    }));
    T.assertEquals(sent, false);
    T.assertEquals(dispatcher.supports('career_status'), false);
    T.assertEquals(dispatcher.supports('ops'), true);
  });

  // --- Slack 送信 -----------------------------------------------------------

  T.test('Webhook URL が未設定なら NotifyError', function () {
    const notifier = SlackNotifier.create({ props: T.fakeProperties() });
    T.assertThrows(Errors.KIND.NOTIFY, function () {
      notifier.send(sampleNotification());
    });
  });

  T.test('4xx は再送しない（URL 失効・チャンネル削除）', function () {
    const fetch = fakeFetch([400]);
    const notifier = slackWith(fetch);
    T.assertThrows(Errors.KIND.NOTIFY, function () { notifier.send(sampleNotification()); });
    T.assertEquals(fetch.calls.length, 1, '4xx を再送している');
  });

  T.test('5xx は再送し、成功すれば送れたことになる', function () {
    const fetch = fakeFetch([500, 200]);
    slackWith(fetch).send(sampleNotification());
    T.assertEquals(fetch.calls.length, 2);
  });

  T.test('ドライランは本来の宛先を明示して ops へ寄せる', function () {
    const fetch = fakeFetch([200]);
    const notifier = slackWith(fetch, { dryRunChannelKey: 'ops' });
    notifier.send(sampleNotification());
    T.assertEquals(fetch.calls[0].url, 'https://example.invalid/ops');
    const text = JSON.parse(fetch.calls[0].params.payload).text;
    T.assert(text.indexOf('[DRY-RUN]') >= 0, 'ドライランの明示が無い');
    T.assert(text.indexOf('career_status') >= 0, '本来の通知先が読めない');
  });

  return T.run('watchers');
}

/** 通知1件ぶんのサンプル。個人情報は入れない。 */
function sampleNotification() {
  return Events.notification({
    watcherId: 'career_status', resourceId: '18', eventType: 'item_changed',
    digest: 'h1', channelKey: 'career_status', subject: 's', body: 'b',
  });
}

/** UrlFetchApp の代わり。**Slack を叩かない。** */
function fakeFetch(statuses) {
  const calls = [];
  const queue = statuses.slice();
  const fetch = function (url, params) {
    calls.push({ url: url, params: params });
    const status = queue.length ? queue.shift() : 200;
    return {
      getResponseCode: function () { return status; },
      getContentText: function () { return ''; },
    };
  };
  fetch.calls = calls;
  return fetch;
}

function slackWith(fetch, options) {
  const opts = options || {};
  const props = T.fakeProperties();
  props.setProperty('SLACK_WEBHOOK_CAREER_STATUS', 'https://example.invalid/career');
  props.setProperty('SLACK_WEBHOOK_OPS', 'https://example.invalid/ops');
  return SlackNotifier.create({
    props: props, fetch: fetch, dryRunChannelKey: opts.dryRunChannelKey || null,
    sleep: function () {},
  });
}
