// レンダラーのエントリポイント
import DOMPurify from 'dompurify';
import { createDiffDialog } from './diff-dialog.js';
import { MirrorEditor } from './editor.js';
import { emojiMap } from './emoji.js';
import { createGotoDialog } from './goto-dialog.js';
import { countChanges, diffLines, lineMarks } from './line-diff.js';
import { findBrokenLinks } from './link-check.js';
import { createTocPanel } from './toc-panel.js';
import { previewFontCss, previewLineHeight } from './preview-style.js';
import { createMarkdownRenderer } from './markdown.js';
import { buildTextIndex, rangeFor } from './preview-search.js';
import { findMatches, indexAtOrAfter } from './search.js';
import { createFontDialog } from './font-dialog.js';
import { createSettingsDialog } from './settings-dialog.js';
import { createShortcutsHelp } from './shortcuts-help.js';
import { createSyntaxHelp } from './syntax-help.js';
import { createThemePicker } from './theme-picker.js';
import { findTheme, themeCssVars } from '../shared/themes.js';

// 起動計測用の時刻（依存ライブラリの評価が終わり、アプリ本体の実行を始めた時刻）
const marks = { 'app.js 実行開始': Date.now() };
// ナビゲーション開始・バンドル取得完了の時刻（読み込みと評価にかかった時間を見るため）
try {
  marks['ナビゲーション開始'] = performance.timeOrigin;
  const bundle = performance.getEntriesByType('resource').find((e) => e.name.endsWith('app.bundle.js'));
  if (bundle) marks['app.bundle.js 取得完了'] = performance.timeOrigin + bundle.responseEnd;
} catch {
  // 計測できなくても動作に影響しない
}
const api = window.mvp;
const APP_NAME = 'MarkdownViewerPlus';
const MODE_LABELS = { view: '表示モード', edit: '編集モード', split: '2ペイン' };
const $ = (sel) => document.querySelector(sel);

const els = {
  body: document.body,
  btnSave: $('#btn-save'),
  btnSaveAs: $('#btn-save-as'),
  btnReload: $('#btn-reload'),
  btnAutoReload: $('#btn-auto-reload'),
  btnBreaks: $('#btn-breaks'),
  btnWidth: $('#btn-width'),
  btnMarks: $('#btn-marks'),
  btnToc: $('#btn-toc'),
  toc: $('#toc'),
  tocList: $('#toc-list'),
  tocClose: $('#toc-close'),
  modeButtons: [...document.querySelectorAll('[data-mode]')],
  tools: $('#tools'),
  banner: $('#banner'),
  bannerText: $('#banner-text'),
  bannerReload: $('#banner-reload'),
  bannerDiff: $('#banner-diff'),
  bannerClose: $('#banner-close'),
  workspace: $('#workspace'),
  editorPane: $('#editor-pane'),
  editorRoot: $('#editor'),
  textarea: $('#ed-input'),
  mirror: $('#ed-mirror'),
  splitter: $('#splitter'),
  previewPane: $('#preview-pane'),
  preview: $('#preview'),
  empty: $('#empty'),
  emptyOpen: $('#empty-open'),
  btnFind: $('#btn-find'),
  btnZoomIn: $('#btn-zoom-in'),
  btnZoomOut: $('#btn-zoom-out'),
  btnZoomReset: $('#btn-zoom-reset'),
  recent: $('#recent'),
  recentList: $('#recent-list'),
  recentClear: $('#recent-clear'),
  edRuler: $('#ed-ruler'),
  pvRuler: $('#pv-ruler'),
  search: $('#search'),
  searchInput: $('#search-input'),
  searchCount: $('#search-count'),
  searchCase: $('#search-case'),
  searchWord: $('#search-word'),
  searchRegex: $('#search-regex'),
  searchPrev: $('#search-prev'),
  searchNext: $('#search-next'),
  searchClose: $('#search-close'),
  stPath: $('#st-path'),
  stPos: $('#st-pos'),
  stEncoding: $('#st-encoding'),
  stEol: $('#st-eol'),
  stReadOnly: $('#st-readonly'),
  stDirty: $('#st-dirty'),
  stSearch: $('#st-search'),
  stChars: $('#st-chars'),
  stMode: $('#st-mode'),
  stMessage: $('#st-message'),
  stLinks: $('#st-links'),
  stExternal: $('#st-external'),
};

const state = {
  doc: null, // { path, name, baseUrl, encodingLabel, eolLabel, readOnly }
  mode: 'view',
  savedText: '',
  dirty: false,
  renderedText: null,
  previewTimer: null,
  anchors: null,
  scrollLock: { source: null, until: 0 },
  search: { open: false, matches: [], current: -1, error: null, truncated: false },
  saving: false,
  changeCount: 0, // 保存済みの内容からの変更の数（変更のまとまりの数）
  brokenLinks: [], // プレビューのリンク切れの要素
  brokenIndex: -1,
  // 外部での変更の通知（通知バナーを閉じても、ステータスバーの印から出し直せるように覚えておく）
  external: null, // { text, options, label }
};

// ---------------------------------------------------------------------------
// プレビュー（Shadow DOM に隔離: Markdown 中の <style> がアプリ UI に効かないようにする）
// ---------------------------------------------------------------------------

const md = createMarkdownRenderer({ DOMPurify });
const shadow = els.preview.attachShadow({ mode: 'open' });
shadow.innerHTML = '<link rel="stylesheet" href="preview.css"><article class="markdown-body"></article>';
const article = shadow.querySelector('article');

function renderPreview({ force = false } = {}) {
  clearTimeout(state.previewTimer);
  state.previewTimer = null;
  const text = editor.value;
  if (!force && text === state.renderedText) return;
  state.renderedText = text;
  const html = md.render(text, { baseUrl: state.doc?.baseUrl });
  marks['Markdown 変換・サニタイズ'] ??= Date.now();
  article.innerHTML = html;
  marks['プレビュー DOM 挿入'] ??= Date.now();
  state.anchors = null;
  highlightCode();
  onPreviewDomChanged();
  // 画像の読み込みで高さが変わるとアンカー位置も変わる
  for (const img of article.querySelectorAll('img')) {
    if (!img.complete) img.addEventListener('load', () => (state.anchors = null), { once: true });
  }
  scheduleLinkCheck();
}

function schedulePreview() {
  clearTimeout(state.previewTimer);
  state.previewTimer = setTimeout(() => {
    const top = els.preview.scrollTop;
    renderPreview();
    els.preview.scrollTop = top;
    if (state.mode === 'split') syncScroll('editor');
  }, 150);
}

