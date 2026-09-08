/**
 * Phase1（共通基盤）のテスト。
 *
 * 優先してテストする対象は rules/50-code-style.md の通り:
 *   1. トークンバケット（レートを超えないこと）
 *   2. カーソル前進の条件（Phase2）
 *   3. 冪等キーによる重複除去（Phase2）
 *   4. datetime / date の形式変換
 *
 * 使い方: Apps Script エディタで `runCoreTests` を選んで実行する。
 * **CP API は叩かない。**全てオフラインで完結する。
 */
function runCoreTests() {
  T.reset();

  // --- 時刻の形式変換 ---------------------------------------------------
  // ⚠️ `YYYY/MM/DD HH:MM`（分まで）は CP に 400 で拒否される。生成しないこと

  T.test('toCpDatetime は秒まで出す', function () {
    const d = TimeFmt.parseCpDatetime('2026-08-05T15:20:48');
    T.assertEquals(TimeFmt.toCpDatetime(d), '2026/08/05 15:20:48');
  });

  T.test('toCpDate は日付のみ', function () {
    const d = TimeFmt.parseCpDate('2026-08-05');
    T.assertEquals(TimeFmt.toCpDate(d), '2026/08/05');
  });

  T.test('CP の datetime を読んで CP の形式に戻せる', function () {
    const d = TimeFmt.parseCpDatetime('2026-01-01T00:00:00');
    T.assertEquals(TimeFmt.toCpDatetime(d), '2026/01/01 00:00:00');
    T.assertEquals(TimeFmt.toStore(d), '2026-01-01 00:00:00');
  });

  T.test('保存形式の往復で値が変わらない', function () {
    const stored = '2026-08-05 15:20:48';
    T.assertEquals(TimeFmt.toStore(TimeFmt.fromStore(stored)), stored);
  });

  T.test('日付のみの保存値も読める', function () {
    T.assertEquals(TimeFmt.toStore(TimeFmt.fromStore('2026-08-05')), '2026-08-05 00:00:00');
  });

  T.test('秒精度が保たれる（境界テスト）', function () {
    const a = TimeFmt.parseCpDatetime('2026-08-05T15:20:48');
    const b = TimeFmt.parseCpDatetime('2026-08-05T15:20:49');
    T.assertEquals(b.getTime() - a.getTime(), 1000);
    T.assertEquals(TimeFmt.toCpDatetime(b), '2026/08/05 15:20:49');
  });

  T.test('オーバーラップ幅を引ける', function () {
    const d = TimeFmt.parseCpDatetime('2026-08-05T15:20:48');
    T.assertEquals(TimeFmt.toCpDatetime(TimeFmt.shiftSeconds(d, -60)), '2026/08/05 15:19:48');
  });

  T.test('壊れた形式は ConfigError になる', function () {
    T.assertThrows(Errors.KIND.CONFIG, function () {
      TimeFmt.parseCpDatetime('2026/08/05 15:20:48');
    });
  });

  // --- トークンバケット -------------------------------------------------

  T.test('容量ぶんは待たずに取れる', function () {
    const clock = T.fakeClock();
    const bucket = newTestBucket(clock, T.fakeProperties(), 1.0, 5);
    for (let i = 0; i < 5; i++) {
      T.assertEquals(bucket.acquire(), 0, 'acquire #' + i + ' should not wait');
    }
  });

  T.test('容量を超えたら補充を待つ', function () {
    const clock = T.fakeClock();
    const bucket = newTestBucket(clock, T.fakeProperties(), 1.0, 5);
    for (let i = 0; i < 5; i++) bucket.acquire();
    T.assertNear(bucket.acquire(), 1.0, 0.001, '1 token/sec なら約1秒待つ');
  });

  T.test('⚠️ 60 req/分 を超えない', function () {
    // 既定の設定（1 token/sec = 60 req/分、容量20）で 100 リクエストを流し、
    // 掛かった仮想時間が「容量ぶんを除いた回数 ÷ レート」以上であることを見る
    const clock = T.fakeClock();
    const bucket = newTestBucket(clock, T.fakeProperties(),
                                 Config.rateLimit.tokensPerSecond,
                                 Config.rateLimit.bucketCapacity);
    const startedAt = clock.now();
    const requests = 100;
    for (let i = 0; i < requests; i++) bucket.acquire();

    const elapsedSeconds = (clock.now() - startedAt) / 1000;
    const minimum = (requests - Config.rateLimit.bucketCapacity) / Config.rateLimit.tokensPerSecond;
    T.assert(elapsedSeconds >= minimum,
             'elapsed=' + elapsedSeconds + 's must be >= ' + minimum + 's');

    // 実測レートが上限を超えていないこと（バースト分は容量で説明できる範囲）
    const ratePerMinute = (requests / elapsedSeconds) * 60;
    T.assert(ratePerMinute <= Config.rateLimit.limitPerMinute * 1.3,
             'rate=' + Math.round(ratePerMinute) + ' req/min is too high');
  });

  T.test('⚠️ バケットの状態が実行をまたいで保持される', function () {
    // GAS はトリガー実行ごとに状態が消える。プロパティに保存していないと
    // トリガーの本数だけ流量が増える
    const clock = T.fakeClock();
    const props = T.fakeProperties();

    const first = newTestBucket(clock, props, 1.0, 5);
    for (let i = 0; i < 5; i++) first.acquire();

    // 別の実行を模して、同じプロパティから作り直す（時間は進めない）
    const second = newTestBucket(clock, props, 1.0, 5);
    T.assertNear(second.available(), 0, 0.001, '前の実行の消費が引き継がれていない');
    T.assertNear(second.acquire(), 1.0, 0.001, '引き継いだ状態から待つはず');
  });

  T.test('容量を超える要求は設定不備として弾く', function () {
    const bucket = newTestBucket(T.fakeClock(), T.fakeProperties(), 1.0, 5);
    T.assertThrows(Errors.KIND.CONFIG, function () { bucket.acquire(6); });
  });

  T.test('壊れた保存値からでも復帰する', function () {
    const props = T.fakeProperties();
    props.setProperty('TEST_BUCKET', 'not json');
    const bucket = newTestBucket(T.fakeClock(), props, 1.0, 5);
    T.assertEquals(bucket.acquire(), 0);
  });

  // --- 予算 -------------------------------------------------------------

  T.test('予算を使い切ったら BudgetExhausted', function () {
    const budget = new Budget.RequestBudget(2, 'test');
    budget.consume();
    budget.consume();
    T.assertThrows(Errors.KIND.BUDGET, function () { budget.consume(); });
    T.assertEquals(budget.remaining, 0);
  });

  T.test('経過時間でも打ち切る（6分制限への対応）', function () {
    const budget = new Budget.RequestBudget(100, 'test', 0);
    T.assertThrows(Errors.KIND.BUDGET, function () { budget.consume(); });
    T.assertEquals(budget.canAfford(), false);
  });

  // --- エラー分類 -------------------------------------------------------

  T.test('ステータスコードから例外の種別が決まる', function () {
    T.assertEquals(Errors.fromStatus(400, '', 'r1', '/p').name, Errors.KIND.BAD_REQUEST);
    T.assertEquals(Errors.fromStatus(401, '', 'r1', '/p').name, Errors.KIND.AUTH);
    T.assertEquals(Errors.fromStatus(403, '', 'r1', '/p').name, Errors.KIND.FORBIDDEN);
    T.assertEquals(Errors.fromStatus(404, '', 'r1', '/p').name, Errors.KIND.NOT_FOUND);
    T.assertEquals(Errors.fromStatus(500, '', 'r1', '/p').name, Errors.KIND.SERVER);
  });

  T.test('リトライしてよいのは 500 系と接続エラーだけ', function () {
    T.assertEquals(Errors.fromStatus(500, '', null, '/p').retryable, true);
    T.assertEquals(Errors.fromStatus(504, '', null, '/p').retryable, true);
    T.assertEquals(Errors.fromStatus(400, '', null, '/p').retryable, false);
    T.assertEquals(Errors.fromStatus(401, '', null, '/p').retryable, false);
    T.assertEquals(Errors.transport('x', '/p').retryable, true);
  });

  T.test('requestId を保持する（ベンダー問い合わせに必須）', function () {
    T.assertEquals(Errors.fromStatus(500, 'body', 'req-123', '/p').requestId, 'req-123');
  });

  T.test('⚠️ 例外のメッセージにレスポンスボディを載せない', function () {
    const err = Errors.fromStatus(400, '{"name":"式波 アスカ"}', 'req-1', '/p');
    T.assert(err.message.indexOf('アスカ') < 0, 'response body leaked into the message');
  });

  // --- ログ -------------------------------------------------------------

  T.test('秘密情報らしいキーは伏せられる', function () {
    // Log は console へ出すだけなので、maskValue の挙動で代表させる
    T.assertEquals(Log.maskValue(null), '<none>');
    T.assertEquals(Log.maskValue([1, 2, 3]), '<list len=3>');
    T.assert(Log.maskValue('式波 アスカ').indexOf('アスカ') < 0, 'value leaked');
  });


  // --- メトリクスのパス正規化 -------------------------------------------

  T.test('エンドポイントの正規化', function () {
    T.assertEquals(CpClient.endpointOf('/v1/ext2/career/select/18'), '/v1/ext2/career/select/*');
    T.assertEquals(CpClient.endpointOf('/v1/ext2/schema/career'), '/v1/ext2/schema/*');
    T.assertEquals(CpClient.endpointOf('/v1/ext2/master/MSTUSER'), '/v1/ext2/master/*');
    T.assertEquals(CpClient.endpointOf('/v1/ext2/career/search'), '/v1/ext2/career/search');
  });

  return T.run('core');
}

/** テスト用のバケット。**本番のプロパティを触らない。** */
function newTestBucket(clock, props, rate, capacity) {
  return new RateLimit.Bucket({
    tokensPerSecond: rate,
    capacity: capacity,
    stateProperty: 'TEST_BUCKET',
    props: props,
    now: clock.now,
    sleep: clock.sleep,
  });
}
