/**
 * JST ⇔ CP形式 ⇔ 保存形式 の変換。
 *
 * **この変換はここ1箇所に集約する。各所で日付を整形しない**（rules/10-cp-api.md）。
 *
 * 実測で判明している形式（docs/design/07-verification-results.md 2章）:
 *
 * | | レスポンス（読む） | リクエスト（書く） |
 * |---|---|---|
 * | datetime | ISO 8601・秒あり `2026-08-05T15:20:48` | `YYYY/MM/DD HH:MM:SS` |
 * | date | ISO 8601 `2026-08-05` | `YYYY/MM/DD` |
 *
 * **⚠️ 仕様書に書かれている `YYYY/MM/DD HH:MM`（分まで）は 400 で拒否される。**
 * 読んだ値をそのまま検索条件に渡せないので、必ずここを通すこと。
 *
 * CP が返す datetime はタイムゾーン情報を持たない。JST として扱う
 * （rules/30-state-and-idempotency.md）。
 * **文字列 → Date のパースに `new Date(str)` を使わない。**実行環境のタイムゾーン解釈に
 * 依存して 9 時間ずれる。必ず成分に分解して UTC から組み立てる。
 */
const TimeFmt = (function () {

  const TZ = 'Asia/Tokyo';
  const JST_OFFSET_MINUTES = 9 * 60;

  const CP_DATETIME_FMT = 'yyyy/MM/dd HH:mm:ss';
  const CP_DATE_FMT = 'yyyy/MM/dd';
  const STORE_FMT = 'yyyy-MM-dd HH:mm:ss';
  const STORE_DATE_FMT = 'yyyy-MM-dd';

  /** 現在時刻（秒精度）。ミリ秒は落とす。 */
  function now() {
    const d = new Date();
    d.setMilliseconds(0);
    return d;
  }

  // --- CP へ渡す（検索条件の value） -------------------------------------

  /** datetime 型の検索条件に渡す形式。`YYYY/MM/DD HH:MM:SS`。 */
  function toCpDatetime(date) {
    return Utilities.formatDate(date, TZ, CP_DATETIME_FMT);
  }

  /** date 型の検索条件に渡す形式。`YYYY/MM/DD`。 */
  function toCpDate(date) {
    return Utilities.formatDate(date, TZ, CP_DATE_FMT);
  }

  // --- CP から読む（レスポンスの value） ---------------------------------

  /** レスポンスの datetime（ISO 8601・秒あり）を Date にする。 */
  function parseCpDatetime(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(String(value).trim());
    if (!m) throw Errors.config('unexpected datetime format from CP: ' + value);
    return fromJstParts(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
  }

  /** レスポンスの date（ISO 8601）を Date（JST の 00:00:00）にする。 */
  function parseCpDate(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
    if (!m) throw Errors.config('unexpected date format from CP: ' + value);
    return fromJstParts(+m[1], +m[2], +m[3], 0, 0, 0);
  }

  // --- 保存する（カーソル・スナップショット） ----------------------------

  /**
   * 保存形式。JST の `yyyy-MM-dd HH:mm:ss`。
   * UTC 混在は差分検知のバグの温床になるため、保存は必ず JST で統一する。
   */
  function toStore(date) {
    return Utilities.formatDate(date, TZ, STORE_FMT);
  }

  /** 保存形式を Date に戻す。日付のみの値も受け付ける。 */
  function fromStore(value) {
    const text = String(value).trim();
    const dt = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text);
    if (dt) return fromJstParts(+dt[1], +dt[2], +dt[3], +dt[4], +dt[5], +dt[6]);
    const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (d) return fromJstParts(+d[1], +d[2], +d[3], 0, 0, 0);
    throw Errors.config('unexpected stored time format: ' + value);
  }

  /** 現在時刻の保存形式。ログのタイムスタンプにも使う。 */
  function nowStore() {
    return toStore(now());
  }

  /** 秒を足し引きした Date を返す（オーバーラップ幅の適用に使う）。 */
  function shiftSeconds(date, seconds) {
    return new Date(date.getTime() + seconds * 1000);
  }

  /** 日を足し引きした Date を返す（要件4の走査窓に使う）。 */
  function shiftDays(date, days) {
    return new Date(date.getTime() + days * 86400 * 1000);
  }

  /** JST の年月日時分秒から Date を組み立てる。実行環境のタイムゾーンに依存しない。 */
  function fromJstParts(y, mo, d, h, mi, s) {
    return new Date(Date.UTC(y, mo - 1, d, h, mi, s) - JST_OFFSET_MINUTES * 60 * 1000);
  }

  return {
    now: now,
    toCpDatetime: toCpDatetime,
    toCpDate: toCpDate,
    parseCpDatetime: parseCpDatetime,
    parseCpDate: parseCpDate,
    toStore: toStore,
    fromStore: fromStore,
    nowStore: nowStore,
    shiftSeconds: shiftSeconds,
    shiftDays: shiftDays,
  };
})();
