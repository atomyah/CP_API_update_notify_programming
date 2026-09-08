/**
 * メール送信（要件4）。**Python 版には無い。GAS が初実装。**
 *
 * **notifiers/ は CP のリソースも項目 ID も知らない。**渡された通知を送るだけ
 * （rules/50-code-style.md）。宛先（`notification.to`）はウォッチャーが解決して渡す。
 *
 * ## なぜ GAS ではペンディングが外れるか（仕様書 8.4）
 *
 * Python 版は**手元 PC からの SMTP 送信**を前提にしていた。組織がアプリパスワードを
 * 全体で無効化しているため案A・案Bとも使えず、保留になっていた。
 * **`MailApp` は SMTP サーバもアプリパスワードも固定グローバル IP も要らない。**
 * スクリプトを承認したアカウントの権限でそのまま送信される。
 *
 * 代わりに GAS 固有の制約が2つある。**どちらも推測で埋めず実測する**（C-15 と同じ姿勢）:
 *
 * 1. **1日あたりの送信上限**（宛先数でカウント）。`checkMail()` で残量を見る
 * 2. **送信元はスクリプトの所有者。**別アドレスにするには Gmail の確認済み
 *    エイリアスが要る（`Config.mail.fromAddressProperty`）
 *
 * ## ⚠️ 誤送信を防ぐ
 *
 * 宛先は CP 上の実在アドレス（`CAREER#CHARGE_EMAIL`）で、**取り違えると人に届く。**
 *
 * - **ドライランでは全通知が管理者アドレスへ寄る**（rules/40-secrets-and-security.md）。
 *   本来の宛先は本文の先頭に明示する
 * - 宛先が空・不正な通知はそもそもウォッチャーが作らない（仕様書 3.3.6）。
 *   それでも届いたら `NotifyError` にして dead_letter へ落とす。**黙って捨てない**
 * - **アドレスをログに出さない**（rules/40-secrets-and-security.md）
 */
const MailNotifier = (function () {

  // 明らかに壊れた宛先を弾くだけの検査。RFC の完全な検証はしない
  // （厳しすぎる正規表現で正当なアドレスを落とす方が有害）
  const ADDRESS_PATTERN = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

  // ドライランであることを本文の先頭で明示する
  const DRY_RUN_PREFIX =
    '[DRY-RUN] 本来の宛先: {to}\n' +
    '----------------------------------------\n';

  class Notifier {
    /**
     * @param options
     *   channelKeys  このノーティファイアが扱うチャンネル
     *   dryRun       **すべての通知を管理者アドレスへ寄せる。**
     *                管理者アドレスが未設定なら ConfigError（本物の宛先へ送らせない）
     *   dryRunTo     寄せ先を明示する（テスト用。dryRun より優先）
     *   props        テストのために差し替える。本番では既定のまま
     *   mailApp      同上。**本番のメールを送るテストを書かないこと**
     */
    constructor(options) {
      const opts = options || {};
      this._channelKeys = opts.channelKeys || Config.mail.channelKeys;
      this._props = opts.props || PropertiesService.getScriptProperties();
      // ⚠️ ここで MailApp を掴まない。ファイルの読み込み順とテスト環境に依存させない
      this._mailApp = opts.mailApp || null;

      this._dryRunTo = opts.dryRunTo || null;
      if (!this._dryRunTo && opts.dryRun) {
        // **ここで落とす。**寄せ先が無いまま送ると本物の担当者へ届く
        this._dryRunTo = this.adminAddress();
        if (!this._dryRunTo) {
          throw Errors.config(
            'dry run needs a valid address in script property "' +
            Config.mail.adminAddressProperty + '"; refusing to send to real recipients');
        }
      }
    }

    supports(channelKey) {
      return this._channelKeys.indexOf(channelKey) >= 0;
    }

    /** 送信する。失敗したら NotifyError を投げる（dispatcher が dead_letter へ落とす）。 */
    send(notification) {
      let to = notification.to;
      let body = notification.body;
      let fallback = false;

      if (!to) {
        // 宛先を持たない通知（1サイクルの上限を超えたぶんのサマリなど）は
        // **管理者へ送る。**業務の通知が宛先未設定でここに来ることはない
        // （ウォッチャーが先に弾いて件数を数えている。仕様書 3.3.6）
        to = this.adminAddress();
        fallback = true;
      }

      if (this._dryRunTo) {
        // 本来の宛先を明示したうえで、すべて管理者アドレスへ寄せる
        body = Templates.render(DRY_RUN_PREFIX, { to: to || '(未設定)' }) + body;
        to = this._dryRunTo;
      }

      if (!isValidAddress(to)) {
        // ウォッチャー側で弾いているはずのもの。ここに来たら実装の誤り
        throw Errors.notify('invalid or missing mail address for ' +
                            notification.watcherId + '/' + notification.resourceId);
      }

      // **送る前に残量を見る。**尽きた状態で送ると例外になり、原因が分かりにくい
      const remaining = this.remainingQuota();
      if (remaining !== null && remaining <= 0) {
        throw Errors.notify('daily mail quota is exhausted; nothing was sent');
      }
      if (remaining !== null && remaining < Config.mail.quotaWarnThreshold) {
        Log.warn('mail_quota_low', {
          remaining: remaining, threshold: Config.mail.quotaWarnThreshold,
        });
      }

      const message = {
        to: to,
        subject: notification.subject,
        body: body,
        name: Config.mail.senderName,
      };
      // 承認アカウントの確認済みエイリアスのときだけ有効。未設定なら指定しない
      const from = this._property(Config.mail.fromAddressProperty);
      if (from) message.from = from;

      try {
        this._mail().sendEmail(message);
      } catch (e) {
        throw Errors.notify('mail send failed: ' + (e.name || 'Error') + ': ' + e.message);
      }

      // ⚠️ 宛先も本文もログに出さない（rules/40-secrets-and-security.md）
      Log.info('mail_sent', {
        watcher_id: notification.watcherId,
        resource_id: notification.resourceId,
        event_type: notification.eventType,
        channel_key: notification.channelKey,
        dry_run: !!this._dryRunTo,
        fallback_to_admin: fallback,
        remaining_quota: remaining,
      });
    }

    /** 残りの送信可能数。取れなければ null（クォータの確認を諦めても送信は続ける）。 */
    remainingQuota() {
      try {
        return this._mail().getRemainingDailyQuota();
      } catch (e) {
        Log.warn('mail_quota_unavailable', { error: e.name + ': ' + e.message });
        return null;
      }
    }

    /** 宛先未設定・ドライラン・送信失敗の受け皿。**未設定なら null。** */
    adminAddress() {
      const address = this._property(Config.mail.adminAddressProperty);
      return isValidAddress(address) ? address : null;
    }

    _property(name) {
      if (!name) return null;
      const value = this._props.getProperty(name);
      return value ? String(value).trim() : null;
    }

    _mail() {
      if (this._mailApp) return this._mailApp;
      // 本番のみ。テストは必ず mailApp を差し替える
      return MailApp;
    }
  }

  /** 明らかに壊れた宛先を弾く。 */
  function isValidAddress(address) {
    if (address === null || address === undefined) return false;
    return ADDRESS_PATTERN.test(String(address).trim());
  }

  function create(options) {
    return new Notifier(options);
  }

  return {
    DRY_RUN_PREFIX: DRY_RUN_PREFIX,
    Notifier: Notifier,
    isValidAddress: isValidAddress,
    create: create,
  };
})();
