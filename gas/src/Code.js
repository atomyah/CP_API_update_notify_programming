/**
 * clasp push の疎通確認用テストコード。
 * 移植の本実装を入れる段階で削除する。
 */

/** スプレッドシートを開いたときにメニューを追加する */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('CP進捗通知')
    .addItem('Hello World', 'helloWorld')
    .addToUi();
}

/** 実行ログとスプレッドシート上のトーストに Hello World を表示する */
function helloWorld() {
  const message = 'Hello World';
  console.log(message);
  SpreadsheetApp.getActiveSpreadsheet().toast(message, 'CP進捗通知', 5);
}
