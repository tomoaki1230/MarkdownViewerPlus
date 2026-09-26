// 表示 > フォントと行間...（プレビューの本文のフォント・行間を、見本を見ながら選ぶモーダル）
// 選ぶとすぐに本文にも反映し、全ウィンドウ共通の設定として保存する（保存は main が行う）
import { PREVIEW_FONT_OPTIONS, PREVIEW_LINE_HEIGHT_OPTIONS, previewFontCss, previewLineHeight } from './preview-style.js';

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * @param {{dialog: HTMLDialogElement, onFont: (id: string) => void, onLineHeight: (id: string) => void}} opts
 */
function build({ dialog, onFont, onLineHeight }) {
  const form = el('form', 'sd-inner');
  form.method = 'dialog';
  const head = el('header', 'td-head');
  const title = el('h2', '', 'フォントと行間');
  title.id = 'font-dialog-title';
  const close = el('button', 'td-close', '×');
  close.value = 'close';
  close.setAttribute('aria-label', '閉じる');
  head.append(title, close);

  const section = el('section', 'sd-section');
  section.append(el('h3', '', '表示（プレビューの本文）'));
  const select = (id, label, options, onChange) => {
    const row = el('label', 'sd-row');
    row.htmlFor = id;
    const s = el('select');
    s.id = id;
    for (const o of options) {
      const opt = el('option', '', o.label);
      opt.value = o.id;
      s.append(opt);
    }
    s.addEventListener('change', () => {
      onChange(s.value);
      updateSample();
    });
    row.append(el('span', 'sd-label', label), s);
    return { row, s };
  };
  const font = select('setting-preview-font', 'フォント', PREVIEW_FONT_OPTIONS, onFont);
  const lineHeight = select('setting-preview-line-height', '行間', PREVIEW_LINE_HEIGHT_OPTIONS, onLineHeight);
  // 選んだフォント・行間の見本（本文の表示もすぐに変わる）
  const sample = el('div', 'sd-sample');
  sample.append(
    el('p', '', 'この文書はレビュー用のサンプルです。誤記があれば、その場で直せます。'),
    el('p', '', '行間を広くすると、長い文章でも行を目で追いやすくなります。'),
    el('p', '', 'The quick brown fox jumps over the lazy dog. 0123456789'),
  );
  function updateSample() {
    sample.style.fontFamily = previewFontCss(font.s.value);
    sample.style.lineHeight = previewLineHeight(lineHeight.s.value);
  }
  section.append(font.row, lineHeight.row, sample, el('p', 'sd-help', 'お使いの PC に入っていないフォントは、標準のフォントで表示します。コードブロックと編集欄の文字は変わりません。'));

  const foot = el('footer', 'td-foot');
  const ok = el('button', 'tb-btn primary', '閉じる');
  ok.value = 'close';
  foot.append(el('span'), ok);
  form.append(head, section, foot);
  dialog.append(form);
  dialog.setAttribute('aria-labelledby', title.id);
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });

  /** @param {{previewFont?: string, previewLineHeight?: string}} state */
  function update(state) {
    if (state.previewFont) font.s.value = state.previewFont;
    if (state.previewLineHeight) lineHeight.s.value = state.previewLineHeight;
    updateSample();
  }
  return { update, focus: () => font.s.focus() };
}

/** 画面の中身は初めて開くときに作る（起動時の処理を減らすため） */
export function createFontDialog(opts) {
  let built = null;
  return {
    open(state) {
      built ??= build(opts);
      built.update(state);
      if (!opts.dialog.open) opts.dialog.showModal();
      built.focus();
    },
    update: (state) => built?.update(state),
  };
}
