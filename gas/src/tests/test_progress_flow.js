/**
 * Phase4（要件2/3 progress_flow + 名前解決）のテスト。
 *
 * ここで厚く見るのは**このウォッチャー固有の事故**:
 *
 *   - ⚠️ 冪等キーに遷移前ステータスが入っていないこと（仕様書 3.2.4）。
 *     入っているとオーバーラップのたびに二重通知になる。**発覚が遅れる**
 *   - ⚠️ 冪等キーが枝番を含むこと。後戻り（16 → 11 → 16）で2回目の 16 が消えない
 *   - 遷移前ステータスの持ち越し（初回は「(不明)」。推測で埋めない）
 *   - 通知しなかった遷移でも持ち越しは更新すること
 *   - 中断したサイクルで持ち越しもカーソルも進めないこと（仕様書 11.4）
 *   - 名前解決のキャッシュが効くこと（効かないと通知1件につき3リクエスト増える）
 *
 * 使い方: Apps Script エディタで `runProgressFlowTests`（または `runAllTests`）を実行する。
 * **CP API・Slack・本番のシート・本番のプロパティを一切触らない。**
 */

/** テスト用の schema。実環境と同じ形（validationRule.codeName を持つ）。 */
function fakeProgressSchemas() {
  return {
    progress_history: [
      { itemId: 'PROGRESS_HISTORY#INSERT_DATE', label: '登録日時', itemType: 'datetime' },
      { itemId: 'PROGRESS_HISTORY#PROGRESS_ID', label: '進捗ID', itemType: 'number' },
      { itemId: 'PROGRESS_HISTORY#PROGRESS_ID_SUB', label: '枝番', itemType: 'number' },
      {
        itemId: 'PROGRESS_HISTORY#PROGRESS_STATUS_ID', label: '進捗ステータス',
        itemType: 'selectone', validationRule: { codeName: 'MST_PROGRESS_STATUS' },
      },
      { itemId: 'PROGRESS_HISTORY#PROGRESS_DATE', label: '進捗日', itemType: 'date' },
      {
        itemId: 'PROGRESS_HISTORY#CAREER_CHARGE_ID', label: '求職者担当',
        itemType: 'selectone', validationRule: { codeName: 'MSTUSER' },
      },
      {
        itemId: 'PROGRESS_HISTORY#ORDER_CHARGE_ID', label: '求人担当',
        itemType: 'selectone', validationRule: { codeName: 'MSTUSER' },
      },
      { itemId: 'PROGRESS_HISTORY#ESTIMATED_SALES_AMOUNT', label: '見込回収金額', itemType: 'number' },
      {
        itemId: 'PROGRESS_HISTORY#ESTIMATED_SALES_ACCURACY', label: '見込確度',
        itemType: 'selectone', validationRule: { codeName: 'MST_ESTIMATED_SALES_ACCURACY' },
      },
      { itemId: 'PROGRESS_HISTORY#ESTIMATED_SALES_MONTH', label: '見込計上月', itemType: 'text' },
    ],
    progress: [
      { itemId: 'PROGRESS#CAREER_ID', label: '求職者ID', itemType: 'number' },
      { itemId: 'PROGRESS#ORDER_ID', label: '求人ID', itemType: 'number' },
      { itemId: 'PROGRESS#CLIENT_ID', label: '企業ID', itemType: 'number' },
      {
        itemId: 'PROGRESS#STATUS_ID', label: '進捗ステータス', itemType: 'selectone',
        validationRule: { codeName: 'MST_PROGRESS_STATUS' },
      },
      {
        itemId: 'PROGRESS#PROGRESS_CHARGE_ID', label: '進捗担当', itemType: 'selectone',
        validationRule: { codeName: 'MSTUSER' },
      },
    ],
    career: [
      { itemId: 'CAREER#LASTNAME', label: '姓', itemType: 'text' },
      { itemId: 'CAREER#FIRSTNAME', label: '名', itemType: 'text' },
    ],
    order: [{ itemId: 'ORDER#POSITIONNAME', label: 'ポジション名', itemType: 'text' }],
    client: [{ itemId: 'CLIENT#CLIENTNAME', label: '企業名', itemType: 'text' }],
  };
}

/**
 * 進捗履歴は**空で始める。**テストの中で addHistory() して「増えた」状況を作る。
 * 進捗・求職者・求人・企業は既にあるものとして置く。
 */
