/**
 * 状態管理（Python 版 `app/core/store.py` の移植）。
 *
 * SQLite が使えないので置き場所だけが変わる。**冪等キーの定義・オーバーラップ・
 * 少なくとも1回配信・ブートストラップの考え方は一切変えない**（rules/30-state-and-idempotency.md）。
 *
 * | 元テーブル | 置き場所 |
 * |---|---|
 * | `cursors` | PropertiesService（1ウォッチャー = 1プロパティ。**これがコミット点**） |
 * | `snapshots` | シート。1リソース = 1行、監視項目 = 列（仕様書 11.3） |
 * | `snapshots.value_raw` | 別シート `snapshot_values`。**対象項目を限定する**（仕様書 11.3） |
 * | `notified` | シート。**UNIQUE 制約が無いのでアプリ側で担保する**（仕様書 11.5） |
 * | `dead_letter` | シート |
 *
 * **⚠️ snapshots を PropertiesService に置かない。**1ストア約500KB・1値約9KB の上限があり、
 * 「全求職者 × 229項目」は桁が違う（仕様書 11.2）。
 *
 * **⚠️ snapshots の書き戻しはカーソル前進と同じサイクル内でのみ行う。**
 * snapshots だけが進むと差分を取りこぼす（＝通知漏れ）。この判断は Runner が持つ。
 */
