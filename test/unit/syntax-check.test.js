// 記法の崩れの確認のテスト
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countCells, findSyntaxIssues, newSyntaxIssues } from '../../src/renderer/syntax-check.js';

const types = (text) => findSyntaxIssues(text).map((i) => [i.type, i.line]);

test('コードブロック: 閉じ忘れは開始の行を示す。閉じていれば何も出さない', () => {
  assert.deepEqual(types('a\n```js\ncode\n'), [['fence', 1]]);
  assert.deepEqual(types('```js\ncode\n```\n'), []);
  assert.deepEqual(types('~~~\ncode\n~~~\n'), []);
  assert.deepEqual(types('~~~\n```\n'), [['fence', 0]], '種類が違う記号では閉じない');
  assert.deepEqual(types('````\n```\n````\n'), [], '短い記号では閉じない');
  assert.deepEqual(types('```\n``` x\n'), [['fence', 0]], '閉じる行に文字があれば閉じない');
  assert.deepEqual(types('``` `x`\n'), [], '1 行目に ` があればインラインのコード');
  assert.deepEqual(types('    ```\n'), [], '4 文字の字下げはコードブロックの開始ではない');
});

test('コードブロックの中の表・リンクは調べない', () => {
  assert.deepEqual(types('```\n| a |\n| - | - |\n[x](y\n```\n'), []);
});

test('表: 見出しと区切り、本文の行の列数の違いを見つける', () => {
  assert.deepEqual(types('| a | b |\n| - | - |\n| 1 | 2 |\n'), []);
  assert.deepEqual(types('a | b\n- | -\n1 | 2\n'), [], '外側の | は省略できる');
  assert.deepEqual(types('| a | b |\n| - |\n'), [['table', 0]]);
  assert.deepEqual(types('| a | b |\n| - | - |\n| 1 |\n| 1 | 2 | 3 |\n'), [['table', 2], ['table', 3]]);
  assert.deepEqual(types('| a | b |\n| - | - |\n| 1 \\| 2 | 3 |\n'), [], '\\| は区切りではない');
  assert.deepEqual(types('| a | b |\n| - | - |\n\n| 1 |\n'), [], '空行で表は終わる');
  assert.deepEqual(types('| a | b |\n| - | - |\n文章\n'), [], '| の無い行は調べない');
  assert.deepEqual(types('文章 | 文章\n---\n'), [], '区切りに | が無ければ表と見なさない（見出しの可能性）');
  assert.deepEqual(types('| a |\n本文 | です\n'), [], '区切りの行が無ければ表ではない');
});

test('countCells', () => {
  assert.equal(countCells('| a | b |'), 2);
  assert.equal(countCells('a | b'), 2);
  assert.equal(countCells('| a \\| b |'), 1);
  assert.equal(countCells('| a | b \\|'), 2, '行末の \\| は閉じではない');
  assert.equal(countCells('|---|:--|'), 2);
});

test('リンク: 括弧の閉じ忘れを見つける。正しいリンク・インラインのコード・普通の文字は出さない', () => {
  assert.deepEqual(types('[文字](https://example.com\n'), [['link', 0]]);
  assert.deepEqual(types('![図](a.png\n'), [['link', 0]]);
  assert.deepEqual(types('[文字](https://example.com) と [別](x)\n'), []);
  assert.deepEqual(types('`[文字](x` の書き方\n'), []);
  assert.deepEqual(types('[文字] (x\n- [ ] (作業\n配列 a[0](x) です\n'), []);
  assert.deepEqual(types('    [文字](x\n'), [], '字下げのコード');
});

test('新しく生じた崩れだけを返す。元からある崩れは、行がずれても出さない', () => {
  const saved = '# 題\n\n[古い](x\n\n| a | b |\n| - | - |\n| 1 |\n';
  assert.deepEqual(newSyntaxIssues(saved, saved), []);
  assert.deepEqual(newSyntaxIssues(saved, `追加\n\n${saved}`), [], '行がずれても元からの崩れ');
  assert.deepEqual(newSyntaxIssues(saved, `${saved}\n[新しい](y\n`).map((i) => i.message), ['リンクの括弧 ) が閉じられていません']);
  assert.deepEqual(newSyntaxIssues(saved, saved.replace('| 1 |', '| 1 | 2 | 3 |')).map((i) => i.line), [6], '元の崩れを別の崩れにした');
  assert.deepEqual(newSyntaxIssues('[a](x\n', '[a](x\n[a](x\n').length, 1, '同じ中身は数で比べる');
  assert.deepEqual(newSyntaxIssues('[a](x\n', '[a](x)\n'), [], '直せば消える');
});

test('修正でコードブロックを壊すと知らせる（閉じる行を消した）', () => {
  const saved = '```\ncode\n```\n\n本文\n';
  const issues = newSyntaxIssues(saved, '```\ncode\n\n本文\n');
  assert.deepEqual(issues.map((i) => [i.type, i.line]), [['fence', 0]]);
  assert.ok(issues[0].message.includes('コードとして表示'));
});

test('大きな文書でも速い（50 万文字で 200ms 未満）', () => {
  const lines = [];
  for (let i = 0; i < 5000; i++) lines.push(`## 見出し ${i}`, '', `本文 ${i} [リンク](x) \`code\``.repeat(3), '', '| a | b |', '| - | - |', '| 1 | 2 |', '', '```js', 'x', '```', '');
  const text = lines.join('\n');
  assert.ok(text.length > 500000);
  const best = Math.min(...[0, 1, 2].map(() => { const t = performance.now(); newSyntaxIssues(text, `${text}\n`); return performance.now() - t; }));
  assert.ok(best < 200, `${Math.round(best)}ms`);
});
