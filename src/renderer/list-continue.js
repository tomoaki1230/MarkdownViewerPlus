// 箇条書き・番号付きリスト・タスクリストの行で Enter を押したときに、次の行へ同じ記号を入れる
// ・「- 項目」で Enter →「- 」、「1. 項目」→「2. 」、「- [x] 済み」→「- [ ] 」（字下げも引き継ぐ）
// ・中身の無い項目（「- 」だけの行）で Enter → 記号を消してリストを終える
// ・コードブロックの中・水平線（- - -）・記号の途中にキャレットがあるときは何もしない（普通の改行にする）

const ITEM = /^([ \t]*)(?:([-*+])|(\d{1,9})([.)]))([ \t]+)(\[[ xX]\][ \t]+)?/;
const HR = /^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/;
const FENCE = /^ {0,3}(```|~~~)/gm;

/**
 * @param {string} value 本文
 * @param {number} start 選択の始まり
 * @param {number} end 選択の終わり
 * @returns {{from: number, to: number, text: string, caret: number} | null} 置き換える区間と文字・置き換えた後のキャレット（null は普通の改行）
 */
export function continueList(value, start, end) {
  if (start !== end) return null;
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = value.indexOf('\n', start);
  if (lineEnd < 0) lineEnd = value.length;
  const line = value.slice(lineStart, lineEnd);
  if (HR.test(line)) return null;
  const m = ITEM.exec(line);
  if (!m || start - lineStart < m[0].length) return null;
  // コードブロックの中（前にあるフェンスの数が奇数）では何もしない
  const fences = value.slice(0, lineStart).match(FENCE)?.length ?? 0;
  if (fences % 2 === 1) return null;

  const [prefix, indent, bullet, num, delim, space, task] = m;
  if (line.slice(prefix.length).trim() === '') {
    // 中身の無い項目: 記号を消してリストを終える（行は空になる）
    if (start !== lineEnd) return null;
    return { from: lineStart, to: lineEnd, text: '', caret: lineStart };
  }
  const marker = bullet ?? `${Number(num) + 1}${delim}`;
  const text = `\n${indent}${marker}${space}${task ? '[ ] ' : ''}`;
  return { from: start, to: start, text, caret: start + text.length };
}
