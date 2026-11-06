import assert from 'node:assert/strict';
import { test } from 'node:test';
import { continueList } from '../../src/renderer/list-continue.js';

// 行末にキャレットを置いて Enter を押したときの結果（本文・キャレット）
function enterAtEnd(value) {
  const edit = continueList(value, value.length, value.length);
  if (!edit) return null;
  return { value: value.slice(0, edit.from) + edit.text + value.slice(edit.to), caret: edit.caret };
}

test('箇条書き・番号付き・タスクリストの記号を次の行に引き継ぐ', () => {
  assert.deepEqual(enterAtEnd('- 項目'), { value: '- 項目\n- ', caret: 7 });
  assert.equal(enterAtEnd('* 項目').value, '* 項目\n* ');
  assert.equal(enterAtEnd('+ 項目').value, '+ 項目\n+ ');
  assert.equal(enterAtEnd('1. 一つ目').value, '1. 一つ目\n2. ');
  assert.equal(enterAtEnd('9) 九').value, '9) 九\n10) ');
  assert.equal(enterAtEnd('- [x] 済み').value, '- [x] 済み\n- [ ] ');
  assert.equal(enterAtEnd('1. [ ] 未').value, '1. [ ] 未\n2. [ ] ');
});

test('字下げと記号の後の空白を引き継ぐ', () => {
  assert.equal(enterAtEnd('  - 子').value, '  - 子\n  - ');
  assert.equal(enterAtEnd('\t1.  二つの空白').value, '\t1.  二つの空白\n\t2.  ');
});

test('記号だけの行ではリストを終える（記号を消す）', () => {
  assert.deepEqual(enterAtEnd('- 項目\n- '), { value: '- 項目\n', caret: 5 });
  assert.equal(enterAtEnd('- 項目\n  2. ').value, '- 項目\n');
  assert.equal(enterAtEnd('- [ ] ').value, '');
});

test('行の途中で Enter を押すと、後ろの文字は記号付きの次の行へ', () => {
  const v = '- 前後';
  const edit = continueList(v, 3, 3);
  assert.equal(v.slice(0, edit.from) + edit.text + v.slice(edit.to), '- 前\n- 後');
  assert.equal(edit.caret, 6);
});

test('対象外のときは普通の改行（null）', () => {
  assert.equal(enterAtEnd('普通の段落'), null);
  assert.equal(enterAtEnd('-記号の後に空白なし'), null);
  assert.equal(enterAtEnd('- - -'), null, '水平線');
  assert.equal(enterAtEnd('* * *'), null, '水平線');
  assert.equal(enterAtEnd('```\n- コードの中'), null, 'コードブロックの中');
  assert.equal(enterAtEnd('~~~\n1. コードの中'), null, 'コードブロックの中');
  assert.equal(enterAtEnd('```\nx\n```\n- コードの後').value, '```\nx\n```\n- コードの後\n- ', 'コードブロックの後');
  // 記号の途中・前にキャレットがある
  assert.equal(continueList('- 項目', 1, 1), null);
  assert.equal(continueList('- 項目', 0, 0), null);
  // 選択があるとき
  assert.equal(continueList('- 項目', 2, 4), null);
  // 記号だけの行でも、キャレットが行末でなければ何もしない
  assert.equal(continueList('-  ', 2, 2), null);
});
