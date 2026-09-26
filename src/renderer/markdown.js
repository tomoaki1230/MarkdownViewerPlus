// Markdown → サニタイズ済み HTML
// ・表示モードと編集中のプレビューは必ずこの経路を通す（サニタイズ漏れを作らない）
// ・トップレベルのブロック先頭タグに data-line（0 始まりのソース行）を付け、左右スクロール同期に使う
import { Marked } from 'marked';
import { emojiExtension, emojiMap } from './emoji.js';

// GitHub 互換の見出し ID（同名はサフィックス -1, -2 … で区別）
function createSlugger() {
  const seen = new Map();
  return (text) => {
    const base =
      text
        .toLowerCase()
        .trim()
        .replace(/<[^>]*>/g, '')
        .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
        .replace(/\s/g, '-') || 'section';
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|#39);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);
}

// data-line を付けないトークン（生 HTML はネスト構造を壊さないためそのまま連結する）
const NO_LINE_TYPES = new Set(['html', 'space', 'def']);

/**
 * @param {{DOMPurify: object, map?: Map<string,string>}} deps DOMPurify はブラウザ/jsdom の window に結び付いたもの
 */
export function createMarkdownRenderer({ DOMPurify, map = emojiMap }) {
  let slug = createSlugger();
  let baseUrl = null;

  const marked = new Marked({ gfm: true, breaks: false });
  marked.use(emojiExtension(map));
  marked.use({
    renderer: {
      heading(token) {
        const inner = this.parser.parseInline(token.tokens);
        const id = slug(stripTags(inner));
        return `<h${token.depth} id="${id}">${inner}</h${token.depth}>\n`;
      },
    },
  });

  // 相対パスの画像はファイルのあるフォルダ基準で解決する（プレビューは Shadow DOM のため <base> が効かない）
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (!baseUrl) return;
    for (const attr of ['src', 'poster']) {
      const v = node.getAttribute?.(attr);
      if (v && !/^[a-z][a-z0-9+.-]*:/i.test(v) && !v.startsWith('//')) {
        try {
          node.setAttribute(attr, new URL(v, baseUrl).href);
        } catch {
          // 解決できない値はそのまま
        }
      }
    }
  });

  /**
   * Markdown をサニタイズ前の HTML にする（data-line 付き）
   */
  function toHtml(src) {
    slug = createSlugger();
    const tokens = marked.lexer(src);
    let html = '';
    let pos = 0;
    let line = 0;
    for (const token of tokens) {
      // ソース上の位置を raw で追跡し、行番号を求める
      const at = token.raw ? src.indexOf(token.raw, pos) : -1;
      if (at >= 0) {
        line += countNewlines(src, pos, at);
        pos = at;
      }
      const tokenList = [token];
      tokenList.links = tokens.links;
      let part = marked.parser(tokenList);
      if (!NO_LINE_TYPES.has(token.type)) {
        part = part.replace(/^(\s*<[a-zA-Z][a-zA-Z0-9-]*)/, `$1 data-line="${line}"`);
      }
      html += part;
      if (at >= 0) {
        line += countNewlines(src, pos, pos + token.raw.length);
        pos += token.raw.length;
      }
    }
    return html;
  }

  /**
   * Markdown → サニタイズ済み HTML
   * @param {string} src
   * @param {{baseUrl?: string}} [options]
   */
  function render(src, options = {}) {
    baseUrl = options.baseUrl ?? null;
    const dirty = toHtml(src);
    return DOMPurify.sanitize(dirty, {
      // 4章: Markdown 中の HTML を表示する。スクリプト・イベントハンドラ・javascript: は DOMPurify が除去する
      ADD_ATTR: ['open'],
      FORBID_TAGS: ['base', 'meta', 'link', 'iframe', 'frame', 'object', 'embed'],
      ALLOW_DATA_ATTR: true,
    });
  }

  /** 改行だけでも改行して表示するか（行末の半角スペース 2 つが無くても <br> にする） */
  function setBreaks(breaks) {
    marked.setOptions({ breaks: Boolean(breaks) });
  }

  return { render, toHtml, setBreaks };
}

function countNewlines(s, from, to) {
  let n = 0;
  for (let i = s.indexOf('\n', from); i >= 0 && i < to; i = s.indexOf('\n', i + 1)) n++;
  return n;
}
