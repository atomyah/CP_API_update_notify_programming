/**
 * 通知の送出口。冪等除去と dead letter をここで一括して扱う。
 * Python 版 `app/notifiers/dispatcher.py` の移植。
 *
 * **⚠️ 通知送信より先に notified へ追記する**（rules/30-state-and-idempotency.md）。
 * 送信後に追記すると、送信成功・追記失敗のときに二重送信する。
 * 逆順なら最悪1件落ちるだけで、落ちたことは dead_letter で検出できる。
 * シートに UNIQUE 制約が無い以上、この順序だけが二重通知を防いでいる（仕様書 11.5）。
 *
 * **1件ずつ即座に送る（ストリーミング）。**まとめてから送ると、途中で予算切れに
 * なったときに組み立て済みの通知が送信前に捨てられる。
 *
 * Phase3 では 1サイクルの通知件数上限とサマリへの切り替え（仕様書 8.1 / Python 版の
 * max_notifications_per_cycle）は入れていない。**Phase5 で足す。**
 */
const Dispatcher = (function () {

  class NotificationDispatcher {
    /**
     * @param options { state, notifiers }
     */
    constructor(options) {
      const opts = options || {};
      this._state = opts.state;
      this._notifiers = opts.notifiers || [];
      this._sent = 0;
      if (!this._state) throw Errors.config('dispatcher needs a state store');
    }

    /** そのチャンネルを扱える送信先があるか。起動時チェックで使う。 */
    supports(channelKey) {
      return this._pick(channelKey) !== null;
    }

    beginCycle() {
      this._sent = 0;
    }

    /** 1件送る。送れたら true。**例外は投げない**（dead_letter に落とす）。 */
    dispatchOne(notification) {
      // 先に予約する。競合したら既送信なので黙って捨てる
      if (!this._state.claimNotification(
            notification.watcherId, notification.resourceId,
            notification.eventType, notification.digest)) {
        Log.debug('notification_deduped', {
          watcher_id: notification.watcherId,
          resource_id: notification.resourceId,
          event_type: notification.eventType,
        });
        return false;
      }

      const notifier = this._pick(notification.channelKey);
      if (notifier === null) {
        this._fail(notification,
          'no notifier handles channel "' + notification.channelKey + '"');
        return false;
      }

      try {
        notifier.send(notification);
        this._sent += 1;
        return true;
      } catch (e) {
        if (!Errors.is(e, Errors.KIND.NOTIFY)) throw e;
        this._fail(notification, e.name + ': ' + e.message);
        return false;
      }
    }

    /** サイクルを閉じ、送信できた件数を返す。 */
    endCycle() {
      return this._sent;
    }

    _pick(channelKey) {
      for (let i = 0; i < this._notifiers.length; i++) {
        if (this._notifiers[i].supports(channelKey)) return this._notifiers[i];
      }
      return null;
    }

    /**
     * 諦めた通知は dead_letter に落とす。**自動再送はしない。**
     * 本文は個人情報を含みうるため、シートの共有範囲に注意する（rules/40）。
     */
    _fail(notification, error) {
      this._state.addDeadLetter(notification.watcherId, JSON.stringify({
        channel_key: notification.channelKey,
        subject: notification.subject,
        body: notification.body,
        resource_id: notification.resourceId,
        event_type: notification.eventType,
      }), error);
      Log.error('notification_failed', {
        watcher_id: notification.watcherId,
        resource_id: notification.resourceId,
        event_type: notification.eventType,
        error: error,
      });
    }
  }

  /**
   * 既定の一式（Slack のみ）。
   * @param options { state, dryRun, notifiers }
   *   dryRun が true なら全通知をドライラン用チャンネルへ寄せる
   */
  function create(options) {
    const opts = options || {};
    const notifiers = opts.notifiers || [SlackNotifier.create({
      dryRunChannelKey: opts.dryRun ? Config.slack.dryRunChannelKey : null,
    })];
    return new NotificationDispatcher({ state: opts.state, notifiers: notifiers });
  }

  return { NotificationDispatcher: NotificationDispatcher, create: create };
})();
