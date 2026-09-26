// メインプロセス: ウィンドウ管理（1ウィンドウ1ファイル）・予備ウィンドウ・トレイ常駐・ファイル入出力
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, screen, shell, Tray } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLogger, isGpuFailure, isNetworkPath } from './diagnostics.js';
import { buildSaveBytes, encodingDisplay, looksBinary, parseDocument } from './document.js';
import { checkExternalChange, inspectBeforeOverwrite, isWritable, readStable, safeWriteFile, snapshotStat } from './file-guard.js';
import { buildMenu } from './menu.js';
import { buildOpenNotice, OpenNotice } from './open-notice.js';
import { pushRecent, removeRecent } from './recent.js';
import { findTheme, isThemeId } from '../shared/themes.js';
import { loadSettings, PREVIEW_WIDTHS, saveSettings, THEMES } from './settings.js';

// 起動時間の計測（MVP_TRACE=1 のときだけ、プロセス起動からの経過時間を標準出力へ出す）
const TRACE = Boolean(process.env.MVP_TRACE);
const PROCESS_START = Date.now() - process.uptime() * 1000;
function trace(label, at = Date.now()) {
  if (TRACE) process.stdout.write(`[起動計測] ${label}: ${Math.round(at - PROCESS_START)}ms\n`);
}
trace('main.js 読み込み完了');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(__dirname, '..', '..');
const RENDERER_HTML = path.join(APP_ROOT, 'dist', 'renderer', 'index.html');
const PRELOAD = path.join(APP_ROOT, 'src', 'preload', 'preload.cjs');
// Windows は複数サイズ入りの .ico（ビルド時に作る）を使う。大きな PNG を渡すと Windows が粗く縮小してアイコンが汚くなるため
const ICON = process.platform === 'win32' ? path.join(APP_ROOT, 'dist', 'icon.ico') : path.join(APP_ROOT, 'assets', 'icon.png');
const APP_NAME = 'MarkdownViewerPlus';
const MAX_FILE_SIZE = 50 * 1024 * 1024;
// 開くダイアログの絞り込み・プレビュー内のリンクをこのアプリで開く対象（開けるかどうか自体は中身で判断する）
const MARKDOWN_EXTS = ['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'txt'];
const SPARE_DELAY_MS = 1500;
// E2E テストでウィンドウを画面に出さずに動かす（描画の間引きも止める）
const E2E_HIDDEN = Boolean(process.env.MVP_E2E_HIDDEN);

/**
 * ウィンドウごとの状態
 * @typedef {{win: BrowserWindow, ready: Promise<void>, doc: object|null, dirty: boolean,
 *            isSpare: boolean, forceClose: boolean, notifiedStat: object|null}} WindowContext
 */
/** @type {Map<number, WindowContext>} webContents.id → 状態 */
const contexts = new Map();
let spare = null;
let spareTimer = null;
let tray = null;
let isQuitting = false;
let settings = {
  theme: 'system',
  lightTheme: 'standard',
  darkTheme: 'standard',
  resident: false,
  disableGpu: false,
  autoReload: true,
  breaks: false,
  previewWidth: 'standard',
  recent: [],
};
// 起動・終了・異常終了の記録（起動処理の最初で userData/logs/main.log へ向ける）
let log = () => {};

// ---------------------------------------------------------------------------
// ウィンドウ生成・予備ウィンドウ
// ---------------------------------------------------------------------------

function createWindowContext({ isSpare }) {
  // 起動を速く見せるため、予備以外のウィンドウは作成と同時に表示する（テーマの背景色で出し、本文は後から描く）。
  // 予備ウィンドウは隠したまま先読みし、文書を流し込んでから表示する
  const showNow = !isSpare && !E2E_HIDDEN;
  // 予備ウィンドウは使うときに位置を決める（takeSpare）
  const pos = isSpare ? null : cascadePosition([1100, 820]);
  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    ...(pos ?? {}),
    minWidth: 480,
    minHeight: 320,
    show: showNow,
    title: APP_NAME,
    icon: ICON,
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: !E2E_HIDDEN,
    },
  });

  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  const ctx = {
    win,
    ready,
    resolveReady,
    doc: null,
    dirty: false,
    mode: 'view',
    isSpare,
    forceClose: false,
    notifiedStat: null,
    menuTimer: null,
  };
  const id = win.webContents.id;
  contexts.set(id, ctx);

  // レンダラーからのナビゲーション・新規ウィンドウは禁止（リンクは既定ブラウザで開く）
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  win.webContents.on('context-menu', (_e, params) => showContextMenu(win, params));

  win.on('close', (e) => onWindowClose(ctx, e));
  win.on('closed', () => {
    unwatchDocument(ctx);
    contexts.delete(id);
    if (spare === ctx) spare = null;
    log(`ウィンドウを閉じた（${ctx.isSpare ? '予備' : '表示中'}、残り ${visibleContexts().length}）`);
    // 常駐しない設定では、表示中のウィンドウがすべて閉じたら終了する
    // （予備ウィンドウが隠れて残るため window-all-closed は発生しない）
    if (!ctx.isSpare && !isQuitting && !settings.resident && visibleContexts().length === 0) {
      log('表示中のウィンドウが無くなったため終了（常駐しない設定）');
      app.quit();
    }
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    log(`表示プロセスが終了: 理由=${details.reason} 終了コード=${details.exitCode}`);
  });
  win.on('focus', () => checkExternalOnFocus(ctx));

  // メニューバーは作成と同時に付ける（後から付くと本文領域の高さが変わり、表示がずれるため）
  applyMenu(ctx);
  trace('BrowserWindow 作成');
  log(`ウィンドウ作成（${isSpare ? '予備' : showNow ? '表示' : '非表示'}）`);
  if (showNow) trace('ウィンドウ表示（作成と同時）');
  else win.once('show', () => trace('ウィンドウ表示'));
  // 最初の描画から正しい配色にするため、テーマの設定を URL で渡す（boot.bundle.js が読む）
  win.loadFile(RENDERER_HTML, {
    query: {
      theme: settings.theme,
      light: settings.lightTheme,
      dark: settings.darkTheme,
      // 最初の描画から正しく表示するため、表示に関わる設定も渡す（settings:get の応答を待たない）
      autoReload: settings.autoReload ? '1' : '0',
      breaks: settings.breaks ? '1' : '0',
      width: settings.previewWidth,
    },
  });
  return ctx;
}

