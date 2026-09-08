/**
 * 1サイクルの結果（Python 版 `app/core/events.py` の `CycleResult`）。
 *
 * **Runner はこの戻り値だけを見てカーソルを進めるかどうかを決める**（仕様書 11.4）。
 * ウォッチャー自身にカーソルを書かせない。コミット点を1箇所に閉じるため。
 *
 * 通知の中間表現（`Notification`）もここに置く。**ウォッチャーが組み立て、
 * notifiers/ が送る。**notifiers/ は CP のリソースも項目 ID も知らない
 * （rules/50-code-style.md）。
 */
const Events = (function () {

  /**
   * @param fields
   *   ok               成功したか
   *   exhausted        予算切れ・時間切れで打ち切ったか（異常ではない）
   *   cursor           コミットするカーソル。`{ value: Date, pageOffset, bootstrapped }`
   *                    **これを入れたサイクルだけカーソルが前進する。**
   *                    入れなければ前進しない（＝次サイクルで再処理される）
   *   eventsDetected   検知した件数
   *   eventsNotified   実際に送った件数
   *   error            失敗した理由（ok=false のとき）
   */
  function result(fields) {
    const f = fields || {};
    return {
      ok: f.ok !== false,
      exhausted: !!f.exhausted,
      cursor: f.cursor || null,
      eventsDetected: f.eventsDetected || 0,
      eventsNotified: f.eventsNotified || 0,
      requestsUsed: f.requestsUsed || 0,
      skipped: f.skipped || null,     // ロック取得失敗・自動停止のときだけ入る
      error: f.error || null,
    };
  }

  /** 予算切れ・時間切れ。**カーソルも snapshots も進めない**（仕様書 11.4）。 */
  function exhausted(fields) {
    const f = fields || {};
    f.ok = true;
    f.exhausted = true;
    f.cursor = null;
    return result(f);
  }

  function failed(error, fields) {
    const f = fields || {};
    f.ok = false;
    f.cursor = null;
    f.error = error;
    return result(f);
  }

  /** そもそも実行しなかった（ロックが取れない・自動停止中）。 */
  function skipped(reason) {
    return result({ ok: true, skipped: reason });
  }

  /**
   * 通知の中間表現。
   *
   * @param fields
   *   watcherId / resourceId / eventType / digest  冪等キーの4つ組（rules/30）
   *   channelKey  論理的な宛先。**Webhook URL ではない**（notifiers が解決する）
   *   subject     件名。Slack では本文に含めないが、メール（要件4）で使う
   *   body        送信する本文。**組み立て済みで渡す。**再取得しない（rules/20）
   *   to          個別の宛先（要件4のメールアドレス）。チャンネルが宛先を決める
   *               Slack では使わない。**空のまま通知を作らないこと**
   *               （要件4は宛先が無ければそもそも送らない。仕様書 3.3.6）
   *   meta        ログ用の補助情報。個人情報を入れないこと。
   *               **`to` はここに入れない**（dead_letter に載って共有範囲が広がる）
   */
  function notification(fields) {
    const f = fields || {};
    if (!f.watcherId || !f.resourceId || !f.eventType || !f.digest) {
      throw Errors.config('notification needs watcherId/resourceId/eventType/digest');
    }
    if (!f.channelKey) throw Errors.config('notification needs channelKey');
    return {
      watcherId: f.watcherId,
      resourceId: String(f.resourceId),
      eventType: f.eventType,
      digest: f.digest,
      channelKey: f.channelKey,
      subject: f.subject || '',
      body: f.body || '',
      to: f.to || null,
      meta: f.meta || {},
    };
  }

  /** 「何件取得して何件通知したか」を1行で出すためのログ項目（rules/50-code-style.md）。 */
  function logFields(r) {
    return {
      ok: r.ok,
      requests_used: r.requestsUsed,
      events_detected: r.eventsDetected,
      events_notified: r.eventsNotified,
      exhausted: r.exhausted,
      committed: !!r.cursor,
      skipped: r.skipped,
      error: r.error,
    };
  }

  return {
    result: result,
    notification: notification,
    exhausted: exhausted,
    failed: failed,
    skipped: skipped,
    logFields: logFields,
  };
})();
