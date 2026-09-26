// 最近開いたファイルの一覧操作のテスト
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_RECENT, pushRecent, removeRecent } from '../../src/main/recent.js';

test('先頭に追加され、同じパスは重複しない', () => {
  let list = [];
  list = pushRecent(list, '/a.md');
  list = pushRecent(list, '/b.md');
  list = pushRecent(list, '/a.md');
  assert.deepEqual(list, ['/a.md', '/b.md']);
});

test(`最大 ${MAX_RECENT} 件で古いものから消える`, () => {
  let list = [];
  for (let i = 0; i < 15; i++) list = pushRecent(list, `/f${i}.md`);
  assert.equal(list.length, 10);
  assert.equal(list[0], '/f14.md');
  assert.equal(list.at(-1), '/f5.md');
});

test('Windows では大文字小文字の違いを同じパスとみなす', () => {
  const list = pushRecent(['C:\\Docs\\A.md'], 'c:\\docs\\a.md', { ignoreCase: true });
  assert.deepEqual(list, ['c:\\docs\\a.md']);
  assert.deepEqual(pushRecent(['/A.md'], '/a.md', { ignoreCase: false }), ['/a.md', '/A.md']);
});

test('一覧から取り除く', () => {
  assert.deepEqual(removeRecent(['/a.md', '/b.md'], '/a.md'), ['/b.md']);
});
