// 設定画面（ファイル > 設定... / Ctrl+, で開くモーダル）
// 項目: タスクトレイに常駐する / 保存の前に変更点を確認する
// （プレビューのフォント・行間は 表示 > フォントと行間... の画面で選ぶ）
// （明暗・カラーテーマは入口を 1 つにするため、ツールバーの明暗ボタンと 表示 メニューで行う）

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * @param {{dialog: HTMLDialogElement, onResident: (on: boolean) => void, onConfirmDiff: (on: boolean) => void}} opts
 */
function buildSettingsDialog({ dialog, onResident, onConfirmDiff }) {
  const form = el('form', 'sd-inner');
  form.method = 'dialog';

  const head = el('header', 'td-head');
  const title = el('h2', '', '設定');
  title.id = 'settings-dialog-title';
  const close = el('button', 'td-close', '×');
  close.value = 'close';
  close.setAttribute('aria-label', '閉じる');
  head.append(title, close);

  // ---- 起動と終了 ----
  const general = el('section', 'sd-section');
  general.append(el('h3', '', '起動と終了'));
  const residentLabel = el('label', 'sd-check');
  const resident = el('input');
  resident.type = 'checkbox';
  resident.id = 'setting-resident';
  resident.addEventListener('change', () => onResident(resident.checked));
  residentLabel.append(resident, el('span', '', 'タスクトレイに常駐する'));
  general.append(
    residentLabel,
    el(
      'p',
      'sd-help',
      'オンにすると、ウィンドウをすべて閉じてもタスクトレイに残り、次にファイルを開くときの表示が速くなります。' +
        'オフ（既定）のときは、最後のウィンドウを閉じるとアプリを終了します。',
    ),
  );

  // ---- 保存 ----
  const saving = el('section', 'sd-section');
  saving.append(el('h3', '', '保存'));
  const diffLabel = el('label', 'sd-check');
  const confirmDiff = el('input');
  confirmDiff.type = 'checkbox';
  confirmDiff.id = 'setting-confirm-diff';
  confirmDiff.addEventListener('change', () => onConfirmDiff(confirmDiff.checked));
  diffLabel.append(confirmDiff, el('span', '', '保存の前に変更点を確認する'));
  saving.append(
    diffLabel,
    el(
      'p',
      'sd-help',
      'オンにすると、上書き保存のたびに変更点（保存済みの内容との差分）を表示し、確認してから保存します。' +
        'オフ（既定）のときも、編集 > 変更点を確認（Ctrl+D）でいつでも見られます。',
    ),
  );

  const foot = el('footer', 'td-foot');
  foot.append(el('span'));
  const ok = el('button', 'tb-btn primary', '閉じる');
  ok.value = 'close';
  foot.append(ok);

  form.append(head, general, saving, foot);
  dialog.append(form);
  dialog.setAttribute('aria-labelledby', title.id);
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });

  /** @param {{resident?: boolean, confirmDiffOnSave?: boolean}} state */
  function update(state) {
    if (typeof state.resident === 'boolean') resident.checked = state.resident;
    if (typeof state.confirmDiffOnSave === 'boolean') confirmDiff.checked = state.confirmDiffOnSave;
  }

  function open(state) {
    update(state);
    if (!dialog.open) dialog.showModal();
    resident.focus();
  }

  return { open, update, close: () => dialog.close() };
}

/**
 * 画面の中身（DOM）は初めて開くときに作る（起動時の処理を減らすため）。
 * 作る前の update() は何もしない（open() に渡す状態で最新にする）
 */
export function createSettingsDialog(opts) {
  let built = null;
  const get = () => (built ??= buildSettingsDialog(opts));
  return {
    open: (state) => get().open(state),
    update: (state) => built?.update(state),
    close: () => opts.dialog.close(),
  };
}
