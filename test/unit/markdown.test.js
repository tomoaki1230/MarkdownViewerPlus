// Markdown レンダリング（とほほ 4章 HTML / 5.4 絵文字 / サニタイズ / 行番号）のテスト
import assert from 'node:assert/strict';
import { test } from 'node:test';
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { CHUNK_CHARS, CHUNK_LINES, createMarkdownRenderer } from '../../src/renderer/markdown.js';

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

test('巨大な段落は塊に分けて描画し、文字・強調・リンクは失わず、塊には元の行番号を付ける', () => {
  // 1 行ごとに強調とリンクが改行をまたぐ（強調・リンクの途中では分けない）
  const row = (i) => `行${i} **太字\n続き** [リンク\n先](http://a/)`;
  const rows = 250;
  const src = `# 見出し\n\n${Array.from({ length: rows }, (_, i) => row(i)).join('\n')}\n\n後ろ\n`;
  const d = dom(md.render(src));
  const p = d.querySelector('p');
  const chunks = [...p.querySelectorAll(':scope > span.md-chunk')];
  assert.ok(chunks.length > 1, '分けられている');
  assert.equal(p.querySelectorAll('strong').length, rows);
  assert.equal(p.querySelectorAll('a').length, rows);
  // 元の段落と同じ文字（境目の改行を除く）
  const plain = Array.from({ length: rows }, (_, i) => `行${i} 太字続き リンク先`).join('');
  assert.equal(p.textContent.replace(/[\s\n]/g, ''), plain.replace(/\s/g, ''));
  // 塊の data-line は、その塊の先頭のソース行
  const lines = src.split('\n');
  for (const c of chunks.slice(1)) {
    const line = Number(c.dataset.line);
    assert.equal(lines[line].split(' ')[0], c.textContent.split(' ')[0], `data-line=${line}`);
  }
  // 塊の大きさは上限の範囲（強調等をまたぐ分だけ少し超え得る）
  for (const c of chunks) assert.ok(c.textContent.split('\n').length <= CHUNK_LINES + 3);
});

test('小さい段落・改行の無い長文・改行して表示する設定での塊', () => {
  assert.equal(dom(md.render('a\nb\nc')).querySelector('.md-chunk'), null, '小さい段落は分けない');
  // 改行の無い長文は文字数で区切る（サロゲートペアを壊さない）
  const long = 'あ'.repeat(CHUNK_CHARS * 2 + 1) + '😀'.repeat(CHUNK_CHARS);
  const d = dom(md.render(long));
  assert.ok(d.querySelectorAll('.md-chunk').length >= 4);
  assert.equal(d.querySelector('p').textContent, long);
  // 改行して表示する設定: 塊の境目の改行は <br> の代わり（<br> と境目の合計は元の改行の数）
  md.setBreaks(true);
  try {
    const text = Array.from({ length: CHUNK_LINES * 3 }, (_, i) => `行${i}`).join('\n');
    const p = dom(md.render(text)).querySelector('p');
    const chunks = p.querySelectorAll('.md-chunk').length;
    assert.ok(chunks > 1);
    assert.equal(p.querySelectorAll('br').length + chunks - 1, CHUNK_LINES * 3 - 1);
  } finally {
    md.setBreaks(false);
  }
});

test('GitHub のアラート: 5 種類の見出しと中身、普通の引用・行の途中の [!NOTE] はアラートにしない', () => {
  const labels = { NOTE: '注記', TIP: 'ヒント', IMPORTANT: '重要', WARNING: '警告', CAUTION: '注意' };
  for (const [type, label] of Object.entries(labels)) {
    const d = dom(md.render(`> [!${type}]\n> 本文 **太字**\n> - 箇条書き`));
    const alert = d.querySelector(`.markdown-alert.markdown-alert-${type.toLowerCase()}`);
    assert.ok(alert, type);
    assert.equal(alert.querySelector('.markdown-alert-title').textContent, label);
    assert.equal(alert.querySelector('strong').textContent, '太字');
    assert.equal(alert.querySelectorAll('li').length, 1);
    assert.equal(d.querySelector('blockquote'), null);
  }
  // 小文字でもよい（GitHub と同じ）
  assert.ok(dom(md.render('> [!note]\n> 本文')).querySelector('.markdown-alert-note'));
  // 普通の引用・1 行目に他の文字がある・知らない種類はアラートにしない
  for (const src of ['> 引用', '> 注意 [!NOTE]', '> [!NOTE] 同じ行の文章', '> [!INFO]\n> 本文']) {
    const d = dom(md.render(src));
    assert.equal(d.querySelector('.markdown-alert'), null, src);
    assert.ok(d.querySelector('blockquote'), src);
  }
  // アラートにも data-line が付く（スクロール同期）
  assert.equal(dom(md.render('# a\n\n> [!TIP]\n> b')).querySelector('.markdown-alert').dataset.line, '2');
});

