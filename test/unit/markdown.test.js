// Markdown レンダリング（とほほ 4章 HTML / 5.4 絵文字 / サニタイズ / 行番号）のテスト
import assert from 'node:assert/strict';
import { test } from 'node:test';
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { createMarkdownRenderer } from '../../src/renderer/markdown.js';

const { window } = new JSDOM('');
const md = createMarkdownRenderer({ DOMPurify: createDOMPurify(window) });

function dom(html) {
  const div = window.document.createElement('div');
  div.innerHTML = html;
  return div;
}

test('4章: <pre> の中は Markdown と解釈されない', () => {
  const d = dom(md.render('<pre>\n**AAA**\n**BBB**\n</pre>'));
  assert.equal(d.querySelector('strong'), null);
  assert.match(d.querySelector('pre').textContent, /\*\*AAA\*\*/);
});

test('4章: <div> ブロックは空行までは Markdown と解釈されず、空行の後は解釈される', () => {
  const d = dom(md.render('<div>\n**AAA**\n\n**BBB**\n</div>'));
  const div = d.querySelector('div');
  assert.match(div.textContent, /\*\*AAA\*\*/);
  assert.equal(div.querySelector('strong')?.textContent, 'BBB');
});

test('4章: 開始タグと同じ行にテキストがあるインライン要素は Markdown と解釈される', () => {
  const d = dom(md.render('<span>**AAA**\n**BBB**\n**CCC**</span>'));
  assert.deepEqual(
    [...d.querySelectorAll('span strong')].map((s) => s.textContent),
    ['AAA', 'BBB', 'CCC'],
  );
});

test('4章: 開始タグだけの行のインライン要素はブロック扱い（空行まで Markdown 無効）', () => {
  const d = dom(md.render('<span>\n**DDD**\n\n**EEE**\n</span>'));
  assert.match(d.textContent, /\*\*DDD\*\*/);
  assert.equal(d.querySelector('strong')?.textContent, 'EEE');
});

test('4章: details / kbd / table などの HTML がそのまま表示される', () => {
  const d = dom(md.render('<details open><summary>概要</summary>\n\n本文\n\n</details>\n\n<kbd>Ctrl</kbd>'));
  assert.equal(d.querySelector('details summary').textContent, '概要');
  assert.ok(d.querySelector('details').hasAttribute('open'));
  assert.equal(d.querySelector('kbd').textContent, 'Ctrl');
});

test('5.4: :smile: 等の絵文字ショートコードが Unicode 絵文字になる', () => {
  const d = dom(md.render(':smile: :+1: :heart: :notexist:'));
  const emojis = [...d.querySelectorAll('.emoji')].map((e) => e.textContent);
  assert.deepEqual(emojis, ['😄', '👍', '❤️']);
  assert.match(d.textContent, /:notexist:/, '未登録の名前は文字のまま');
});

test('5.4: コード内の :smile: は変換しない', () => {
  const d = dom(md.render('`:smile:`\n\n```\n:smile:\n```'));
  assert.equal(d.querySelector('.emoji'), null);
});

test('サニタイズ: script・イベントハンドラ・javascript: URL を除去する', () => {
  const html = md.render(
    '<script>alert(1)</script>\n\n<img src="x.png" onerror="alert(2)">\n\n<a href="javascript:alert(3)">a</a>\n\n[b](javascript:alert(4))\n\n<iframe src="https://example.com"></iframe>\n\n<div onclick="alert(5)">c</div>',
  );
  assert.doesNotMatch(html, /<script|onerror|onclick|javascript:|<iframe/i);
});

test('相対パスの画像はファイルのフォルダ基準の file:// URL になる', () => {
  const d = dom(md.render('![a](img/a.png)\n\n<img src="../b.png">\n\n![c](https://example.com/c.png)', { baseUrl: 'file:///C:/docs/sub/' }));
  const srcs = [...d.querySelectorAll('img')].map((i) => i.getAttribute('src'));
  assert.deepEqual(srcs, ['file:///C:/docs/sub/img/a.png', 'file:///C:/docs/b.png', 'https://example.com/c.png']);
});

test('ブロックにソース行番号 data-line が付く（スクロール同期用）', () => {
  const src = '# 見出し\n\n段落1\n段落1続き\n\n- a\n- b\n\n[r]: https://example.com\n\n```js\nx\n```\n\n| a |\n|---|\n| 1 |\n';
  const d = dom(md.render(src));
  const lines = [...d.querySelectorAll('[data-line]')].map((e) => [e.tagName.toLowerCase(), Number(e.dataset.line)]);
  assert.deepEqual(lines, [
    ['h1', 0],
    ['p', 2],
    ['ul', 5],
    ['pre', 10],
    ['table', 14],
  ]);
});

test('見出しに GitHub 互換の id が付き、同名は連番になる', () => {
  const d = dom(md.render('# Hello World\n\n## Hello World\n\n### 日本語 見出し'));
  assert.deepEqual(
    [...d.querySelectorAll('h1,h2,h3')].map((h) => h.id),
    ['hello-world', 'hello-world-1', '日本語-見出し'],
  );
  // 2 回目の描画で連番がリセットされる
  const d2 = dom(md.render('# Hello World'));
  assert.equal(d2.querySelector('h1').id, 'hello-world');
});

test('GFM: 表・タスクリスト・取り消し線', () => {
  const d = dom(md.render('| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n~~del~~'));
  assert.equal(d.querySelectorAll('td').length, 2);
  assert.equal(d.querySelectorAll('input[type=checkbox]').length, 2);
  assert.equal(d.querySelector('del').textContent, 'del');
});

test('改行で折り返す: オンなら段落内の改行が <br> になり、オフなら半角スペース 2 つのときだけ', () => {
  const src = '一行目\n二行目  \n三行目';
  const off = dom(md.render(src));
  assert.equal(off.querySelectorAll('br').length, 1, 'オフ: 行末の半角スペース 2 つの所だけ');
  md.setBreaks(true);
  try {
    const on = dom(md.render(src));
    assert.equal(on.querySelectorAll('br').length, 2, 'オン: すべての改行');
  } finally {
    md.setBreaks(false);
  }
  assert.equal(dom(md.render(src)).querySelectorAll('br').length, 1, '元に戻る');
});