// highlight.js は本文の描画を優先するため別バンドルにして後から読み込む
let hljsLoading = false;
function highlightCode() {
  if (window.hljs) {
    for (const code of article.querySelectorAll('pre code[class*="language-"]')) {
      const lang = /language-([\w+#-]+)/.exec(code.className)?.[1];
      if (lang && window.hljs.getLanguage(lang)) window.hljs.highlightElement(code);
    }
    return;
  }
  if (hljsLoading || !article.querySelector('pre code[class*="language-"]')) return;
  hljsLoading = true;
  const load = () => {
    const s = document.createElement('script');
    s.src = 'hljs.bundle.js';
    s.onload = () => {
      window.hljs.configure({ ignoreUnescapedHTML: true });
      highlightCode();
      state.anchors = null;
      onPreviewDomChanged();
    };
    document.head.appendChild(s);
  };
  (window.requestIdleCallback ?? setTimeout)(load);
}

// プレビュー内のリンク: 外部は既定ブラウザ、#見出しは内部スクロール、相対 .md は新しいウィンドウ
article.addEventListener('click', (e) => {
  if (e.target.closest('input[type="checkbox"]')) {
    e.preventDefault();
    return;
  }
  const a = e.target.closest('a[href]');
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute('href').trim();
  // 空のリンク（[文字]() など）は何もしない（文書のフォルダを開いてしまわないように）
  if (href === '') return;
  if (href.startsWith('#')) {
    const target = findAnchor(href.slice(1));
    if (target) els.preview.scrollTop += target.getBoundingClientRect().top - els.preview.getBoundingClientRect().top - 8;
    return;
  }
  let url;
  try {
    url = new URL(href, state.doc?.baseUrl ?? undefined);
  } catch {
    return;
  }
  // 他の文書の見出し（other.md#見出し）は、開いた後にその見出しへ移動する（# 以降も main へ渡す）
  if (url.protocol === 'file:') api.openLink(url.href);
  else api.openExternal(url.href);
});

/**
 * #の後ろの文字（URL エンコードされていてもよい）から、プレビューの移動先の要素を探す。
 * 「#100%」のような正しくないエンコードは、そのままの文字で探す（decodeURIComponent は例外を投げるため）
 */
function findAnchor(raw) {
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    // そのまま使う
  }
  if (!id) return null;
  return shadow.getElementById(id) ?? article.querySelector(`[name="${CSS.escape(id)}"]`);
}

// 他の文書のリンクから開いた（または前面に出した）文書で、指定の見出しへ移動する。
// 編集モードでもプレビューを作って、移動先の要素のソース行を求める
api.onGotoAnchor((raw) => {
  if (!state.doc) return;
  renderPreview();
  const line = Number(findAnchor(raw)?.closest('[data-line]')?.dataset.line);
  if (Number.isFinite(line)) gotoHeading(line);
});

// 表示の文字をダブルクリック →「ここを直す」: 表示モードなら 2 ペインに切り替え、編集側で同じ文字を選択する
// （ダブルクリックで選ばれた語を、そのブロックのソース行の範囲から探す。見つからなければブロックの先頭行へ）
article.addEventListener('dblclick', (e) => {
  if (!state.doc || e.target.closest('a[href], input, button, summary, select, textarea')) return;
  const block = e.target.closest('[data-line]');
  if (!block) return;
  const word = selectedWordIn(block);
  if (state.mode === 'view') setMode('split');
  revealSourceOf(block, word);
});

/** ダブルクリックで選ばれた語と、それがブロックの中で何番目に出てくるか */
function selectedWordIn(block) {
  const sel = shadow.getSelection?.() ?? document.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const text = sel.toString().trim();
  if (!text || text.length > 200 || text.includes('\n')) return null;
  const range = sel.getRangeAt(0);
  if (!block.contains(range.startContainer)) return null;
  const before = document.createRange();
  before.setStart(block, 0);
  before.setEnd(range.startContainer, range.startOffset);
  let nth = 0;
  const head = before.toString();
  for (let i = head.indexOf(text); i >= 0; i = head.indexOf(text, i + text.length)) nth++;
  return { text, nth };
}

/** ブロックに対応するソースの場所へキャレットを移し、選ばれた語があればそれを選択する */
function revealSourceOf(block, word) {
  const line = Number(block.dataset.line);
  const next = getAnchors().find((a) => a.line > line);
  const start = editor.offsetOfLine(line);
  const end = next ? editor.offsetOfLine(next.line) : editor.value.length;
  let selStart = start;
  let selEnd = start;
  if (word) {
    const src = editor.value.slice(start, end);
    const found = [];
    for (let i = src.indexOf(word.text); i >= 0; i = src.indexOf(word.text, i + word.text.length)) found.push(i);
    if (found.length > 0) {
      selStart = start + found[Math.min(word.nth, found.length - 1)];
      selEnd = selStart + word.text.length;
    }
  }
  // 編集側を動かしたことでプレビューが連動して動かないようにする（クリックした場所を見失わないように）
  state.scrollLock = { source: 'preview', until: performance.now() + 400 };
  els.textarea.focus({ preventScroll: true });
  els.textarea.setSelectionRange(selStart, selEnd);
  editor.revealRange(selStart);
  updateCaretStatus();
}

// ---------------------------------------------------------------------------
// リンク切れの検出（相対パスのファイル・画像が無い、#見出しが無い）。外部のリンクは調べない
// ---------------------------------------------------------------------------

let linkTimer = null;
let linkSeq = 0;
const fileExistsCache = new Map(); // URL → { ok, at }
const FILE_EXISTS_TTL = 2000;

async function filesExist(urls) {
  const now = Date.now();
  const ask = urls.filter((u) => !(fileExistsCache.get(u)?.at > now - FILE_EXISTS_TTL));
  if (ask.length > 0) {
    const result = await api.checkFiles(ask);
    ask.forEach((u, i) => fileExistsCache.set(u, { ok: Boolean(result?.[i]), at: now }));
  }
  return urls.map((u) => fileExistsCache.get(u)?.ok ?? true);
}

function scheduleLinkCheck() {
  clearTimeout(linkTimer);
  linkTimer = setTimeout(checkLinks, 250);
}

async function checkLinks() {
  if (!state.doc) return;
  const seq = ++linkSeq;
  const broken = await findBrokenLinks(shadow, {
    baseUrl: state.doc.baseUrl ?? null,
    exists: filesExist,
    hasAnchor: (id) => Boolean(shadow.getElementById(id) ?? article.querySelector(`[name="${CSS.escape(id)}"]`)),
  });
  // 調べている間に描き直されたら、新しい結果に任せる
  if (seq !== linkSeq) return;
  for (const e of article.querySelectorAll('.mvp-broken')) e.classList.remove('mvp-broken');
  for (const { el, reason } of broken) {
    el.classList.add('mvp-broken');
    el.title = reason;
  }
  state.brokenLinks = broken.map((b) => b.el);
  state.brokenIndex = -1;
  updateLinkStatus();
}

// ステータスバーの「リンク切れ N」（プレビューを出していないモードでは出さない）
function updateLinkStatus() {
  const n = state.doc && state.mode !== 'edit' ? state.brokenLinks.filter((e) => e.isConnected).length : 0;
  els.stLinks.hidden = n === 0;
  els.stLinks.textContent = n > 0 ? `リンク切れ ${n}` : '';
}

// 次のリンク切れへ（プレビューをスクロールして一瞬強調する）
function nextBrokenLink() {
  const list = state.brokenLinks.filter((e) => e.isConnected);
  if (list.length === 0 || state.mode === 'edit') return;
  state.brokenIndex = (state.brokenIndex + 1) % list.length;
  const target = list[state.brokenIndex];
  els.preview.scrollTop += target.getBoundingClientRect().top - els.preview.getBoundingClientRect().top - 60;
  flash(target);
}

function flash(node) {
  node.classList.remove('mvp-flash');
  void node.offsetWidth;
  node.classList.add('mvp-flash');
  setTimeout(() => node.classList.remove('mvp-flash'), 1300);
}

// ---------------------------------------------------------------------------
// 目次（見出しの一覧）: ツールバーの目次ボタン / Ctrl+Shift+O で開閉。開閉の状態はウィンドウ間で共有して覚える
// ---------------------------------------------------------------------------

const tocPanel = createTocPanel({ panel: els.toc, list: els.tocList, onSelect: gotoHeading });
let tocTimer = null;
let tocCurrentTimer = null;

function readTocOpen() {
  try {
    return localStorage.getItem('mvp.toc') === '1';
  } catch {
    return false;
  }
}

// 狭いウィンドウでは、目次を本文の横に並べず本文の上に重ねて出す（本文・2 ペインの幅を削らない）。
// 重ねて出した目次の開閉は覚えない。広くなったら、覚えている開閉の状態に戻す
const TOC_OVERLAY_WIDTH = { split: 900, other: 640 };

function tocIsOverlay() {
  return els.body.classList.contains('toc-overlay');
}

function updateTocLayout() {
  const limit = state.mode === 'split' ? TOC_OVERLAY_WIDTH.split : TOC_OVERLAY_WIDTH.other;
  const narrow = window.innerWidth < limit;
  if (narrow === tocIsOverlay()) return;
  els.body.classList.toggle('toc-overlay', narrow);
  setTocOpen(narrow ? false : readTocOpen(), { save: false });
}

function setTocOpen(open, { save = true } = {}) {
  if (tocIsOverlay()) save = false;
  // 本文の幅が変わって折り返しが変わっても、読んでいる位置（ソース行）を保つ
  const line = state.doc ? (state.mode === 'view' ? previewTopLine() : editor.topLine()) : null;
  els.toc.hidden = !open;
  els.btnToc.setAttribute('aria-pressed', String(open));
  els.btnToc.title = `目次: ${open ? '表示中' : '非表示'} (Ctrl+Shift+O)`;
  if (save) {
    try {
      localStorage.setItem('mvp.toc', open ? '1' : '0');
    } catch {
      // 保存できなくても動作に影響しない
    }
  }
  // 本文の幅が変わるので、プレビューの位置の対応を取り直す
  state.anchors = null;
  if (line !== null) {
    if (state.mode === 'view') scrollPreviewToLine(line);
    else {
      editor.scrollToLine(line);
      if (state.mode === 'split') syncScroll('editor');
    }
  }
  if (open) updateToc();
}

function toggleToc() {
  if (!state.doc) return;
  setTocOpen(els.toc.hidden);
}

/** 見出しの一覧を作り直す（閉じているときは作らない） */
function updateToc() {
  clearTimeout(tocTimer);
  tocTimer = null;
  if (!state.doc || els.toc.hidden) return;
  tocPanel.setHeadings(md.headings(editor.value));
  updateTocCurrent();
}

// 入力のたびに作り直すと重いので間引く
function scheduleToc() {
  if (els.toc.hidden) return;
  clearTimeout(tocTimer);
  tocTimer = setTimeout(updateToc, 300);
}

/** 今読んでいる位置の見出しを強調する（表示・2 ペインはプレビュー、編集モードは編集側の表示先頭の行） */
function updateTocCurrent() {
  if (!state.doc || els.toc.hidden) return;
  const line = state.mode === 'edit' ? editor.topLine() : previewTopLine();
  // 見出しが表示の先頭より少し下にあっても、その見出しの節を読んでいるとみなす
  tocPanel.setCurrentLine(Math.floor(line + 0.5));
}

function scheduleTocCurrent() {
  if (els.toc.hidden || tocCurrentTimer) return;
  tocCurrentTimer = setTimeout(() => {
    tocCurrentTimer = null;
    updateTocCurrent();
  }, 60);
}

/** 目次の見出しをクリック: その見出しを表示の先頭にする（編集側はキャレットも見出しの行へ） */
function gotoHeading(line) {
  if (state.mode === 'view') {
    scrollPreviewToLine(line);
  } else {
    const pos = editor.offsetOfLine(line);
    els.textarea.focus({ preventScroll: true });
    els.textarea.setSelectionRange(pos, pos);
    editor.scrollToLine(line);
    if (state.mode === 'split') {
      state.scrollLock = { source: null, until: 0 };
      scrollPreviewToLine(line);
    }
    updateCaretStatus();
  }
  // クリックした見出しを強調する（文書が短くてスクロールできず、表示の先頭が変わらないときも）
  clearTimeout(tocCurrentTimer);
  tocCurrentTimer = null;
  tocPanel.setCurrentLine(line);
  // 重ねて出しているときは、移動したら閉じて本文を見せる
  if (tocIsOverlay()) setTocOpen(false);
}

els.btnToc.addEventListener('click', toggleToc);
els.tocClose.addEventListener('click', () => setTocOpen(false));
// 他のウィンドウで開閉したら合わせる
window.addEventListener('storage', (e) => {
  if (e.key === 'mvp.toc' && !tocIsOverlay()) setTocOpen(e.newValue === '1', { save: false });
});
// 重ねて出した目次は、目次の外をクリックしたら閉じる
document.addEventListener('pointerdown', (e) => {
  if (!tocIsOverlay() || els.toc.hidden) return;
  if (els.toc.contains(e.target) || els.btnToc.contains(e.target)) return;
  setTocOpen(false);
});
window.addEventListener('resize', updateTocLayout);
setTocOpen(readTocOpen(), { save: false });
updateTocLayout();

// ---------------------------------------------------------------------------
// ステータスバー: 狭くて項目が収まらないときは、優先度の低い項目から隠す
// （未保存・リンク切れ・外部で変更あり・読み取り専用の知らせは隠さない）
// ---------------------------------------------------------------------------

const statusBar = document.querySelector('#status');
// 隠す順（先頭ほど優先度が低い）
const STATUS_DROP_ORDER = ['#st-chars', '#st-mode', '#st-search', '#st-eol', '#st-encoding', '#st-pos'].map((q) =>
  document.querySelector(q),
);
// ファイルのパスは省略されて縮むので、ここまで縮んだら他の項目を隠す
const STATUS_PATH_MIN = 80;
let statusFitFrame = 0;

function statusOverflows() {
  if (statusBar.scrollWidth > statusBar.clientWidth + 1) return true;
  return els.stPath.textContent !== '' && els.stPath.clientWidth < STATUS_PATH_MIN;
}

function fitStatus() {
  statusFitFrame = 0;
  for (const el of STATUS_DROP_ORDER) el.classList.remove('st-squeezed');
  for (const el of STATUS_DROP_ORDER) {
    if (!statusOverflows()) break;
    el.classList.add('st-squeezed');
  }
}

// 変更が続いても 1 回にまとめて測る（requestAnimationFrame は隠れたウィンドウで止まるので setTimeout）
function scheduleFitStatus() {
  if (!statusFitFrame) statusFitFrame = setTimeout(fitStatus, 0);
}

window.addEventListener('resize', scheduleFitStatus);
// 項目の文字や表示・非表示が変わったら測り直す（自分で付ける st-squeezed の変化は見ない）
new MutationObserver(scheduleFitStatus).observe(statusBar, {
  subtree: true,
  childList: true,
  characterData: true,
  attributes: true,
  attributeFilter: ['hidden'],
});

// 他のソフトでファイルを作った・消したかもしれないので、ウィンドウに戻ったら調べ直す
window.addEventListener('focus', () => {
  if (state.doc && state.mode !== 'edit') scheduleLinkCheck();
});

// ---------------------------------------------------------------------------
// エディタ
// ---------------------------------------------------------------------------

const editor = new MirrorEditor({
  textarea: els.textarea,
  mirror: els.mirror,
  root: els.editorRoot,
  isEmoji: (name) => emojiMap.has(name),
  onInput: onEditorInput,
  onScroll: () => {
    if (state.mode === 'split') syncScroll('editor');
    if (state.mode === 'edit') scheduleTocCurrent();
  },
});
window.__mvpEditor = editor;
// E2E テストが内部状態を確認するために参照する
window.__mvpState = state;
// main から終了確認時に本文を取り出すため
window.__mvpGetText = () => editor.value;

function onEditorInput() {
  updateDirty();
  scheduleToc();
  if (state.search.open) runSearch({ keepPosition: true });
  if (state.mode === 'split') schedulePreview();
  else state.renderedText = null;
  updateCaretStatus();
}

function updateDirty() {
  const dirty = state.doc !== null && editor.value !== state.savedText;
  if (dirty !== state.dirty) {
    state.dirty = dirty;
    notifyUiState();
  }
  updateTitle();
  els.btnSave.disabled = !dirty;
  els.stDirty.hidden = !dirty;
  scheduleCharCount();
  scheduleChangeMarks();
}

// ---------------------------------------------------------------------------
// 変更箇所の目印（保存済みの内容との差分を、エディタの行番号の横に出す）
// ---------------------------------------------------------------------------

let marksTimer = null;
const savedLinesCache = { text: null, lines: [] };
function savedLines() {
  if (savedLinesCache.text !== state.savedText) {
    savedLinesCache.text = state.savedText;
    savedLinesCache.lines = state.savedText.split('\n');
  }
  return savedLinesCache.lines;
}

function updateChangeMarks() {
  clearTimeout(marksTimer);
  marksTimer = null;
  if (!state.doc || !state.dirty) {
    editor.setLineMarks(new Map());
    state.changeCount = 0;
  } else {
    const lines = editor.value.split('\n');
    const ops = diffLines(savedLines(), lines);
    // 「変更した行に印」をオフにしているときは印を出さない（変更の数は数える）
    editor.setLineMarks(appSettings.changeMarks ? lineMarks(ops, lines.length) : new Map());
    state.changeCount = countChanges(ops);
  }
  els.stDirty.textContent = state.changeCount > 0 ? `● 未保存（変更 ${state.changeCount} か所）` : '● 未保存';
}

// 入力のたびに計算すると大きな文書で重くなるので、少し間引く（保存・読み直しで変更が無くなったときはすぐ消す）
function scheduleChangeMarks() {
  if (!state.dirty) {
    updateChangeMarks();
    return;
  }
  clearTimeout(marksTimer);
  marksTimer = setTimeout(updateChangeMarks, 120);
}

// main へ未保存・モードを伝える（閉じる確認とメニューの有効/無効に使う）
function notifyUiState() {
  api.setUiState({ dirty: state.dirty, mode: state.mode });
}

// 文字数（サロゲートペアは 1 文字、改行は数えない）。入力のたびに数えると重いので間引く
let charTimer = null;
function scheduleCharCount() {
  clearTimeout(charTimer);
  charTimer = setTimeout(() => {
    if (!state.doc) {
      els.stChars.textContent = '';
      return;
    }
    const v = editor.value;
    let n = 0;
    for (let i = 0; i < v.length; i++) {
      const c = v.charCodeAt(i);
      if (c === 0x0a || (c >= 0xdc00 && c <= 0xdfff)) continue;
      n++;
    }
    els.stChars.textContent = `${n.toLocaleString()} 文字`;
  }, 200);
}

function updateTitle() {
  document.title = state.doc ? `${state.dirty ? '● ' : ''}${state.doc.name} - ${APP_NAME}` : APP_NAME;
}

function updateCaretStatus() {
  if (!state.doc || state.mode === 'view') {
    els.stPos.textContent = '';
    return;
  }
  const { line, col, selected } = editor.caretPosition();
  els.stPos.textContent = `${line}行 ${col}列${selected ? `（${selected}文字選択）` : ''}`;
}
for (const ev of ['keyup', 'mouseup', 'focus']) els.textarea.addEventListener(ev, updateCaretStatus);
document.addEventListener('selectionchange', () => {
  if (document.activeElement === els.textarea) updateCaretStatus();
});

// スクロールバーの上では通常の矢印カーソルにする（見た目を変えたスクロールバーでは、Chromium が
// 入力欄の I 字カーソルをそのまま出してしまうため）。ドラッグ中は押した時点のカーソルが続く
els.textarea.addEventListener('mousemove', (e) => {
  const onScrollbar = e.offsetX >= els.textarea.clientWidth;
  const cursor = onScrollbar ? 'default' : '';
  if (els.textarea.style.cursor !== cursor) els.textarea.style.cursor = cursor;
});
els.textarea.addEventListener('mouseleave', () => (els.textarea.style.cursor = ''));

// Tab はフォーカス移動ではなくタブ文字の入力にする
els.textarea.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    document.execCommand('insertText', false, '\t');
  }
});

