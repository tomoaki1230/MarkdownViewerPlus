// 表示モード検索（プレビューのテキスト索引と Range）のテスト
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { buildTextIndex, rangeFor } from '../../src/renderer/preview-search.js';
import { findMatches } from '../../src/renderer/search.js';

const { document } = new JSDOM('').window;

function article(html) {
  const el = document.createElement('article');
  el.innerHTML = html;
  return el;
}

test('表示されているテキストを連結し、style / script は含めない', () => {
  const root = article('<h1>見出し</h1>\n<p>本文<strong>誤記</strong>です</p><style>.x{}</style><script>var a</script>');
  assert.equal(buildTextIndex(root).text, '見出し\n本文誤記です');
});

test('要素をまたぐヒットも 1 つの Range になる', () => {
  const root = article('<p>レビュー<strong>中の</strong>誤記</p>');
  const index = buildTextIndex(root);
  const { matches } = findMatches(index.text, 'ー中の誤');
  assert.equal(matches.length, 1);
  const range = rangeFor(index, matches[0].start, matches[0].end);
  assert.equal(range.toString(), 'ー中の誤');
});

test('Range の文字列はヒットした文字列と一致する', () => {
  const root = article('<p>abc <em>abc</em> <code>abc</code></p><ul><li>abc</li></ul>');
  const index = buildTextIndex(root);
  const { matches } = findMatches(index.text, 'abc');
  assert.equal(matches.length, 4);
  for (const m of matches) assert.equal(rangeFor(index, m.start, m.end).toString(), 'abc');
});

test('ノードの境目から始まるヒットは次のノードの先頭から始まる', () => {
  const root = article('<p>ab<b>cd</b></p>');
  const index = buildTextIndex(root);
  const range = rangeFor(index, 2, 4);
  assert.equal(range.startContainer.data, 'cd');
  assert.equal(range.startOffset, 0);
});

test('空のプレビューでは Range を作らない', () => {
  assert.equal(rangeFor(buildTextIndex(article('')), 0, 0), null);
});
