// プリロード: レンダラーへ最小限の API だけを公開する（contextIsolation + sandbox 前提）
const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');

function subscribe(channel, callback) {
  const listener = (_e, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// 拡大縮小は本文（エディタ・プレビュー）だけに掛けるため、ページ全体のズームは使わない（ツールバーは拡大しない）
webFrame.setZoomLevel(0);
webFrame.setVisualZoomLevelLimits(1, 1);

contextBridge.exposeInMainWorld('mvp', {
  platform: process.platform,
  // main → renderer
  onLoad: (cb) => subscribe('doc:load', cb),
  onReload: (cb) => subscribe('doc:reload', cb),
  onEmpty: (cb) => subscribe('doc:empty', cb),
  onExternalChanged: (cb) => subscribe('doc:external-changed', cb),
  onMenuCommand: (cb) => subscribe('menu:command', cb),
  onThemeChanged: (cb) => subscribe('theme:changed', cb),
  onRecentChanged: (cb) => subscribe('recent:changed', cb),
  onSettingsChanged: (cb) => subscribe('settings:changed', cb),
  // 開かなかったファイル等のお知らせ（ウィンドウ下部に控えめに表示する）
  onNotice: (cb) => subscribe('app:notice', cb),
  // renderer → main
  ready: () => ipcRenderer.send('app:ready'),
  // marks: 起動計測用の時刻（MVP_TRACE のときだけ main が表示する）
  rendered: (marks) => ipcRenderer.send('doc:rendered', marks ?? null),
  // 自動再読み込みを、編集中のため適用しなかったことを伝える
  reloadRejected: () => ipcRenderer.send('doc:reload-rejected'),
  // 未保存・モードを main へ伝える（閉じる確認・メニューの有効/無効）
  setUiState: (state) => ipcRenderer.send('ui:state', { dirty: Boolean(state.dirty), mode: String(state.mode) }),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (theme) => ipcRenderer.send('theme:set', String(theme)),
  // カラーテーマの選択（scheme: 'light' / 'dark'）
  setPalette: (scheme, id) => ipcRenderer.send('theme:set-palette', String(scheme), String(id)),
  quit: () => ipcRenderer.send('app:quit'),
  // ウィンドウを閉じる（main の close を通し、未保存なら確認を出す。window.close() は確認を通らずに閉じてしまう）
  closeWindow: () => ipcRenderer.send('app:close-window'),
  newWindow: () => ipcRenderer.send('app:new-window'),
  // サードパーティのライセンス一覧の文章
  getLicenses: () => ipcRenderer.invoke('app:licenses'),
  // ウィンドウの最小幅（本文領域の幅。ツールバーの必要な部分が隠れない幅）
  setMinContentWidth: (width) => ipcRenderer.send('ui:min-width', Number(width)),
  // 設定画面の項目（resident: タスクトレイに常駐するか）
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (key, value) => ipcRenderer.send('settings:set', String(key), value),
  getRecent: () => ipcRenderer.invoke('recent:get'),
  openRecent: (p) => ipcRenderer.invoke('recent:open', String(p)),
  clearRecent: () => ipcRenderer.send('recent:clear'),
  save: (text) => ipcRenderer.invoke('doc:save', String(text)),
  saveAs: (text) => ipcRenderer.invoke('doc:save-as', String(text)),
  // 表示幅の選択メニューを出す
  widthMenu: () => ipcRenderer.send('ui:width-menu'),
  // confirmed: 編集中の変更を破棄してよいことを確認済み（通知バナーの「再読み込み」など）
  reloadFromDisk: (confirmed = false) => ipcRenderer.invoke('doc:reload', { confirmed: Boolean(confirmed) }),
  openDialog: () => ipcRenderer.invoke('doc:open-dialog'),
  openPath: (p) => ipcRenderer.invoke('doc:open-path', String(p)),
  openPaths: (paths) => ipcRenderer.invoke('doc:open-paths', Array.from(paths, String)),
  openLink: (url) => ipcRenderer.invoke('doc:open-link', String(url)),
  openExternal: (url) => ipcRenderer.send('app:open-external', String(url)),
  // 外部で変更されたファイルの今の内容（差分表示用）
  readDiskText: () => ipcRenderer.invoke('doc:read-disk'),
  // リンク切れの検出: file: の URL が指すファイルがあるか（真偽値の配列）
  checkFiles: (urls) => ipcRenderer.invoke('doc:check-files', Array.from(urls, String)),
  // ドロップされたファイルの実パス（Electron 32 以降は File.path が無いため）
  pathForFile: (file) => webUtils.getPathForFile(file),
});