// ---------------------------------------------------------------------------
// 表示モード（表示 / 編集 / 2 ペイン）
// ---------------------------------------------------------------------------

function setMode(mode, { keepScroll = true } = {}) {
  if (!state.doc) return;
  const prev = state.mode;
  // 切り替え前の表示位置（ソース行）を覚えておく
  let line = null;
  if (keepScroll) {
    if (prev === 'view') line = previewTopLine();
    else line = editor.topLine();
  }

  state.mode = mode;
  els.body.dataset.mode = mode;
  els.stMode.textContent = MODE_LABELS[mode];
  notifyUiState();
  for (const b of els.modeButtons) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  updatePreviewOnlyButtons(mode);
  updateLinkStatus();
  updateTocLayout();
  scheduleTocCurrent();

  if (mode !== 'edit') renderPreview();
  state.anchors = null;
  // 表示モードではエディタの鏡を更新しない（大きい文書で起動・表示が遅くなるため）。編集側を出すときに作る
  editor.setSuspended(mode === 'view');

  if (line !== null) {
    if (mode === 'view') scrollPreviewToLine(line);
    else {
      editor.scrollToLine(line);
      if (mode === 'split') syncScroll('editor');
    }
  }
  if (state.search.open) {
    // 対象（プレビュー / 編集側）が変わるので検索し直す。フォーカスは検索欄に残す
    runSearch({ keepPosition: false });
    els.searchInput.focus({ preventScroll: true });
  } else if (mode !== 'view' && prev === 'view') els.textarea.focus({ preventScroll: true });
  updateCaretStatus();
}

for (const b of els.modeButtons) b.addEventListener('click', () => setMode(b.dataset.mode));

// ---------------------------------------------------------------------------
// スクロール同期（ソース行 ⇔ プレビューの data-line 要素）
// ---------------------------------------------------------------------------

function getAnchors() {
  if (state.anchors) return state.anchors;
  const hostTop = els.preview.getBoundingClientRect().top - els.preview.scrollTop;
  const list = [];
  for (const el of article.querySelectorAll('[data-line]')) {
    const line = Number(el.dataset.line);
    const top = el.getBoundingClientRect().top - hostTop;
    // 行・位置とも単調増加のものだけ使う
    if (list.length === 0 || (line > list.at(-1).line && top >= list.at(-1).top)) list.push({ line, top });
  }
  state.anchors = list;
  return list;
}

// 最後にプログラムで合わせた表示位置（行）。利用者がスクロールしていなければ（scrollTop が同じなら）、
// 位置を測り直さずにこの行を使う。scrollTop は整数に丸められるので、「測る → 描き直す → 合わせる」を
// 繰り返すと 1px ずつずれていく（改行で折り返すの切り替え・拡大縮小の連打で表示が少しずつ上へ詰まる）ため
let previewLineMemo = null;

function scrollPreviewToLine(line) {
  const anchors = getAnchors();
  const pv = els.preview;
  if (anchors.length === 0) {
    pv.scrollTop = 0;
    previewLineMemo = null;
    return;
  }
  const totalLines = Math.max(editor.lineCount(), 1);
  const pts = [{ line: 0, top: 0 }, ...anchors.filter((a) => a.line > 0), { line: totalLines, top: pv.scrollHeight }];
  let i = 0;
  while (i < pts.length - 2 && pts[i + 1].line <= line) i++;
  const a = pts[i];
  const b = pts[i + 1];
  const ratio = b.line === a.line ? 0 : (line - a.line) / (b.line - a.line);
  pv.scrollTop = Math.max(0, a.top + ratio * (b.top - a.top) - 8);
  previewLineMemo = { scrollTop: pv.scrollTop, line };
}

function previewTopLine() {
  const pv = els.preview;
  if (previewLineMemo && previewLineMemo.scrollTop === pv.scrollTop) return previewLineMemo.line;
  previewLineMemo = null;
  const anchors = getAnchors();
  const y = pv.scrollTop + 8;
  if (anchors.length === 0) return 0;
  const totalLines = Math.max(editor.lineCount(), 1);
  const pts = [{ line: 0, top: 0 }, ...anchors.filter((a) => a.line > 0), { line: totalLines, top: pv.scrollHeight }];
  let i = 0;
  while (i < pts.length - 2 && pts[i + 1].top <= y) i++;
  const a = pts[i];
  const b = pts[i + 1];
  const ratio = b.top === a.top ? 0 : (y - a.top) / (b.top - a.top);
  return a.line + Math.max(0, Math.min(1, ratio)) * (b.line - a.line);
}

// 片側をスクロールするともう片側がスクロールイベントを返すので、短時間は逆方向を無視する
function syncScroll(source) {
  const now = performance.now();
  if (state.scrollLock.source && state.scrollLock.source !== source && now < state.scrollLock.until) return;
  state.scrollLock = { source, until: now + 120 };
  const ta = els.textarea;
  if (source === 'editor') {
    // 端に着いたら相手も端へ（行対応の誤差で届かないのを防ぐ）
    if (ta.scrollTop + ta.clientHeight >= ta.scrollHeight - 2) els.preview.scrollTop = els.preview.scrollHeight;
    else scrollPreviewToLine(editor.topLine());
  } else {
    const pv = els.preview;
    if (pv.scrollTop + pv.clientHeight >= pv.scrollHeight - 2) {
      ta.scrollTop = ta.scrollHeight;
      editor.syncMirrorScroll();
    } else editor.scrollToLine(previewTopLine());
  }
}
els.preview.addEventListener('scroll', () => {
  if (state.mode === 'split') syncScroll('preview');
  if (state.mode !== 'edit') scheduleTocCurrent();
});
new ResizeObserver(() => {
  state.anchors = null;
  // 折り返しが変わるとヒット位置の割合も変わる
  if (state.search.open) updateHitRulers();
}).observe(els.preview);
new ResizeObserver(() => {
  if (state.search.open && searchTarget() === 'editor') updateHitRulers();
}).observe(els.editorRoot);