function takeSpare() {
  if (spare && !spare.win.isDestroyed()) {
    const ctx = spare;
    // 表示する前に、開いているウィンドウから少しずらした位置へ動かす
    const pos = cascadePosition(ctx.win.getSize());
    if (pos) ctx.win.setPosition(pos.x, pos.y);
    spare = null;
    ctx.isSpare = false;
    return ctx;
  }
  return null;
}

// 新しいウィンドウは、今のウィンドウ（フォーカス中、無ければ最後に開いたもの）から右下へ少しずらして開く。
// 画面の作業領域からはみ出すときは、その画面の左上寄りへ戻す。基準のウィンドウが無ければ null（既定の中央）
const CASCADE_OFFSET = 28;
function cascadePosition([width, height]) {
  const focused = BrowserWindow.getFocusedWindow();
  const refCtx = visibleContexts().find((c) => c.win === focused) ?? visibleContexts().at(-1);
  if (!refCtx) return null;
  const b = refCtx.win.getBounds();
  const area = screen.getDisplayMatching(b).workArea;
  let x = b.x + CASCADE_OFFSET;
  let y = b.y + CASCADE_OFFSET;
  if (x + width > area.x + area.width || y + height > area.y + area.height) {
    x = area.x + CASCADE_OFFSET;
    y = area.y + CASCADE_OFFSET;
  }
  return { x, y };
}

// 次回のファイル表示を速くするため、隠しウィンドウを 1 枚だけ先読みしておく
function scheduleSpare() {
  if (isQuitting || process.env.MVP_NO_SPARE) return;
  clearTimeout(spareTimer);
  spareTimer = setTimeout(() => {
    if (isQuitting || spare) return;
    spare = createWindowContext({ isSpare: true });
  }, SPARE_DELAY_MS);
}

function visibleContexts() {
  return [...contexts.values()].filter((c) => !c.isSpare && !c.win.isDestroyed());
}

async function showContext(ctx) {
  // 隠れているウィンドウ（予備ウィンドウ）は、文書を DOM に反映し終えた合図（doc:rendered）で表示する。
  // 画面更新（requestAnimationFrame）の合図は隠れたウィンドウでは来ないことがあるので使わない。
  // 応答が無くても一定時間で表示する
  if (!ctx.win.isVisible()) {
    await Promise.race([
      new Promise((r) => {
        ctx.onRendered = r;
      }),
      new Promise((r) => setTimeout(r, 1000)),
    ]);
    ctx.onRendered = null;
  }
  if (ctx.win.isDestroyed() || E2E_HIDDEN) return;
  if (!ctx.win.isVisible()) ctx.win.show();
  ctx.win.focus();
}

// ---------------------------------------------------------------------------
// ファイルを開く
// ---------------------------------------------------------------------------

// 保存の基準（読み込んだ内容・文字コード・BOM・改行・行ごとの元のバイト列）
function baseFromParsed(parsed) {
  return {
    text: parsed.text,
    encoding: parsed.encoding,
    bom: parsed.bom,
    eols: parsed.eols,
    dominant: parsed.dominant,
    segments: parsed.segments,
    wholeRewriteExact: parsed.wholeRewriteExact,
  };
}

// 保存の途中で失敗したときに元へ戻すための控えの置き場所
function recoveryDir() {
  return path.join(app.getPath('userData'), 'recovery');
}

function readDocument(filePath) {
  const st = fs.statSync(filePath);
  // 利用者の操作で避けられる理由（フォルダ・大きすぎる・表示できない種類）は OpenNotice で、お知らせとして伝える
  if (!st.isFile()) throw new OpenNotice('folder');
  if (st.size > MAX_FILE_SIZE) throw new OpenNotice('too-large');
  // 書き込み途中を読んでも変化を見逃さないよう、読む前の状態を記録する（file-guard.js の readStable）
  const { bytes, snapshot } = readStable(filePath);
  const parsed = parseDocument(bytes);
  // 開けるかどうかは拡張子ではなく中身で判断する（.java・.js などのテキストは開ける。exe・画像などは開かない）
  if (looksBinary(parsed.text)) throw new OpenNotice('binary');
  return {
    path: filePath,
    base: baseFromParsed(parsed),
    eolLabel: parsed.eolLabel,
    stat: snapshot,
  };
}

// 読み込めなかった理由（画面に出す文言）
function readErrorText(err) {
  if (err.code === 'ENOENT') return 'ファイルが見つかりません';
  if (err.code === 'EACCES' || err.code === 'EPERM') return 'アクセスが拒否されました';
  if (err.code === 'EBUSY') return '他のソフトが使用中です';
  return err.message;
}

function docPayload(doc) {
  const dir = path.dirname(doc.path);
  return {
    path: doc.path,
    name: path.basename(doc.path),
    baseUrl: pathToFileURL(dir + path.sep).href,
    text: doc.base.text,
    encodingLabel: encodingDisplay(doc.base.encoding, doc.base.bom),
    eolLabel: doc.eolLabel,
    readOnly: !isWritable(doc.path),
  };
}

/**
 * ファイルを開く。表示中でないウィンドウ（空のウィンドウ）が指定されればそこへ、無ければ予備ウィンドウへ読み込む
 */
/**
 * ファイルを開く
 * @param {string} filePath
 * @param {object|null} targetCtx 開き先の候補（空のウィンドウならそこへ読み込む）
 * @param {Array|null} notices 開かなかったファイルを集める配列（複数をまとめて開くとき。null ならその場で知らせる）
 */
