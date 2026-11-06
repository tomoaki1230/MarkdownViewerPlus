// コードブロックのコピーボタンのテスト
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { codeTextOf, copyWithResult, decorateCodeBlocks, resetCopyResult, runCodeCopy } from '../../src/renderer/code-copy.js';

function root(html) {
  const { window } = new JSDOM(`<div id="r">${html}</div>`);
  return window.document.querySelector('#r');
}

test('コードブロックに枠とボタンを付ける。Mermaid には付けず、2 回呼んでも増えない', () => {
  const r = root('<pre data-line="0"><code>a</code></pre><pre><code class="language-mermaid">flowchart</code></pre><div class="mermaid-figure"><pre><code>誤り</code></pre></div><pre>生の pre</pre>');
  decorateCodeBlocks(r);
  decorateCodeBlocks(r);
  assert.equal(r.querySelectorAll('.code-copy').length, 2);
  assert.equal(r.querySelector('code.language-mermaid').closest('.code-block'), null);
  assert.equal(r.querySelector('.mermaid-figure .code-copy'), null);
  assert.equal(r.querySelector('.code-block pre').getAttribute('data-line'), '0', 'pre の行番号はそのまま');
});

test('ボタンは文字を持たない（検索・選択・コピーの内容に混ざらない）。名前は読み上げできる', () => {
  const r = root('<pre><code>a</code></pre>');
  decorateCodeBlocks(r);
  const b = r.querySelector('.code-copy');
  assert.equal(b.textContent, '');
  assert.equal(b.getAttribute('aria-label'), 'コードをコピー');
  assert.equal(b.type, 'button');
  assert.equal(r.querySelector('.code-block').textContent, 'a');
});

test('コピーする文字: 最後の改行だけを除き、途中の改行・字下げ・最後の空行は残す', () => {
  assert.equal(codeTextOf(root('<pre><code>a\n  b\n</code></pre>').firstChild), 'a\n  b');
  assert.equal(codeTextOf(root('<pre><code>a\n\n</code></pre>').firstChild), 'a\n');
  assert.equal(codeTextOf(root('<pre><code>a</code></pre>').firstChild), 'a');
  assert.equal(codeTextOf(root('<pre>生の\npre\n</pre>').firstChild), '生の\npre');
  assert.equal(codeTextOf(root('<pre><code><span>色</span>付き\n</code></pre>').firstChild), '色付き');
});

test('押すとコピーし、結果を表示する。失敗（false・例外）も伝える', async () => {
  const r = root('<pre><code>echo 1\n</code></pre>');
  decorateCodeBlocks(r);
  const b = r.querySelector('.code-copy');
  let copied = null;
  await runCodeCopy(b, async (t) => ((copied = t), true));
  clearTimeout(b.__copyTimer);
  assert.equal(copied, 'echo 1');
  assert.equal(b.title, 'コピーしました');
  assert.ok(b.classList.contains('done') && !b.classList.contains('failed'));
  for (const fail of [async () => false, async () => { throw new Error('x'); }]) {
    await runCodeCopy(b, fail);
    clearTimeout(b.__copyTimer);
    assert.equal(b.title, 'コピーできませんでした');
    assert.ok(b.classList.contains('failed'));
  }
});

test('結果の表示を普段の状態に戻す（選んだ文字のコピーのボタンで、隠すときに使う）', async () => {
  const r = root('<button id="b"></button>');
  const b = r.querySelector('#b');
  await copyWithResult(b, 'x', async () => true, '名前');
  assert.ok(b.classList.contains('done'));
  resetCopyResult(b, '名前');
  assert.equal(b.title, '名前');
  assert.equal(b.getAttribute('aria-label'), '名前');
  assert.ok(!b.classList.contains('done'));
});
