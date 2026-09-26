// 行単位の差分（変更箇所の目印・変更点の確認画面・外部変更の差分表示で使う）
// 先頭・末尾の一致する行を除いた中央部分を、最長共通部分列（LCS）で対応付ける。
// 中央部分が大きすぎるとき（表の大きさが上限を超える）は、中央部分をまとめて「置き換え」とみなす。

const MAX_LCS_CELLS = 4_000_000;

/**
 * 行の差分を、一致する区間と変更の区間の並びで返す
 * @param {string[]} oldLines
 * @param {string[]} newLines
 * @returns {{type: 'equal' | 'change', oldStart: number, oldEnd: number, newStart: number, newEnd: number}[]}
 *   change は oldStart..oldEnd（削除された行）を newStart..newEnd（追加された行）に置き換えたことを表す
 */
export function diffLines(oldLines, newLines) {
  const o = oldLines.length;
  const n = newLines.length;
  let prefix = 0;
  while (prefix < o && prefix < n && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < o - prefix && suffix < n - prefix && oldLines[o - 1 - suffix] === newLines[n - 1 - suffix]) suffix++;

  // 中央部分の一致（[旧の行, 新の行] の組を昇順に）
  const pairs = [];
  const om = o - prefix - suffix;
  const nm = n - prefix - suffix;
  if (om > 0 && nm > 0 && om * nm <= MAX_LCS_CELLS) {
    // LCS の長さは min(om, nm) 以下（表の大きさの上限から 2000 以下）なので Uint16 に収まる
    const w = nm + 1;
    const dp = new Uint16Array((om + 1) * w);
    for (let a = om - 1; a >= 0; a--) {
      for (let b = nm - 1; b >= 0; b--) {
        dp[a * w + b] =
          oldLines[prefix + a] === newLines[prefix + b] ? dp[(a + 1) * w + b + 1] + 1 : Math.max(dp[(a + 1) * w + b], dp[a * w + b + 1]);
      }
    }
    let a = 0;
    let b = 0;
    while (a < om && b < nm) {
      if (oldLines[prefix + a] === newLines[prefix + b]) {
        pairs.push([prefix + a, prefix + b]);
        a++;
        b++;
      } else if (dp[(a + 1) * w + b] >= dp[a * w + b + 1]) a++;
      else b++;
    }
  }

  const ops = [];
  const push = (type, oldStart, oldEnd, newStart, newEnd) => {
    if (oldStart === oldEnd && newStart === newEnd) return;
    const last = ops.at(-1);
    if (last && last.type === type) {
      last.oldEnd = oldEnd;
      last.newEnd = newEnd;
    } else ops.push({ type, oldStart, oldEnd, newStart, newEnd });
  };
  push('equal', 0, prefix, 0, prefix);
  let oi = prefix;
  let ni = prefix;
  for (const [pa, pb] of pairs) {
    push('change', oi, pa, ni, pb);
    push('equal', pa, pa + 1, pb, pb + 1);
    oi = pa + 1;
    ni = pb + 1;
  }
  push('change', oi, o - suffix, ni, n - suffix);
  push('equal', o - suffix, o, n - suffix, n);
  return ops;
}

/**
 * エディタの行の目印（新しい行番号 → 種類）
 * - 'mod': 変更した行（元の行を置き換えた）
 * - 'add': 追加した行
 * - 'del': この行の直前で元の行が削除された（文書の末尾で削除されたときは最後の行に 'del-end'）
 * 変更した行の直前にも削除がある場合は 'mod' を優先する
 * @returns {Map<number, 'mod' | 'add' | 'del' | 'del-end'>}
 */
export function lineMarks(ops, newLineCount) {
  const marks = new Map();
  for (const op of ops) {
    if (op.type !== 'change') continue;
    const removed = op.oldEnd - op.oldStart;
    const added = op.newEnd - op.newStart;
    if (added === 0) {
      if (op.newStart < newLineCount) {
        if (!marks.has(op.newStart)) marks.set(op.newStart, 'del');
      } else if (newLineCount > 0 && !marks.has(newLineCount - 1)) marks.set(newLineCount - 1, 'del-end');
      continue;
    }
    for (let i = 0; i < added; i++) marks.set(op.newStart + i, i < removed ? 'mod' : 'add');
  }
  return marks;
}