function fakeProgressRecords() {
  return {
    progress_history: {},
    progress: {
      // CLAUDE.md の検証用レコード（式波 アスカ）に紐づく進捗
      '21': {
        'PROGRESS#CAREER_ID': 18, 'PROGRESS#ORDER_ID': 5, 'PROGRESS#CLIENT_ID': 7,
        'PROGRESS#STATUS_ID': '11', 'PROGRESS#PROGRESS_CHARGE_ID': '1',
      },
      '22': {
        'PROGRESS#CAREER_ID': 18, 'PROGRESS#ORDER_ID': 6, 'PROGRESS#CLIENT_ID': 7,
        'PROGRESS#STATUS_ID': '16', 'PROGRESS#PROGRESS_CHARGE_ID': '1',
      },
    },
    career: { '18': { 'CAREER#LASTNAME': '式波', 'CAREER#FIRSTNAME': 'アスカ' } },
    order: {
      '5': { 'ORDER#POSITIONNAME': 'ソフトウェアエンジニア' },
      '6': { 'ORDER#POSITIONNAME': 'データ分析' },
    },
    client: { '7': { 'CLIENT#CLIENTNAME': '株式会社ネルフ' } },
  };
}

/** 進捗履歴を1行足す。CP 画面で進捗を動かしたのと同じ状況。 */
function addHistory(cp, historyId, statusId, extra) {
  const row = {
    'PROGRESS_HISTORY#PROGRESS_ID': Number(String(historyId).split('_')[0]),
    'PROGRESS_HISTORY#PROGRESS_ID_SUB': Number(String(historyId).split('_')[1]),
    'PROGRESS_HISTORY#PROGRESS_STATUS_ID': statusId,
    'PROGRESS_HISTORY#PROGRESS_DATE': '2026-09-06',
    'PROGRESS_HISTORY#CAREER_CHARGE_ID': '1',
    'PROGRESS_HISTORY#ORDER_CHARGE_ID': '1',
    'PROGRESS_HISTORY#ESTIMATED_SALES_AMOUNT': null,
    'PROGRESS_HISTORY#ESTIMATED_SALES_ACCURACY': null,
    'PROGRESS_HISTORY#ESTIMATED_SALES_MONTH': null,
  };
  Object.keys(extra || {}).forEach(function (k) { row[k] = extra[k]; });
  cp.resources.progress_history[historyId] = row;
  return row;
}

/**
 * CP クライアントを差し替える。**CP は一切叩かない。**
 * リソース別に schema とレコードを持つ（要件2/3 は4リソースを横断する）。
 * 予算は本物と同じように消費させる（予算切れの挙動を検証するため）。
 */
function fakeProgressCp(options) {
  const opts = options || {};
  const saved = {
    search: CpClient.search, select: CpClient.select,
    getSchema: CpClient.getSchema, getMaster: CpClient.getMaster,
  };
  const cp = {
    schemas: opts.schemas || fakeProgressSchemas(),
    resources: opts.resources || fakeProgressRecords(),
    masters: opts.masters || {
      MST_PROGRESS_STATUS: { '16': '社内確認中', '11': '応募意思確認中(求人)', '21': '内定' },
      MSTUSER: { '1': '矢原' },
      MST_ESTIMATED_SALES_ACCURACY: { '1': 'A（ほぼ確実）' },
    },
    // select したときに 404 を返す ID。{ resource: [id, ...] }
    notFound: opts.notFound || {},
    calls: { search: 0, select: {}, schema: 0, master: 0 },
    lastSearch: null,
    lastItemIds: {},
    restore: function () {
      CpClient.search = saved.search;
      CpClient.select = saved.select;
      CpClient.getSchema = saved.getSchema;
      CpClient.getMaster = saved.getMaster;
    },
    selects: function (resource) { return cp.calls.select[resource] || 0; },
  };

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
    cp.lastSearch = { resource: resource, params: params };
    // 検索は ID 順ではなく登録順（= INSERT_DATE 昇順）で返る想定
    const all = Object.keys(cp.resources[resource] || {});
    const offset = (params && params.offset) || 0;
    const limit = (params && params.limit) || 100;
    return { ids: all.slice(offset, offset + limit), count: all.length };
  };
  CpClient.select = function (resource, resourceId, itemIds, budget) {
    cp.calls.select[resource] = (cp.calls.select[resource] || 0) + 1;
    if (budget) budget.consume();
    cp.lastItemIds[resource] = itemIds;
    if ((cp.notFound[resource] || []).indexOf(String(resourceId)) >= 0) {
      throw Errors.fromStatus(404, '', 'req-test', '/v1/ext2/' + resource + '/select/' + resourceId);
    }
    const record = (cp.resources[resource] || {})[String(resourceId)] || {};
    const values = {};
    itemIds.forEach(function (itemId) {
      values[itemId] = Object.prototype.hasOwnProperty.call(record, itemId)
        ? record[itemId] : null;
    });
    return values;
  };

  Schema.clearCache();
  Master.clearCache();
  Resolver.clearCache();
  return cp;
}

