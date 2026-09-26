// テーマ画面（明暗とカラーテーマを選ぶモーダル。ツールバーの明暗ボタン・表示 > テーマ... から開く）
// 今の明暗（ライト / ダーク）で使うテーマの 8 つだけを表示する。明暗を切り替えると表示も切り替わる。
// 各カードはそのテーマの CSS 変数を持ち、ミニ見本（ツールバー・エディタ・プレビュー）をそのテーマの色で描く。
import { DARK_THEMES, LIGHT_THEMES, themeCssVars } from '../shared/themes.js';

const MODE_LABELS = [
  ['system', 'システムに従う'],
  ['light', 'ライト'],
  ['dark', 'ダーク'],
];

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

// テーマ 1 つ分のカード
function buildCard(scheme, theme) {
  const card = el('button', 'theme-card');
  card.type = 'button';
  card.dataset.scheme = scheme;
  card.dataset.id = theme.id;
  card.setAttribute('aria-pressed', 'false');
  card.title = `${theme.name}: ${theme.description}`;

  const sample = el('span', 'tc-sample');
  for (const [k, v] of Object.entries(themeCssVars(theme))) sample.style.setProperty(k, v);
  const bar = el('span', 'tc-bar');
  bar.append(el('i'), el('i'), el('i', 'tc-acc'));
  const body = el('span', 'tc-body');
  const ed = el('span', 'tc-ed');
  ed.append(el('span', 'tc-h', '# 見出し'), el('span', 'tc-t'), el('span', 'tc-em', '**強調**'), el('span', 'tc-code', '`code`'));
  ed.querySelector('.tc-t').append('本文 ', el('span', 'tc-hit', '誤記'));
  const pv = el('span', 'tc-pv');
  pv.append(el('span', 'tc-ph', '見出し'), el('span', 'tc-pt', '本文の文章'), el('span', 'tc-pl', 'リンク'));
  body.append(ed, pv);
  sample.append(bar, body);

  card.append(sample, el('span', 'tc-name', theme.name), el('span', 'tc-desc', theme.description));
  return card;
}

/**
 * @param {{dialog: HTMLDialogElement, onSelect: (scheme: string, id: string) => void, onMode: (mode: string) => void}} opts
 */
function buildThemePicker({ dialog, onSelect, onMode }) {
  const form = el('form', 'td-inner');
  form.method = 'dialog';

  const head = el('header', 'td-head');
  const title = el('h2', '', 'テーマ');
  title.id = 'theme-dialog-title';
  const close = el('button', 'td-close', '×');
  close.value = 'close';
  close.setAttribute('aria-label', '閉じる');
  head.append(title, close);

  // 明暗の選び方（ツールバーのテーマボタン・表示メニューと同じ設定）
  const mode = el('div', 'td-mode');
  mode.setAttribute('role', 'radiogroup');
  mode.setAttribute('aria-label', 'システムテーマ');
  mode.append(el('span', 'td-mode-label', 'システムテーマ'));
  const modeButtons = MODE_LABELS.map(([value, label]) => {
    const b = el('button', 'td-mode-btn', label);
    b.type = 'button';
    b.dataset.mode = value;
    b.setAttribute('role', 'radio');
    b.addEventListener('click', () => onMode(value));
    mode.append(b);
    return b;
  });

  const sections = {};
  for (const [scheme, label, list] of [
    ['light', 'ライトモード用', LIGHT_THEMES],
    ['dark', 'ダークモード用', DARK_THEMES],
  ]) {
    const section = el('section', 'td-section');
    section.dataset.scheme = scheme;
    const h = el('h3', '', label);
    const grid = el('div', 'td-grid');
    for (const theme of list) {
      const card = buildCard(scheme, theme);
      card.addEventListener('click', () => onSelect(scheme, theme.id));
      grid.append(card);
    }
    section.append(h, grid);
    sections[scheme] = section;
  }

  const foot = el('footer', 'td-foot');
  foot.append(el('span', 'td-note', '今の明暗で使うテーマを表示しています。もう一方のテーマは、明暗を切り替えると選べます。'));
  const ok = el('button', 'tb-btn primary', '閉じる');
  ok.value = 'close';
  foot.append(ok);

  form.append(head, mode, sections.light, sections.dark, foot);
  dialog.append(form);
  dialog.setAttribute('aria-labelledby', title.id);
  // 背景（ダイアログの外側）をクリックしたら閉じる
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });

  /** 設定の状態を画面に反映する */
  function update(state) {
    for (const b of modeButtons) b.setAttribute('aria-checked', String(b.dataset.mode === state.theme));
    for (const card of dialog.querySelectorAll('.theme-card')) {
      const selected = card.dataset.id === (card.dataset.scheme === 'dark' ? state.darkTheme : state.lightTheme);
      card.setAttribute('aria-pressed', String(selected));
    }
    // 今の明暗で使われている側だけを表示する
    sections.light.hidden = state.dark;
    sections.dark.hidden = !state.dark;
  }

  function open(state) {
    update(state);
    if (!dialog.open) dialog.showModal();
    const scheme = state.dark ? 'dark' : 'light';
    dialog.querySelector(`.theme-card[data-scheme="${scheme}"][aria-pressed="true"]`)?.focus();
  }

  return { open, update, close: () => dialog.close() };
}

/**
 * 画面の中身（DOM）は初めて開くときに作る（起動時の処理を減らすため）。
 * 作る前の update() は何もしない（open() に渡す状態で最新にする）
 */
export function createThemePicker(opts) {
  let built = null;
  const get = () => (built ??= buildThemePicker(opts));
  return {
    open: (state) => get().open(state),
    update: (state) => built?.update(state),
    close: () => opts.dialog.close(),
  };
}
