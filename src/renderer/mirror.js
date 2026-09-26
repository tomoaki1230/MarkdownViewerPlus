// エディタの「鏡」(pre) の中身を作る純粋ロジック
//
// 不変条件: mirror.textContent === textarea.value
//   1 文字でも崩れると、色分け・検索ハイライト・行の対応・左右スクロール同期がまとめて狂う。
//   そのため DOM は innerHTML ではなく textContent で組み立てる（HTML パーサーによる NUL 等の置換を避ける）。
//   目印（色分け・検索ヒット）を足すときは、文字を増減させず「区間を span で包むだけ」にすること。
//
// 構造: 1 行 = 1 つの箱  <span class="ed-line">…<span class="ed-nl">\n</span></span>
//   改行は display:none の .ed-nl に入れる（描画されないが textContent には残る）。

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}(?=\s|$)/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^(?: {0,3}>[ \t]?)+/;
const LIST = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(\[[ xX]\](?=[ \t]))?/;
const TABLE_ROW = /^\s*\|/;

// インライン記法（先に書いたものが同じ開始位置で優先される）
const INLINE = new RegExp(
  [
    '(?<esc>\\\\[\\\\`*_{}\\[\\]()#+\\-.!|~<>:])',
    '(?<code>(?<bt>`+)[^`]+?\\k<bt>)',
    '(?<comment><!--.*?-->)',
    '(?<autolink><(?:https?|mailto):[^>\\s]+>)',
    '(?<html></?[A-Za-z][A-Za-z0-9-]*(?:\\s[^<>]*)?/?>)',
    '(?<link>!?\\[[^\\]\\n]*\\]\\([^)\\n]*\\)|!?\\[[^\\]\\n]+\\]\\[[^\\]\\n]*\\])',
    '(?<url>https?://[^\\s<>()]+)',
    '(?<strong>(?<sd>\\*\\*|__)(?=\\S)[^\\n]*?\\S\\k<sd>)',
    '(?<del>~~(?=\\S)[^\\n]*?~~)',
    '(?<em>\\*(?=[^\\s*])[^*\\n]*?[^\\s*]\\*|\\*[^\\s*]\\*|(?<![\\p{L}\\p{N}_])_(?=\\S)[^_\\n]*?\\S_(?![\\p{L}\\p{N}_]))',
    '(?<emoji>:[a-z0-9_+-]+:)',
  ].join('|'),
  'giu',
);
const INLINE_GROUPS = ['esc', 'code', 'comment', 'autolink', 'html', 'link', 'url', 'strong', 'del', 'em', 'emoji'];

/**
 * 各行のブロック状態（フェンスコード内か等）を求める
 * @param {string[]} lines
 * @returns {string[]} 各行の行クラス（'' / 'ln-fence' / 'ln-code' / 'ln-h' / 'ln-hr'）
 */
export function computeLineClasses(lines) {
  const classes = new Array(lines.length);
  let fence = null; // { ch, len }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      const m = FENCE_OPEN.exec(line);
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && line.slice(m[0].length).trim() === '') {
        classes[i] = 'ln-fence';
        fence = null;
      } else {
        classes[i] = 'ln-code';
      }
      continue;
    }
    const m = FENCE_OPEN.exec(line);
    if (m && !(m[1][0] === '`' && line.slice(m[0].length).includes('`'))) {
      fence = { ch: m[1][0], len: m[1].length };
      classes[i] = 'ln-fence';
    } else if (HEADING.test(line)) {
      classes[i] = 'ln-h';
    } else if (HR.test(line)) {
      classes[i] = 'ln-hr';
    } else {
      classes[i] = '';
    }
  }
  return classes;
}

/**
 * 1 行の色分け区間（重なりなし・昇順）を求める
 * @param {string} line
 * @param {string} lineClass
 * @param {(name: string) => boolean} [isEmoji] 絵文字名として有効か
 * @returns {Array<{start: number, end: number, cls: string}>}
 */