async function openFile(filePath, targetCtx = null, notices = null) {
  const absPath = path.resolve(filePath);
  // 同じファイルが既に開かれていればそのウィンドウを前面へ
  for (const ctx of visibleContexts()) {
    if (ctx.doc && samePath(ctx.doc.path, absPath)) {
      if (ctx.win.isMinimized()) ctx.win.restore();
      ctx.win.show();
      ctx.win.focus();
      return ctx;
    }
  }

  let doc;
  try {
    doc = readDocument(absPath);
  } catch (err) {
    // 最近開いたファイルに残っていれば取り除く（移動・削除されたファイル）
    if (settings.recent.some((p) => samePath(p, absPath))) setRecent(removeRecent(settings.recent, absPath));
    if (err instanceof OpenNotice) {
      // 種類が違う等は、ダイアログではなくウィンドウ内のお知らせで伝える（複数のときはまとめて 1 回）
      const entry = { name: path.basename(absPath), reason: err.reason };
      log(`開かなかった: ${absPath}（${err.message}）`);
      if (notices) notices.push(entry);
      else await showOpenNotices([entry], 1, targetCtx);
      return null;
    }
    // 権限が無い・読み込みに失敗した等の本当のエラーはダイアログで知らせる
    await dialog.showMessageBox(targetCtx?.win ?? null, {
      type: 'error',
      title: APP_NAME,
      message: 'ファイルを開けませんでした。',
      detail: `${absPath}\n\n${err.message}`,
      noLink: true,
    });
    return null;
  }
  trace('ファイル読み込み・文字コード判定完了');
  addRecent(absPath);

  // 開き先: 指定された空のウィンドウ → 開いている空のウィンドウ（エクスプローラーのダブルクリック等でも使う）
  //         → 予備ウィンドウ → 新しいウィンドウ
  const ctx =
    (targetCtx && !targetCtx.doc && !targetCtx.reserved ? targetCtx : null) ??
    findEmptyContext() ??
    takeSpare() ??
    createWindowContext({ isSpare: false });
  // 読み込みが終わるまで、同時に開く別のファイルがこのウィンドウを選ばないようにする
  ctx.reserved = true;
  await ctx.ready;
  ctx.reserved = false;
  ctx.doc = doc;
  watchDocument(ctx);
  ctx.dirty = false;
  ctx.mode = 'view';
  ctx.notifiedStat = null;
  updateMenu(ctx);
  ctx.win.webContents.send('doc:load', docPayload(doc));
  trace('文書をレンダラーへ送信');
  await showContext(ctx);
  scheduleSpare();
  return ctx;
}

// 表示中で文書を持たない（空の）ウィンドウ。最後に使ったものを優先する
function findEmptyContext() {
  const empty = visibleContexts().filter((c) => !c.doc && !c.reserved);
  const focused = BrowserWindow.getFocusedWindow();
  return empty.find((c) => c.win === focused) ?? empty.at(-1) ?? null;
}

// 空のウィンドウは 1 つだけにする。既にあればそれを前面へ出す（新しいウィンドウ・ファイル無しの 2 つ目の起動など）
async function openEmptyWindow() {
  const existing = findEmptyContext();
  if (existing) {
    if (existing.win.isMinimized()) existing.win.restore();
    existing.win.show();
    existing.win.focus();
    return existing;
  }
  const ctx = takeSpare() ?? createWindowContext({ isSpare: false });
  await ctx.ready;
  ctx.win.webContents.send('doc:empty');
  await showContext(ctx);
  scheduleSpare();
  return ctx;
}

/**
 * 複数のファイルをまとめて開く。開かなかったファイルは最後に 1 回だけお知らせする
 */
async function openFiles(paths, targetCtx = null) {
  const notices = [];
  let target = targetCtx && !targetCtx.doc ? targetCtx : null;
  for (const p of paths) {
    const ctx = await openFile(p, target, notices);
    if (ctx) target = null;
  }
  if (notices.length > 0) await showOpenNotices(notices, paths.length, targetCtx);
}

/**
 * 開かなかったファイルのお知らせを、ウィンドウ内（下部のお知らせ）に出す。
 * 出す先: 開こうとしたウィンドウ → フォーカス中のウィンドウ → 最後のウィンドウ → 無ければ空のウィンドウを開く
 */
async function showOpenNotices(notices, total, preferredCtx = null) {
  const message = buildOpenNotice(notices, total);
  const focused = BrowserWindow.getFocusedWindow();
  const alive = (c) => c && !c.win.isDestroyed() && !c.isSpare;
  let ctx =
    (alive(preferredCtx) ? preferredCtx : null) ?? visibleContexts().find((c) => c.win === focused) ?? visibleContexts().at(-1);
  if (!ctx) ctx = await openEmptyWindow();
  await ctx.ready;
  ctx.win.webContents.send('app:notice', { message });
}

