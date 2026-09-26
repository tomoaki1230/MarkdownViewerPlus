// プレビューのリンク切れの検出
// ・#見出し: 同じ文書の中に、その id（または name）の要素があるか
// ・相対パス / file: のリンクと画像: そのファイル（フォルダ）が存在するか（main に問い合わせる）
// ・http(s) / mailto 等の外部のリンクは調べない（ネットワークに問い合わせない）

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * リンク先を分類する
 * @returns {{kind: 'anchor', id: string} | {kind: 'file', url: string} | null} 調べないものは null
 */
export function classifyTarget(href, baseUrl) {
  const h = (href ?? '').trim();
  if (!h) return null;
  if (h.startsWith('#')) {
    const id = safeDecode(h.slice(1));
    return id ? { kind: 'anchor', id } : null;
  }
  let url;
  try {
    url = new URL(h, baseUrl ?? undefined);
  } catch {
    return null;
  }
  if (url.protocol !== 'file:') return null;
  url.hash = '';
  url.search = '';
  return { kind: 'file', url: url.href };
}

/**
 * プレビューのリンク・画像を調べ、リンク切れの要素を返す
 * @param {ParentNode & {getElementById?: Function}} root プレビューの Shadow DOM
 * @param {{baseUrl: string | null, exists: (urls: string[]) => Promise<boolean[]>,
 *          hasAnchor: (id: string) => boolean}} opts
 * @returns {Promise<{el: Element, reason: string}[]>}
 */
export async function findBrokenLinks(root, { baseUrl, exists, hasAnchor }) {
  const items = [];
  for (const a of root.querySelectorAll('a[href]')) {
    const t = classifyTarget(a.getAttribute('href'), baseUrl);
    if (t) items.push({ el: a, target: t });
  }
  for (const img of root.querySelectorAll('img[src]')) {
    const t = classifyTarget(img.getAttribute('src'), baseUrl);
    if (t?.kind === 'file') items.push({ el: img, target: t });
  }
  const urls = [...new Set(items.filter((i) => i.target.kind === 'file').map((i) => i.target.url))];
  const found = urls.length > 0 ? await exists(urls) : [];
  const existsByUrl = new Map(urls.map((u, i) => [u, Boolean(found[i])]));
  const broken = [];
  for (const { el, target } of items) {
    if (target.kind === 'anchor') {
      if (!hasAnchor(target.id)) broken.push({ el, reason: `この文書に見出し「${target.id}」が見つかりません` });
    } else if (!existsByUrl.get(target.url)) {
      // Windows のドライブ名の前の / は外して見せる（/C:/x.md → C:/x.md）
      const shown = safeDecode(new URL(target.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
      broken.push({ el, reason: `ファイルが見つかりません: ${shown}` });
    }
  }
  return broken;
}
