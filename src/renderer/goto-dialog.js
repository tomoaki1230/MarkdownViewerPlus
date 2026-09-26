// 編集 > 指定行へ移動（Ctrl+G）の小さな入力画面

/** 入力された行番号（全角数字も可）。読めなければ NaN */
function parseLine(value) {
  const half = String(value).trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  return /^\d+$/.test(half) ? Number(half) : NaN;
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * @param {{dialog: HTMLDialogElement, onGo: (line: number) => void}} opts line は 1 始まり
 */
export function createGotoDialog({ dialog, onGo }) {
  let input = null;
  let hint = null;
  let maxLine = 1;

  function build() {
    const form = el('form', 'gt-inner');
    form.method = 'dialog';
    const label = el('label', 'gt-label');
    label.htmlFor = 'goto-input';
    hint = el('span');
    label.append(hint);
    input = el('input');
    input.id = 'goto-input';
    // 入力の検査はブラウザの検査（required / min）ではなく自前で行う（範囲外は丸め、数字でなければ閉じない）
    input.type = 'text';
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    input.spellcheck = false;
    const row = el('div', 'gt-row');
    const cancel = el('button', 'tb-btn', 'キャンセル');
    cancel.value = 'cancel';
    const go = el('button', 'tb-btn primary', '移動');
    go.value = 'go';
    row.append(input, go, cancel);
    form.append(label, row);
    // 数字として読めないときは閉じずに、入力欄を選んだままにする
    form.addEventListener('submit', (e) => {
      if (e.submitter?.value !== 'go') return;
      if (!Number.isFinite(parseLine(input.value))) {
        e.preventDefault();
        input.select();
      }
    });
    dialog.append(form);
    dialog.setAttribute('aria-label', '指定行へ移動');
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close('cancel');
    });
    dialog.addEventListener('close', () => {
      if (dialog.returnValue !== 'go') return;
      const n = parseLine(input.value);
      if (Number.isFinite(n)) onGo(Math.min(Math.max(n, 1), maxLine));
    });
  }

  return {
    /**
     * @param {number} lines 文書の行数
     * @param {number} current 今の行（1 始まり）
     */
    open(lines, current) {
      if (!input) build();
      maxLine = Math.max(1, lines);
      hint.textContent = `移動先の行番号（1〜${maxLine}）`;
      input.value = String(current);
      dialog.returnValue = '';
      if (!dialog.open) dialog.showModal();
      input.select();
    },
  };
}
