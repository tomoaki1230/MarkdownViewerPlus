// GitHub の記法の拡張: アラート（> [!NOTE] など）と脚注（[^1]）
// marked の拡張として実装する（外部のライブラリは使わない）。出力は GitHub と同じ構造・クラス名にそろえる。

// ---------------------------------------------------------------------------
// アラート
// ---------------------------------------------------------------------------

/** アラートの種類と見出し（アイコンは自作の簡単な図形） */
export const ALERT_TYPES = {
  note: { label: '注記', icon: '<circle cx="8" cy="8" r="6.25"/><path d="M8 7.25v4M8 4.9v.1"/>' },
  tip: { label: 'ヒント', icon: '<path d="M5.5 10.5a4 4 0 1 1 5 0c-.6.5-.9 1-.9 1.7v.3H6.4v-.3c0-.7-.3-1.2-.9-1.7zM6.5 14.5h3"/>' },
  important: { label: '重要', icon: '<path d="M2 2.5h12v8.5H8l-3 3v-3H2z"/><path d="M8 4.75v3.5M8 9.4v.1"/>' },
  warning: { label: '警告', icon: '<path d="M8 1.75l6.5 12H1.5z"/><path d="M8 6.25v3.5M8 11.4v.1"/>' },
  caution: { label: '注意', icon: '<path d="M5.4 1.75h5.2l3.65 3.65v5.2l-3.65 3.65H5.4L1.75 10.6V5.4z"/><path d="M8 4.75v3.75M8 10.9v.1"/>' },
};

// 引用の 1 行目が [!NOTE] などだけの行。引用の行（> で始まる行）が続く所までをアラートとみなす
const ALERT_BLOCK = /^ {0,3}> ?\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)((?: {0,3}>[^\n]*(?:\n|$))*)/i;

function alertIcon(type) {
  return `<svg class="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${ALERT_TYPES[type].icon}</svg>`;
}

