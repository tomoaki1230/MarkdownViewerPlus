// エディタの鏡: mirror.textContent === textarea.value の不変条件を守ること
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { buildLineElement, computeLineClasses, distributeHits, tokenizeLine } from '../../src/renderer/mirror.js';
import { findMatches } from '../../src/renderer/search.js';

const { document } = new JSDOM('').window;

// MirrorEditor.refresh と同じ手順で鏡の中身を作る
function buildMirror(value, matches = [], current = -1) {
  const pre = document.createElement('pre');
  const lines = value.split('\n');
  const classes = computeLineClasses(lines);
  const hits = distributeHits(lines, matches, current);
  lines.forEach((line, i) => {
    const tokens = tokenizeLine(line, classes[i]);
    pre.appendChild(buildLineElement(document, line, classes[i], tokens, hits.get(i) ?? [], i < lines.length - 1));
  });
  return pre;
}

const SAMPLES = [
  '',
  '\n',
  '\n\n\n',
  'a',
  'a\n',
  '# 見出し :smile:\n\n**太字** と *斜体* と ~~取消~~ と `code` と [link](http://x) <b>html</b>\n',
  '```js\nconst a = "<b>**x**</b>";\n```\n後ろ',
  '> 引用 **強調**\n> - [ ] タスク\n1. 番号\n   - 入れ子',
  '| a | b |\n|---|---|\n| `|` | \\| |',
  'タブ\tと　全角空白と 😀 絵文字と 𠮷 サロゲート',
  'NUL文字\u0000と制御文字\u0001\u001f',
  '<!-- コメント --> & &amp; &lt; < > "\'',
  '***\n---\n___\n',
  'http://example.com/a_b_c*d* snake_case_name **未閉じ',
  '~~~\n```\n内側\n~~~\n',
  '\\*エスケープ\\* \\\\',
];

test('色分けだけの鏡: textContent が元の文字列と一致する', () => {
  for (const s of SAMPLES) {
    assert.equal(buildMirror(s).textContent, s, JSON.stringify(s));
  }
});

test('検索ヒット（行をまたぐものを含む）を重ねても textContent が一致する', () => {
  const queries = [
    ['a', {}],
    ['**', {}],
    ['\\n', { regex: true }],
    ['.\\n.', { regex: true }],
    ['[a-z]+', { regex: true }],
    ['見出し', {}],
    ['😀', {}],
  ];
  for (const s of SAMPLES) {
    for (const [q, opts] of queries) {
      const { matches } = findMatches(s, q, opts);
      const pre = buildMirror(s, matches, 0);
      assert.equal(pre.textContent, s, `${JSON.stringify(s)} / ${q}`);
    }
  }
});

test('行ごとに 1 つの箱があり、改行は .ed-nl に入る', () => {
  const pre = buildMirror('a\n\nb');
  const lines = pre.querySelectorAll(':scope > .ed-line');
  assert.equal(lines.length, 3);
  assert.equal(pre.querySelectorAll('.ed-nl').length, 2);
  assert.equal(lines[2].querySelector('.ed-nl'), null, '最終行は改行を持たない');
});

test('フェンスコード内は色分けしない', () => {
  const lines = ['```', '**x** `y`', '```', '**z**'];
  const classes = computeLineClasses(lines);
  assert.deepEqual(classes, ['ln-fence', 'ln-code', 'ln-fence', '']);
  assert.deepEqual(tokenizeLine(lines[1], classes[1]), []);
  assert.equal(tokenizeLine(lines[3], classes[3])[0].cls, 'tk-strong');
});

test('インライン記法の区間は重ならず昇順', () => {
  const line = '- [x] **a** *b* `c` [d](e) <i>f</i> :smile: ~~g~~ https://h.example';
  const tokens = tokenizeLine(line, '');
  for (let i = 1; i < tokens.length; i++) assert.ok(tokens[i].start >= tokens[i - 1].end);
  const kinds = tokens.map((t) => t.cls);
  for (const k of ['tk-list', 'tk-task', 'tk-strong', 'tk-em', 'tk-code', 'tk-link', 'tk-html', 'tk-emoji', 'tk-del', 'tk-url']) {
    assert.ok(kinds.includes(k), k);
  }
});

test('現在のヒットには hit-cur が付く', () => {
  const s = 'foo bar foo';
  const { matches } = findMatches(s, 'foo');
  const pre = buildMirror(s, matches, 1);
  const hits = [...pre.querySelectorAll('.hit')];
  assert.equal(hits.length, 2);
  assert.ok(!hits[0].classList.contains('hit-cur'));
  assert.ok(hits[1].classList.contains('hit-cur'));
});