export function tokenizeLine(line, lineClass, isEmoji = () => true) {
  if (lineClass === 'ln-code' || lineClass === 'ln-fence' || lineClass === 'ln-hr') return [];
  const tokens = [];
  let offset = 0;

  if (lineClass === 'ln-h') {
    const m = HEADING.exec(line);
    tokens.push({ start: 0, end: m[0].length, cls: 'tk-mark' });
    offset = m[0].length;
  } else {
    const q = QUOTE.exec(line);
    if (q) {
      tokens.push({ start: 0, end: q[0].length, cls: 'tk-quote' });
      offset = q[0].length;
    }
    const l = LIST.exec(line.slice(offset));
    if (l) {
      const markStart = offset + l[1].length;
      tokens.push({ start: markStart, end: markStart + l[2].length, cls: 'tk-list' });
      offset += l[1].length + l[2].length + l[3].length;
      if (l[4]) {
        tokens.push({ start: offset, end: offset + l[4].length, cls: 'tk-task' });
        offset += l[4].length;
      }
    } else if (TABLE_ROW.test(line)) {
      for (let i = line.indexOf('|'); i >= 0; i = line.indexOf('|', i + 1)) {
        if (line[i - 1] !== '\\') tokens.push({ start: i, end: i + 1, cls: 'tk-pipe' });
      }
      return tokens;
    }
  }

  INLINE.lastIndex = offset;
  let m;
  while ((m = INLINE.exec(line)) !== null) {
    if (m[0].length === 0) {
      INLINE.lastIndex++;
      continue;
    }
    const group = INLINE_GROUPS.find((g) => m.groups[g] !== undefined);
    if (group === 'emoji' && !isEmoji(m[0].slice(1, -1))) {
      // 未登録の :name: は色を付けず、後ろの ':' から探し直す
      INLINE.lastIndex = m.index + m[0].length - 1;
      continue;
    }
    tokens.push({ start: m.index, end: m.index + m[0].length, cls: `tk-${group}` });
  }
  return tokens;
}

/**
 * 1 行分の箱（DOM 要素）を作る
 * @param {Document} doc
 * @param {string} text 行の文字列（改行を含まない）
 * @param {string} lineClass
 * @param {Array<{start:number,end:number,cls:string}>} tokens 色分け区間
 * @param {Array<{start:number,end:number,current?:boolean}>} hits 行内の検索ヒット区間（行頭からの位置）
 * @param {boolean} withNewline 行末に改行を持つか（最終行以外 true）
 */
export function buildLineElement(doc, text, lineClass, tokens, hits, withNewline) {
  const el = doc.createElement('span');
  el.className = lineClass ? `ed-line ${lineClass}` : 'ed-line';

  const cuts = new Set([0, text.length]);
  for (const t of tokens) {
    cuts.add(t.start);
    cuts.add(t.end);
  }
  for (const h of hits) {
    cuts.add(Math.min(Math.max(h.start, 0), text.length));
    cuts.add(Math.min(Math.max(h.end, 0), text.length));
  }
  const points = [...cuts].sort((a, b) => a - b);
  let ti = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (a === b) continue;
    while (ti < tokens.length && tokens[ti].end <= a) ti++;
    const token = ti < tokens.length && tokens[ti].start <= a ? tokens[ti] : null;
    const hit = hits.find((h) => h.start <= a && h.end > a);
    const seg = text.slice(a, b);
    if (!token && !hit) {
      el.appendChild(doc.createTextNode(seg));
      continue;
    }
    const span = doc.createElement('span');
    const cls = [];
    if (token) cls.push(token.cls);
    if (hit) cls.push(hit.current ? 'hit hit-cur' : 'hit');
    span.className = cls.join(' ');
    span.textContent = seg;
    el.appendChild(span);
  }
  if (withNewline) {
    const nl = doc.createElement('span');
    nl.className = 'ed-nl';
    nl.textContent = '\n';
    el.appendChild(nl);
  }
  return el;
}

/**
 * 全体の検索ヒット（絶対位置）を行ごとの相対位置に振り分ける
 * @param {string[]} lines
 * @param {Array<{start:number,end:number}>} matches
 * @param {number} currentIndex
 * @returns {Map<number, Array<{start:number,end:number,current:boolean}>>}
 */
export function distributeHits(lines, matches, currentIndex) {
  const byLine = new Map();
  if (matches.length === 0) return byLine;
  let lineNo = 0;
  let lineStart = 0;
  for (let mi = 0; mi < matches.length; mi++) {
    const m = matches[mi];
    while (lineNo < lines.length - 1 && m.start > lineStart + lines[lineNo].length) {
      lineStart += lines[lineNo].length + 1;
      lineNo++;
    }
    // 複数行にまたがるヒットは行ごとに分割する
    let ln = lineNo;
    let ls = lineStart;
    while (ln < lines.length) {
      const lineEnd = ls + lines[ln].length;
      const start = Math.max(m.start, ls) - ls;
      const end = Math.min(m.end, lineEnd) - ls;
      if (end > start) {
        if (!byLine.has(ln)) byLine.set(ln, []);
        byLine.get(ln).push({ start, end, current: mi === currentIndex });
      }
      if (m.end <= lineEnd + 1) break;
      ls = lineEnd + 1;
      ln++;
    }
  }
  return byLine;
}
