// Markdown → サニタイズ済み HTML
// ・表示モードと編集中のプレビューは必ずこの経路を通す（サニタイズ漏れを作らない）
// ・トップレベルのブロック先頭タグに data-line（0 始まりのソース行）を付け、左右スクロール同期に使う
// ・巨大な段落（空行を挟まない大量の行・非常に長い行）は、見た目を保ったまま内部で小分けにする（splitParagraph）
// ・GitHub のアラート（> [!NOTE] など）と脚注（[^1]）に対応する（gfm-extras.js）
import { Marked } from 'marked';
import { emojiExtension, emojiMap } from './emoji.js';
import { alertExtension, createFootnoteState, FOOTNOTE_ID_PREFIX, footnoteExtension, footnotesHtml } from './gfm-extras.js';

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

// 巨大な段落の小分けの単位。Chromium は 1 つの段落の文字の配置に、文字数の 2 乗近い時間がかかる
// （空行の無い 3 万行の段落で、拡大縮小 1 回に数十秒）。塊ごとに display:block の span にすると速くなる
export const CHUNK_LINES = 100;
export const CHUNK_CHARS = 4000;

function countChar(s, ch) {
  let n = 0;
  for (let i = s.indexOf(ch); i >= 0; i = s.indexOf(ch, i + 1)) n++;
  return n;
}

/**
 * 段落のインライントークンを、行・文字数の上限ごとの塊に分ける（小さい段落は null = 分けない）。
 * 分ける位置は段落内の改行（ソフト改行・<br>）で、その改行は塊の境目（ブロックの切れ目）に置き換わる。
 * 強調・リンク等の途中では分けない。改行の無い長すぎる文字列だけは文字数で区切る
 * @returns {{tokens: object[], line: number}[] | null} line は段落先頭からの行数
 */
export function splitParagraph(tokens, raw) {
  if (raw.length <= CHUNK_CHARS * 2 && countChar(raw, '\n') <= CHUNK_LINES * 2) return null;
  const chunks = [];
  let cur = [];
  let chars = 0;
  let lines = 0;
  let line = 0; // 今の塊の先頭行
  let at = 0; // 処理済みの行数
  const full = () => lines >= CHUNK_LINES || chars >= CHUNK_CHARS;
  const flush = () => {
    if (cur.length > 0) chunks.push({ tokens: cur, line });
    cur = [];
    chars = 0;
    lines = 0;
    line = at;
  };
  const pushText = (text) => {
    if (text) cur.push({ type: 'text', raw: text, text, escaped: false });
    chars += text.length;
  };
  for (const t of tokens) {
    if (t.type === 'br') {
      at++;
      if (full()) flush();
      else {
        cur.push(t);
        lines++;
      }
    } else if (t.type === 'text' && !t.tokens && !t.escaped) {
      const parts = t.text.split('\n');
      parts.forEach((part, i) => {
        let p = part;
        // 改行の無い長すぎる文字列は文字数で区切る（サロゲートペアの途中では切らない）
        while (p.length > CHUNK_CHARS) {
          let cut = CHUNK_CHARS;
          const c = p.charCodeAt(cut - 1);
          if (c >= 0xd800 && c <= 0xdbff) cut--;
          pushText(p.slice(0, cut));
          flush();
          p = p.slice(cut);
        }
        if (i === parts.length - 1) {
          pushText(p);
          return;
        }
        at++;
        lines++;
        if (full()) {
          pushText(p);
          flush();
        } else pushText(`${p}\n`);
      });
    } else {
      cur.push(t);
      const r = t.raw ?? '';
      chars += r.length;
      const n = countChar(r, '\n');
      lines += n;
      at += n;
    }
  }
  flush();
  return chunks.length > 1 ? chunks : null;
}

/**
 * @param {{DOMPurify: object, map?: Map<string,string>}} deps DOMPurify はブラウザ/jsdom の window に結び付いたもの
 */