// 2 ペインの区切り: ドラッグで幅を変更、ダブルクリックで中央（50:50）に戻す
function setSplit(value) {
  els.workspace.style.setProperty('--split', value);
  state.anchors = null;
  try {
    localStorage.setItem('mvp.split', value);
  } catch {
    // 保存できなくても動作に影響しない
  }
}
els.splitter.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  els.splitter.setPointerCapture(e.pointerId);
  els.splitter.classList.add('dragging');
  const rect = els.workspace.getBoundingClientRect();
  // 編集側は検索バーが見切れない幅（CSS の --editor-min）より狭くしない
  const editorMin = parseFloat(getComputedStyle(els.workspace).getPropertyValue('--editor-min')) || 0;
  const minRatio = Math.max(0.2, (editorMin + 3.5) / rect.width);
  const move = (ev) => {
    const ratio = Math.min(0.8, Math.max(minRatio, (ev.clientX - rect.left) / rect.width));
    els.workspace.style.setProperty('--split', `${(ratio * 100).toFixed(2)}%`);
  };
  const up = () => {
    els.splitter.removeEventListener('pointermove', move);
    els.splitter.removeEventListener('pointerup', up);
    els.splitter.removeEventListener('pointercancel', up);
    els.splitter.classList.remove('dragging');
    setSplit(els.workspace.style.getPropertyValue('--split'));
  };
  els.splitter.addEventListener('pointermove', move);
  els.splitter.addEventListener('pointerup', up);
  els.splitter.addEventListener('pointercancel', up);
});
els.splitter.addEventListener('dblclick', () => {
  setSplit('50%');
  if (state.mode === 'split') requestAnimationFrame(() => syncScroll('editor'));
});
// 保存しておいた比率は、ドラッグで取り得る範囲（20〜80%）の「数値%」のときだけ使う
// （壊れた値をそのまま CSS に入れると 2 ペインの列の指定が無効になり、編集側が幅 0 になるため）
try {
  const split = localStorage.getItem('mvp.split');
  const m = /^(\d+(?:\.\d+)?)%$/.exec(split ?? '');
  if (m && Number(m[1]) >= 20 && Number(m[1]) <= 80) els.workspace.style.setProperty('--split', split);
} catch {
  // 無視
}

// ---------------------------------------------------------------------------
// 検索（入力のたびに即時検索）
//   表示モード          … プレビューの表示テキストが対象（CSS Custom Highlight API で色付け）
//   編集モード / 2 ペイン … 編集側（鏡の .hit で色付け）
// ---------------------------------------------------------------------------

const hasHighlightApi = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

function searchTarget() {
  return state.mode === 'view' ? 'preview' : 'editor';
}

// プレビューのテキスト索引（再描画・コード色付けで DOM が変わったら作り直す）
function previewIndex() {
  if (!state.previewIndex) state.previewIndex = buildTextIndex(article);
  return state.previewIndex;
}

function paintPreviewHits() {
  if (!hasHighlightApi) return;
  const s = state.search;
  const all = new Highlight();
  const cur = new Highlight();
  if (s.open && searchTarget() === 'preview') {
    const index = previewIndex();
    s.matches.forEach((m, i) => {
      const range = rangeFor(index, m.start, m.end);
      if (range) (i === s.current ? cur : all).add(range);
    });
  }
  CSS.highlights.set('mvp-hit', all);
  CSS.highlights.set('mvp-hit-cur', cur);
}

function clearPreviewHits() {
  if (!hasHighlightApi) return;
  CSS.highlights.delete('mvp-hit');
  CSS.highlights.delete('mvp-hit-cur');
}

function matchRect(m) {
  return rangeFor(previewIndex(), m.start, m.end)?.getBoundingClientRect() ?? null;
}

// ヒットがプレビューの見える範囲に無ければ、画面の 1/3 付近へスクロールする
function revealPreviewMatch(m) {
  const rect = matchRect(m);
  if (!rect) return;
  const pv = els.preview;
  const box = pv.getBoundingClientRect();
  if (rect.top < box.top || rect.bottom > box.bottom) pv.scrollTop += rect.top - box.top - pv.clientHeight / 3;
}

// プレビューで表示中の位置以降にある最初のヒット（位置は文書順に増えるので二分探索）
function firstVisiblePreviewMatch(matches) {
  const top = els.preview.getBoundingClientRect().top;
  let lo = 0;
  let hi = matches.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const rect = matchRect(matches[mid]);
    if (rect && rect.bottom < top) lo = mid + 1;
    else hi = mid;
  }
  return lo < matches.length ? lo : 0;
}

// ---- スクロールバー上のヒット位置のマーク（概要ルーラー） ----

const MAX_RULER_MARKS = 2000;

/**
 * @param {HTMLElement} ruler
 * @param {Array<number>} fractions 文書全体に対する位置（0〜1）
 * @param {number} current 現在のヒットの位置（無ければ -1）
 */
function drawRuler(ruler, fractions, current) {
  ruler.replaceChildren();
  ruler.hidden = fractions.length === 0;
  const seen = new Set();
  for (const f of fractions) {
    // 同じ高さに重なるマークは 1 つにまとめる
    const key = Math.round(f * 500);
    if (seen.has(key)) continue;
    seen.add(key);
    const mark = document.createElement('i');
    mark.style.top = `${(f * 100).toFixed(3)}%`;
    ruler.append(mark);
  }
  if (current >= 0) {
    const mark = document.createElement('i');
    mark.className = 'cur';
    mark.style.top = `${(current * 100).toFixed(3)}%`;
    ruler.append(mark);
  }
}

function updateHitRulers() {
  const s = state.search;
  const active = s.open && s.matches.length > 0;
  const target = searchTarget();
  if (!active || target !== 'editor') drawRuler(els.edRuler, [], -1);
  if (!active || target !== 'preview') drawRuler(els.pvRuler, [], -1);
  if (!active) return;

  const matches = s.matches.slice(0, MAX_RULER_MARKS);
  if (target === 'editor') {
    // ヒット位置の行番号を 1 回の走査で求め、行の箱の位置から割合を出す
    const v = editor.value;
    const total = els.mirror.scrollHeight || 1;
    let line = 0;
    let pos = 0;
    const lineOf = (offset) => {
      for (let nl = v.indexOf('\n', pos); nl >= 0 && nl < offset; nl = v.indexOf('\n', pos)) {
        line++;
        pos = nl + 1;
      }
      return line;
    };
    const fractions = matches.map((m) => editor.lineTop(lineOf(m.start)) / total);
    const cur = s.matches[s.current];
    const curFraction = cur ? editor.lineTop(editor.lineOfOffset(cur.start)) / total : -1;
    drawRuler(els.edRuler, fractions, curFraction);
  } else {
    const pv = els.preview;
    const base = pv.getBoundingClientRect().top - pv.scrollTop;
    const total = pv.scrollHeight || 1;
    const toFraction = (m) => {
      const rect = matchRect(m);
      return rect ? (rect.top - base) / total : -1;
    };
    const fractions = matches.map(toFraction).filter((f) => f >= 0);
    const cur = s.matches[s.current];
    drawRuler(els.pvRuler, fractions, cur ? toFraction(cur) : -1);
  }
}

function searchOptions() {
  return {
    caseSensitive: els.searchCase.getAttribute('aria-pressed') === 'true',
    wholeWord: els.searchWord.getAttribute('aria-pressed') === 'true',
    regex: els.searchRegex.getAttribute('aria-pressed') === 'true',
  };
}

function openSearch() {
  if (!state.doc) return;
  state.search.open = true;
  els.search.hidden = false;
  updateSearchButtons();
  // 選択中の文字列（1 行以内）を検索語にする
  let sel = '';
  if (searchTarget() === 'editor') {
    const ta = els.textarea;
    sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
  } else {
    sel = (shadow.getSelection?.() ?? document.getSelection())?.toString() ?? '';
  }
  if (sel && !sel.includes('\n')) els.searchInput.value = sel;
  els.searchInput.focus();
  els.searchInput.select();
  runSearch({ keepPosition: false });
}

function closeSearch() {
  const wasEditor = searchTarget() === 'editor';
  state.search.open = false;
  els.search.hidden = true;
  updateSearchButtons();
  els.stSearch.hidden = true;
  editor.setMatches([], -1);
  clearPreviewHits();
  const m = state.search.matches[state.search.current];
  state.search.matches = [];
  state.search.current = -1;
  updateHitRulers();
  if (wasEditor) {
    // 編集側では現在のヒットを選択状態にする（そのまま直せる）
    els.textarea.focus({ preventScroll: true });
    if (m) els.textarea.setSelectionRange(m.start, m.end);
  } else {
    els.preview.focus({ preventScroll: true });
  }
}

/**
 * 検索を実行してハイライトを更新する
 * @param {{keepPosition: boolean}} opts true: 現在のヒット付近を保つ（本文編集・再描画時） / false: キャレット（表示モードは表示位置）以降の最初のヒットへ
 */
function runSearch({ keepPosition }) {
  const s = state.search;
  const target = searchTarget();
  const text = target === 'preview' ? previewIndex().text : editor.value;
  const prev = s.matches[s.current];
  const { matches, error, truncated } = findMatches(text, els.searchInput.value, searchOptions());
  s.matches = matches;
  s.error = error;
  s.truncated = truncated;
  if (matches.length === 0) s.current = -1;
  else if (keepPosition && prev) s.current = indexAtOrAfter(matches, prev.start);
  else if (target === 'editor') s.current = indexAtOrAfter(matches, els.textarea.selectionStart);
  else s.current = firstVisiblePreviewMatch(matches);

  if (target === 'editor') {
    clearPreviewHits();
    editor.setMatches(matches, s.current);
  } else {
    editor.setMatches([], -1);
    paintPreviewHits();
  }
  updateSearchCount();
  updateHitRulers();
  if (!keepPosition && s.current >= 0) {
    if (target === 'editor') editor.revealRange(matches[s.current].start);
    else revealPreviewMatch(matches[s.current]);
  }
}

// プレビューの DOM が変わったとき（再描画・コードの色付け）に索引とハイライトを作り直す
function onPreviewDomChanged() {
  state.previewIndex = null;
  if (state.search.open && searchTarget() === 'preview') runSearch({ keepPosition: true });
}

