/**
 * Slack Incoming Webhook への送信。
 * Python 版 `app/notifiers/slack.py` の移植。
 *
 * **notifiers/ は CP のリソースも項目 ID も知らない。**渡された通知を送るだけ
 * （rules/50-code-style.md）。
 *
 * ⚠️ Webhook URL は**チャンネルを特定する秘密情報。**スクリプトプロパティから読み、
 * リポジトリにもコードにもログにも書かない（rules/40-secrets-and-security.md）。
 *
 * ⚠️ **CP のトークンバケットは通さない。**240 req/分 は CP API 専用の制約であり、
 * Slack への送信とは無関係（rules/20-rate-limit.md）。
 * ここは core/client.js を経由しない唯一の UrlFetchApp の呼び出し。
 */
const SlackNotifier = (function () {

  const TEXT_LIMIT = 3500;   // Slack の本文上限（40000字）に対して十分手前で切る

  class Notifier {
    /**
     * @param options
     *   webhookProperties  { チャンネル論理名: スクリプトプロパティ名 }
     *   dryRunChannelKey   指定するとすべての通知をこのチャンネルへ寄せる
     *   props / fetch      テストのために差し替える。本番では既定のまま
     */
    constructor(options) {
      const opts = options || {};
      this._webhookProperties = opts.webhookProperties || Config.slack.webhookProperties;
      this._dryRunChannelKey = opts.dryRunChannelKey || null;
      this._props = opts.props || PropertiesService.getScriptProperties();
      this._fetch = opts.fetch || function (url, params) {
        return UrlFetchApp.fetch(url, params);
      };
      this._sleep = opts.sleep || function (ms) { Utilities.sleep(ms); };
    }

    supports(channelKey) {
      return !!this._webhookProperties[channelKey];
    }

    /** URL が実際に設定されているチャンネルの一覧。起動時チェックで使う。 */
    configuredChannels() {
      const self = this;
      return Object.keys(this._webhookProperties).filter(function (key) {
        return !!self._url(key);
      });
    }

    /** 送信する。失敗したら NotifyError を投げる。 */
    send(notification) {
      let channelKey = notification.channelKey;
      let text = notification.body;

      if (this._dryRunChannelKey) {
        // 本来の宛先を明示したうえで、すべてドライラン用チャンネルへ寄せる
        text = Templates.render(DRY_RUN_PREFIX, { channel_key: channelKey }) + text;
        channelKey = this._dryRunChannelKey;
      }

      const url = this._resolveUrl(channelKey);
      this._post(url, clip(text), notification);
    }

    _resolveUrl(channelKey) {
      const property = this._webhookProperties[channelKey];
      if (!property) {
        throw Errors.notify('no webhook configured for channel "' + channelKey + '"');
      }
      const url = this._url(channelKey);
      if (!url) {
        throw Errors.notify('script property ' + property + ' is not set');
      }
      return url;
    }

    _url(channelKey) {
      const property = this._webhookProperties[channelKey];
      if (!property) return null;
      const url = this._props.getProperty(property);
      return url ? String(url).trim() : null;
    }

    _post(url, text, notification) {
      let lastError = '';
      for (let attempt = 1; attempt <= Config.slack.sendRetryMax; attempt++) {
        let response;
        try {
          response = this._fetch(url, {
            method: 'post',
            contentType: 'application/json',
            payload: JSON.stringify({ text: text }),
            muteHttpExceptions: true,
          });
        } catch (e) {
          lastError = e.name || 'FetchError';
          response = null;
        }

        if (response) {
          const status = response.getResponseCode();
          if (status === 200) {
            // ⚠️ URL も本文もログに出さない（rules/40-secrets-and-security.md）
            Log.info('slack_sent', {
              watcher_id: notification.watcherId,
              resource_id: notification.resourceId,
              event_type: notification.eventType,
              channel_key: notification.channelKey,
            });
            return;
          }
          // 4xx は再送しても直らない。URL 失効・チャンネル削除など
          if (status >= 400 && status < 500) {
            throw Errors.notify('slack rejected the message: HTTP ' + status);
          }
          lastError = 'HTTP ' + status;
        }

        if (attempt < Config.slack.sendRetryMax) {
          this._sleep(Math.pow(Config.slack.backoffBaseSeconds, attempt) * 1000);
        }
      }
      throw Errors.notify('slack send failed after ' + Config.slack.sendRetryMax +
                          ' attempts: ' + lastError);
    }
  }

  // ドライランであることを本文の先頭で明示する
  const DRY_RUN_PREFIX =
    '*[DRY-RUN]* 本来の通知先: `{channel_key}`\n' +
    '----------------------------------------\n';

  /** 長すぎる本文で Slack 側に弾かれるのを防ぐ。 */
  function clip(text) {
    const value = String(text);
    return value.length <= TEXT_LIMIT ? value : value.slice(0, TEXT_LIMIT) + '…';
  }

  function create(options) {
    return new Notifier(options);
  }

  return { TEXT_LIMIT: TEXT_LIMIT, Notifier: Notifier, create: create };
})();
