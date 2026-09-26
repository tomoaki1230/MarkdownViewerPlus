// 設定画面（ファイル > 設定... / Ctrl+, で開くモーダル）
// 項目: タスクトレイに常駐する
// （明暗・カラーテーマは入口を 1 つにするため、ツールバーの明暗ボタンと 表示 メニューで行う）

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * @param {{dialog: HTMLDialogElement, onResident: (on: boolean) => void}} opts
 */
function buildSettingsDialog({ dialog, onResident }) {
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

  const foot = el('footer', 'td-foot');
  foot.append(el('span'));
  const ok = el('button', 'tb-btn primary', '閉じる');
  ok.value = 'close';
  foot.append(ok);

  form.append(head, general, foot);
  dialog.append(form);
  dialog.setAttribute('aria-labelledby', title.id);
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });

  /** @param {{resident?: boolean}} state */
  function update(state) {
    if (typeof state.resident === 'boolean') resident.checked = state.resident;
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
