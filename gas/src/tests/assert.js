/**
 * 最小のテスト基盤。GAS にテストフレームワークはない。
 *
 * **CP API を叩くテストを書かない**（流量制約に反する。rules/50-code-style.md）。
 * ここにあるのは全てオフラインで完結するテスト。
 */
const T = (function () {

  let cases = [];

  /** テストを登録する。 */
  function test(name, fn) {
    cases.push({ name: name, fn: fn });
  }

  function assert(condition, message) {
    if (!condition) throw new Error('assertion failed: ' + (message || ''));
  }

  function assertEquals(actual, expected, message) {
    if (actual !== expected) {
      throw new Error('expected ' + JSON.stringify(expected) +
                      ' but got ' + JSON.stringify(actual) +
                      (message ? ' (' + message + ')' : ''));
    }
  }

  function assertNear(actual, expected, tolerance, message) {
    if (Math.abs(actual - expected) > tolerance) {
      throw new Error('expected ~' + expected + ' (+-' + tolerance + ') but got ' + actual +
                      (message ? ' (' + message + ')' : ''));
    }
  }

  /** fn が name という名前の例外を投げることを確認する。 */
  function assertThrows(name, fn, message) {
    try {
      fn();
    } catch (e) {
      if (e.name !== name) {
        throw new Error('expected ' + name + ' but got ' + e.name + ': ' + e.message);
      }
      return e;
    }
    throw new Error('expected ' + name + ' but nothing was thrown' +
                    (message ? ' (' + message + ')' : ''));
  }

  /** 登録済みのテストを全部走らせる。1件でも落ちたら例外を投げる。 */
  function run(label) {
    const failures = [];
    cases.forEach(function (c) {
      try {
        c.fn();
        Log.info('test_passed', { test: c.name });
      } catch (e) {
        failures.push(c.name + ': ' + e.message);
        Log.error('test_failed', { test: c.name, message: e.message });
      }
    });
    const summary = { suite: label, total: cases.length, failed: failures.length };
    if (failures.length) {
      Log.error('tests_failed', summary);
      throw new Error(label + ': ' + failures.length + ' test(s) failed\n' + failures.join('\n'));
    }
    Log.info('tests_passed', summary);
    return summary;
  }

  function reset() {
    cases = [];
  }

  /**
   * PropertiesService の代わり。テストが本番の状態を壊さないようにする。
   * **本番のプロパティを触るテストを書かないこと。**
   */
  function fakeProperties() {
    const store = {};
    return {
      getProperty: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setProperty: function (k, v) { store[k] = String(v); return this; },
      deleteProperty: function (k) { delete store[k]; return this; },
      _dump: function () { return store; },
    };
  }

  /** 仮想時計。sleep で時間が進む。実時間を待たずにレートを検証できる。 */
  function fakeClock(startMs) {
    let nowMs = startMs || 1000000;
    return {
      now: function () { return nowMs; },
      sleep: function (ms) { nowMs += ms; },
      advance: function (ms) { nowMs += ms; },
      elapsedSince: function (t0) { return nowMs - t0; },
    };
  }

  /**
   * Sheets の代わり。メモリ上の2次元配列で持つ。
   * **本番のシートを触るテストを書かないこと。**
   *
   * 呼び出し回数を数えている。「1サイクルで setValues が何回走ったか」
   * 「中断したサイクルで書かれていないか」を検証するため（仕様書 11.3 / 11.4）。
   */
  function fakeSheets(initial) {
    const data = {};
    const counts = { read: 0, write: 0, append: 0 };
    const names = Sheets.NAMES;
    Object.keys(names).forEach(function (key) {
      const name = names[key];
      const seed = (initial && initial[name]) || [Sheets.HEADERS[name].slice()];
      data[name] = copy(seed);
    });

    function copy(values) {
      return values.map(function (row) { return row.slice(); });
    }

    return {
      NAMES: names,
      HEADERS: Sheets.HEADERS,
      counts: counts,
      readAll: function (name) { counts.read += 1; return copy(data[name]); },
      writeAll: function (name, values) { counts.write += 1; data[name] = copy(values); },
      append: function (name, rows) {
        counts.append += 1;
        copy(rows).forEach(function (row) { data[name].push(row); });
      },
      dataRowCount: function (name) { return Math.max(0, data[name].length - 1); },
      dump: function (name) { return copy(data[name]); },
    };
  }

  /** LockService の代わり。`acquired` が false なら常に取れない。 */
  function fakeLock(acquired) {
    let released = false;
    return {
      tryLock: function () { return acquired !== false; },
      releaseLock: function () { released = true; },
      wasReleased: function () { return released; },
    };
  }

  return {
    test: test, assert: assert, assertEquals: assertEquals, assertNear: assertNear,
    assertThrows: assertThrows, run: run, reset: reset,
    fakeProperties: fakeProperties, fakeClock: fakeClock,
    fakeSheets: fakeSheets, fakeLock: fakeLock,
  };
})();