function updateSearchCount() {
  const s = state.search;
  els.search.classList.toggle('no-result', !!els.searchInput.value && s.matches.length === 0);
  if (s.error) els.searchCount.textContent = '正規表現エラー';
  else if (!els.searchInput.value) els.searchCount.textContent = '';
  else if (s.matches.length === 0) els.searchCount.textContent = '0 件';
  else els.searchCount.textContent = `${s.current + 1} / ${s.matches.length}${s.truncated ? '+' : ''} 件`;
  els.searchCount.title = s.error ?? '';
  els.stSearch.hidden = !s.open || !els.searchInput.value;
  els.stSearch.textContent = `検索: ${els.searchCount.textContent}`;
}

function moveMatch(delta) {
  const s = state.search;
  if (s.matches.length === 0) return;
  s.current = (s.current + delta + s.matches.length) % s.matches.length;
  const m = s.matches[s.current];
  if (searchTarget() === 'editor') {
    editor.setMatches(s.matches, s.current);
    editor.revealRange(m.start);
    // キャレットもヒット位置へ（検索欄を閉じたときにそこから編集を続けられる）
    els.textarea.setSelectionRange(m.start, m.end);
  } else {
    paintPreviewHits();
    revealPreviewMatch(m);
  }
  updateSearchCount();
  updateHitRulers();
}

els.searchInput.addEventListener('input', () => runSearch({ keepPosition: false }));
els.searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    moveMatch(e.shiftKey ? -1 : 1);
  }
});
for (const btn of [els.searchCase, els.searchWord, els.searchRegex]) {
  btn.addEventListener('click', () => {
    btn.setAttribute('aria-pressed', String(btn.getAttribute('aria-pressed') !== 'true'));
    runSearch({ keepPosition: false });
    els.searchInput.focus();
  });
}
els.searchPrev.addEventListener('click', () => moveMatch(-1));
els.searchNext.addEventListener('click', () => moveMatch(1));
els.searchClose.addEventListener('click', closeSearch);
function updateSearchButtons() {
  els.btnFind.setAttribute('aria-pressed', String(state.search.open));
}
els.btnFind.addEventListener('click', () => ACTIONS.find());

// ---------------------------------------------------------------------------
// 記法ボタン（プレビューで表示できる記法だけを置く）
// ---------------------------------------------------------------------------

/** 選択範囲を記号で囲む。既に囲まれていれば外す */
function toggleWrap(before, after = before, placeholder = '文字列') {
  const ta = els.textarea;
  const v = ta.value;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const sel = v.slice(start, end);
  if (v.slice(start - before.length, start) === before && v.slice(end, end + after.length) === after) {
    editor.replaceRange(start - before.length, end + after.length, sel, {
      selectStart: start - before.length,
      selectEnd: end - before.length,
    });
    return;
  }
  if (sel.startsWith(before) && sel.endsWith(after) && sel.length >= before.length + after.length) {
    const inner = sel.slice(before.length, sel.length - after.length);
    editor.replaceRange(start, end, inner, { selectStart: start, selectEnd: start + inner.length });
    return;
  }
  const inner = sel || placeholder;
  editor.replaceRange(start, end, before + inner + after, {
    selectStart: start + before.length,
    selectEnd: start + before.length + inner.length,
  });
}

/** 選択行の行頭記号を切り替える（全行に付いていれば外し、そうでなければ付ける） */
function toggleLinePrefix(pattern, makePrefix) {
  const ta = els.textarea;
  const v = ta.value;
  const lineStart = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
  let lineEnd = v.indexOf('\n', Math.max(ta.selectionEnd - (ta.selectionEnd > ta.selectionStart ? 1 : 0), ta.selectionStart));
  if (lineEnd < 0) lineEnd = v.length;
  const lines = v.slice(lineStart, lineEnd).split('\n');
  const allHave = lines.every((l) => pattern.test(l));
  const out = lines.map((l, i) => (allHave ? l.replace(pattern, '') : makePrefix(i) + l)).join('\n');
  editor.replaceRange(lineStart, lineEnd, out, { selectStart: lineStart, selectEnd: lineStart + out.length });
}

function cycleHeading() {
  const ta = els.textarea;
  const v = ta.value;
  const lineStart = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
  let lineEnd = v.indexOf('\n', ta.selectionStart);
  if (lineEnd < 0) lineEnd = v.length;
  const line = v.slice(lineStart, lineEnd);
  const m = /^(#{1,6})[ \t]+/.exec(line);
  const body = m ? line.slice(m[0].length) : line;
  const level = m ? m[1].length : 0;
  // なし → # → ## → ### → なし
  const next = level >= 3 ? '' : `${'#'.repeat(level + 1)} `;
  const out = next + body;
  const caret = lineStart + out.length;
  editor.replaceRange(lineStart, lineEnd, out, { selectStart: caret });
}

function insertBlock(text, selectFrom, selectLen) {
  const ta = els.textarea;
  const v = ta.value;
  const start = ta.selectionStart;
  const needNl = start > 0 && v[start - 1] !== '\n' ? '\n' : '';
  const block = needNl + text;
  editor.replaceRange(start, ta.selectionEnd, block, {
    selectStart: start + needNl.length + selectFrom,
    selectEnd: start + needNl.length + selectFrom + selectLen,
  });
}

const TOOLS = {
  heading: cycleHeading,
  bold: () => toggleWrap('**'),
  italic: () => toggleWrap('*'),
  strike: () => toggleWrap('~~'),
  code: () => toggleWrap('`', '`', 'code'),
  link: () => {
    const ta = els.textarea;
    const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd) || 'リンク';
    const start = ta.selectionStart;
    const text = `[${sel}](https://)`;
    editor.replaceRange(start, ta.selectionEnd, text, { selectStart: start + sel.length + 3, selectEnd: start + text.length - 1 });
  },
  ul: () => toggleLinePrefix(/^[ \t]*[-*+][ \t]+(?!\[[ xX]\])/, () => '- '),
  ol: () => toggleLinePrefix(/^[ \t]*\d+[.)][ \t]+/, (i) => `${i + 1}. `),
  task: () => toggleLinePrefix(/^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+/, () => '- [ ] '),
  quote: () => toggleLinePrefix(/^[ \t]*>[ \t]?/, () => '> '),
  codeblock: () => {
    const ta = els.textarea;
    const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    const body = sel || 'コード';
    insertBlock(`\`\`\`\n${body}\n\`\`\`\n`, 4, body.length);
  },
  hr: () => insertBlock('\n---\n', 5, 0),
  table: insertTable,
};

// 表のひな形（2 列 × 見出し + 1 行）を、カーソルのある行の次に挿入し、最初の見出しを選択する。
// 前の行に文字があれば空行を挟む（段落の続きにしない）。後ろの行に文字があれば空行を挟む
// （挟まないと、その行が表の行として取り込まれてしまう）
const TABLE_TEMPLATE = '| 見出し | 見出し |\n| --- | --- |\n|  |  |';
function insertTable() {
  const ta = els.textarea;
  const v = ta.value;
  const lineStart = v.lastIndexOf('\n', ta.selectionEnd - 1) + 1;
  let lineEnd = v.indexOf('\n', ta.selectionEnd);
  if (lineEnd < 0) lineEnd = v.length;
  const lineEmpty = v.slice(lineStart, lineEnd).trim() === '';
  const nextStart = lineEnd + 1;
  const nextEnd = v.indexOf('\n', nextStart) < 0 ? v.length : v.indexOf('\n', nextStart);
  const nextHasText = lineEnd < v.length && v.slice(nextStart, nextEnd).trim() !== '';
  const prevHasText = lineStart > 0 && v.slice(v.lastIndexOf('\n', lineStart - 2) + 1, lineStart - 1).trim() !== '';
  // 文字のある行: その行末の後ろに空行を挟んで入れる
  // 空の行で、前の行に文字がある: その空行を区切りとして残し、次の行に入れる
  // 空の行で、前も空: その行（空白だけ）を置き換える
  let at = lineEnd;
  let head = '\n\n';
  if (lineEmpty && prevHasText) head = '\n';
  else if (lineEmpty) {
    at = lineStart;
    head = '';
  }
  const text = head + TABLE_TEMPLATE + (nextHasText ? '\n' : '');
  const select = at + head.length + 2;
  editor.replaceRange(at, lineEnd, text, { selectStart: select, selectEnd: select + 3 });
}

els.tools.addEventListener('mousedown', (e) => e.preventDefault()); // ボタン押下で textarea の選択を失わない
els.tools.addEventListener('click', (e) => {
  if (state.mode === 'view') return;
  const tool = e.target.closest('[data-tool]');
  if (tool) {
    els.textarea.focus();
    TOOLS[tool.dataset.tool]();
    return;
  }
  const action = e.target.closest('[data-action]');
  if (action) ACTIONS[action.dataset.action]();
});

// 取り消し・検索など（ツールバーとメニューから使う）
const ACTIONS = {
  undo: () => {
    els.textarea.focus();
    document.execCommand('undo');
  },
  redo: () => {
    els.textarea.focus();
    document.execCommand('redo');
  },
  // 変更点を確認（2 段目の右端）
  'show-changes': () => showChanges(),
  // 変更した行に印のオン / オフ（全ウィンドウ共通の設定）
  'toggle-marks': () => api.setSetting('changeMarks', !appSettings.changeMarks),
  // 検索ボタン: 開いていれば閉じる（トグル）。対象は編集側
  find: () => {
    if (state.search.open) closeSearch();
    else openSearch();
  },
};

// ---------------------------------------------------------------------------
// 読み込み・保存
// ---------------------------------------------------------------------------

function applyDocMeta(payload) {
  state.doc = {
    path: payload.path,
    name: payload.name,
    baseUrl: payload.baseUrl,
    encodingLabel: payload.encodingLabel,
    eolLabel: payload.eolLabel,
    readOnly: payload.readOnly,
  };
  els.stPath.textContent = payload.path;
  els.stPath.title = payload.path;
  els.stEncoding.textContent = payload.encodingLabel;
  els.stEol.textContent = payload.eolLabel;
  els.stReadOnly.hidden = !payload.readOnly;
  setDocControlsEnabled(true);
}

/**
 * 文書を開いているときだけ使えるツールバー 1 段目のボタンを有効 / 無効にする。
 * 開いていないときも隠さずに無効で表示する（どんな機能があるか最初から見えるように）。
 * 保存ボタンは未保存の変更の有無で、明暗ボタンは文書に関係なく常に使える
 */
function setDocControlsEnabled(enabled) {
  for (const b of [
    els.btnSaveAs,
    els.btnReload,
    els.btnAutoReload,
    els.btnToc,
    els.btnBreaks,
    els.btnWidth,
    els.btnZoomIn,
    els.btnZoomOut,
    els.btnZoomReset,
    els.btnFind,
    ...els.modeButtons,
  ]) {
    b.disabled = !enabled;
  }
  if (enabled) updatePreviewOnlyButtons(state.mode);
}