export function createMarkdownRenderer({ DOMPurify, map = emojiMap }) {
  let slug = createSlugger();
  let baseUrl = null;
  // 変換中のトップレベルのトークンとその行（段落の塊にも data-line を付けるため）
  let topToken = null;
  let topLine = 0;

  // 脚注の状態（変換のたびに作り直す）
  let footnotes = createFootnoteState();
  // アプリが作った脚注の要素の印（起動ごとの乱数。文書からは分からないので、文書中の HTML が脚注の id を名乗れない）
  const ownToken = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  const own = ` data-mvp-own="${ownToken}"`;

  const marked = new Marked({ gfm: true, breaks: false });
  marked.use(emojiExtension(map));
  marked.use(alertExtension(), footnoteExtension(() => footnotes, own));
  marked.use({
    renderer: {
      heading(token) {
        const inner = this.parser.parseInline(token.tokens);
        const id = slug(stripTags(inner));
        return `<h${token.depth} id="${id}">${inner}</h${token.depth}>\n`;
      },
      paragraph(token) {
        const chunks = splitParagraph(token.tokens, token.raw ?? '');
        if (!chunks) return `<p>${this.parser.parseInline(token.tokens)}</p>\n`;
        const top = token === topToken;
        const body = chunks
          .map((c, i) => `<span class="md-chunk"${top && i > 0 ? ` data-line="${topLine + c.line}"` : ''}>${this.parser.parseInline(c.tokens)}</span>`)
          .join('');
        return `<p>${body}</p>\n`;
      },
    },
  });

  // 脚注の id（mvp-fn…）は、印の付いた（アプリが作った）要素にだけ残す。印は表示には残さない
  DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    if (data.attrName === 'id' && data.attrValue.startsWith(FOOTNOTE_ID_PREFIX) && node.getAttribute?.('data-mvp-own') !== ownToken) {
      data.keepAttr = false;
    }
  });
  DOMPurify.addHook('afterSanitizeAttributes', (node) => node.removeAttribute?.('data-mvp-own'));

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
    footnotes = createFootnoteState();
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
      topToken = token;
      topLine = line;
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
    // 参照された脚注を文書の最後にまとめて出す（参照リンクの定義は本文と共通）
    html += footnotesHtml(footnotes, (list) => {
      const t = [...list];
      t.links = tokens.links;
      return marked.parser(t);
    }, own);
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

  /**
   * 目次用の見出しの一覧（トップレベルの見出しだけ。引用・リストの中の見出しは含めない）
   * 表示と同じ字句解析を使うので、コードブロックの中の # 等は見出しにならない。setext 形式（=== / ---）も含む
   * @returns {{level: number, text: string, line: number}[]} text は記法・タグを除いた文字、line は 0 始まりのソース行
   */
  function headings(src) {
    footnotes = createFootnoteState();
    const tokens = marked.lexer(src);
    const list = [];
    let pos = 0;
    let line = 0;
    for (const token of tokens) {
      const at = token.raw ? src.indexOf(token.raw, pos) : -1;
      if (at >= 0) {
        line += countNewlines(src, pos, at);
        pos = at;
      }
      if (token.type === 'heading') {
        const text = stripTags(marked.Parser.parseInline(token.tokens, { ...marked.defaults, renderer: marked.defaults.renderer })).trim();
        list.push({ level: token.depth, text: text || '（空の見出し）', line });
      }
      if (at >= 0) {
        line += countNewlines(src, pos, pos + token.raw.length);
        pos += token.raw.length;
      }
    }
    return list;
  }

  /** 改行だけでも改行して表示するか（行末の半角スペース 2 つが無くても <br> にする） */
  function setBreaks(breaks) {
    marked.setOptions({ breaks: Boolean(breaks) });
  }

  return { render, toHtml, setBreaks, headings };
}

function countNewlines(s, from, to) {
  let n = 0;
  for (let i = s.indexOf('\n', from); i >= 0 && i < to; i = s.indexOf('\n', i + 1)) n++;
  return n;
}
