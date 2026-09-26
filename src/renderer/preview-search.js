// 表示モード（プレビュー）の検索
// DOM を書き換えずに CSS Custom Highlight API（::highlight）で色を付ける。
// プレビューの HTML（サニタイズ済み）に手を加えないので、表示内容やリンク等を壊さない。

// 検索対象にしない要素（テキストとして見えないもの）
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);

/**
 * プレビューの表示テキストを連結し、各テキストノードの開始位置を記録する
 * @param {Node} root
 * @returns {{text: string, nodes: Array<{node: Text, start: number}>}}
 */
export function buildTextIndex(root) {
  const doc = root.ownerDocument ?? root;
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */, {
    acceptNode(node) {
      for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
        if (SKIP.has(el.tagName)) return 2; // FILTER_REJECT
      }
      return 1; // FILTER_ACCEPT
    },
  });
  const nodes = [];
  let text = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push({ node, start: text.length });
    text += node.data;
  }
  return { text, nodes };
}

// 連結テキスト上の位置 → (テキストノード, ノード内の位置)
function locate(index, pos, preferNext) {
  const { nodes } = index;
  let lo = 0;
  let hi = nodes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (nodes[mid].start <= pos) lo = mid;
    else hi = mid - 1;
  }
  let i = lo;
  // ノードの末尾ちょうどの位置は、開始点なら次のノードの先頭として扱う
  if (preferNext) {
    while (i + 1 < nodes.length && pos - nodes[i].start >= nodes[i].node.data.length) i++;
  }
  return { node: nodes[i].node, offset: Math.min(pos - nodes[i].start, nodes[i].node.data.length) };
}

/**
 * 連結テキスト上の区間を Range にする（複数の要素にまたがってもよい）
 */
export function rangeFor(index, start, end) {
  if (index.nodes.length === 0) return null;
  const a = locate(index, start, true);
  const b = locate(index, end, false);
  const range = a.node.ownerDocument.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  return range;
}