// 改行で折り返す・表示幅はプレビューだけの設定なので、プレビューを出さない編集モードでは使えない
function updatePreviewOnlyButtons(mode) {
  for (const b of [els.btnBreaks, els.btnWidth]) b.disabled = mode === 'edit';
}

function loadDocument(payload) {
  applyDocMeta(payload);
  els.body.classList.remove('is-empty', 'is-loading');
  hideBanner();
  if (state.search.open) closeSearch();
  state.savedText = payload.text;
  editor.setValue(payload.text);
  marks['エディタ準備（鏡の構築）'] ??= Date.now();
  state.renderedText = null;
  updateDirty();
  // 「直せるビューア」: ファイルは必ず表示モードで開く
  setMode('view', { keepScroll: false });
  els.preview.scrollTop = 0;
  els.textarea.scrollTop = 0;
  updateToc();
}

function reloadDocument(payload) {
  // 自動再読み込みが届く前に編集を始めていたら、編集中の内容を優先して読み直さない（main は元の文書に戻して通知する）
  if (payload.reason === 'auto' && editor.value !== state.savedText) {
    api.reloadRejected();
    return;
  }
  const mode = state.mode;
  const line = mode === 'view' ? previewTopLine() : editor.topLine();
  const caret = els.textarea.selectionStart;
  applyDocMeta(payload);
  hideBanner();
  state.savedText = payload.text;
  editor.setValue(payload.text);
  const pos = Math.min(caret, payload.text.length);
  els.textarea.setSelectionRange(pos, pos);
  state.renderedText = null;
  updateDirty();
  setMode(mode, { keepScroll: false });
  if (mode === 'view') scrollPreviewToLine(line);
  else editor.scrollToLine(line);
  if (state.search.open) runSearch({ keepPosition: true });
  updateToc();
  showMessage('外部の変更を読み込みました');
}

/**
 * 上書き保存
 * @param {{skipDiffConfirm?: boolean}} [options] skipDiffConfirm: 変更点の確認画面から保存するとき（もう確認済み）
 */
async function save(options) {
  if (!state.doc || state.saving) return;
  if (!state.dirty) {
    showMessage('変更はありません');
    return;
  }
  // 設定「保存の前に変更点を確認する」: 差分を見せて、保存してよいか確かめる
  if (appSettings.confirmDiffOnSave && !options?.skipDiffConfirm) {
    const answer = await diffDialog.open({
      title: '保存の前に変更点を確認',
      note: `「${state.doc.name}」に保存する変更です。`,
      sections: [{ heading: '保存済みの内容 → 保存する内容', oldText: state.savedText, newText: editor.value }],
      buttons: [
        { label: '保存する', value: 'save', primary: true },
        { label: 'キャンセル', value: 'close' },
      ],
    });
    if (answer !== 'save' || !state.doc || state.saving) return;
  }
  state.saving = true;
  try {
    const text = editor.value;
    const result = await api.save(text);
    if (!result.ok) {
      if (!result.canceled && result.error) showMessage(`保存できませんでした: ${result.error}`);
      return;
    }
    // 読み取り専用のため「別名で保存」になった場合は、保存先のファイルに切り替わる
    if (result.path && result.path !== state.doc.path) {
      const baseChanged = result.baseUrl !== state.doc.baseUrl;
      applyDocMeta(result);
      applySaveResult(result, text);
      if (baseChanged && state.mode !== 'edit') renderPreview({ force: true });
      else if (baseChanged) state.renderedText = null;
      showMessage(`「${result.name}」として保存しました`);
      return;
    }
    applySaveResult(result, text);
    showMessage('保存しました');
  } finally {
    state.saving = false;
  }
}

/** 名前を付けて保存（文字コード・改行コードは元のまま）。以後は保存先のファイルを編集対象にする */
async function saveAs() {
  if (!state.doc || state.saving) return;
  state.saving = true;
  try {
    const text = editor.value;
    const result = await api.saveAs(text);
    if (!result.ok) {
      if (!result.canceled && result.error) showMessage(`保存できませんでした: ${result.error}`);
      return;
    }
    const baseChanged = result.baseUrl !== state.doc.baseUrl;
    applyDocMeta(result);
    applySaveResult(result, text);
    // フォルダが変わると相対パスの画像の場所も変わるので描き直す
    if (baseChanged && state.mode !== 'edit') renderPreview({ force: true });
    else if (baseChanged) state.renderedText = null;
    showMessage(`「${result.name}」として保存しました`);
  } finally {
    state.saving = false;
  }
}

// 保存の結果を画面に反映する（変換できない文字が '?' になった場合などは、実際に保存された内容にする）
function applySaveResult(result, text) {
  if (result.text !== editor.value && editor.value === text) {
    const caret = els.textarea.selectionStart;
    const top = els.textarea.scrollTop;
    editor.replaceRange(0, editor.value.length, result.text, { selectStart: Math.min(caret, result.text.length) });
    els.textarea.scrollTop = top;
    editor.syncMirrorScroll();
  }
  state.savedText = result.text;
  state.doc.eolLabel = result.eolLabel;
  state.doc.readOnly = result.readOnly;
  els.stEol.textContent = result.eolLabel;
  els.stReadOnly.hidden = !result.readOnly;
  hideBanner();
  updateDirty();
  if (state.mode === 'split') schedulePreview();
}

els.btnSave.addEventListener('click', save);
els.btnSaveAs.addEventListener('click', saveAs);
// 手動の再読み込み（編集中なら main が破棄してよいか確認する）。読み込めなかったときは理由を知らせる
async function reloadFromDisk(confirmed = false) {
  const result = await api.reloadFromDisk(confirmed);
  if (result && !result.ok && !result.canceled && result.error) {
    showBanner(`ファイルを読み込めませんでした（${result.error}）。表示しているのは前に読み込んだ内容です。`);
  }
}
els.btnReload.addEventListener('click', () => reloadFromDisk());
els.btnAutoReload.addEventListener('click', () => api.setSetting('autoReload', !appSettings.autoReload));
els.btnBreaks.addEventListener('click', () => api.setSetting('breaks', !appSettings.breaks));
els.btnWidth.addEventListener('click', () => api.widthMenu());

// ---------------------------------------------------------------------------
// 拡大縮小（ツールバー 1 段目。倍率表示をクリックすると 100% に戻す）
// 本文（エディタの文字サイズ・プレビュー）だけを拡大する。ツールバー・ステータスバーは変えない。
// 倍率は CSS 変数 --zoom（Shadow DOM のプレビューにも継承される）。localStorage に保存し、他のウィンドウとも揃える
// ---------------------------------------------------------------------------

const ZOOM_STEPS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300];
let zoomPercent = 100;

function applyZoom(percent, { save = true } = {}) {
  if (!ZOOM_STEPS.includes(percent)) percent = 100;
  // 表示位置（ソース行）を保って拡大する
  const line = state.doc ? (state.mode === 'view' ? previewTopLine() : editor.topLine()) : 0;
  zoomPercent = percent;
  document.documentElement.style.setProperty('--zoom', String(percent / 100));
  els.btnZoomReset.textContent = `${percent}%`;
  state.anchors = null;
  if (state.doc) {
    if (state.mode === 'view') scrollPreviewToLine(line);
    else {
      editor.scrollToLine(line);
      if (state.mode === 'split') syncScroll('editor');
    }
  }
  if (state.search.open) requestAnimationFrame(updateHitRulers);
  if (save) {
    try {
      localStorage.setItem('mvp.zoom', String(percent));
    } catch {
      // 保存できなくても動作に影響しない
    }
  }
}

/** @param {number} dir +1: 拡大 / -1: 縮小 / 0: 100% */
function zoom(dir) {
  // 文書を開いていない（空の）ウィンドウでは拡大縮小しない（ボタン・キー・Ctrl+ホイールとも）
  if (!state.doc) return;
  if (dir === 0) return applyZoom(100);
  const i = ZOOM_STEPS.indexOf(zoomPercent);
  applyZoom(ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, i + Math.sign(dir)))]);
}
els.btnZoomIn.addEventListener('click', () => zoom(1));
els.btnZoomOut.addEventListener('click', () => zoom(-1));
els.btnZoomReset.addEventListener('click', () => zoom(0));
// Ctrl + ホイールも本文だけの拡大縮小にする（ページ全体のズームにさせない）
window.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoom(e.deltaY < 0 ? 1 : -1);
  },
  { passive: false },
);
// 他のウィンドウで倍率が変わったら合わせる
window.addEventListener('storage', (e) => {
  if (e.key === 'mvp.zoom' && e.newValue) applyZoom(Number(e.newValue), { save: false });
});
try {
  applyZoom(Number(localStorage.getItem('mvp.zoom')) || 100, { save: false });
} catch {
  applyZoom(100, { save: false });
}

// ---------------------------------------------------------------------------
// 最近開いたファイル（空の画面に一覧を出す。メニューの「ファイル > 最近開いたファイル」と同じ内容）
// ---------------------------------------------------------------------------

function renderRecent(list) {
  els.recentList.replaceChildren();
  els.recent.hidden = list.length === 0;
  for (const file of list) {
    const sep = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.title = file;
    const name = document.createElement('span');
    name.className = 'recent-name';
    name.textContent = file.slice(sep + 1);
    const dir = document.createElement('span');
    dir.className = 'recent-dir';
    dir.textContent = file.slice(0, sep);
    btn.append(name, dir);
    btn.addEventListener('click', () => api.openRecent(file));
    li.appendChild(btn);
    els.recentList.appendChild(li);
  }
}
els.recentClear.addEventListener('click', () => api.clearRecent());
api.onRecentChanged(renderRecent);
api.getRecent().then(renderRecent);

// ---------------------------------------------------------------------------
// テーマ（システムに従う / ライト / ダーク）。配色は main の nativeTheme 経由で
// prefers-color-scheme が切り替わることで CSS 側が追従する
// ---------------------------------------------------------------------------

// 明暗の選び方（system / light / dark）と、ライト用・ダーク用に選ばれたカラーテーマ
// main が URL のクエリで渡した設定を初期値にする（boot.bundle.js と同じ値。IPC の応答を待たずに正しい配色で出す）
const bootParams = new URLSearchParams(location.search);
let themeState = {
  theme: bootParams.get('theme') ?? 'system',
  dark: false,
  lightTheme: bootParams.get('light') ?? 'standard',
  darkTheme: bootParams.get('dark') ?? 'standard',
};
const colorMedia = matchMedia('(prefers-color-scheme: dark)');
// 今使っているカラーテーマの CSS 変数（記法一覧の表示にも写す）
let paletteVars = {};