export function alertExtension() {
  return {
    extensions: [
      {
        name: 'alert',
        level: 'block',
        start(src) {
          const m = /^ {0,3}> ?\[!/m.exec(src);
          return m ? m.index : undefined;
        },
        tokenizer(src) {
          const m = ALERT_BLOCK.exec(src);
          if (!m) return undefined;
          // 各行の先頭の > と、その後の空白 1 つを取り除いた中身を、ブロックとして解釈する
          const body = m[2]
            .split('\n')
            .map((line) => line.replace(/^ {0,3}> ?/, ''))
            .join('\n');
          return { type: 'alert', raw: m[0], alert: m[1].toLowerCase(), tokens: this.lexer.blockTokens(body, []) };
        },
        renderer(token) {
          const { label } = ALERT_TYPES[token.alert];
          return (
            `<div class="markdown-alert markdown-alert-${token.alert}">` +
            `<p class="markdown-alert-title">${alertIcon(token.alert)}${label}</p>\n${this.parser.parse(token.tokens)}</div>\n`
          );
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 脚注
// ---------------------------------------------------------------------------

// 定義: [^名前]: 本文（続きの行は 2 つ以上の空白・タブで字下げ。途中の空行も可）
const FOOTNOTE_DEF = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]?([^\n]*(?:\n|$))((?:(?:[ \t]*\n)*(?: {2,}|\t)[^\n]*(?:\n|$))*)/;
const FOOTNOTE_REF = /^\[\^([^\]\s]+)\]/;

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

/**
 * 脚注の状態（1 回の変換ごとに作り直す）
 * - defs: 名前（小文字）→ 定義のトークン
 * - order: 参照された順の名前（番号はこの順で 1 から）
 * - refCounts: 名前 → 参照された回数（同じ脚注を何度も参照したときの戻りリンク用）
 */
export function createFootnoteState() {
  return { defs: new Map(), order: [], numbers: new Map(), refCounts: new Map() };
}

// 脚注の id は mvp-fn-番号 / mvp-fnref-番号。文書中の HTML が同じ id を付けても使えないよう、
// アプリが作った要素には own（秘密の印の属性）を付け、markdown.js のサニタイズで印の無い要素の mvp-fn の id を取り除く
export const FOOTNOTE_ID_PREFIX = 'mvp-fn';

/**
 * @param {() => ReturnType<typeof createFootnoteState>} getState 今の変換の状態
 * @param {string} own アプリが作った要素に付ける属性（例: ` data-mvp-own="…"`）
 */
export function footnoteExtension(getState, own = '') {
  return {
    extensions: [
      {
        name: 'footnoteDef',
        level: 'block',
        start(src) {
          const m = /^ {0,3}\[\^[^\]\s]+\]:/m.exec(src);
          return m ? m.index : undefined;
        },
        tokenizer(src) {
          const m = FOOTNOTE_DEF.exec(src);
          if (!m) return undefined;
          const rest = m[3].replace(/^(?: {2,4}|\t)/gm, '');
          const body = (m[2] + rest).replace(/\s+$/, '');
          const token = { type: 'footnoteDef', raw: m[0], label: m[1].toLowerCase(), tokens: this.lexer.blockTokens(body, []) };
          // 最初の定義を使う（同じ名前が 2 回あれば後のものは無視）
          const state = getState();
          if (!state.defs.has(token.label)) state.defs.set(token.label, token);
          return token;
        },
        // 定義はその場所には出さず、文書の最後にまとめて出す（footnotesHtml）
        renderer() {
          return '';
        },
      },
      {
        name: 'footnoteRef',
        level: 'inline',
        start(src) {
          const i = src.indexOf('[^');
          return i < 0 ? undefined : i;
        },
        tokenizer(src) {
          const m = FOOTNOTE_REF.exec(src);
          if (!m) return undefined;
          return { type: 'footnoteRef', raw: m[0], label: m[1].toLowerCase() };
        },
        renderer(token) {
          const state = getState();
          // 定義の無い参照は、書いたとおりの文字で出す（GitHub と同じ）
          if (!state.defs.has(token.label)) return escapeHtml(token.raw);
          let n = state.numbers.get(token.label);
          if (!n) {
            n = state.order.push(token.label);
            state.numbers.set(token.label, n);
          }
          const k = (state.refCounts.get(token.label) ?? 0) + 1;
          state.refCounts.set(token.label, k);
          const id = k === 1 ? `mvp-fnref-${n}` : `mvp-fnref-${n}-${k}`;
          return `<sup class="footnote-ref"><a href="#mvp-fn-${n}" id="${id}"${own} data-footnote-ref>${n}</a></sup>`;
        },
      },
    ],
  };
}

/**
 * 参照された脚注の一覧（文書の最後に置く）。参照が無ければ空文字
 * @param {(tokens: object[]) => string} parse ブロックのトークンを HTML にする
 * @param {string} own アプリが作った要素に付ける属性
 */
export function footnotesHtml(state, parse, own = '') {
  if (state.order.length === 0) return '';
  const items = [];
  // 脚注の中から別の脚注を参照すると order が伸びるので、長さを毎回見る
  for (let i = 0; i < state.order.length; i++) {
    const label = state.order[i];
    const n = i + 1;
    const count = state.refCounts.get(label) ?? 1;
    const backs = Array.from({ length: count }, (_, j) => {
      const target = j === 0 ? `mvp-fnref-${n}` : `mvp-fnref-${n}-${j + 1}`;
      return `<a href="#${target}" class="footnote-backref" data-footnote-backref aria-label="本文へ戻る">↩${j > 0 ? `<sup>${j + 1}</sup>` : ''}</a>`;
    }).join(' ');
    let body = parse(state.defs.get(label).tokens);
    // 戻りリンクは最後の段落の中に置く（段落が無ければ新しい段落）
    const last = body.lastIndexOf('</p>');
    body = last >= 0 && body.slice(last).trim() === '</p>' ? `${body.slice(0, last)} ${backs}</p>\n` : `${body}<p>${backs}</p>\n`;
    items.push(`<li id="mvp-fn-${n}"${own}>\n${body}</li>`);
  }
  return `<section class="footnotes" data-footnotes>\n<ol>\n${items.join('\n')}\n</ol>\n</section>\n`;
}
