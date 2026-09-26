// ヘルプ > キーボード ショートカット（F1）
// 一覧の中身はここ 1 か所で持つ（キーの処理は app.js の keydown。変えたらここも直す）

export const SHORTCUT_GROUPS = [
  {
    title: 'ファイル',
    items: [
      ['Ctrl+O', 'ファイルを開く'],
      ['Ctrl+S', '保存'],
      ['Ctrl+Shift+S', '名前を付けて保存'],
      ['F5', 'ファイルから再読み込み'],
      ['Ctrl+N', '新しいウィンドウ'],
      ['Ctrl+W', 'ウィンドウを閉じる'],
      ['Ctrl+Q', '終了'],
      ['Ctrl+,', '設定'],
    ],
  },
  {
    title: '表示の切り替え',
    items: [
      ['Ctrl+1', '表示モード'],
      ['Ctrl+2', '編集モード'],
      ['Ctrl+3', '2 ペイン（編集＋表示）'],
      ['Ctrl+Shift+O', '目次の表示 / 非表示'],
      ['Ctrl+＋ / Ctrl+－', '本文の拡大 / 縮小'],
      ['Ctrl+0', '本文を 100% に戻す'],
      ['Ctrl+マウスホイール', '本文の拡大 / 縮小'],
    ],
  },
  {
    title: '編集',
    items: [
      ['Ctrl+Z / Ctrl+Y', '元に戻す / やり直し'],
      ['Ctrl+B / Ctrl+I', '太字 / 斜体'],
      ['Tab', 'タブ文字を入力'],
      ['Ctrl+G', '指定した行へ移動'],
      ['Ctrl+D', '変更点を確認（保存済みの内容との差分）'],
    ],
  },
  {
    title: '検索',
    items: [
      ['Ctrl+F', '検索'],
      ['Enter / F3', '次を検索'],
      ['Shift+Enter / Shift+F3', '前を検索'],
      ['Esc', '検索を閉じる'],
    ],
  },
  {
    // メニューの見出しのアクセスキー（menu.js のラベルの & の文字）。開いた後は項目の下線の文字で選べる
    title: 'メニューを開く',
    items: [
      ['Alt+F', 'ファイル メニュー'],
      ['Alt+E', '編集 メニュー'],
      ['Alt+V', '表示 メニュー'],
      ['Alt+H', 'ヘルプ メニュー'],
    ],
  },
  {
    // マウスの操作は説明が長いので、キーの枠ではなく普通の文字で、全幅に並べる
    title: 'マウス',
    plain: true,
    items: [
      ['表示の文字をダブルクリック', 'その場所を編集（2 ペインに切り替えて、同じ文字を選択）'],
      ['区切り線をダブルクリック', '2 ペインの幅を半分ずつに戻す'],
      ['ステータスバーの「行・列」をクリック', '指定した行へ移動'],
      ['ステータスバーの「● 未保存」をクリック', '変更点を確認'],
      ['ステータスバーの「リンク切れ」をクリック', '次のリンク切れへ移動'],
      ['ステータスバーの「外部で変更あり」をクリック', '閉じた外部での変更のお知らせを再表示'],
    ],
  },
  {
    title: 'ヘルプ',
    items: [['F1', 'この一覧']],
  },
];

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function build(dialog) {
  const form = el('form', 'td-inner');
  form.method = 'dialog';
  const head = el('header', 'td-head');
  const title = el('h2', '', 'キーボード ショートカット');
  title.id = 'shortcuts-dialog-title';
  const close = el('button', 'td-close', '×');
  close.value = 'close';
  close.setAttribute('aria-label', '閉じる');
  head.append(title, close);
  const body = el('div', 'sc-body');
  for (const group of SHORTCUT_GROUPS) {
    const section = el('section', group.plain ? 'sc-group sc-plain' : 'sc-group');
    section.append(el('h3', '', group.title));
    const table = el('table', 'sc-table');
    for (const [keys, action] of group.items) {
      const tr = el('tr');
      const k = el('td', 'sc-keys');
      if (group.plain) k.textContent = keys;
      else {
        keys.split(' / ').forEach((key, i) => {
          if (i > 0) k.append(' / ');
          k.append(el('kbd', '', key));
        });
      }
      tr.append(k, el('td', 'sc-action', action));
      table.append(tr);
    }
    section.append(table);
    body.append(section);
  }
  const foot = el('footer', 'td-foot');
  const ok = el('button', 'tb-btn primary', '閉じる');
  ok.value = 'close';
  foot.append(el('span'), ok);
  form.append(head, body, foot);
  dialog.append(form);
  dialog.setAttribute('aria-labelledby', title.id);
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
}

/** 画面の中身は初めて開くときに作る（起動時の処理を減らすため） */
export function createShortcutsHelp({ dialog }) {
  let built = false;
  return {
    open() {
      if (!built) {
        build(dialog);
        built = true;
      }
      if (!dialog.open) dialog.showModal();
      dialog.querySelector('.tb-btn.primary')?.focus();
    },
  };
}