// 今の明暗に対応するカラーテーマの色を CSS 変数として当てる。
// プレビューは Shadow DOM の :host で既定値を持つため、ホスト要素にも直接設定して上書きする
function applyPalette() {
  const dark = colorMedia.matches;
  const theme = findTheme(dark ? 'dark' : 'light', dark ? themeState.darkTheme : themeState.lightTheme);
  paletteVars = themeCssVars(theme);
  for (const [name, value] of Object.entries(paletteVars)) {
    document.documentElement.style.setProperty(name, value);
    els.preview.style.setProperty(name, value);
  }
  els.body.dataset.palette = `${dark ? 'dark' : 'light'}:${theme.id}`;
}
colorMedia.addEventListener('change', () => {
  themeState = { ...themeState, dark: colorMedia.matches };
  applyPalette();
  themePicker.update(themeState);
});

const themePicker = createThemePicker({
  dialog: document.querySelector('#theme-dialog'),
  onSelect: (scheme, id) => api.setPalette(scheme, id),
  onMode: (mode) => api.setTheme(mode),
});

// 設定画面（常駐）
// 画面から変更できる設定。表示に関わるものは main が URL のクエリでも渡す（最初の描画から正しく表示するため）
let appSettings = {
  resident: false,
  confirmDiffOnSave: false,
  changeMarks: true,
  autoReload: bootParams.get('autoReload') !== '0',
  breaks: bootParams.get('breaks') === '1',
  previewWidth: bootParams.get('width') ?? 'standard',
  previewFont: bootParams.get('font') ?? 'standard',
  previewLineHeight: bootParams.get('lineHeight') ?? 'standard',
};
const PREVIEW_MAX_WIDTH = { narrow: '720px', standard: '980px', wide: '1280px', full: 'none' };
const PREVIEW_WIDTH_LABELS = { narrow: '狭い', standard: '標準', wide: '広い', full: 'ウィンドウいっぱい' };

/** 設定を画面に反映する（変わった項目だけ処理する） */
function applyAppSettings(next) {
  const prev = appSettings;
  appSettings = { ...appSettings, ...next };
  const s = appSettings;
  // 改行の扱い・表示幅・フォント・行間が変わると折り返しが変わるので、変える前に読んでいる位置（ソース行）を測っておく
  const layoutChanged =
    prev.breaks !== s.breaks ||
    prev.previewWidth !== s.previewWidth ||
    prev.previewFont !== s.previewFont ||
    prev.previewLineHeight !== s.previewLineHeight;
  const line = layoutChanged && state.doc && state.mode === 'view' ? previewTopLine() : null;
  els.btnAutoReload.setAttribute('aria-pressed', String(s.autoReload));
  els.btnAutoReload.title = `自動再読み込み: ${s.autoReload ? 'オン' : 'オフ'}（ファイルが外部で変更されたら自動で読み直す）`;
  els.btnBreaks.setAttribute('aria-pressed', String(s.breaks));
  els.btnBreaks.title = `改行で折り返す: ${s.breaks ? 'オン' : 'オフ'}（行末の半角スペース 2 つが無くても、改行で改行して表示）`;
  els.btnWidth.title = `表示幅: ${PREVIEW_WIDTH_LABELS[s.previewWidth] ?? '標準'}（プレビューの本文の幅）`;
  els.btnMarks.setAttribute('aria-pressed', String(s.changeMarks));
  els.btnMarks.title = `変更した行に印: ${s.changeMarks ? 'オン' : 'オフ'}（保存済みの内容から変更・追加・削除した行の横に印を出す）`;
  if (prev.changeMarks !== s.changeMarks) updateChangeMarks();
  els.preview.style.setProperty('--pv-max-width', PREVIEW_MAX_WIDTH[s.previewWidth] ?? '980px');
  els.preview.style.setProperty('--pv-font', previewFontCss(s.previewFont));
  els.preview.style.setProperty('--pv-line', previewLineHeight(s.previewLineHeight));
  md.setBreaks(s.breaks);
  settingsDialog.update(s);
  fontDialog.update(s);
  // 改行の扱い・表示幅・フォント・行間が変わったら、表示位置（ソース行）を保ったまま描き直す
  if (layoutChanged && state.doc) {
    if (prev.breaks !== s.breaks) {
      if (state.mode !== 'edit') renderPreview({ force: true });
      else state.renderedText = null;
    }
    state.anchors = null;
    if (line !== null) scrollPreviewToLine(line);
    else if (state.mode === 'split') syncScroll('editor');
  }
}
const settingsDialog = createSettingsDialog({
  dialog: document.querySelector('#settings-dialog'),
  onResident: (on) => api.setSetting('resident', on),
  onConfirmDiff: (on) => api.setSetting('confirmDiffOnSave', on),
});
// 表示 > フォントと行間...（プレビューの本文。見本を見ながら選ぶ）
const fontDialog = createFontDialog({
  dialog: document.querySelector('#font-dialog'),
  onFont: (id) => api.setSetting('previewFont', id),
  onLineHeight: (id) => api.setSetting('previewLineHeight', id),
});
function openSettings() {
  settingsDialog.open(appSettings);
}
api.onSettingsChanged(applyAppSettings);
api.getSettings().then(applyAppSettings);
applyAppSettings({});

function applyTheme(state) {
  themeState = { ...themeState, ...state, dark: colorMedia.matches };
  const { theme } = themeState;
  els.body.dataset.theme = theme;
  document.documentElement.dataset.theme = theme;
  applyPalette();
  themePicker.update(themeState);
}
// 明暗・カラーテーマはテーマ画面 1 か所で選ぶ（表示 > テーマ... で開く）
api.onThemeChanged(applyTheme);
applyTheme(themeState);
api.getTheme().then(applyTheme);
els.emptyOpen.addEventListener('click', () => api.openDialog());

/**
 * 通知バナーを出す
 * @param {{reload?: boolean, diff?: boolean, closeTitle?: string}} options closeTitle: 「×」を押すと何が起きるか
 */
function showBanner(text, { reload = true, diff = false, closeTitle = '閉じる' } = {}) {
  els.bannerText.textContent = text;
  els.bannerReload.hidden = !reload;
  els.bannerDiff.hidden = !diff;
  els.bannerClose.title = closeTitle;
  els.bannerClose.setAttribute('aria-label', closeTitle);
  els.banner.hidden = false;
  els.stExternal.hidden = true;
}

/** 外部での変更を知らせる（覚えておき、閉じた後もステータスバーから出し直せるようにする） */
function showExternalNotice(text, options, label) {
  state.external = { text, options, label };
  showBanner(text, options);
}

/** 通知を片付ける（読み直し・保存などで外部での変更が解決したとき） */
function hideBanner() {
  els.banner.hidden = true;
  state.external = null;
  els.stExternal.hidden = true;
}

/** 「×」: 通知を閉じるだけ（外部での変更は解決していないので、ステータスバーに印を残す） */
function dismissBanner() {
  els.banner.hidden = true;
  if (state.external) {
    els.stExternal.textContent = state.external.label;
    els.stExternal.hidden = false;
  }
}
// 通知バナーの「再読み込み」は、編集中の内容が失われる旨をバナーで伝えているので確認済みとして扱う
els.bannerReload.addEventListener('click', () => reloadFromDisk(true));
els.bannerClose.addEventListener('click', dismissBanner);
// ステータスバーの「外部で変更あり」: 閉じた通知を出し直す
els.stExternal.addEventListener('click', () => {
  if (state.external) showBanner(state.external.text, state.external.options);
});
els.bannerDiff.addEventListener('click', () => showExternalDiff());

let messageTimer = null;
function showMessage(text) {
  els.stMessage.textContent = text;
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => (els.stMessage.textContent = ''), 4000);
}

// ---------------------------------------------------------------------------
// ドラッグ & ドロップ（空のウィンドウならここで、表示中なら新しいウィンドウで開く）
// ---------------------------------------------------------------------------

function hasFiles(e) {
  return [...(e.dataTransfer?.types ?? [])].includes('Files');
}
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  els.body.classList.add('drag-over');
});
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) els.body.classList.remove('drag-over');
});
window.addEventListener('drop', async (e) => {
  els.body.classList.remove('drag-over');
  if (!hasFiles(e)) return;
  e.preventDefault();
  // まとめて開く（開かなかったファイルは最後に 1 回だけお知らせが出る）
  const paths = [...e.dataTransfer.files].map((file) => api.pathForFile(file)).filter(Boolean);
  if (paths.length > 0) await api.openPaths(paths);
});

// ---------------------------------------------------------------------------
// お知らせ（トースト）: 開かなかったファイル等を、操作を止めずにウィンドウ下部に知らせる
// ---------------------------------------------------------------------------

const toast = { el: $('#toast'), text: $('#toast-text'), timer: null };
const TOAST_MS = 8000;

function showToast(message) {
  clearTimeout(toast.timer);
  toast.text.textContent = message;
  toast.el.classList.remove('leaving');
  toast.el.hidden = false;
  // マウスを乗せていても、一定時間で自動的に消す
  toast.timer = setTimeout(hideToast, TOAST_MS);
}
function hideToast() {
  clearTimeout(toast.timer);
  toast.el.classList.add('leaving');
  setTimeout(() => {
    if (toast.el.classList.contains('leaving')) toast.el.hidden = true;
  }, 200);
}
$('#toast-close').addEventListener('click', hideToast);
api.onNotice(({ message }) => showToast(message));

// ---------------------------------------------------------------------------
// キーボードショートカット
// ---------------------------------------------------------------------------

// 画面（ダイアログ）が開いているか。開いている間は、後ろの画面を変えるキー操作・メニューのコマンドを受け付けない
// （受け付けると、後ろでモードや検索が切り替わったり、画面が重なったりする）
function modalOpen() {
  return document.querySelector('dialog[open]') !== null;
}
// ダイアログを開いていても使える操作（ウィンドウを閉じる・終了）
const ALLOWED_WITH_MODAL = new Set(['close']);