test('脚注: 参照順の番号・戻りリンク・何度も参照・定義の無い参照・続きの行・参照されない定義', () => {
  const d = dom(
    md.render('本文[^b]と[^a]と[^b]と[^none]\n\n[^a]: A の脚注\n[^b]: B の脚注\n    続きの行\n[^unused]: 使われない\n'),
  );
  const refs = [...d.querySelectorAll('sup.footnote-ref a')].map((a) => [a.textContent, a.getAttribute('href'), a.id]);
  assert.deepEqual(refs, [
    ['1', '#mvp-fn-1', 'mvp-fnref-1'],
    ['2', '#mvp-fn-2', 'mvp-fnref-2'],
    ['1', '#mvp-fn-1', 'mvp-fnref-1-2'],
  ]);
  assert.match(d.querySelector('p').textContent, /\[\^none\]/, '定義の無い参照は文字のまま');
  const items = [...d.querySelectorAll('section.footnotes li')];
  assert.deepEqual(
    items.map((li) => li.id),
    ['mvp-fn-1', 'mvp-fn-2'],
    '参照された脚注だけ、参照された順',
  );
  assert.match(items[0].textContent, /B の脚注\s+続きの行/);
  assert.deepEqual(
    [...items[0].querySelectorAll('.footnote-backref')].map((a) => a.getAttribute('href')),
    ['#mvp-fnref-1', '#mvp-fnref-1-2'],
  );
  // 定義は本文の位置には出さない。脚注が無ければ一覧も出さない
  assert.doesNotMatch(d.textContent.split('A の脚注')[0], /使われない/);
  assert.equal(dom(md.render('本文だけ')).querySelector('.footnotes'), null);
  // 脚注の中の参照リンクの定義は本文と共通
  const withRef = dom(md.render('x[^1]\n\n[^1]: [参照][r]\n\n[r]: https://example.com/'));
  assert.equal(withRef.querySelector('.footnotes a[href="https://example.com/"]')?.textContent, '参照');
});

test('脚注の id は文書中の HTML からは名乗れない（mvp-fn の id は取り除く。印を推測しても無効）。他の id はそのまま', () => {
  const d = dom(
    md.render('本文[^1]\n\n<div id="mvp-fn-1">偽物</div><a id="mvp-fnref-1" data-mvp-own="guess">偽</a> <span id="fn-1">ふつう</span>\n\n[^1]: 脚注\n'),
  );
  assert.deepEqual(
    [...d.querySelectorAll('[id^="mvp-fn"]')].map((e) => [e.tagName, e.id]),
    [
      ['A', 'mvp-fnref-1'],
      ['LI', 'mvp-fn-1'],
    ],
  );
  assert.equal(d.querySelector('#fn-1').textContent, 'ふつう');
  assert.equal(d.querySelector('[data-mvp-own]'), null, '印は表示に残さない');
});

test('アラート・脚注の拡張: 段落の数が多い大きな文書でも、変換の時間が文書の長さに比例する程度で済む', () => {
  // 以前は段落ごとに文書の残り全体を探しており、1MB（段落 2 万）で約 5 秒かかっていた（2 乗で増える）
  const blocks = [];
  for (let i = 0; i < 10000; i++) blocks.push(`**太字** ${i}`, '', `本文 ${i} `.repeat(8), '');
  const src = `${blocks.join('\n')}\n\n> [!NOTE]\n> 最後のアラート\n\n最後[^1]\n\n[^1]: 最後の脚注\n`;
  const t = performance.now();
  md.headings(src);
  const html = md.render(src);
  const ms = performance.now() - t;
  assert.ok(ms < 3000, `${Math.round(ms)}ms`);
  // 段落の外（文書の最後）にあるアラート・脚注も、これまでどおり変換される
  const d = dom(html);
  assert.ok(d.querySelector('.markdown-alert-note'));
  assert.ok(d.querySelector('section.footnotes li'));
});

test('アラート・脚注の拡張: 段落のすぐ下の行（空行なし）のアラート・脚注の定義は、段落を区切って変換される', () => {
  const d = dom(md.render('段落\n> [!WARNING]\n> 警告\n\n本文[^1]\n[^1]: 定義\n'));
  assert.ok(d.querySelector('.markdown-alert-warning'));
  assert.equal(d.querySelector('section.footnotes li')?.textContent.replace('↩', '').trim(), '定義');
});
