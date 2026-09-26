// メニューバー（ウィンドウごとに状態に合わせて作る）
//
// ショートカットはレンダラーの keydown で一元的に処理する。
// メニューにはキー表示だけを出し（registerAccelerator: false）、二重に実行されないようにする。
// モード切替・拡大縮小・記法入力はツールバーで行うため、メニューには置かない。
// テーマ（明暗・カラーテーマ）はテーマ画面に一本化し、メニューはその画面を開く項目だけを置く。
import { Menu } from 'electron';
import path from 'node:path';

// アクセスキーを「ファイル(F)」の形で見せる。Chromium は「(&F)」の形のアクセスキーを括弧ごと表示から消す
// （実測: 「ファイル(&F)」は「ファイル」とだけ表示される）。括弧の直後にゼロ幅スペースを入れると消されずに
// 「ファイル(F)」と表示される。& の後の文字は変わらないので、アクセスキー（Alt+F・項目の文字キー）はそのまま使える
const ZWSP = '\u200B';
function showAccessKeys(items) {
  for (const item of items) {
    if (typeof item.label === 'string') item.label = item.label.replace(/\((&[^&])\)/, `(${ZWSP}$1)`);
    if (Array.isArray(item.submenu)) showAccessKeys(item.submenu);
  }
  return items;
}

// メニューのラベルでは & がアクセスキー扱いになるためエスケープする
function escapeLabel(text) {
  return text.replace(/&/g, '&&');
}

function recentSubmenu(recent, actions) {
  if (recent.length === 0) return [{ label: '(なし)', enabled: false }];
  const items = recent.map((file, i) => ({
    // 1〜9, 0 をアクセスキーにする
    label: `&${(i + 1) % 10} ${escapeLabel(path.basename(file))}    ${escapeLabel(path.dirname(file))}`,
    click: () => actions.openRecent(file),
  }));
  return [...items, { type: 'separator' }, { label: '履歴をクリア(&C)', click: actions.clearRecent }];
}

/**
 * @param {{mode: string, hasDoc: boolean, dirty: boolean}} ui ウィンドウの状態
 * @param {{theme: string, recent: string[]}} settings
 * @param {{command: (cmd: string) => void, about: () => void,
 *          quit: () => void, newWindow: () => void, openRecent: (p: string) => void,
 *          clearRecent: () => void}} actions
 */
export function buildMenu(ui, settings, actions) {
  const editing = ui.hasDoc && ui.mode !== 'view';
  const cmd = (name) => () => actions.command(name);
  const key = (accelerator) => ({ accelerator, registerAccelerator: false });

  const template = [
    {
      label: 'ファイル(&F)',
      submenu: [
        // 空のウィンドウ（既に新しいウィンドウの状態）では使えない（空のウィンドウは 1 つだけ）
        { label: '新しいウィンドウ(&N)', ...key('Ctrl+N'), enabled: ui.hasDoc, click: actions.newWindow },
        { label: '開く(&O)...', ...key('Ctrl+O'), click: cmd('open') },
        { label: '最近開いたファイル(&R)', submenu: recentSubmenu(settings.recent, actions) },
        { type: 'separator' },
        { label: '保存(&S)', ...key('Ctrl+S'), enabled: ui.hasDoc && ui.dirty, click: cmd('save') },
        { label: '名前を付けて保存(&A)...', ...key('Ctrl+Shift+S'), enabled: ui.hasDoc, click: cmd('save-as') },
        { label: 'ファイルから再読み込み(&L)', ...key('F5'), enabled: ui.hasDoc, click: cmd('reload') },
        { type: 'separator' },
        { label: '設定(&T)...', ...key('Ctrl+,'), click: cmd('settings') },
        { type: 'separator' },
        { label: '閉じる(&C)', ...key('Ctrl+W'), click: cmd('close') },
        { label: '終了(&X)', ...key('Ctrl+Q'), click: actions.quit },
      ],
    },
    {
      label: '編集(&E)',
      submenu: [
        { label: '元に戻す(&U)', ...key('Ctrl+Z'), enabled: editing, click: cmd('undo') },
        { label: 'やり直し(&R)', ...key('Ctrl+Y'), enabled: editing, click: cmd('redo') },
        { type: 'separator' },
        { label: '切り取り(&T)', role: 'cut', ...key('Ctrl+X'), enabled: editing },
        { label: 'コピー(&C)', role: 'copy', ...key('Ctrl+C') },
        { label: '貼り付け(&P)', role: 'paste', ...key('Ctrl+V'), enabled: editing },
        { label: 'すべて選択(&A)', role: 'selectAll', ...key('Ctrl+A') },
        { type: 'separator' },
        { label: '検索(&F)', ...key('Ctrl+F'), enabled: ui.hasDoc, click: cmd('find') },
        { label: '次を検索(&N)', ...key('F3'), enabled: ui.hasDoc, click: cmd('find-next') },
        { label: '前を検索(&V)', ...key('Shift+F3'), enabled: ui.hasDoc, click: cmd('find-prev') },
        { type: 'separator' },
        { label: '指定行へ移動(&G)...', ...key('Ctrl+G'), enabled: ui.hasDoc, click: cmd('goto') },
        { label: '変更点を確認(&D)...', ...key('Ctrl+D'), enabled: ui.hasDoc, click: cmd('show-changes') },
      ],
    },
    {
      label: '表示(&V)',
      submenu: [
        // 明暗・カラーテーマはテーマ画面 1 か所で選ぶ（ツールバーの明暗ボタンも同じ画面を開く）
        { label: 'テーマ(&T)...', click: cmd('theme-picker') },
        // プレビューの本文のフォント・行間（見本を見ながら選ぶ画面を開く）
        { label: 'フォントと行間(&F)...', click: cmd('font-settings') },
      ],
    },
    {
      label: 'ヘルプ(&H)',
      submenu: [
        { label: 'キーボード ショートカット(&K)', ...key('F1'), click: cmd('shortcuts') },
        { label: 'Markdown 記法の一覧(&M)', click: cmd('syntax-help') },
        { type: 'separator' },
        { label: 'サードパーティのライセンス(&L)', click: cmd('licenses') },
        { label: 'バージョン情報(&A)', click: actions.about },
      ],
    },
  ];
  return Menu.buildFromTemplate(showAccessKeys(template));
}