window.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  // ダイアログを開いている間は、そのダイアログのキー操作（Esc で閉じる・Enter で決定など）だけにする
  if (modalOpen()) {
    if (ctrl && !e.shiftKey && !e.altKey && key === 'w') return prevent(e, () => api.closeWindow());
    if (ctrl && !e.shiftKey && !e.altKey && key === 'q') return prevent(e, () => api.quit());
    return;
  }
  const editing = state.doc && state.mode !== 'view';

  if (ctrl && e.shiftKey && !e.altKey && key === 's') return prevent(e, saveAs);
  if (ctrl && e.shiftKey && !e.altKey && key === 'o') return prevent(e, toggleToc);
  if (e.key === 'F5' && !ctrl && !e.altKey) return prevent(e, () => state.doc && reloadFromDisk());
  if (ctrl && !e.shiftKey && !e.altKey) {
    if (key === 's') return prevent(e, save);
    if (key === 'o') return prevent(e, () => api.openDialog());
    if (key === 'w') return prevent(e, () => api.closeWindow());
    if (key === 'q') return prevent(e, () => api.quit());
    // メニューと同じく、空のウィンドウでは何もしない
    if (key === 'n') return prevent(e, () => state.doc && api.newWindow());
    if (key === ',') return prevent(e, openSettings);
    if (key === 'g') return prevent(e, openGoto);
    if (key === 'd') return prevent(e, showChanges);
    if (key === '1') return prevent(e, () => setMode('view'));
    if (key === '2') return prevent(e, () => setMode('edit'));
    if (key === '3') return prevent(e, () => setMode('split'));
    if (key === 'f') return prevent(e, () => openSearch());
    if (key === '=' || key === '+' || key === ';') return prevent(e, () => zoom(1));
    if (key === '-') return prevent(e, () => zoom(-1));
    if (key === '0') return prevent(e, () => zoom(0));
    if (editing && document.activeElement === els.textarea) {
      if (key === 'b') return prevent(e, TOOLS.bold);
      if (key === 'i') return prevent(e, TOOLS.italic);
      // Windows 流のやり直し（Linux の Chromium は Ctrl+Y を持たないため自前で処理する）
      if (key === 'y') return prevent(e, ACTIONS.redo);
    }
  }
  if (e.key === 'F3' && state.doc) return prevent(e, () => (state.search.open ? moveMatch(e.shiftKey ? -1 : 1) : openSearch()));
  if (e.key === 'Escape' && tocIsOverlay() && !els.toc.hidden) return prevent(e, () => setTocOpen(false));
  if (e.key === 'Escape' && state.search.open) return prevent(e, closeSearch);
  if (e.key === 'F1' && !ctrl && !e.altKey) return prevent(e, () => shortcutsHelp.open());
});

function prevent(e, fn) {
  e.preventDefault();
  fn();
}

// ---------------------------------------------------------------------------
// main との接続
// ---------------------------------------------------------------------------

api.onLoad((payload) => {
  marks['文書受信'] = Date.now();
  loadDocument(payload);
  marks['文書描画（DOM 反映）完了'] = Date.now();
  // DOM への反映（レイアウトまで）が済んだらすぐ合図する。
  // 画面更新（requestAnimationFrame）は隠れたウィンドウでは来ないことがあるので待たない
  api.rendered(marks);
  // 手が空いたら、編集モードへすぐ切り替えられるようエディタの鏡を先に作っておく
  (window.requestIdleCallback ?? setTimeout)(() => editor.prebuild(), { timeout: 3000 });
});
api.onReload(reloadDocument);

// メニューバーからのコマンド（ショートカットと同じ処理を呼ぶ）
// ヘルプ > Markdown 記法の一覧（表示は本文と同じ変換・サニタイズの経路で作る）
const syntaxHelp = createSyntaxHelp({
  dialog: document.querySelector('#syntax-dialog'),
  render: (src) => md.render(src),
});

// ヘルプ > サードパーティのライセンス（文章は main がアプリに同梱した一覧から読む）
const licensesDialog = document.querySelector('#licenses-dialog');
licensesDialog.addEventListener('click', (e) => {
  if (e.target === licensesDialog) licensesDialog.close();
});
async function openLicenses() {
  const text = document.querySelector('#licenses-text');
  if (!text.textContent) text.textContent = await api.getLicenses();
  if (!licensesDialog.open) licensesDialog.showModal();
  text.scrollTop = 0;
}

const MENU_COMMANDS = {
  licenses: openLicenses,
  shortcuts: () => shortcutsHelp.open(),
  'font-settings': () => fontDialog.open(appSettings),
  goto: openGoto,
  'show-changes': showChanges,
  'syntax-help': () => syntaxHelp.open(paletteVars),
  'save-as': saveAs,
  settings: openSettings,
  'theme-picker': () => themePicker.open(themeState),
  open: () => api.openDialog(),
  save,
  reload: () => reloadFromDisk(),
  close: () => api.closeWindow(),
  undo: () => state.mode !== 'view' && ACTIONS.undo(),
  redo: () => state.mode !== 'view' && ACTIONS.redo(),
  find: () => openSearch(),
  'find-next': () => (state.search.open ? moveMatch(1) : openSearch()),
  'find-prev': () => (state.search.open ? moveMatch(-1) : openSearch()),
};
api.onMenuCommand((cmd) => {
  // ダイアログを開いている間は、閉じる以外のメニューのコマンドを受け付けない（後ろの画面を変えない・画面を重ねない）
  if (modalOpen() && !ALLOWED_WITH_MODAL.has(cmd)) return;
  MENU_COMMANDS[cmd]?.();
});
api.onEmpty(() => {
  setDocControlsEnabled(false);
  els.stPath.textContent = 'ファイルを開いていません';
  els.stPath.title = '';
  for (const b of els.modeButtons) b.setAttribute('aria-pressed', 'false');
  els.body.classList.remove('is-loading');
  els.body.classList.add('is-empty');
  updateTitle();
  api.rendered();
});
api.onExternalChanged(({ missing, dirty, unreadable }) => {
  if (unreadable) {
    showExternalNotice(
      `このファイルは外部で変更されましたが、読み込めませんでした（${unreadable}）。表示しているのは変更前の内容です。`,
      { closeTitle: '閉じる（変更前の内容の表示を続けます）' },
      '外部で変更（読み込めません）',
    );
  } else if (missing) {
    showExternalNotice(
      'このファイルは外部で削除（または移動）されました。保存すると同じ場所に作り直します。',
      { reload: false, closeTitle: '閉じる（このまま編集を続けられます。保存すると同じ場所に作り直します）' },
      '外部で削除',
    );
  } else if (dirty) {
    showExternalNotice(
      'このファイルは外部で変更されました。再読み込みすると編集中の内容は失われます。',
      { diff: true, closeTitle: '閉じる（外部の変更は取り込まずに編集を続けます）' },
      '外部で変更あり',
    );
  } else {
    showExternalNotice(
      'このファイルは外部で変更されました（自動再読み込みはオフです）。',
      { diff: true, closeTitle: '閉じる（外部の変更は読み込まずに、今の表示のままにします）' },
      '外部で変更あり',
    );
  }
});

// 外部での変更の差分: 外部の変更（読み込んだ内容 → 今のファイル）と、編集中なら自分の編集を並べて見せる
async function showExternalDiff() {
  if (!state.doc) return;
  const disk = await api.readDiskText();
  if (!disk?.ok) {
    showBanner(`ファイルを読み込めませんでした（${disk?.error ?? '不明なエラー'}）。`, { reload: false });
    return;
  }
  const sections = [{ heading: '外部の変更（読み込んだ内容 → 今のファイル）', oldText: state.savedText, newText: disk.text }];
  if (state.dirty) sections.push({ heading: 'あなたの編集（読み込んだ内容 → 編集中の内容）', oldText: state.savedText, newText: editor.value });
  const answer = await diffDialog.open({
    title: '外部での変更',
    note: state.dirty
      ? '編集中の内容はまだ保存されていません。外部の変更を読み込むと、編集中の内容は失われます。編集を残すときは「閉じる」を押し、必要な外部の変更を手で取り込んでから保存してください。'
      : '',
    sections,
    buttons: state.dirty
      ? [
          { label: '外部の変更を読み込む（編集を破棄）', value: 'reload', danger: true },
          { label: '閉じる', value: 'close', primary: true },
        ]
      : [
          { label: '外部の変更を読み込む', value: 'reload', primary: true },
          { label: '閉じる', value: 'close' },
        ],
  });
  if (answer === 'reload') reloadFromDisk(true);
}

// 変更点の確認（編集 > 変更点を確認・Ctrl+D・ステータスバーの「● 未保存」）
async function showChanges() {
  if (!state.doc) return;
  const answer = await diffDialog.open({
    title: '変更点の確認',
    note: `「${state.doc.name}」の保存済みの内容と、編集中の内容の差分です。`,
    sections: [{ heading: '保存済みの内容 → 編集中の内容', oldText: state.savedText, newText: editor.value }],
    buttons: state.dirty
      ? [
          { label: '保存', value: 'save', primary: true },
          { label: '閉じる', value: 'close' },
        ]
      : [{ label: '閉じる', value: 'close', primary: true }],
  });
  if (answer === 'save') save({ skipDiffConfirm: true });
}

const diffDialog = createDiffDialog({ dialog: $('#diff-dialog') });

// 指定行へ移動（Ctrl+G・ステータスバーの「行・列」）
const gotoDialog = createGotoDialog({ dialog: $('#goto-dialog'), onGo: gotoLine });
function openGoto() {
  if (!state.doc) return;
  const current = state.mode === 'view' ? Math.floor(previewTopLine()) + 1 : editor.caretPosition().line;
  gotoDialog.open(editor.lineCount(), current);
}

/** @param {number} n 行番号（1 始まり） */
function gotoLine(n) {
  const line = n - 1;
  if (state.mode === 'view') {
    scrollPreviewToLine(line);
    // その行を含むブロックを一瞬強調する
    let block = null;
    for (const node of article.querySelectorAll('[data-line]')) {
      if (Number(node.dataset.line) <= line) block = node;
      else break;
    }
    if (block) flash(block);
    return;
  }
  const pos = editor.offsetOfLine(line);
  els.textarea.focus({ preventScroll: true });
  els.textarea.setSelectionRange(pos, pos);
  const node = editor.lineNodes[line];
  if (node) {
    // 行を画面の上から 1/3 あたりに置く
    els.textarea.scrollTop = Math.max(0, node.offsetTop - els.textarea.clientHeight / 3);
    editor.syncMirrorScroll();
  }
  if (state.mode === 'split') syncScroll('editor');
  updateCaretStatus();
}

// ヘルプ > キーボード ショートカット（F1）
const shortcutsHelp = createShortcutsHelp({ dialog: $('#shortcuts-dialog') });

els.stDirty.addEventListener('click', showChanges);
els.stPos.addEventListener('click', openGoto);
els.stLinks.addEventListener('click', nextBrokenLink);

els.body.dataset.mode = state.mode;
updateTitle();
// ウィンドウの最小幅: ツールバー 1 段目の「別名で保存」までと、右側（モード切替・明暗）が隠れない幅。
// フォント等で幅が変わるので、実際の配置から測って main に伝える
function reportMinWidth() {
  const row = document.querySelector('#tb-main');
  const cs = getComputedStyle(row);
  const left = document.querySelector('#tb-main > .tb-left').getBoundingClientRect();
  const right = document.querySelector('#tb-main > .tb-right').getBoundingClientRect();
  const saveAs = els.btnSaveAs.getBoundingClientRect();
  const gap = parseFloat(cs.columnGap) || 0;
  const width = parseFloat(cs.paddingLeft) + (saveAs.right - left.left) + gap + right.width + parseFloat(cs.paddingRight);
  if (width > 0) api.setMinContentWidth(Math.ceil(width) + 2);
}
(document.fonts?.ready ?? Promise.resolve()).then(reportMinWidth);

marks['初期化完了'] = Date.now();
api.ready();
