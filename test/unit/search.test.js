// 検索のテスト
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findMatches, indexAtOrAfter, MAX_MATCHES } from '../../src/renderer/search.js';

test('通常検索は既定で大文字小文字を区別しない', () => {
  assert.equal(findMatches('Foo foo FOO', 'foo').matches.length, 3);
  assert.equal(findMatches('Foo foo FOO', 'foo', { caseSensitive: true }).matches.length, 1);
});

test('記号はそのまま検索される（正規表現オフ）', () => {
  assert.deepEqual(findMatches('a.b a*b', 'a.b').matches, [{ start: 0, end: 3 }]);
});

test('単語単位', () => {
  assert.equal(findMatches('cat concat cat_x cat', 'cat', { wholeWord: true }).matches.length, 2);
});

test('正規表現: 不正なパターンはエラーを返す / 空一致で無限ループしない', () => {
  assert.ok(findMatches('abc', '(', { regex: true }).error);
  assert.deepEqual(findMatches('abc', 'x*', { regex: true }).matches, []);
  assert.equal(findMatches('a\nb\n', '^', { regex: true }).matches.length, 0);
});

test('indexAtOrAfter: キャレット以降の最初のヒット（無ければ先頭へ）', () => {
  const m = [{ start: 2 }, { start: 5 }, { start: 9 }];
  assert.equal(indexAtOrAfter(m, 0), 0);
  assert.equal(indexAtOrAfter(m, 5), 1);
  assert.equal(indexAtOrAfter(m, 6), 2);
  assert.equal(indexAtOrAfter(m, 10), 0);
  assert.equal(indexAtOrAfter([], 0), -1);
});

test('ヒットは 9999 件まで（超えた分は打ち切りとして示す）', () => {
  assert.equal(MAX_MATCHES, 9999);
  const exact = findMatches('a'.repeat(9999), 'a');
  assert.equal(exact.matches.length, 9999);
  assert.equal(exact.truncated, false, 'ちょうど 9999 件は打ち切りではない');
  const over = findMatches('a'.repeat(12000), 'a');
  assert.equal(over.matches.length, 9999);
  assert.equal(over.truncated, true);
});
