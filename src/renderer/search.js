// エディタ内検索（純粋ロジック）。置換機能は持たない（誤記の修正は直接編集で行う）
// ヒットさせる上限（これを超える分は数えず、件数に + を付けて示す）
export const MAX_MATCHES = 9999;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 検索用の正規表現を作る
 * @returns {{re: RegExp|null, error: string|null}}
 */
export function buildPattern(query, { caseSensitive = false, regex = false, wholeWord = false } = {}) {
  if (!query) return { re: null, error: null };
  let source = regex ? query : escapeRegExp(query);
  if (wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
  try {
    return { re: new RegExp(source, `gu${caseSensitive ? '' : 'i'}`), error: null };
  } catch (err) {
    return { re: null, error: `正規表現が不正です: ${err.message}` };
  }
}

/**
 * @returns {{matches: Array<{start:number,end:number}>, error: string|null, truncated: boolean}}
 */
export function findMatches(text, query, options = {}) {
  const { re, error } = buildPattern(query, options);
  if (!re) return { matches: [], error, truncated: false };
  const matches = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      // 空文字に一致するパターン（^ や .* 等）は無限ループを避けて読み飛ばす
      re.lastIndex += text.codePointAt(re.lastIndex) > 0xffff ? 2 : 1;
      continue;
    }
    if (matches.length >= MAX_MATCHES) {
      // 上限を超えるヒットがあったときだけ「打ち切り」とする（ちょうど上限件数なら打ち切りではない）
      return { matches, error: null, truncated: true };
    }
    matches.push({ start: m.index, end: m.index + m[0].length });
  }
  return { matches, error: null, truncated: false };
}

/**
 * 位置 pos 以降で最初のヒットの番号（無ければ先頭へ折り返し）
 */
export function indexAtOrAfter(matches, pos) {
  if (matches.length === 0) return -1;
  let lo = 0;
  let hi = matches.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (matches[mid].start < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo < matches.length ? lo : 0;
}