const State = (function () {

  const CURSOR_PREFIX = 'cursor:';
  const FAILURES_PREFIX = 'failures:';
  // 自動停止した通算回数。停止1回を一意に識別するために使う（notifiers/ops.js）
  const STOPS_PREFIX = 'stops:';

  // 冪等キーの連結に使う区切り。値に現れない制御文字を使う
  const KEY_SEP = '\u001f';

  // コード値を持つ項目タイプ。これらの `0` は「未設定」を意味する（実測）
  const CODE_ITEM_TYPES = ['selectone', 'select', 'search'];

  // --- 値の正規化とハッシュ（store.py の canonical_value / value_hash） -----

  /**
   * 差分検知のために値を正規化する。
   *
   * **CP は画面で保存すると、未入力の選択項目を null から `0` に書き換える。**
   * 正規化しないと、1項目を直しただけで未入力の選択項目が軒並み「変化した」と
   * 誤判定され、`(未設定) → (未設定)` の通知が大量に出る（2026-08-07 の実送信で判明）。
   *
   * 「未設定」とみなすもの:
   * - null / undefined / 空文字 / 空配列 — 全項目タイプ共通
   * - `0` / `"0"` — **selectone / select / search のみ。**number の 0 は正当な値なので潰さない
   */
  function canonicalValue(value, itemType) {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) {
      const values = [];
      value.forEach(function (v) {
        const c = canonicalValue(v, itemType);
        if (c !== null) values.push(c);
      });
      return values.length ? values : null;
    }
    let text;
    if (typeof value === 'boolean') {
      text = String(value);
    } else {
      // CP は number を JSON 数値で返す。18 / 18.0 / "18" を同じ値として扱う
      text = String(value).trim();
    }
    if (text === '') return null;
    if (CODE_ITEM_TYPES.indexOf(itemType) >= 0 && (text === '0' || text === '0.0')) return null;
    return text;
  }

  /** 差分検知用のハッシュ。正規化してから取る。 */
  function valueHash(value, itemType) {
    return sha256(normalize(canonicalValue(value, itemType)));
  }

  /** 通知本文を決定づける値から取る冪等キーの一部（store.py の payload_hash）。 */
  function payloadHash(parts) {
    return sha256(normalize(parts));
  }

  function normalize(value) {
    if (value === null || value === undefined) return '\u0000none';
    if (typeof value === 'boolean') return '\u0000bool:' + value;
    if (Array.isArray(value)) {
      return '\u0000list:' + value.map(normalize).join(KEY_SEP);
    }
    if (typeof value === 'object') {
      return '\u0000dict:' + Object.keys(value).sort().map(function (k) {
        return k + '\u001e' + normalize(value[k]);
      }).join(KEY_SEP);
    }
    // 18 と "18" を同じ値として扱う（number は JSON 数値で返ってくる）
    return String(value);
  }

  function sha256(text) {
    const bytes = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      // computeDigest は符号付き byte を返す。負値を 0..255 に戻してから16進にする
      const b = (bytes[i] + 256) % 256;
      hex += (b < 16 ? '0' : '') + b.toString(16);
    }
    return hex;
  }

  /** 冪等キー `(watcher_id, resource_id, event_type, payload_hash)` の文字列表現。 */
  function idempotencyKey(watcherId, resourceId, eventType, digest) {
    return [watcherId, resourceId, eventType, digest].join(KEY_SEP);
  }

  // --- snapshots -----------------------------------------------------------

  /**
   * `snapshots` シート1枚をメモリ上で扱う。
   *
   * **読みは getValues 1回、書きは setValues 1回**（仕様書 11.3）。
   * 差分判定はメモリ上で行い、書き戻しは flush() の1回だけ。
   *
   * シートには全ウォッチャーの行が混在する。自分の watcher_id の行だけを索引に載せ、
   * 他ウォッチャーの行はそのまま持ち回って書き戻す（勝手に消さない）。
   *
   * 同じレイアウトを2枚のシートに使う（仕様書 11.3）:
   *
   * | シート | 中身 |
   * |---|---|
   * | `snapshots` | 全監視項目の**ハッシュ**。差分検知はこれだけで足りる |
   * | `snapshot_values` | 遷移前後を通知したい項目の**生値**。設定で明示した項目のみ |
   */
  class SnapshotSet {
    constructor(sheets, watcherId, sheetName) {
      this._sheets = sheets;
      this._watcherId = watcherId;
      this._sheetName = sheetName || Sheets.NAMES.SNAPSHOTS;
      this._loaded = false;
      this._dirty = false;
    }

    _load() {
      if (this._loaded) return;
      const values = this._sheets.readAll(this._sheetName);
      this._header = (values[0] || []).map(String);
      if (this._header.length < 2) {
        this._header = Sheets.HEADERS[this._sheetName].slice();
      }
      this._colIndex = {};
      const self = this;
      this._header.forEach(function (name, i) {
        if (name !== '') self._colIndex[name] = i;
      });
      this._rows = [];
      this._index = {};
      values.slice(1).forEach(function (row) {
        if (String(row[0]) === '' && String(row[1]) === '') return;   // 空行は捨てる
        self._rows.push(row);
        if (String(row[0]) === self._watcherId) self._index[String(row[1])] = row;
      });
      this._loaded = true;
    }

    /** この resource_id の行があるか（ブートストラップ再開時のスキップ判定に使う）。 */
    has(resourceId) {
      this._load();
      return Object.prototype.hasOwnProperty.call(this._index, String(resourceId));
    }

    /** セルの中身。**記録がなければ null。**空欄と「記録なし」は区別しない。 */
    getCell(resourceId, itemId) {
      this._load();
      const row = this._index[String(resourceId)];
      if (!row) return null;
      const col = this._colIndex[itemId];
      if (col === undefined) return null;
      const cell = row[col];
      return (cell === '' || cell === null || cell === undefined) ? null : String(cell);
    }

    /** セルを書く。**シートにはまだ書かない**（flush() まで溜める）。 */
    setCell(resourceId, itemId, text) {
      this._load();
      const col = this._ensureColumn(itemId);
      const row = this._ensureRow(String(resourceId));
      if (String(row[col]) !== text) this._dirty = true;
      row[col] = text;
    }

    /** 前回値のハッシュ。**記録がなければ null。** */
    hashOf(resourceId, itemId) {
      return this.getCell(resourceId, itemId);
    }

    /**
     * 値が前回と変わったか。**前回値が無いときは false**（初めて見たものは通知しない。
     * 基準値を作るだけ。rules/30 のブートストラップ）。
     */
    hasChanged(resourceId, itemId, value, itemType) {
      const previous = this.hashOf(resourceId, itemId);
      if (previous === null) return false;
      return previous !== valueHash(value, itemType);
    }

    /** メモリ上のスナップショットを更新する。**シートにはまだ書かない。** */
    put(resourceId, itemId, value, itemType) {
      this.putHash(resourceId, itemId, valueHash(value, itemType));
    }

    putHash(resourceId, itemId, hash) {
      this.setCell(resourceId, itemId, hash);
    }

    /**
     * 生値を保存する（`snapshot_values` シート用）。
     *
     * **JSON で持つ。**型を保ったまま復元できないと「遷移前 → 遷移後」の表示が壊れる。
     * null も `"null"` という4文字になるので、空欄（＝記録なし）と区別がつく。
     */
    putRaw(resourceId, itemId, value) {
      this.setCell(resourceId, itemId, JSON.stringify(
        value === undefined ? null : value));
    }

    /**
     * 保存した生値を元の型で取り出す。
     * @return `{ hasRaw: false, value: null }` なら記録なし（通知では「(記録なし)」）
     */
    rawOf(resourceId, itemId) {
      const cell = this.getCell(resourceId, itemId);
      if (cell === null) return { hasRaw: false, value: null };
      try {
        return { hasRaw: true, value: JSON.parse(cell) };
      } catch (e) {
        // 手でシートを編集した等。落とさずそのまま文字列として見せる
        return { hasRaw: true, value: cell };
      }
    }

    /** 監視対象から外れたリソースを落とす（rules/30 のスナップショットの寿命）。 */
    remove(resourceId) {
      this._load();
      const key = String(resourceId);
      const row = this._index[key];
      if (!row) return;
      delete this._index[key];
      this._rows = this._rows.filter(function (r) { return r !== row; });
      this._dirty = true;
    }

    /** このウォッチャーが持っている行数。 */
    count() {
      this._load();
      return Object.keys(this._index).length;
    }

    get dirty() {
      return this._dirty;
    }

    /**
     * シートへ書き戻す。**setValues 1回。**
     * **Runner がコミットすると決めたときだけ呼ばれる**（仕様書 11.4）。
     */
    flush() {
      if (!this._loaded || !this._dirty) return false;
      const width = this._header.length;
      const rows = this._rows.map(function (row) {
        const out = row.slice(0, width);
        while (out.length < width) out.push('');
        return out;
      });
      this._sheets.writeAll(this._sheetName, [this._header.slice()].concat(rows));
      this._dirty = false;
      return true;
    }

    _ensureColumn(itemId) {
      let col = this._colIndex[itemId];
      if (col !== undefined) return col;
      col = this._header.length;
      this._header.push(itemId);
      this._colIndex[itemId] = col;
      this._rows.forEach(function (row) { row.push(''); });
      this._dirty = true;
      return col;
    }

    _ensureRow(resourceId) {
      let row = this._index[resourceId];
      if (row) return row;
      row = [];
      for (let i = 0; i < this._header.length; i++) row.push('');
      row[0] = this._watcherId;
      row[1] = resourceId;
      this._rows.push(row);
      this._index[resourceId] = row;
      this._dirty = true;
      return row;
    }
  }

  // --- notified ------------------------------------------------------------

  /**
   * 既送信の判定（仕様書 11.5）。
   *
   * **⚠️ SQLite の UNIQUE 制約が失われている。**シートに一意制約はないので、
   * 冪等キーの集合をアプリ側で持つ。サイクル内の重複もこの集合が吸収する。
   *
   * **⚠️ claim() は通知送信より先に呼ぶこと。**送信後に追記すると、
   * 送信成功・追記失敗のときに二重送信する。逆順なら最悪1件落ちるだけで、
   * 落ちたことは dead_letter で検出できる（rules/30-state-and-idempotency.md）。
   */
  class NotifiedIndex {
    constructor(sheets) {
      this._sheets = sheets;
      this._loaded = false;
    }

    _load() {
      if (this._loaded) return;
      const values = this._sheets.readAll(Sheets.NAMES.NOTIFIED);
      this._keys = {};
      const self = this;
      values.slice(1).forEach(function (row) {
        if (String(row[0]) === '') return;
        self._keys[idempotencyKey(
          String(row[0]), String(row[1]), String(row[2]), String(row[3]))] = true;
      });
      this._loaded = true;
    }

    /**
     * 冪等キーを予約する。
     * @return true なら新規（送ってよい）。false なら既送信（黙って捨てる）
     */
    claim(watcherId, resourceId, eventType, digest) {
      this._load();
      const key = idempotencyKey(watcherId, String(resourceId), eventType, digest);
      if (this._keys[key]) return false;
      // **シートへの追記を先に済ませてから true を返す。**
      // 追記に失敗すれば例外が出て、呼び出し側は通知を送らない
      this._sheets.append(Sheets.NAMES.NOTIFIED,
        [[watcherId, String(resourceId), eventType, digest, TimeFmt.nowStore()]]);
      this._keys[key] = true;
      return true;
    }

    /** 予約済みか（送らずに確認だけしたいとき）。 */
    isClaimed(watcherId, resourceId, eventType, digest) {
      this._load();
      return !!this._keys[idempotencyKey(watcherId, String(resourceId), eventType, digest)];
    }

    /** テスト・再送用に予約を取り消す。**運用では使わない。** */
    release(watcherId, resourceId, eventType, digest) {
      this._load();
      const key = idempotencyKey(watcherId, String(resourceId), eventType, digest);
      if (!this._keys[key]) return;
      delete this._keys[key];
      const values = this._sheets.readAll(Sheets.NAMES.NOTIFIED);
      const kept = values.slice(1).filter(function (row) {
        return idempotencyKey(
          String(row[0]), String(row[1]), String(row[2]), String(row[3])) !== key;
      });
      this._sheets.writeAll(Sheets.NAMES.NOTIFIED, [values[0]].concat(kept));
    }
  }

  // --- 本体 ----------------------------------------------------------------

  class StateStore {
    /**
     * @param options props / sheets を差し替えられる（テストのため。本番では既定のまま）。
     *   **本番のプロパティとシートを触るテストを書かないこと。**
     */
    constructor(options) {
      const opts = options || {};
      this._props = opts.props || PropertiesService.getScriptProperties();
      this._sheets = opts.sheets || Sheets;
      this._snapshots = {};
      this._notified = null;
    }

    /**
     * 同じプロパティストアを使う仕組み（core/metrics.js）に渡すため。
     * **テストが本番のプロパティを触らないよう、必ずここ経由で受け渡す。**
     */
    properties() {
      return this._props;
    }

    /** シートのデータ行数（見出しを除く）。日次サマリが dead_letter を数えるのに使う。 */
    sheetRowCount(sheetName) {
      return this._sheets.dataRowCount(sheetName);
    }

    // --- cursors（PropertiesService） -------------------------------------

    /** @return null | { watcherId, value: Date, pageOffset, bootstrapped, updatedAt: Date } */
    getCursor(watcherId) {
      const raw = this._props.getProperty(CURSOR_PREFIX + watcherId);
      if (!raw) return null;
      let data;
      try {
        data = JSON.parse(raw);
      } catch (e) {
        // 壊れた値で黙って先へ進むとカーソルが暗黙に巻き戻る（＝大量の再通知）。
        // 設定不備として止める
        throw Errors.config('broken cursor for watcher=' + watcherId);
      }
      return {
        watcherId: watcherId,
        value: TimeFmt.fromStore(data.value),
        pageOffset: data.page_offset || 0,
        bootstrapped: !!data.bootstrapped,
        updatedAt: data.updated_at ? TimeFmt.fromStore(data.updated_at) : null,
      };
    }

    /**
     * カーソルを書く。**これが1サイクルのコミット点**（仕様書 11.4）。
     * 呼ぶのは Runner だけ。ウォッチャーから直接呼ばない。
     *
     * @param cursor { value: Date, pageOffset, bootstrapped }
     *   bootstrapped を省くと現在の値を引き継ぐ（Python 版 set_cursor と同じ）。
     */
    setCursor(watcherId, cursor) {
      if (!cursor || !(cursor.value instanceof Date)) {
        throw Errors.config('cursor.value must be a Date for watcher=' + watcherId);
      }
      let bootstrapped = cursor.bootstrapped;
      if (bootstrapped === undefined || bootstrapped === null) {
        const current = this.getCursor(watcherId);
        bootstrapped = current ? current.bootstrapped : false;
      }
      this._props.setProperty(CURSOR_PREFIX + watcherId, JSON.stringify({
        value: TimeFmt.toStore(cursor.value),
        page_offset: cursor.pageOffset || 0,
        bootstrapped: !!bootstrapped,
        updated_at: TimeFmt.nowStore(),
      }));
    }

    /**
     * 中断位置だけを保存する。**カーソル本体は動かさない。**
     *
     * ⚠️ 通常サイクルでは使わない。使ってよいのはブートストラップだけで、
     * そのときも **snapshots を書き戻した後**に呼ぶこと。順序が逆だと、
     * 取得できていないリソースを「取得済み」として飛ばす（＝基準値の欠落）。
     */
    setPageOffset(watcherId, pageOffset) {
      const current = this.getCursor(watcherId);
      if (!current) throw Errors.config('no cursor to update for watcher=' + watcherId);
      this.setCursor(watcherId, {
        value: current.value,
        pageOffset: pageOffset,
        bootstrapped: current.bootstrapped,
      });
    }

    /** テスト・巻き戻し用。運用で消すと次回が全件走査になる。 */
    clearCursor(watcherId) {
      this._props.deleteProperty(CURSOR_PREFIX + watcherId);
    }

    // --- 連続失敗カウンタ ---------------------------------------------------

    getFailureCount(watcherId) {
      const raw = this._props.getProperty(FAILURES_PREFIX + watcherId);
      return raw ? (parseInt(raw, 10) || 0) : 0;
    }

    recordFailure(watcherId) {
      const next = this.getFailureCount(watcherId) + 1;
      this._props.setProperty(FAILURES_PREFIX + watcherId, String(next));
      return next;
    }

    clearFailures(watcherId) {
      this._props.deleteProperty(FAILURES_PREFIX + watcherId);
    }

    /**
     * 自動停止した回数（通算）を1つ進めて返す。
     *
     * **停止1回を一意に識別するためのもの。**ops への警告の冪等キーに入れる。
     * 内容（ウォッチャー + 失敗回数）だけでキーを作ると、復旧して再び停止したときに
     * 前回と同じキーになり、2度目の停止が通知されない（notifiers/ops.js）。
     * **`clearFailures()` では戻さない**（通算の回数なので）。
     */
    recordStop(watcherId) {
      const next = this.getStopCount(watcherId) + 1;
      this._props.setProperty(STOPS_PREFIX + watcherId, String(next));
      return next;
    }

    getStopCount(watcherId) {
      const raw = this._props.getProperty(STOPS_PREFIX + watcherId);
      return raw ? (parseInt(raw, 10) || 0) : 0;
    }

    // --- snapshots ---------------------------------------------------------

    /** ウォッチャーごとのスナップショット（ハッシュ）。1サイクル中は同じインスタンスを返す。 */
    snapshots(watcherId) {
      return this._set(watcherId, Sheets.NAMES.SNAPSHOTS);
    }

    /**
     * 遷移前後を通知するための生値。**対象項目を限定して使うこと**
     * （rules/40-secrets-and-security.md）。書き戻しは snapshots と同じコミット点。
     */
    rawValues(watcherId) {
      return this._set(watcherId, Sheets.NAMES.SNAPSHOT_VALUES);
    }

    _set(watcherId, sheetName) {
      const key = sheetName + '|' + watcherId;
      if (!this._snapshots[key]) {
        this._snapshots[key] = new SnapshotSet(this._sheets, watcherId, sheetName);
      }
      return this._snapshots[key];
    }

    /** Runner が「コミットしてよい」と判断したときだけ呼ぶ。 */
    flushSnapshots() {
      const self = this;
      let flushed = 0;
      Object.keys(this._snapshots).forEach(function (key) {
        if (self._snapshots[key].flush()) flushed += 1;
      });
      return flushed;
    }

    // --- notified ----------------------------------------------------------

    notified() {
      if (!this._notified) this._notified = new NotifiedIndex(this._sheets);
      return this._notified;
    }

    /** **通知送信より先に呼ぶこと。**true なら送ってよい。 */
    claimNotification(watcherId, resourceId, eventType, digest) {
      return this.notified().claim(watcherId, resourceId, eventType, digest);
    }

    // --- dead_letter -------------------------------------------------------

    /** 送信に失敗して諦めたイベント。人が見る用。**自動再送しない。** */
    addDeadLetter(watcherId, payload, error) {
      this._sheets.append(Sheets.NAMES.DEAD_LETTER,
        [[TimeFmt.nowStore(), watcherId, payload, error]]);
    }
  }

  function create(options) {
    return new StateStore(options);
  }

  return {
    create: create,
    canonicalValue: canonicalValue,
    valueHash: valueHash,
    payloadHash: payloadHash,
    idempotencyKey: idempotencyKey,
    SnapshotSet: SnapshotSet,
    NotifiedIndex: NotifiedIndex,
    StateStore: StateStore,
  };
})();
