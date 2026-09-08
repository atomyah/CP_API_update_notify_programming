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
 * **1サイクルの通知件数に上限がある**（`Config.limits.maxNotificationsPerCycle`）。
 * 超えたぶんは送らずに溜め、`endCycle()` で1通のサマリに畳む（Phase5）。
 * データ移行や一括更新で変化件数が跳ねたときにチャンネルが埋まるのを防ぐ。
 * ⚠️ **溜めたぶんは冪等キーを予約しない。**予約してしまうと「送っていないのに
 * 送信済み」になり、次サイクルでも二度と出なくなる（＝通知漏れ）。
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
      this._maxPerCycle = opts.maxPerCycle || Config.limits.maxNotificationsPerCycle;
      this._sent = 0;
      this._suppressed = [];
      if (!this._state) throw Errors.config('dispatcher needs a state store');
    }

    /** そのチャンネルを扱える送信先があるか。起動時チェックで使う。 */
    supports(channelKey) {
      return this._pick(channelKey) !== null;
    }

    beginCycle() {
      this._sent = 0;
      this._suppressed = [];
    }

    /**
     * 1件送る。送れたら true。**例外は投げない**（dead_letter に落とす）。
     *
     * 1サイクルの上限を超えたぶんは送らずに溜め、`endCycle()` でサマリに畳む。
     */
    dispatchOne(notification) {
      if (this._sent >= this._maxPerCycle) {
        this._suppressed.push(notification);
        return false;
      }
      if (!this._sendOne(notification)) return false;
      this._sent += 1;
      return true;
    }

    /** サイクルを閉じ、送信できた件数を返す。溜めたぶんは1通のサマリにする。 */
    endCycle() {
      if (this._suppressed.length) {
        const suppressed = this._suppressed;
        this._suppressed = [];
        Log.warn('notification_flood', {
          watcher_id: suppressed[0].watcherId,
          suppressed: suppressed.length,
          limit: this._maxPerCycle,
        });
        if (this._sendOne(this._summary(suppressed))) this._sent += 1;
      }
      return this._sent;
    }

    /** 実際に1件送る。冪等キーの予約もここ。 */
    _sendOne(notification) {
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
        return true;
      } catch (e) {
        if (!Errors.is(e, Errors.KIND.NOTIFY)) throw e;
        this._fail(notification, e.name + ': ' + e.message);
        return false;
      }
    }

    /**
     * 上限を超えたぶんを1通に畳む。
     *
     * 冪等キーはサイクルごとに一意にする（時刻を含める）。
     * 過去のサマリと衝突すると、次の一括更新のサマリが消える。
     */
    _summary(suppressed) {
      const first = suppressed[0];
      const total = this._sent + suppressed.length;
      const resources = {};
      suppressed.forEach(function (n) { resources[n.resourceId] = true; });
      const template = Templates.get('notification_flood');
      const fields = {
        total: total,
        suppressed: suppressed.length,
        limit: this._maxPerCycle,
        resources: Object.keys(resources).length,
      };
      return Events.notification({
        watcherId: first.watcherId,
        resourceId: '__summary__',
        eventType: 'summary',
        digest: State.payloadHash([TimeFmt.nowStore(), total]),
        channelKey: first.channelKey,
        subject: Templates.renderField(template, 'subject', fields, ''),
        body: Templates.renderField(template, 'body', fields),
        meta: { suppressed: suppressed.length },
      });
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
   * 既定の一式（Slack + メール）。
   *
   * **チャンネルは重ならない。**Slack は `Config.slack.webhookProperties` の鍵、
   * メールは `Config.mail.channelKeys` だけを扱う。先に一致した方が送る。
   *
   * @param options { state, dryRun, notifiers, maxPerCycle }
   *   dryRun が true なら Slack はドライラン用チャンネルへ、
   *   メールは管理者アドレスへ寄せる（rules/40-secrets-and-security.md）。
   *   **メールの寄せ先が設定されていなければ ConfigError**（本物の宛先へ送らせない）
   */
  function create(options) {
    const opts = options || {};
    const notifiers = opts.notifiers || [
      SlackNotifier.create({
        dryRunChannelKey: opts.dryRun ? Config.slack.dryRunChannelKey : null,
      }),
      MailNotifier.create({ dryRun: !!opts.dryRun }),
    ];
    return new NotificationDispatcher({
      state: opts.state, notifiers: notifiers, maxPerCycle: opts.maxPerCycle,
    });
  }

  return { NotificationDispatcher: NotificationDispatcher, create: create };
})();
