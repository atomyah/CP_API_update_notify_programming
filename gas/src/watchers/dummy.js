/**
 * ダミーのウォッチャー（Phase2 の通し確認用）。
 *
 * **CP を叩かない。**固定のレコードを返し、差分検知 → 冪等除去 → 「通知」→
 * snapshots 書き戻し → カーソル前進、という一連の流れが Runner の上で動くことだけを確かめる。
 * 通知は送らずログに出す（Slack は Phase3）。
 *
 * 値は「実行した分」を混ぜてあるので、**1分以上あけて2回実行すると変化が検知される。**
 * 同じ分のうちに2回実行しても、冪等キーが同じなので2回目は通知されない
 * （＝ notified の UNIQUE 制約の代替が効いている。仕様書 11.5）。
 *
 * 実運用に入る前に消してよい。Phase3 以降の実ウォッチャーはこれを継承しない。
 */
const DummyWatcher = (function () {

  const WATCHER_ID = 'dummy';

  // 監視項目に見立てたもの。**実在の項目IDではない**（CP を叩かないので実在しなくてよい）
  const ITEMS = [
    { itemId: 'DUMMY#STATUS', itemType: 'selectone' },
    { itemId: 'DUMMY#MEMO', itemType: 'text' },
  ];

  // 検証用レコードのID（CLAUDE.md の検証用レコード）。値は個人情報を含まないダミー
  const RESOURCE_IDS = ['18', '17'];

  function create(config) {
    return Watchers.define(WATCHER_ID, config || { enabled: true, budgetPerCycle: 10 }, {
      execute: function (ctx) { return cycle(ctx, true); },
      bootstrap: function (ctx) { return cycle(ctx, false); },
    });
  }

  function cycle(ctx, notify) {
    // 分が変わると値が変わる。CP から取ってきた値の代わり
    // テストからは config.marker で固定できる（実行のたびに値が変わると検証しにくい）
    const marker = ctx.config.marker || TimeFmt.toStore(ctx.startedAt).slice(0, 16);
    let detected = 0;
    let notified = 0;

    RESOURCE_IDS.forEach(function (resourceId) {
      // 本物なら select を1回叩くところ。予算の消費だけ模しておく
      ctx.budget.consume();

      const values = {
        'DUMMY#STATUS': marker,
        'DUMMY#MEMO': 'fixed',
      };

      const changed = [];
      ITEMS.forEach(function (item) {
        const value = values[item.itemId];
        if (notify && ctx.snapshots.hasChanged(resourceId, item.itemId, value, item.itemType)) {
          changed.push(item.itemId);
        }
        // **メモリ上のスナップショットを更新するだけ。**
        // シートへの書き戻しは Runner がコミットすると決めたときだけ行われる
        ctx.snapshots.put(resourceId, item.itemId, value, item.itemType);
      });

      if (!changed.length) return;
      detected += 1;

      const digest = State.payloadHash({ items: changed, marker: marker });

      // **通知より先に notified へ追記する**（仕様書 7.3 / 11.5）
      if (!ctx.state.claimNotification(WATCHER_ID, resourceId, 'item_changed', digest)) {
        Log.info('notification_deduped', {
          watcher_id: WATCHER_ID, resource_id: resourceId, event_type: 'item_changed',
        });
        return;
      }

      // Phase3 で Slack に置き換える。値そのものは出さない（rules/40）
      Log.info('notification_would_be_sent', {
        watcher_id: WATCHER_ID,
        resource_id: resourceId,
        event_type: 'item_changed',
        item_ids: changed,
        digest: digest,
      });
      notified += 1;
    });

    return Events.result({
      ok: true,
      eventsDetected: detected,
      eventsNotified: notified,
      // Runner はこれがあるときだけカーソルを進める
      cursor: { value: ctx.startedAt, pageOffset: 0, bootstrapped: true },
    });
  }

  return { WATCHER_ID: WATCHER_ID, create: create };
})();

/**
 * 手動実行。Apps Script エディタで `runDummyCycle` を選んで実行する。
 * 1回目は基準づくり（通知なし）、2回目以降は変化を検知する。
 */
function runDummyCycle() {
  return Runner.execute(DummyWatcher.create());
}

/** 手動実行。ダミーの基準づくりだけを行う（通知しない）。 */
function bootstrapDummyWatcher() {
  return Runner.execute(DummyWatcher.create(), { bootstrap: true });
}