async function showOpenDialog(parentCtx) {
  const result = await dialog.showOpenDialog(parentCtx?.win ?? null, {
    title: 'Markdown ファイルを開く',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Markdown', extensions: MARKDOWN_EXTS },
      { name: 'すべてのファイル', extensions: ['*'] },
    ],
  });
  if (result.canceled) return;
  await openFiles(result.filePaths, parentCtx);
}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// コマンドライン引数からファイルパスを取り出す（オプションやディレクトリは除外）
function filesFromArgv(argv, cwd) {
  const args = argv.slice(process.defaultApp ? 2 : 1);
  const files = [];
  for (const a of args) {
    if (!a || a.startsWith('-')) continue;
    const p = path.resolve(cwd, a);
    try {
      if (fs.statSync(p).isFile()) files.push(p);
    } catch {
      // 存在しないパスは無視
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// 保存
// ---------------------------------------------------------------------------

// 文字コードで表せない文字の警告文（保存・別名で保存で共通）
function unconvertibleWarning(doc, unconvertible) {
  if (unconvertible.length === 0) return null;
  const list = unconvertible
    .slice(0, 10)
    .map((u) => `  「${u.char}」(U+${u.char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}) ${u.line}行${u.column}列`)
    .join('\n');
  const more = unconvertible.length > 10 ? `\n  ほか ${unconvertible.length - 10} 種類` : '';
  return `次の文字は ${encodingDisplay(doc.base.encoding, doc.base.bom)} で表現できないため、保存すると「?」に置き換わります:\n${list}${more}`;
}

// 保存前の確認（警告が無ければ確認しない）。保存してよければ true
async function confirmSave(ctx, fileName, warnings) {
  if (warnings.length === 0) return true;
  const { response } = await dialog.showMessageBox(ctx.win, {
    type: 'warning',
    title: '保存の確認',
    message: `「${fileName}」を保存する前に確認してください。`,
    detail: warnings.map((w) => `・${w}`).join('\n\n'),
    buttons: ['保存する', 'キャンセル'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return response === 0;
}

async function showSaveError(ctx, filePath, err) {
  await dialog.showMessageBox(ctx.win, {
    type: 'error',
    title: APP_NAME,
    message: '保存できませんでした。',
    detail: `${filePath}\n\n${err.message}`,
    noLink: true,
  });
}

// 保存したバイト列を、その文書の新しい基準にする（'?' 置換があった場合は実際に書いた内容を編集画面へ返す）
function adoptSavedBytes(ctx, filePath, bytes) {
  const doc = ctx.doc;
  // 書いたバイト列を、書いたときの文字コードで読み直す（文字コードを判定し直すと、短い文書で別の文字コードと
  // 誤判定して、次の保存で文字コードが変わってしまうおそれがあるため）。行ごとの元のバイト列も新しくする
  const saved = parseDocument(bytes, { encoding: doc.base.encoding, bom: doc.base.bom });
  doc.path = filePath;
  doc.base = baseFromParsed(saved);
  doc.eolLabel = saved.eolLabel;
  doc.stat = snapshotStat(filePath, bytes);
  ctx.dirty = false;
  ctx.notifiedStat = null;
  updateMenu(ctx);
  return {
    ok: true,
    ...docPayload(doc),
    text: saved.text,
  };
}

async function saveDocument(ctx, text) {
  const doc = ctx.doc;
  if (!doc) return { ok: false, error: 'ファイルが開かれていません。' };

  let guard;
  try {
    guard = inspectBeforeOverwrite(doc.path, doc.stat);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  // 読み取り専用のファイルには上書きしない（書き込み禁止を外すこともしない）。別名で保存を案内する
  if (guard.readOnly) {
    const { response } = await dialog.showMessageBox(ctx.win, {
      type: 'info',
      title: APP_NAME,
      message: `「${path.basename(doc.path)}」は読み取り専用のため、上書き保存できません。`,
      detail: '編集した内容は「別名で保存」で別のファイルに保存できます。',
      buttons: ['別名で保存...', 'キャンセル'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    return response === 0 ? saveDocumentAs(ctx, text) : { ok: false, canceled: true };
  }

  const { bytes, unconvertible, lossyLines } = buildSaveBytes(text, doc.base);
  const warnings = [];
  const unconv = unconvertibleWarning(doc, unconvertible);
  if (unconv) warnings.push(unconv);
  const lossy = lossyWarning(lossyLines);
  if (lossy) warnings.push(lossy);
  warnings.push(...guard.warnings);
  if (!(await confirmSave(ctx, path.basename(doc.path), warnings))) return { ok: false, canceled: true };

  try {
    safeWriteFile(doc.path, bytes, { recoveryDir: recoveryDir() });
  } catch (err) {
    log(`保存に失敗: ${doc.path} ${err.message}`);
    await showSaveError(ctx, doc.path, err);
    return { ok: false, error: err.message };
  }
  log(`保存: ${doc.path}`);
  return adoptSavedBytes(ctx, doc.path, bytes);
}

// 編集した行のうち、元のバイト列とは異なる形で保存される行の警告（同じ文字の別の符号・正しく読めなかった部分）
function lossyWarning(lossyLines) {
  if (lossyLines.length === 0) return null;
  if (lossyLines[0] === 0) {
    return 'この文字コード（ISO-2022-JP）のファイルは保存するとファイル全体を変換し直すため、編集していない部分のバイト列（文字の切り替えの位置など）が元とは変わります。文字の内容は変わりません。';
  }
  const list = lossyLines.slice(0, 10).join('・');
  const more = lossyLines.length > 10 ? ` ほか ${lossyLines.length - 10} 行` : '';
  return `編集した行（元の ${list} 行目${more}）に、文字コードとして正しく読めなかった部分、または同じ文字の別の符号があります。保存すると、その部分のバイト列が元とは変わります（編集していない行は元のままです）。`;
}

/**
 * 別名で保存。文字コード・BOM・改行コードは元の文書のまま保存し、以後はそのファイルを編集対象にする
 */
async function saveDocumentAs(ctx, text) {
  const doc = ctx.doc;
  if (!doc) return { ok: false, error: 'ファイルが開かれていません。' };
  // 種類の絞り込みは今のファイルの拡張子を先頭にする（Markdown 固定だと、.java 等に .md が付け足されるおそれがある）
  const ext = path.extname(doc.path).slice(1);
  const filters = ext
    ? [
        { name: `${ext.toUpperCase()} ファイル`, extensions: [ext] },
        { name: 'すべてのファイル', extensions: ['*'] },
      ]
    : [{ name: 'すべてのファイル', extensions: ['*'] }];
  const result = await dialog.showSaveDialog(ctx.win, {
    title: '名前を付けて保存',
    defaultPath: doc.path,
    filters,
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  const target = path.resolve(result.filePath);
  if (samePath(target, doc.path)) return saveDocument(ctx, text);
  // 別のウィンドウで開いているファイルには上書きしない（そちらの編集内容と食い違うため）
  const other = visibleContexts().find((c) => c !== ctx && c.doc && samePath(c.doc.path, target));
  if (other) {
    await dialog.showMessageBox(ctx.win, {
      type: 'warning',
      title: APP_NAME,
      message: 'そのファイルは別のウィンドウで開いています。',
      detail: `${target}\n\n別の名前を指定するか、そのウィンドウを閉じてから保存してください。`,
      noLink: true,
    });
    return { ok: false, canceled: true };
  }

  const { bytes, unconvertible, lossyLines } = buildSaveBytes(text, doc.base);
  const warnings = [];
  const unconv = unconvertibleWarning(doc, unconvertible);
  if (unconv) warnings.push(unconv);
  const lossy = lossyWarning(lossyLines);
  if (lossy) warnings.push(lossy);
  // 既存のファイルへ上書きする場合: 読み取り専用なら保存しない。リンクは確認する（上書きの確認は保存ダイアログが行う）
  if (fs.existsSync(target)) {
    let guard;
    try {
      guard = inspectBeforeOverwrite(target, null);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    if (guard.readOnly) {
      await dialog.showMessageBox(ctx.win, {
        type: 'info',
        title: APP_NAME,
        message: `「${path.basename(target)}」は読み取り専用のため、上書きできません。`,
        detail: '別の名前を指定してください。',
        noLink: true,
      });
      return { ok: false, canceled: true };
    }
    warnings.push(...guard.warnings);
  }
  if (!(await confirmSave(ctx, path.basename(target), warnings))) return { ok: false, canceled: true };

  try {
    safeWriteFile(target, bytes, { recoveryDir: recoveryDir() });
  } catch (err) {
    log(`別名で保存に失敗: ${target} ${err.message}`);
    await showSaveError(ctx, target, err);
    return { ok: false, error: err.message };
  }
  unwatchDocument(ctx);
  const saved = adoptSavedBytes(ctx, target, bytes);
  watchDocument(ctx);
  addRecent(target);
  log(`別名で保存: ${target}`);
  return saved;
}

// ---------------------------------------------------------------------------
// 外部変更の検知（ファイルの監視と、ウィンドウがフォーカスを得たとき）
// ---------------------------------------------------------------------------

const WATCH_INTERVAL_MS = 1000;

// ファイルの変更を監視する。fs.watch はネットワーク上の場所（\\wsl$ 等）で届かないことがあるので、
// 更新日時とサイズを一定間隔で確かめる fs.watchFile を使う
function watchDocument(ctx) {
  unwatchDocument(ctx);
  const doc = ctx.doc;
  if (!doc) return;
  const filePath = doc.path;
  const listener = () => checkExternalChangeFor(ctx);
  fs.watchFile(filePath, { interval: WATCH_INTERVAL_MS, persistent: false }, listener);
  ctx.watching = { filePath, listener };
}

function unwatchDocument(ctx) {
  if (!ctx.watching) return;
  fs.unwatchFile(ctx.watching.filePath, ctx.watching.listener);
  ctx.watching = null;
}

function checkExternalOnFocus(ctx) {
  checkExternalChangeFor(ctx);
}

/**
 * 外部での変更・削除を確かめて対応する
 * - 自動再読み込みがオンで未編集なら、黙って読み直す（ビューアとして最新を表示する）
 * - 編集中・削除・自動再読み込みがオフのときは通知だけ（同じ状態で何度も通知しない）
 */
function checkExternalChangeFor(ctx) {
  const doc = ctx.doc;
  if (!doc || ctx.win.isDestroyed()) return;
  const state = checkExternalChange(doc.path, doc.stat);
  if (state === 'unchanged') return;
  let key = 'missing';
  if (state === 'changed') {
    try {
      const st = snapshotStat(doc.path);
      key = `${st.mtimeMs}:${st.size}`;
    } catch {
      key = 'missing';
    }
  }
  let unreadable = null;
  if (key !== 'missing' && !ctx.dirty && settings.autoReload) {
    // 読み直せなかった状態（開けない種類に置き換わった等）のままなら、毎回読み直しを試みない
    if (ctx.failedReloadKey === key) return;
    const result = reloadFromDisk(ctx, 'auto');
    if (result.ok) return;
    ctx.failedReloadKey = key;
    unreadable = result.error;
    log(`自動再読み込みに失敗: ${doc.path} ${result.error}`);
  }
  if (ctx.notifiedStat === key) return;
  ctx.notifiedStat = key;
  ctx.win.webContents.send('doc:external-changed', { missing: key === 'missing', dirty: ctx.dirty, unreadable });
}

// 手動の再読み込み。編集中なら、変更を破棄してよいか確認する（confirmed のときは確認済み）
async function reloadWithConfirm(ctx, { confirmed = false } = {}) {
  if (ctx.dirty && !confirmed) {
    const { response } = await dialog.showMessageBox(ctx.win, {
      type: 'question',
      title: APP_NAME,
      message: `「${path.basename(ctx.doc.path)}」をファイルから読み直しますか？`,
      detail: '編集中の変更は失われます。',
      buttons: ['再読み込み', 'キャンセル'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) return { ok: false, canceled: true };
  }
  return reloadFromDisk(ctx);
}

/**
 * ファイルから読み直す
 * @param {'auto' | 'manual'} reason auto: 自動再読み込み（レンダラーで編集が始まっていたら読み直さない）
 */
function reloadFromDisk(ctx, reason = 'manual') {
  // 自動再読み込みがレンダラーで断られたとき（編集が始まっていた）に元へ戻せるよう、直前の状態を残す
  ctx.prevDoc = reason === 'auto' ? ctx.doc : null;
  try {
    ctx.doc = readDocument(ctx.doc.path);
  } catch (err) {
    ctx.prevDoc = null;
    return { ok: false, error: readErrorText(err) };
  }
  watchDocument(ctx);
  ctx.dirty = false;
  updateMenu(ctx);
  ctx.notifiedStat = null;
  ctx.failedReloadKey = null;
  ctx.win.webContents.send('doc:reload', { ...docPayload(ctx.doc), reason });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// ウィンドウを閉じる（未保存の確認）
// ---------------------------------------------------------------------------

function onWindowClose(ctx, e) {
  if (ctx.forceClose || !ctx.dirty || !ctx.doc) return;
  e.preventDefault();
  confirmCloseDirty(ctx);
}

async function confirmCloseDirty(ctx) {
  if (ctx.confirming) return;
  ctx.confirming = true;
  try {
    if (ctx.win.isMinimized()) ctx.win.restore();
    ctx.win.show();
    const { response } = await dialog.showMessageBox(ctx.win, {
      type: 'question',
      title: APP_NAME,
      message: `「${path.basename(ctx.doc.path)}」の変更を保存しますか？`,
      buttons: ['保存する', '保存しない', 'キャンセル'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (response === 2) {
      isQuitting = false;
      return;
    }
    if (response === 0) {
      const text = await ctx.win.webContents.executeJavaScript('window.__mvpGetText()');
      const result = await saveDocument(ctx, text);
      if (!result.ok) {
        isQuitting = false;
        return;
      }
    }
    ctx.forceClose = true;
    ctx.win.close();
    if (isQuitting) app.quit();
  } finally {
    ctx.confirming = false;
  }
}

// ---------------------------------------------------------------------------
// 最近開いたファイル（最大 10 件。settings.json に保存し、Windows のジャンプリストにも登録）
// ---------------------------------------------------------------------------

function addRecent(filePath) {
  setRecent(pushRecent(settings.recent, filePath));
  app.addRecentDocument(filePath);
}

function setRecent(list) {
  settings.recent = list;
  saveSettings(settings);
  for (const ctx of contexts.values()) {
    if (ctx.win.isDestroyed()) continue;
    ctx.win.webContents.send('recent:changed', settings.recent);
    updateMenu(ctx);
  }
}

function clearRecent() {
  app.clearRecentDocuments();
  setRecent([]);
}

// ---------------------------------------------------------------------------
// メニュー・テーマ
// ---------------------------------------------------------------------------

// 起動時のチラつきを防ぐため、ウィンドウ背景を選択中のテーマの背景色にする
function windowBackground() {
  const dark = nativeTheme.shouldUseDarkColors;
  return findTheme(dark ? 'dark' : 'light', dark ? settings.darkTheme : settings.lightTheme).colors.bg;
}

function themeState() {
  return {
    theme: settings.theme,
    dark: nativeTheme.shouldUseDarkColors,
    lightTheme: settings.lightTheme,
    darkTheme: settings.darkTheme,
  };
}

// カラーテーマ（ライト用 / ダーク用）の選択
function setPalette(scheme, id) {
  if (!['light', 'dark'].includes(scheme) || !isThemeId(scheme, id)) return;
  if (scheme === 'light') settings.lightTheme = id;
  else settings.darkTheme = id;
  saveSettings(settings);
  broadcastTheme();
}

// ウィンドウの状態（モード・未保存・文書の有無）に合わせてメニューを作り直す
// 状態の変化（未保存・モード・履歴など）が続けて起きることが多いので、少し間引いて作り直す
function updateMenu(ctx) {
  clearTimeout(ctx.menuTimer);
  ctx.menuTimer = setTimeout(() => applyMenu(ctx), 30);
}

function applyMenu(ctx) {
  if (ctx.win.isDestroyed()) return;
  const ui = { mode: ctx.mode, hasDoc: Boolean(ctx.doc), dirty: ctx.dirty };
  // 作ったメニューは状態として保持する（BrowserWindow からは取り出せないため。E2E でも参照する）
  ctx.menu = buildMenu(ui, settings, {
    command: (cmd) => ctx.win.webContents.send('menu:command', cmd),
    about: () => showAbout(ctx),
    quit: () => app.quit(),
    newWindow: () => openEmptyWindow(),
    // 空のウィンドウならそこへ、表示中なら新しいウィンドウで開く
    openRecent: (file) => openFile(file, ctx.doc ? null : ctx),
    clearRecent,
  });
  ctx.win.setMenu(ctx.menu);
}

// テーマ: nativeTheme.themeSource を切り替えると、全ウィンドウの prefers-color-scheme とタイトルバーが追従する
function setTheme(theme) {
  if (!THEMES.includes(theme)) return;
  settings.theme = theme;
  nativeTheme.themeSource = theme;
  saveSettings(settings);
  broadcastTheme();
}

function broadcastTheme() {
  for (const ctx of contexts.values()) {
    if (ctx.win.isDestroyed()) continue;
    ctx.win.setBackgroundColor(windowBackground());
    ctx.win.webContents.send('theme:changed', themeState());
    updateMenu(ctx);
  }
}

async function showAbout(ctx) {
  const { response } = await dialog.showMessageBox(ctx.win, {
    type: 'info',
    title: 'バージョン情報',
    message: `${APP_NAME} ${app.getVersion()}`,
    detail: [
      'コードレビュー向けの「直せる」Markdown ビューア',
      '',
      '作成者: Tomoaki Bessho',
      '',
      `Electron ${process.versions.electron}`,
      `Chromium ${process.versions.chrome}`,
      `Node.js ${process.versions.node}`,
    ].join('\n'),
    buttons: ['OK', 'サードパーティのライセンス...'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (response === 1 && !ctx.win.isDestroyed()) ctx.win.webContents.send('menu:command', 'licenses');
}

// サードパーティのライセンス一覧（ビルド時に dist/renderer/THIRD_PARTY_LICENSES.txt として作る）
function readThirdPartyLicenses() {
  try {
    return fs.readFileSync(path.join(APP_ROOT, 'dist', 'renderer', 'THIRD_PARTY_LICENSES.txt'), 'utf8');
  } catch (err) {
    return `ライセンス一覧を読み込めませんでした。\n${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// その他
// ---------------------------------------------------------------------------

function openExternalSafe(url) {
  try {
    const u = new URL(url);
    if (['http:', 'https:', 'mailto:'].includes(u.protocol)) shell.openExternal(url);
  } catch {
    // 不正な URL は無視
  }
}

function showContextMenu(win, params) {
  const items = [];
  if (params.isEditable) {
    items.push(
      { label: '元に戻す', role: 'undo', enabled: params.editFlags.canUndo },
      { label: 'やり直し', role: 'redo', enabled: params.editFlags.canRedo },
      { type: 'separator' },
      { label: '切り取り', role: 'cut', enabled: params.editFlags.canCut },
      { label: 'コピー', role: 'copy', enabled: params.editFlags.canCopy },
      { label: '貼り付け', role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { label: 'すべて選択', role: 'selectAll' },
    );
  } else if (params.selectionText) {
    items.push({ label: 'コピー', role: 'copy' });
  } else {
    items.push({ label: 'すべて選択', role: 'selectAll' });
  }
  if (params.linkURL && /^(https?|mailto):/i.test(params.linkURL)) {
    items.push({ type: 'separator' }, { label: 'リンクをブラウザで開く', click: () => openExternalSafe(params.linkURL) });
  }
  Menu.buildFromTemplate(items).popup({ window: win });
}

// ---------------------------------------------------------------------------
// 設定（設定画面から変更する項目）
// ---------------------------------------------------------------------------

// 画面から変更できる設定と、その値の検証
const APP_SETTINGS = {
  resident: (v) => typeof v === 'boolean',
  autoReload: (v) => typeof v === 'boolean',
  breaks: (v) => typeof v === 'boolean',
  previewWidth: (v) => PREVIEW_WIDTHS.includes(v),
};

function appSettingsState() {
  return Object.fromEntries(Object.keys(APP_SETTINGS).map((k) => [k, settings[k]]));
}

// 常駐する設定ならトレイを作り、しないなら片付ける
function applyResident() {
  if (settings.resident && !tray) createTray();
  else if (!settings.resident && tray) {
    tray.destroy();
    tray = null;
  }
}

function setAppSetting(key, value) {
  if (!Object.hasOwn(APP_SETTINGS, key) || !APP_SETTINGS[key](value)) return;
  settings[key] = value;
  saveSettings(settings);
  if (key === 'resident') applyResident();
  // 自動再読み込みをオンにしたら、その間に起きていた外部変更をすぐ反映する
  if (key === 'autoReload' && value) for (const ctx of visibleContexts()) checkExternalChangeFor(ctx);
  for (const ctx of contexts.values()) {
    if (!ctx.win.isDestroyed()) ctx.win.webContents.send('settings:changed', appSettingsState());
  }
}

function createTray() {
  // .ico は表示倍率に合うサイズが選ばれる。PNG のときは高品質に縮小する
  const image = ICON.endsWith('.ico') ? ICON : nativeImage.createFromPath(ICON).resize({ width: 16, height: 16, quality: 'best' });
  tray = new Tray(image);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'ファイルを開く...', click: () => showOpenDialog(null) },
      { type: 'separator' },
      { label: '終了', click: () => app.quit() },
    ]),
  );
  tray.on('click', () => {
    const list = visibleContexts();
    if (list.length === 0) showOpenDialog(null);
    else list.forEach((c) => c.win.show());
  });
}

function ctxFromEvent(e) {
  return contexts.get(e.sender.id);
}

function registerIpc() {
  ipcMain.on('app:ready', (e) => {
    trace('レンダラー初期化完了（app:ready）');
    ctxFromEvent(e)?.resolveReady();
  });
  ipcMain.on('doc:rendered', (e, marks) => {
    if (TRACE && marks && typeof marks === 'object') {
      for (const [label, at] of Object.entries(marks)) if (typeof at === 'number') trace(`  レンダラー: ${label}`, at);
    }
    trace('描画完了（doc:rendered）');
    ctxFromEvent(e)?.onRendered?.();
  });
  // レンダラーの状態（未保存・モード）。閉じる確認とメニューの有効/無効に使う
  ipcMain.on('ui:state', (e, state) => {
    const ctx = ctxFromEvent(e);
    if (!ctx || typeof state !== 'object' || state === null) return;
    ctx.dirty = Boolean(state.dirty);
    if (['view', 'edit', 'split'].includes(state.mode)) ctx.mode = state.mode;
    updateMenu(ctx);
  });
  ipcMain.handle('settings:get', () => appSettingsState());
  ipcMain.on('settings:set', (_e, key, value) => setAppSetting(key, value));
  ipcMain.handle('recent:get', () => settings.recent);
  ipcMain.handle('recent:open', async (e, p) => {
    const ctx = ctxFromEvent(e);
    if (typeof p !== 'string' || !settings.recent.includes(p)) return;
    await openFile(p, ctx?.doc ? null : ctx);
  });
  ipcMain.on('recent:clear', () => clearRecent());
  ipcMain.handle('theme:get', () => themeState());
  ipcMain.on('theme:set', (_e, theme) => setTheme(theme));
  ipcMain.on('theme:set-palette', (_e, scheme, id) => setPalette(scheme, id));
  ipcMain.on('app:quit', () => app.quit());
  // Ctrl+W・ファイル > 閉じる。win.close() は close イベント（未保存の確認）を通る
  ipcMain.on('app:close-window', (e) => ctxFromEvent(e)?.win.close());
  ipcMain.handle('app:licenses', () => readThirdPartyLicenses());
  // ウィンドウの最小幅（レンダラーがツールバーの配置から測った本文領域の幅に、枠の分を足す）
  ipcMain.on('ui:min-width', (e, width) => {
    const ctx = ctxFromEvent(e);
    if (!ctx || !Number.isFinite(width) || width < 200 || width > 2000) return;
    const [w, h] = ctx.win.getSize();
    const frame = w - ctx.win.getContentSize()[0];
    const [, minH] = ctx.win.getMinimumSize();
    const minW = Math.ceil(width) + frame;
    ctx.win.setMinimumSize(minW, minH || 320);
    if (w < minW) ctx.win.setSize(minW, h);
  });
  // 新しいウィンドウ（空のウィンドウ）を開く（ファイル メニュー・Ctrl+N）
  ipcMain.on('app:new-window', () => openEmptyWindow());
  ipcMain.handle('doc:save', (e, text) => {
    const ctx = ctxFromEvent(e);
    if (!ctx || typeof text !== 'string') return { ok: false, error: '不正な要求です。' };
    return saveDocument(ctx, text);
  });
  // 自動再読み込みを、レンダラーが編集中のため断った: 直前の文書に戻し、外部変更として知らせる
  // （戻さないと、次の保存で外部の変更を確認なしに上書きしてしまう）
  ipcMain.on('doc:reload-rejected', (e) => {
    const ctx = ctxFromEvent(e);
    if (!ctx?.prevDoc) return;
    ctx.doc = ctx.prevDoc;
    ctx.prevDoc = null;
    ctx.dirty = true;
    watchDocument(ctx);
    ctx.notifiedStat = null;
    checkExternalChangeFor(ctx);
  });
  ipcMain.handle('doc:save-as', (e, text) => {
    const ctx = ctxFromEvent(e);
    if (!ctx || typeof text !== 'string') return { ok: false, error: '不正な要求です。' };
    return saveDocumentAs(ctx, text);
  });
  ipcMain.handle('doc:reload', (e, options) => {
    const ctx = ctxFromEvent(e);
    return ctx?.doc ? reloadWithConfirm(ctx, { confirmed: Boolean(options?.confirmed) }) : { ok: false };
  });
  // 表示幅の選択メニュー（ツールバーのボタンから）
  ipcMain.on('ui:width-menu', (e) => {
    const ctx = ctxFromEvent(e);
    if (!ctx) return;
    const labels = { narrow: '狭い（720px）', standard: '標準（980px）', wide: '広い（1280px）', full: 'ウィンドウいっぱい' };
    Menu.buildFromTemplate(
      PREVIEW_WIDTHS.map((w) => ({
        label: labels[w],
        type: 'radio',
        checked: settings.previewWidth === w,
        click: () => setAppSetting('previewWidth', w),
      })),
    ).popup({ window: ctx.win });
  });
  ipcMain.handle('doc:open-dialog', (e) => showOpenDialog(ctxFromEvent(e)));
  ipcMain.handle('doc:open-path', async (e, p) => {
    if (typeof p !== 'string') return;
    await openFile(p, ctxFromEvent(e));
  });
  // ドロップされた複数のファイルをまとめて開く（開かなかったものは 1 回だけお知らせ）
  ipcMain.handle('doc:open-paths', async (e, paths) => {
    if (!Array.isArray(paths)) return;
    await openFiles(paths.filter((p) => typeof p === 'string'), ctxFromEvent(e));
  });
  // プレビュー内の相対リンク（Markdown ファイルのみ新しいウィンドウで開く）
  ipcMain.handle('doc:open-link', async (e, url) => {
    const ctx = ctxFromEvent(e);
    let target;
    try {
      target = fileURLToPath(new URL(url));
    } catch {
      return;
    }
    const ext = path.extname(target).slice(1).toLowerCase();
    if (MARKDOWN_EXTS.includes(ext)) await openFile(target, ctx?.doc ? null : ctx);
    else if (fs.existsSync(target)) shell.showItemInFolder(target);
  });
  ipcMain.on('app:open-external', (_e, url) => openExternalSafe(url));
}

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

// E2E テストでは利用者の設定ファイルに触れないよう、専用の userData を使う
if (process.env.MVP_USER_DATA) app.setPath('userData', process.env.MVP_USER_DATA);

// ---- 起動の記録と、起動を妨げる環境への対策（いずれも app の ready より前に決める必要がある） ----
log = createLogger(path.join(app.getPath('userData'), 'logs', 'main.log'));
log(
  `起動 v${app.getVersion()} Electron ${process.versions.electron} ${process.platform} ` +
    `exe=${app.getPath('exe')} 引数=${JSON.stringify(process.argv.slice(1))}`,
);
settings = loadSettings();
// 前回、保存の途中で止まった場合の控えが残っていれば記録する（手作業で戻せるように）
try {
  for (const f of fs.readdirSync(recoveryDir())) log(`保存途中の控えが残っています: ${path.join(recoveryDir(), f)}`);
} catch {
  // 控えが無ければ何もしない
}

// ネットワーク上の場所（\\wsl$ 等の UNC パス）から起動されると、Chromium のサンドボックスが
// GPU / 表示用のプロセスを起動できず、ウィンドウが一瞬出て終了することがある。この場合だけサンドボックスを外す
if (isNetworkPath(app.getPath('exe'))) {
  app.commandLine.appendSwitch('no-sandbox');
  log('ネットワーク上の場所から起動されたため、サンドボックスを無効にして起動する（ローカルのフォルダでの利用を推奨）');
}
// 以前に GPU 処理が異常終了していたら、GPU を使わずに起動する
if (settings.disableGpu) {
  app.disableHardwareAcceleration();
  log('GPU を使わずに起動する（以前に GPU 処理が異常終了したため）');
}
app.on('child-process-gone', (_e, details) => {
  log(`子プロセスが終了: 種類=${details.type} 理由=${details.reason} 終了コード=${details.exitCode} ${details.name ?? ''}`);
  if (isGpuFailure(details) && !settings.disableGpu) {
    // GPU 処理が使えないとアプリ全体が終了することがあるので、次回からは GPU を使わない
    settings.disableGpu = true;
    saveSettings(settings);
    log('次回から GPU を使わずに起動するよう設定した');
  }
});
process.on('uncaughtException', (err) => {
  log(`予期しないエラー: ${err?.stack ?? err}`);
  dialog.showErrorBox(`${APP_NAME} - 予期しないエラー`, String(err?.stack ?? err));
});
process.on('unhandledRejection', (reason) => log(`処理されなかったエラー: ${reason?.stack ?? reason}`));
app.on('quit', (_e, exitCode) => log(`終了（終了コード ${exitCode}）`));

if (!app.requestSingleInstanceLock()) {
  log('既に起動しているため、そちらに処理を引き継いで終了');
  app.quit();
} else {
  app.setAppUserModelId('com.markdownviewerplus.app');

  app.on('second-instance', (_e, argv, cwd) => {
    const files = filesFromArgv(argv, cwd);
    log(`2 つ目の起動を受け取った: ${JSON.stringify(files)}`);
    if (files.length === 0) openEmptyWindow();
    else {
      openFiles(files).then(() => {
        if (visibleContexts().length === 0) openEmptyWindow();
      });
    }
  });

  app.on('before-quit', () => {
    isQuitting = true;
    clearTimeout(spareTimer);
    if (spare && !spare.win.isDestroyed()) spare.win.destroy();
  });

  // 常駐する設定のときは、ウィンドウがすべて閉じても終了しない（常駐しないときの終了は closed で判断する）
  app.on('window-all-closed', () => {
    if (process.env.MVP_E2E) app.quit();
  });

  app.whenReady().then(async () => {
    trace('app ready');
    Menu.setApplicationMenu(null);
    nativeTheme.themeSource = settings.theme;
    // 「システムに従う」のとき、Windows の設定変更に追従する
    nativeTheme.on('updated', broadcastTheme);
    registerIpc();
    // タスクトレイへの常駐は設定で選ぶ（既定は常駐しない）
    applyResident();
    const files = filesFromArgv(process.argv, process.cwd());
    if (files.length === 0) await openEmptyWindow();
    else await openFiles(files);
    // 指定されたファイルがすべて開けなかった場合も、空のウィンドウを出して操作を続けられるようにする
    // （ウィンドウが無いまま見えないプロセスが残らないように）
    if (visibleContexts().length === 0) await openEmptyWindow();

    // E2E テスト用: main のインスペクタから dialog を差し替えたり状態を参照できるようにする
    if (process.env.MVP_E2E) {
      globalThis.__mvp = { app, dialog, shell, Menu, contexts, openFile, openFiles, openEmptyWindow, visibleContexts, cascadePosition, get spare() { return spare; }, get tray() { return tray; } };
    }
  });
}
