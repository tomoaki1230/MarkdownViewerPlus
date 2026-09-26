// 開けなかったファイルのお知らせ文言のテスト
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOpenNotice, OpenNotice } from '../../src/main/open-notice.js';

test('1 件だけ開こうとして開かなかったとき', () => {
  assert.equal(
    buildOpenNotice([{ name: 'tool.exe', reason: 'binary' }], 1),
    '「tool.exe」は表示できない種類のファイルのため、開きませんでした。Markdown やテキストのファイルを開けます。',
  );
});

test('複数のうち一部を開かなかったときは、まとめて 1 回で知らせる', () => {
  const msg = buildOpenNotice([{ name: 'a.exe', reason: 'binary' }], 3);
  assert.equal(msg, '3 件中 1 件は開きませんでした: a.exe（表示できない種類のファイル）。Markdown やテキストのファイルを開けます。');
});

test('すべて開かなかったとき・多いときは名前を 3 つまで', () => {
  const notices = ['a.exe', 'b.png', 'c.zip', 'd.dll'].map((name) => ({ name, reason: 'binary' }));
  const msg = buildOpenNotice(notices, 4);
  assert.match(msg, /^4 件とも開きませんでした: a\.exe（.+）、b\.png（.+）、c\.zip（.+） ほか 1 件。/);
});

test('理由の種類', () => {
  assert.match(buildOpenNotice([{ name: 'big.md', reason: 'too-large' }], 1), /大きすぎるファイル（50MB まで）のため/);
  assert.match(buildOpenNotice([{ name: 'docs', reason: 'folder' }], 1), /「docs」はフォルダのため/);
  assert.equal(new OpenNotice('binary').reason, 'binary');
  assert.equal(buildOpenNotice([], 2), '');
});