/** 変更の区間がいくつあるか（変更点の数） */
export function countChanges(ops) {
  return ops.filter((op) => op.type === 'change').length;
}

// サロゲートペアの途中で切らないよう、位置を文字の境目へ寄せる
function isLowSurrogate(s, i) {
  const c = s.charCodeAt(i);
  return c >= 0xdc00 && c <= 0xdfff;
}

/**
 * 1 行の中で変わった部分（共通の先頭・末尾を除いた部分）
 * @returns {{start: number, oldEnd: number, newEnd: number}} 旧は start..oldEnd、新は start..newEnd が変わった部分
 */
export function intraline(oldText, newText) {
  let start = 0;
  const max = Math.min(oldText.length, newText.length);
  while (start < max && oldText[start] === newText[start]) start++;
  while (start > 0 && (isLowSurrogate(oldText, start) || isLowSurrogate(newText, start))) start--;
  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  while ((oldEnd < oldText.length && isLowSurrogate(oldText, oldEnd)) || (newEnd < newText.length && isLowSurrogate(newText, newEnd))) {
    oldEnd++;
    newEnd++;
  }
  return { start, oldEnd, newEnd };
}

/**
 * 変更点の確認画面に並べる「かたまり（前後の数行を含む変更のまとまり）」を作る
 * @param {number} context 変更の前後に見せる、変わっていない行の数
 * @returns {{rows: {kind: ' ' | '-' | '+', oldNo: number | null, newNo: number | null, text: string,
 *   mark?: [number, number]}[]}[]} oldNo / newNo は 1 始まりの行番号。mark は 1 行の中で変わった部分
 */
export function buildHunks(oldLines, newLines, ops, context = 2) {
  const hunks = [];
  let current = null;
  let lastEqualTail = null; // 直前の一致区間（次の変更の前の文脈に使う）
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.type === 'equal') {
      lastEqualTail = op;
      if (current) {
        // 変更の後の文脈。次の変更まで近ければ、同じかたまりにつなげる
        const len = op.oldEnd - op.oldStart;
        const next = ops[k + 1];
        const joinNext = next && len <= context * 2;
        const take = joinNext ? len : Math.min(context, len);
        for (let i = 0; i < take; i++) {
          current.rows.push({ kind: ' ', oldNo: op.oldStart + i + 1, newNo: op.newStart + i + 1, text: oldLines[op.oldStart + i] });
        }
        if (!joinNext) {
          hunks.push(current);
          current = null;
        }
      }
      continue;
    }
    if (!current) {
      current = { rows: [] };
      if (lastEqualTail) {
        const len = lastEqualTail.oldEnd - lastEqualTail.oldStart;
        for (let i = Math.max(0, len - context); i < len; i++) {
          current.rows.push({
            kind: ' ',
            oldNo: lastEqualTail.oldStart + i + 1,
            newNo: lastEqualTail.newStart + i + 1,
            text: oldLines[lastEqualTail.oldStart + i],
          });
        }
      }
    }
    // 削除した行と追加した行を、先頭から順に対にして 1 行の中の変わった部分を示す
    const removed = op.oldEnd - op.oldStart;
    const added = op.newEnd - op.newStart;
    const paired = Math.min(removed, added);
    const marks = [];
    for (let i = 0; i < paired; i++) marks.push(intraline(oldLines[op.oldStart + i], newLines[op.newStart + i]));
    for (let i = 0; i < removed; i++) {
      const m = marks[i];
      current.rows.push({ kind: '-', oldNo: op.oldStart + i + 1, newNo: null, text: oldLines[op.oldStart + i], ...(m ? { mark: [m.start, m.oldEnd] } : {}) });
    }
    for (let i = 0; i < added; i++) {
      const m = marks[i];
      current.rows.push({ kind: '+', oldNo: null, newNo: op.newStart + i + 1, text: newLines[op.newStart + i], ...(m ? { mark: [m.start, m.newEnd] } : {}) });
    }
  }
  if (current) hunks.push(current);
  return hunks;
}