/** 要件2/3 のチャンネルを扱える通知先を持つ一式。 */
function newProgressEnv(options) {
  const opts = options || {};
  return newWatcherEnv({
    props: opts.props, sheets: opts.sheets,
    notifier: opts.notifier || recordingNotifier(['progress_flow', 'job_intro', 'ops']),
  });
}

/** ブートストラップ済みの状態を作る（通知は出ない）。 */
function bootstrappedProgressEnv(options) {
  const env = newProgressEnv(options);
  Runner.execute(ProgressFlowWatcher.create(), {
    state: env.state, lock: env.lock, dispatcher: env.dispatcher, bootstrap: true,
  });
  return advance(env);
}

/** validate() に渡す ctx。Runner を通さずに起動時チェックだけを走らせる。 */
function progressValidateCtx(overrides) {
  const opts = overrides || {};
  const state = newState();
  return {
    config: opts.config || ProgressFlowWatcher.create().config,
    budget: Budget.unlimited('progress_flow'),
    schema: Schema,
    master: Master,
    resolver: Resolver,
    templates: Templates,
    dispatcher: opts.dispatcher || Dispatcher.create({
      state: state, notifiers: [recordingNotifier(['progress_flow', 'job_intro'])],
    }),
  };
}

function runProgressFlowTests() {
  T.reset();

  // --- 設定と遷移ルール -----------------------------------------------------

  T.test('何も通知されない設定は ConfigError', function () {
    // notifyAllTransitions: false かつ watchedStatuses: [] （仕様書 3.2.7）
    T.assertThrows(Errors.KIND.CONFIG, function () {
      ProgressFlowWatcher.create({ notifyAllTransitions: false, watchedStatuses: [] });
    });
  });

  T.test('全部に当たる特別ルールは ConfigError', function () {
    // 一般チャンネルを覆い隠してしまう
    T.assertThrows(Errors.KIND.CONFIG, function () {
      ProgressFlowWatcher.create({
        specialTransitions: [{ name: 'x', notify: { channelKey: 'job_intro', template: 'job_intro_ok' } }],
      });
    });
  });

  T.test('要件3の遷移は job_intro、それ以外は progress_flow', function () {
    const rules = ProgressFlowWatcher.buildRules(ProgressFlowWatcher.create().config);
    const cfg = ProgressFlowWatcher.create().config;
    T.assertEquals(ProgressFlowWatcher.matchRule(cfg, rules, '11', '16').channelKey, 'job_intro');
    T.assertEquals(ProgressFlowWatcher.matchRule(cfg, rules, '21', '11').channelKey, 'progress_flow');
    // 後戻り（再面談）は一般チャンネル
    T.assertEquals(ProgressFlowWatcher.matchRule(cfg, rules, '16', '11').channelKey, 'progress_flow');
  });

  T.test('遷移前が不明でも既定では要件3に当たる（取りこぼしより重複を選ぶ）', function () {
    const cfg = ProgressFlowWatcher.create().config;
    const rules = ProgressFlowWatcher.buildRules(cfg);
    T.assertEquals(ProgressFlowWatcher.matchRule(cfg, rules, '11', null).channelKey, 'job_intro');

    // fromStatusRequired: true にすると一般チャンネルへ流れる
    const strictCfg = ProgressFlowWatcher.create({
      specialTransitions: [{
        name: '求人紹介OK', toStatus: '11', fromStatus: '16', fromStatusRequired: true,
        notify: { channelKey: 'job_intro', template: 'job_intro_ok' },
      }],
    }).config;
    const strict = ProgressFlowWatcher.buildRules(strictCfg);
    T.assertEquals(
      ProgressFlowWatcher.matchRule(strictCfg, strict, '11', null).channelKey, 'progress_flow');
  });

  T.test('モードB（watchedStatuses）は挙げたステータスだけ通知する', function () {
    const cfg = ProgressFlowWatcher.create({
      notifyAllTransitions: false, watchedStatuses: ['21'], specialTransitions: [],
    }).config;
    const rules = ProgressFlowWatcher.buildRules(cfg);
    T.assertEquals(ProgressFlowWatcher.matchRule(cfg, rules, '21', '11').channelKey, 'progress_flow');
    T.assertEquals(ProgressFlowWatcher.matchRule(cfg, rules, '12', '11'), null);
  });

  // --- ID の分解 ------------------------------------------------------------

  T.test('進捗IDと枝番はレスポンスの値を優先し、無ければIDを分解する', function () {
    T.assertEquals(ProgressFlowWatcher.identify('21_3', {
      'PROGRESS_HISTORY#PROGRESS_ID': 21, 'PROGRESS_HISTORY#PROGRESS_ID_SUB': 3,
    }).progressId, '21');
    const fallback = ProgressFlowWatcher.identify('21_3', {});
    T.assertEquals(fallback.progressId, '21');
    T.assertEquals(fallback.progressSub, '3');
  });

  T.test('枝番の 0 を未設定に潰さない（career_action は 0 始まり）', function () {
    const identity = ProgressFlowWatcher.identify('30_0', {
      'PROGRESS_HISTORY#PROGRESS_ID': 30, 'PROGRESS_HISTORY#PROGRESS_ID_SUB': 0,
    });
    T.assertEquals(identity.progressSub, '0');
  });

  T.test('分解できないIDは progressId が null（dead_letter へ落とす）', function () {
    T.assertEquals(ProgressFlowWatcher.identify('21', {}).progressId, null);
  });

  // --- ブートストラップ -----------------------------------------------------

  T.test('⚠️ ブートストラップ前に execute しても通知は出ない', function () {
    // 基準が無い状態で走らせると既存の進捗履歴が全部「新しい遷移」になる
    const cp = fakeProgressCp();
    try {
      addHistory(cp, '21_1', '16');
      const env = newProgressEnv();
      const result = Runner.execute(ProgressFlowWatcher.create(), env.options);
      T.assertEquals(result.ok, false, '失敗として扱われるはず');
      T.assertEquals(env.notifier.sent.length, 0);
      T.assertEquals(env.state.getCursor('progress_flow'), null, 'カーソルが進んでいる');
    } finally { cp.restore(); }
  });

  T.test('ブートストラップはカーソルを置くだけでリクエストを使わない', function () {
    const cp = fakeProgressCp();
    try {
      addHistory(cp, '21_1', '16');
      const env = bootstrappedProgressEnv();
      T.assertEquals(cp.calls.search, 0, 'CP を叩いている');
      T.assertEquals(cp.selects('progress_history'), 0);
      T.assertEquals(env.notifier.sent.length, 0);
      T.assertEquals(env.state.getCursor('progress_flow').bootstrapped, true);
    } finally { cp.restore(); }
  });

  // --- 検知と通知（要件2の本体） -------------------------------------------

  T.test('進捗が動くと1通だけ届く。遷移前は初回 (不明)', function () {
    const cp = fakeProgressCp();
    try {
      const env = bootstrappedProgressEnv();
      addHistory(cp, '21_1', '16');   // CP 画面で進捗を1つ動かした想定

      const result = Runner.execute(ProgressFlowWatcher.create(), env.options);
      T.assertEquals(result.ok, true);
      T.assertEquals(result.eventsDetected, 1);
      T.assertEquals(result.eventsNotified, 1);
      T.assertEquals(env.notifier.sent.length, 1, '1通だけ届くはず');

      const sent = env.notifier.sent[0];
      T.assertEquals(sent.channelKey, 'progress_flow');
      T.assertEquals(sent.resourceId, '21_1', '冪等キーが枝番を含んでいない');
      T.assert(sent.body.indexOf('ステータス: (不明) → 社内確認中') >= 0,
               '遷移前後が読めない: ' + sent.body);
      T.assert(sent.body.indexOf('式波 アスカ × ソフトウェアエンジニア（株式会社ネルフ）') >= 0,
               '名前が解決されていない: ' + sent.body);
      T.assert(sent.body.indexOf('進捗担当: 矢原') >= 0, 'コード値のまま出ている: ' + sent.body);
    } finally { cp.restore(); }
  });

  T.test('検索条件は INSERT_DATE の CP 形式（秒まで）＋昇順', function () {
    // 古い順に処理しないと、同一進捗の連続した遷移で持ち越しが壊れる
    const cp = fakeProgressCp();
    try {
      const env = bootstrappedProgressEnv();
      Runner.execute(ProgressFlowWatcher.create(), env.options);
      const params = cp.lastSearch.params;
      T.assertEquals(cp.lastSearch.resource, 'progress_history');
      T.assertEquals(params.condition.items[0].itemId, 'PROGRESS_HISTORY#INSERT_DATE');
      T.assertEquals(params.condition.items[0].searchType, 'GE');
      T.assert(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/.test(params.condition.items[0].value),
               'CP の datetime 形式でない: ' + params.condition.items[0].value);
      T.assertEquals(params.sort[0].order, 'asc');
      T.assertEquals(params.limit, 100);
    } finally { cp.restore(); }
  });

  T.test('2回目の遷移では持ち越した遷移前ステータスが出る', function () {
    const cp = fakeProgressCp();
    try {
      const env = bootstrappedProgressEnv();
      addHistory(cp, '21_1', '16');
      Runner.execute(ProgressFlowWatcher.create(), env.options);

      addHistory(cp, '21_2', '11');
      Runner.execute(ProgressFlowWatcher.create(), advance(env).options);

      const sent = env.notifier.sent[1];
      T.assertEquals(sent.channelKey, 'job_intro', '要件3のチャンネルへ出ていない');
      T.assert(sent.body.indexOf('ステータス: 社内確認中 → 応募意思確認中(求人)') >= 0,
               '持ち越しが効いていない: ' + sent.body);
      T.assert(sent.body.indexOf('求人紹介OK') >= 0, 'ルール名が出ていない');
    } finally { cp.restore(); }
  });

  T.test('要件3の見込3項目。未入力は (未設定)', function () {
    const cp = fakeProgressCp();
    try {
      const env = bootstrappedProgressEnv();
      addHistory(cp, '21_2', '11', {
        'PROGRESS_HISTORY#ESTIMATED_SALES_AMOUNT': 300.0,
        'PROGRESS_HISTORY#ESTIMATED_SALES_ACCURACY': '1',
      });
      Runner.execute(ProgressFlowWatcher.create(), env.options);
      const body = env.notifier.sent[0].body;
      // number は JSON 数値で返る。300.0 を 300 と出す
      T.assert(body.indexOf('見込回収金額（万円）: 300') >= 0, body);
      T.assert(body.indexOf('見込確度: A（ほぼ確実）') >= 0, body);
      T.assert(body.indexOf('見込計上月: (未設定)') >= 0, body);
    } finally { cp.restore(); }
  });

  // --- 冪等キー（移植で最も事故になりやすい） -------------------------------

  T.test('⚠️ 遷移前ステータスは冪等キーに入らない（同じ履歴の再取得で二重通知しない）', function () {
    // オーバーラップで同じ履歴を再取得したとき、1回目は from=(不明)、2回目は
    // 持ち越し済みの値と突き合わせて from=16 になる。**ここが digest に入っていると
    // 重複除去をすり抜けて二重通知になる**（仕様書 3.2.4）
    const cp = fakeProgressCp();
    try {
      const env = bootstrappedProgressEnv();
      addHistory(cp, '21_1', '16');
      Runner.execute(ProgressFlowWatcher.create(), env.options);
      T.assertEquals(env.notifier.sent.length, 1);

      const again = Runner.execute(ProgressFlowWatcher.create(), advance(env).options);
      T.assertEquals(again.eventsDetected, 1, '同じ履歴は再取得されるはず');
      T.assertEquals(again.eventsNotified, 0, '⚠️ 二重通知が出ている');
      T.assertEquals(env.notifier.sent.length, 1);
    } finally { cp.restore(); }
  });

  T.test('⚠️ 遷移前が変わってもダイジェストは変わらない', function () {
    // 上のテストは「冪等キーで弾かれた」ことしか見ていない。
    // 予約を取り消して同じ履歴を通し、**ダイジェストそのものが一致する**ことを見る
    const cp = fakeProgressCp();
    try {
      const env = bootstrappedProgressEnv();
      addHistory(cp, '21_1', '16');
      Runner.execute(ProgressFlowWatcher.create(), env.options);
      const first = env.notifier.sent[0];

      advance(env);
      env.state.notified().release('progress_flow', '21_1', 'status_changed', first.digest);
      Runner.execute(ProgressFlowWatcher.create(), env.options);

      const second = env.notifier.sent[1];
      T.assertEquals(second.digest, first.digest, '⚠️ 遷移前がダイジェストに入っている');
      T.assert(first.body.indexOf('(不明) → 社内確認中') >= 0, first.body);
      T.assert(second.body.indexOf('社内確認中 → 社内確認中') >= 0,
               '持ち越しが効いていない: ' + second.body);
    } finally { cp.restore(); }
  });

  T.test('⚠️ 後戻り（16 → 11 → 16）で2回目の 16 が消えない', function () {
    // progressId + ステータス値で冪等キーを作ると 21_1 と 21_3 が同じになり、
    // 2回目の 16 が重複扱いで消える（仕様書 3.2.4）
    const cp = fakeProgressCp();
    try {
      const env = bootstrappedProgressEnv();
      addHistory(cp, '21_1', '16');
      addHistory(cp, '21_2', '11');
      addHistory(cp, '21_3', '16');

      const result = Runner.execute(ProgressFlowWatcher.create(), env.options);
      T.assertEquals(result.eventsNotified, 3, '後戻りが通知から消えている');
      T.assertEquals(env.notifier.sent[2].resourceId, '21_3');
      T.assert(env.notifier.sent[2].body.indexOf('応募意思確認中(求人) → 社内確認中') >= 0,
               '古い順に処理されていない: ' + env.notifier.sent[2].body);
    } finally { cp.restore(); }
  });

  T.test('通知しなかった遷移でも持ち越しは更新する', function () {
    // 飛ばすと次の通知の「遷移前」が古い値になる（仕様書 3.2.3）
    const cp = fakeProgressCp();
    try {
      const env = bootstrappedProgressEnv();
      const watcher = function () {
        return ProgressFlowWatcher.create({
          notifyAllTransitions: false, watchedStatuses: ['21'], specialTransitions: [],
        });
      };
      addHistory(cp, '21_1', '16');
      const filtered = Runner.execute(watcher(), env.options);
      T.assertEquals(filtered.eventsNotified, 0, '絞り込みが効いていない');

      addHistory(cp, '21_2', '21');
      Runner.execute(watcher(), advance(env).options);
      T.assert(env.notifier.sent[0].body.indexOf('社内確認中 → 内定') >= 0,
               '持ち越しが更新されていない: ' + env.notifier.sent[0].body);
    } finally { cp.restore(); }
  });

  // --- 中断とコミット点（仕様書 11.4） -------------------------------------

  T.test('⚠️ 予算切れではカーソルも持ち越しも進めない', function () {
    const cp = fakeProgressCp();
    try {
      const env = bootstrappedProgressEnv();
      const before = TimeFmt.toStore(env.state.getCursor('progress_flow').value);
      addHistory(cp, '21_1', '16');

      // search(1) + 履歴select(1) + 進捗select(1) まで。名前解決の手前で切れる
      const result = Runner.execute(
        ProgressFlowWatcher.create({ budgetPerCycle: 3 }), env.options);

      T.assertEquals(result.exhausted, true);
      T.assertEquals(result.cursor, null, '⚠️ 打ち切ったサイクルでカーソルを返している');
      T.assertEquals(env.notifier.sent.length, 0);
      T.assertEquals(TimeFmt.toStore(env.state.getCursor('progress_flow').value), before,
                     '⚠️ カーソルが前進している');
      const reloaded = State.create({ props: env.props, sheets: env.sheets });
      T.assertEquals(
        reloaded.rawValues('progress_flow')
          .rawOf('21', ProgressFlowWatcher.LAST_STATUS_KEY).hasRaw, false,
        '⚠️ 持ち越しだけが進んでいる');
    } finally { cp.restore(); }
  });

  T.test('中断した次のサイクルで取りこぼさずに通知される', function () {
    const cp = fakeProgressCp();
    try {
      const env = bootstrappedProgressEnv();
      addHistory(cp, '21_1', '16');
      Runner.execute(ProgressFlowWatcher.create({ budgetPerCycle: 3 }), env.options);
      T.assertEquals(env.notifier.sent.length, 0);

      const result = Runner.execute(ProgressFlowWatcher.create(), advance(env).options);
      T.assertEquals(result.eventsNotified, 1, '中断ぶんが取りこぼされている');
      T.assert(env.notifier.sent[0].body.indexOf('(不明) → 社内確認中') >= 0,
               '持ち越しが中断時に進んでいた');
    } finally { cp.restore(); }
  });

  T.test('進捗IDを決められない履歴は dead_letter に落として先へ進む', function () {
    const cp = fakeProgressCp();
    try {
      const env = bootstrappedProgressEnv();
      // ID が "{progressId}_{枝番}" の形をしていない
      cp.resources.progress_history['broken'] = {};
      addHistory(cp, '21_1', '16');

      const result = Runner.execute(ProgressFlowWatcher.create(), env.options);
      T.assertEquals(result.ok, true, '1件の異常でサイクルを落としてはいけない');
      T.assertEquals(result.eventsNotified, 1, '後続が処理されていない');
      T.assertEquals(env.sheets.dataRowCount(Sheets.NAMES.DEAD_LETTER), 1);
    } finally { cp.restore(); }
  });

  // --- 名前解決（core/resolver.js） ----------------------------------------

  T.test('同じ求職者・求人・企業は1サイクルで1回しか引かない', function () {
    // 効かないと通知1件あたり3リクエストが上乗せされる（仕様書 3.2.8）
    const cp = fakeProgressCp();
    try {
      const env = bootstrappedProgressEnv();
      addHistory(cp, '21_1', '16');
      addHistory(cp, '21_2', '11');
      addHistory(cp, '21_3', '16');

      Runner.execute(ProgressFlowWatcher.create(), env.options);
      T.assertEquals(cp.selects('career'), 1, '求職者名を毎回引いている');
      T.assertEquals(cp.selects('order'), 1);
      T.assertEquals(cp.selects('client'), 1);
      T.assertEquals(Resolver.stats().name_cache_hits, 6, '3遷移 × 3種 − 初回3');
    } finally { cp.restore(); }
  });

  T.test('別の求人なら引き直す', function () {
    const cp = fakeProgressCp();
    try {
      const env = bootstrappedProgressEnv();
      addHistory(cp, '21_1', '16');
      addHistory(cp, '22_1', '16');
      Runner.execute(ProgressFlowWatcher.create(), env.options);
      T.assertEquals(cp.selects('order'), 2, '求人が違えば引き直すはず');
      T.assertEquals(cp.selects('client'), 1, '同じ企業を引き直している');
    } finally { cp.restore(); }
  });

  T.test('名前を引けなくても通知は落とさない', function () {
    // 削除済みのレコードを参照している。名前が出ないより通知が届く方が価値が高い
    const cp = fakeProgressCp({ notFound: { order: ['5'] } });
    try {
      const env = bootstrappedProgressEnv();
      addHistory(cp, '21_1', '16');
      const result = Runner.execute(ProgressFlowWatcher.create(), env.options);
      T.assertEquals(result.eventsNotified, 1);
      T.assert(env.notifier.sent[0].body.indexOf('(取得できません: order 5)') >= 0,
               env.notifier.sent[0].body);
    } finally { cp.restore(); }
  });

  T.test('参照IDが未設定（0・null）なら1リクエストも使わない', function () {
    const cp = fakeProgressCp();
    try {
      // CP は未設定の参照 ID を 0 で表す（実測）
      cp.resources.progress['21']['PROGRESS#ORDER_ID'] = 0;
      cp.resources.progress['21']['PROGRESS#CLIENT_ID'] = null;
      const env = bootstrappedProgressEnv();
      addHistory(cp, '21_1', '16');
      Runner.execute(ProgressFlowWatcher.create(), env.options);
      T.assertEquals(cp.selects('order'), 0);
      T.assertEquals(cp.selects('client'), 0);
      T.assert(env.notifier.sent[0].body.indexOf('(未設定)') >= 0, env.notifier.sent[0].body);
    } finally { cp.restore(); }
  });

  T.test('⚠️ 名前解決に担当者メールアドレスを入れない', function () {
    // 要件4の宛先。担当者変更の直後に旧担当へ送る事故になる（仕様書 5.3）
    Object.keys(Config.nameResolution).forEach(function (kind) {
      Config.nameResolution[kind].items.forEach(function (itemId) {
        T.assert(itemId.indexOf('EMAIL') < 0, kind + ' に ' + itemId + ' が入っている');
      });
    });
  });

  // --- 起動時チェック -------------------------------------------------------

  T.test('起動時チェックは項目・テンプレート・チャンネルを検証する', function () {
    const cp = fakeProgressCp();
    try {
      const summary = ProgressFlowWatcher.validate(progressValidateCtx());
      T.assertEquals(summary.notify_all_transitions, true, 'モードAで開始する');
      T.assertEquals(summary.special_transitions.length, 1);
      T.assertEquals(summary.special_transitions[0].to_status, '11');
    } finally { cp.restore(); }
  });

  T.test('schema に無い項目があれば起動を失敗させる', function () {
    const schemas = fakeProgressSchemas();
    schemas.progress = schemas.progress.filter(function (i) {
      // 項目一覧 xlsx に無い項目。実環境の schema が正
      return i.itemId !== 'PROGRESS#PROGRESS_CHARGE_ID';
    });
    const cp = fakeProgressCp({ schemas: schemas });
    try {
      T.assertThrows(Errors.KIND.CONFIG, function () {
        ProgressFlowWatcher.validate(progressValidateCtx());
      });
    } finally { cp.restore(); }
  });

  T.test('テンプレートの未定義変数は起動時に落とす', function () {
    // 通知の組み立て時に落ちると、そのイベントは dead_letter にすら載らない
    const cp = fakeProgressCp();
    Templates.TEMPLATES.progress_flow_test_bad = { body: '{no_such_variable}' };
    try {
      const config = ProgressFlowWatcher.create(
        { notify: { template: 'progress_flow_test_bad' } }).config;
      T.assertThrows(Errors.KIND.CONFIG, function () {
        ProgressFlowWatcher.validate(progressValidateCtx({ config: config }));
      });
    } finally {
      delete Templates.TEMPLATES.progress_flow_test_bad;
      cp.restore();
    }
  });

  T.test('通知先が無いチャンネルは起動時に落とす', function () {
    const cp = fakeProgressCp();
    try {
      const dispatcher = Dispatcher.create({
        state: newState(), notifiers: [recordingNotifier(['progress_flow'])],
      });
      T.assertThrows(Errors.KIND.CONFIG, function () {
        ProgressFlowWatcher.validate(progressValidateCtx({ dispatcher: dispatcher }));
      });
    } finally { cp.restore(); }
  });

  // --- 2ウォッチャーの同居（Phase4 の主題） --------------------------------

  T.test('要件1と要件2/3 は状態を共有しない', function () {
    // snapshots / snapshot_values は1枚のシートに混在する。watcher_id で分かれていないと、
    // 片方の持ち越しがもう片方の差分検知を壊す（仕様書 11.3）
    const cp = fakeProgressCp();
    try {
      const env = bootstrappedProgressEnv();
      addHistory(cp, '21_1', '16');
      Runner.execute(ProgressFlowWatcher.create(), env.options);

      const reloaded = State.create({ props: env.props, sheets: env.sheets });
      T.assertEquals(
        reloaded.rawValues('progress_flow')
          .rawOf('21', ProgressFlowWatcher.LAST_STATUS_KEY).value, '16');
      T.assertEquals(
        reloaded.rawValues('career_status')
          .rawOf('21', ProgressFlowWatcher.LAST_STATUS_KEY).hasRaw, false,
        '要件1の行に要件2/3 の持ち越しが見えている');
      T.assertEquals(reloaded.getCursor('career_status'), null,
                     'カーソルがウォッチャー間で共有されている');
    } finally { cp.restore(); }
  });

  T.test('前の実行が終わっていなければ何もせず抜ける（LockService）', function () {
    // 2つのトリガーが同時に走ると、トークンバケットと状態が競合する
    const cp = fakeProgressCp();
    try {
      const env = newProgressEnv();
      env.options.lock = T.fakeLock(false);
      const result = Runner.execute(ProgressFlowWatcher.create(), env.options);
      T.assertEquals(result.skipped, 'lock_busy');
      T.assertEquals(cp.calls.search, 0, 'ロックを取れていないのに CP を叩いている');
    } finally { cp.restore(); }
  });

  return T.run('progress_flow');
}
