// 変更点の確認画面（モーダル）
// ・編集 > 変更点を確認（Ctrl+D）/ ステータスバーの「● 未保存」: 保存済みの内容と編集中の内容の差分
// ・保存の前に確認する設定のとき: 同じ画面で「保存する / キャンセル」
// ・外部で変更されたとき: 外部の変更（読み込んだ内容 → 今のファイル）と、自分の編集の差分
// 差分は行単位（line-diff.js）で、変更した行は 1 行の中の変わった部分も強調する。文字は textContent で入れる（HTML として解釈しない）
import { buildHunks, countChanges, diffLines } from './line-diff.js';

// 1 つの差分に並べる行の上限（巨大な差分で画面が固まらないように）
const MAX_ROWS = 3000;

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderText(row) {
  const cell = el('td', 'df-text');
  if (!row.mark || row.mark[0] === row.mark[1]) {
    cell.textContent = row.text;
    return cell;
  }
  const [a, b] = row.mark;
  cell.append(document.createTextNode(row.text.slice(0, a)), el('mark', '', row.text.slice(a, b)), document.createTextNode(row.text.slice(b)));
  return cell;
}

/**
 * 1 つの差分（見出し + 表）を作る
 * @returns {{node: HTMLElement, changes: number}}
 */
function renderSection({ heading, oldText, newText }) {
  const section = el('section', 'df-section');
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const ops = diffLines(oldLines, newLines);
  const changes = countChanges(ops);
  const head = el('h3', '', heading);
  head.append(el('span', 'df-count', changes === 0 ? '変更なし' : `${changes} か所`));
  section.append(head);
  if (changes === 0) {
    section.append(el('p', 'df-empty', '変更はありません。'));
    return { node: section, changes };
  }
  const table = el('table', 'df-table');
  let rows = 0;
  let omitted = 0;
  const hunks = buildHunks(oldLines, newLines, ops, 2);
  hunks.forEach((hunk, h) => {
    if (h > 0) {
      const gap = el('tr', 'df-gap');
      const td = el('td', '', '⋯');
      td.colSpan = 4;
      gap.append(td);
      table.append(gap);
    }
    for (const row of hunk.rows) {
      if (rows >= MAX_ROWS) {
        omitted++;
        continue;
      }
      rows++;
      const tr = el('tr', row.kind === '-' ? 'df-del' : row.kind === '+' ? 'df-add' : 'df-ctx');
      tr.append(el('td', 'df-no', row.oldNo ?? ''), el('td', 'df-no', row.newNo ?? ''), el('td', 'df-sign', row.kind === ' ' ? '' : row.kind), renderText(row));
      table.append(tr);
    }
  });
  const wrap = el('div', 'df-scroll');
  wrap.append(table);
  section.append(wrap);
  if (omitted > 0) section.append(el('p', 'df-empty', `ほか ${omitted} 行は省略しました。`));
  return { node: section, changes };
}

/**
 * @param {{dialog: HTMLDialogElement}} opts
 */
export function createDiffDialog({ dialog }) {
  let resolveOpen = null;
  const form = el('form', 'td-inner');
  form.method = 'dialog';
  const head = el('header', 'td-head');
  const title = el('h2');
  title.id = 'diff-dialog-title';
  const close = el('button', 'td-close', '×');
  close.value = 'close';
  close.setAttribute('aria-label', '閉じる');
  head.append(title, close);
  const note = el('p', 'df-note');
  const body = el('div', 'df-body');
  const foot = el('footer', 'td-foot');
  const legend = el('span', 'df-legend');
  legend.append(el('span', 'df-legend-del', '− 元の行'), el('span', 'df-legend-add', '＋ 新しい行'));
  const buttons = el('span', 'df-buttons');
  foot.append(legend, buttons);
  form.append(head, note, body, foot);
  dialog.append(form);
  dialog.setAttribute('aria-labelledby', title.id);
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close('close');
  });
  dialog.addEventListener('close', () => {
    const value = dialog.returnValue || 'close';
    resolveOpen?.(value);
    resolveOpen = null;
  });

  /**
   * 画面を開き、押されたボタンの value を返す（×・Esc・背景のクリックは 'close'）
   * @param {{title: string, note?: string, sections: {heading: string, oldText: string, newText: string}[],
   *          buttons: {label: string, value: string, primary?: boolean, danger?: boolean}[]}} spec
   * @returns {Promise<string>}
   */
  function open(spec) {
    if (dialog.open) dialog.close('close');
    title.textContent = spec.title;
    note.textContent = spec.note ?? '';
    note.hidden = !spec.note;
    body.replaceChildren(...spec.sections.map((s) => renderSection(s).node));
    buttons.replaceChildren(
      ...spec.buttons.map((b) => {
        const btn = el('button', `tb-btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}`, b.label);
        btn.value = b.value;
        return btn;
      }),
    );
    dialog.returnValue = '';
    dialog.showModal();
    body.scrollTop = 0;
    // 既定のボタン（primary）にフォーカスを置く。無ければ最後のボタン
    (buttons.querySelector('.primary') ?? buttons.lastElementChild)?.focus();
    return new Promise((resolve) => (resolveOpen = resolve));
  }

  return { open, isOpen: () => dialog.open };
}
