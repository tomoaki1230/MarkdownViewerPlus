// 行単位の差分（変更箇所の目印・変更点の確認画面）のテスト
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildHunks, countChanges, diffLines, intraline, lineMarks } from '../../src/renderer/line-diff.js';

const L = (s) => s.split('\n');

test('変更なし: 一致の区間だけ・目印なし', () => {
  const ops = diffLines(L('a\nb\nc'), L('a\nb\nc'));
  assert.deepEqual(ops, [{ type: 'equal', oldStart: 0, oldEnd: 3, newStart: 0, newEnd: 3 }]);
  assert.equal(lineMarks(ops, 3).size, 0);
  assert.equal(countChanges(ops), 0);
  assert.deepEqual(buildHunks(L('a\nb\nc'), L('a\nb\nc'), ops), []);
});

test('1 行の変更・追加・削除の目印', () => {
  // 2 行目を変更
  let ops = diffLines(L('a\nb\nc'), L('a\nB\nc'));
  assert.deepEqual([...lineMarks(ops, 3)], [[1, 'mod']]);
  // 2 行目の後に 2 行追加
  ops = diffLines(L('a\nb\nc'), L('a\nb\nx\ny\nc'));
  assert.deepEqual([...lineMarks(ops, 5)], [[2, 'add'], [3, 'add']]);
  // 2 行目を削除 → 削除された位置の次の行（c）に印
  ops = diffLines(L('a\nb\nc'), L('a\nc'));
  assert.deepEqual([...lineMarks(ops, 2)], [[1, 'del']]);
  // 末尾の行を削除 → 最後の行に「末尾で削除」の印
  ops = diffLines(L('a\nb\nc'), L('a\nb'));
  assert.deepEqual([...lineMarks(ops, 2)], [[1, 'del-end']]);
  // 2 行を 3 行に置き換え → 2 行は変更、1 行は追加
  ops = diffLines(L('a\nb\nc\nd'), L('a\nB\nC\nX\nd'));
  assert.deepEqual([...lineMarks(ops, 5)], [[1, 'mod'], [2, 'mod'], [3, 'add']]);
});

test('離れた 2 か所の変更は別の区間になり、間の行は一致として対応付く', () => {
  const oldLines = Array.from({ length: 20 }, (_, i) => `行${i}`);
  const newLines = [...oldLines];
  newLines[3] = '行3（修正）';
  newLines.splice(15, 1);
  const ops = diffLines(oldLines, newLines);
  assert.equal(countChanges(ops), 2);
  assert.deepEqual([...lineMarks(ops, newLines.length)], [[3, 'mod'], [15, 'del']]);
  const hunks = buildHunks(oldLines, newLines, ops, 2);
  assert.equal(hunks.length, 2, '離れているので 2 つのかたまり');
  assert.deepEqual(
    hunks[0].rows.map((r) => [r.kind, r.oldNo, r.newNo]),
    [[' ', 2, 2], [' ', 3, 3], ['-', 4, null], ['+', null, 4], [' ', 5, 5], [' ', 6, 6]],
  );
  assert.deepEqual(hunks[1].rows.map((r) => r.kind), [' ', ' ', '-', ' ', ' ']);
});

test('近い 2 か所の変更は 1 つのかたまりにまとめる', () => {
  const oldLines = L('a\nb\nc\nd\ne\nf\ng');
  const newLines = L('a\nB\nc\nd\ne\nF\ng');
  const hunks = buildHunks(oldLines, newLines, diffLines(oldLines, newLines), 2);
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0].rows.map((r) => r.kind).join(''), ' -+   -+ ');
});

test('1 行の中の変わった部分（誤記の修正で 1 文字だけ変わる）', () => {
  assert.deepEqual(intraline('誤記があります', '誤字があります'), { start: 1, oldEnd: 2, newEnd: 2 });
  assert.deepEqual(intraline('abc', 'abXc'), { start: 2, oldEnd: 2, newEnd: 3 });
  // サロゲートペアの途中で切らない（𠮷 と 𠮟 は上位サロゲートが同じ）
  const m = intraline('a𠮷b', 'a𠮟b');
  assert.deepEqual(m, { start: 1, oldEnd: 3, newEnd: 3 });
  const rows = buildHunks(['誤記'], ['誤字'], diffLines(['誤記'], ['誤字']))[0].rows;
  assert.deepEqual(rows.map((r) => [r.kind, r.mark]), [['-', [1, 2]], ['+', [1, 2]]]);
});

test('中央部分が大きすぎるときは、まとめて置き換えとみなす（固まらない）', () => {
  const oldLines = Array.from({ length: 3000 }, (_, i) => `旧${i}`);
  const newLines = Array.from({ length: 3000 }, (_, i) => `新${i}`);
  const t0 = Date.now();
  const ops = diffLines(['先頭', ...oldLines, '末尾'], ['先頭', ...newLines, '末尾']);
  assert.ok(Date.now() - t0 < 2000);
  assert.deepEqual(ops.map((o) => o.type), ['equal', 'change', 'equal']);
  assert.equal(lineMarks(ops, 3002).size, 3000);
});

test('空の文書との差分', () => {
  const ops = diffLines([''], L('a\nb'));
  assert.deepEqual([...lineMarks(ops, 2)], [[0, 'mod'], [1, 'add']]);
  const back = diffLines(L('a\nb'), ['']);
  assert.deepEqual([...lineMarks(back, 1)], [[0, 'mod']]);
});
