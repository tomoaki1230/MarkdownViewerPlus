// 実機スモークテスト: Electron を起動し、CDP 経由で操作して主要機能を確認する
//
// 罠への対策:
//  ・ダイアログが出る経路は、操作の前に main のインスペクタから dialog を差し替える（放置すると数百秒止まる）
//  ・--inspect / --remote-debugging-port は毎回空きポートを取得して使う（固定ポートの重複で固まるのを防ぐ）
//  ・一時ファイルは temp/ に作る
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Encoding from 'encoding-japanese';
import electronPath from 'electron';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const work = path.join(root, 'temp', `e2e-${process.pid}`);
fs.mkdirSync(work, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitFor(fn, { timeout = 15000, interval = 100, label = '条件' } = {}) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(interval);
  }
  throw new Error(`タイムアウト: ${label} (${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

// 最小限の CDP クライアント
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  ws.onclose = () => {
    for (const resolve of pending.values()) resolve({ result: { exceptionDetails: { text: '接続が切れました' } } });
    pending.clear();
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      // 切断済みの接続に送ると応答が来ないまま待ち続けるので、すぐに失敗を返す
      if (ws.readyState !== WebSocket.OPEN) {
        resolve({ result: { exceptionDetails: { text: '接続が切れています' } } });
        return;
      }
      const mid = ++id;
      pending.set(mid, resolve);
      try {
        ws.send(JSON.stringify({ id: mid, method, params }));
      } catch {
        pending.delete(mid);
        resolve({ result: { exceptionDetails: { text: '接続が切れています' } } });
      }
    });
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.result?.exceptionDetails) {
      throw new Error(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text);
    }
    return res.result?.result?.value;
  };
  return { evaluate, close: () => ws.close() };
}

async function targets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return res.json();
}

// ---------------------------------------------------------------------------
// テスト用ファイル（Shift_JIS + CRLF。保存で文字コード・改行が変わらないことを確かめる）
// ---------------------------------------------------------------------------
const sampleText = [
  '# テスト文書 :smile:',
  '',
  '誤記を直すためのサンプルです。',
  '',
  '<div>',
  '**AAA**',
  '</div>',
  '',
  '<script>window.__xss = 1</script>',
  '<img src="x.png" onerror="window.__xss = 2">',
  '',
  '```js',
  'const a = 1;',
  '```',
  '',
  ...Array.from({ length: 80 }, (_, i) => `## 節 ${i + 1}\r\n\r\n本文 ${i + 1} の段落です。誤記があります。\r\n`),
  '末尾',
  '',
].join('\r\n');
const samplePath = path.join(work, 'sample.md');
fs.writeFileSync(samplePath, Buffer.from(Encoding.convert(sampleText, { to: 'SJIS', from: 'UNICODE', type: 'arraybuffer' })));

const mainPort = await freePort();
const rendererPort = await freePort();
const env = {
  ...process.env,
  MVP_E2E: '1',
  MVP_E2E_HIDDEN: process.env.MVP_E2E_SHOW ? '' : '1',
  MVP_USER_DATA: path.join(work, 'userData'),
};
delete env.ELECTRON_RUN_AS_NODE;
const localLibs = path.join(root, 'temp', 'syslibs', 'root', 'usr', 'lib', 'x86_64-linux-gnu');
if (process.platform === 'linux' && fs.existsSync(localLibs)) {
  env.LD_LIBRARY_PATH = [localLibs, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
}

const child = spawn(electronPath, [`--inspect=${mainPort}`, `--remote-debugging-port=${rendererPort}`, root, samplePath], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));
const exited = new Promise((r) => child.on('exit', r));

const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✔ ${name} (${Date.now() - t0}ms)`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`  ✖ ${name}\n      ${err.message}`);
  }
}

let main;
let page;
try {
  console.log('Electron を起動しています…');
  // main のインスペクタ
  const mainTarget = await waitFor(async () => (await targets(mainPort))[0], { label: 'main インスペクタ' });
  main = await connect(mainTarget.webSocketDebuggerUrl);
  await waitFor(() => main.evaluate('Boolean(globalThis.__mvp)'), { label: 'main 起動' });
  // ダイアログは操作より先に差し替える（呼ばれた内容は記録して後で確認する）
  await main.evaluate(`(() => {
    globalThis.__dialogCalls = [];
    // メニューのラベルはアクセスキーを見せるためにゼロ幅スペースを含む（menu.js）。比べるときは取り除く
    globalThis.__plain = (label) => String(label).replaceAll('\\u200B', '');
    const d = globalThis.__mvp.dialog;
    d.showMessageBox = async (_w, opts) => { globalThis.__dialogCalls.push(opts ?? _w); return { response: 0 }; };
    d.showMessageBoxSync = (_w, opts) => { globalThis.__dialogCalls.push(opts ?? _w); return 0; };
    d.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    // 予期しないエラーのダイアログは画面に出さず記録する（出たらテストの失敗として最後に確かめる）
    globalThis.__errorBoxes = [];
    d.showErrorBox = (title, content) => { globalThis.__errorBoxes.push(title + ' ' + content); process.stdout.write('[E2E-ERRORBOX] ' + title + ' ' + content + '\\n'); };
    return true;
  })()`);

  const pageTarget = await waitFor(
    async () => (await targets(rendererPort)).find((t) => t.type === 'page' && t.title.includes('sample.md')),
    { label: 'sample.md のウィンドウ' },
  );
  page = await connect(pageTarget.webSocketDebuggerUrl);
  const q = (expr) => page.evaluate(expr);

  await step('ファイルは表示モードで開き、プレビューが描画される', async () => {
    assert.equal(await q('document.body.dataset.mode'), 'view');
    const h1 = await q(`document.querySelector('#preview').shadowRoot.querySelector('h1')?.textContent`);
    assert.equal(h1, 'テスト文書 😄');
  });

  await step('ステータスバーに文字コード・改行コードが出る', async () => {
    assert.equal(await q(`document.querySelector('#st-encoding').textContent`), 'Shift_JIS');
    assert.equal(await q(`document.querySelector('#st-eol').textContent`), 'CRLF');
  });

  await step('4章 HTML が表示され、スクリプトは実行されない', async () => {
    const r = await q(`(() => {
      const root = document.querySelector('#preview').shadowRoot;
      return { div: root.querySelector('article > div')?.textContent.trim(), script: !!root.querySelector('script'),
               onerror: !!root.querySelector('[onerror]'), xss: window.__xss ?? null };
    })()`);
    assert.deepEqual(r, { div: '**AAA**', script: false, onerror: false, xss: null });
  });

  await step('highlight.js が遅延ロードされコードが色付けされる', async () => {
    await waitFor(() => q(`!!document.querySelector('#preview').shadowRoot.querySelector('code.hljs .hljs-keyword')`), {
      label: 'hljs',
    });
  });

  // メニュー項目をラベルでたどってクリックする（実際のメニュー経由の動作を確かめる）
  const menuState = (labels) =>
    main.evaluate(`(() => {
      let items = globalThis.__mvp.visibleContexts()[0].menu?.items ?? [];
      let item = null;
      for (const label of ${JSON.stringify(labels)}) {
        item = items.find((i) => __plain(i.label) === label);
        items = item?.submenu?.items ?? [];
      }
      return item ? { enabled: item.enabled, checked: item.checked } : null;
    })()`);
  const clickMenu = (labels) =>
    main.evaluate(`(() => {
      let items = globalThis.__mvp.visibleContexts()[0].menu.items;
      let item = null;
      for (const label of ${JSON.stringify(labels)}) {
        item = items.find((i) => __plain(i.label) === label);
        items = item?.submenu?.items ?? [];
      }
      item.click();
      return true;
    })()`);

  await step('メニューバー: ファイル・編集・表示・ヘルプ（書式・モード切替・拡大縮小・置換は無い）', async () => {
    const labels = await main.evaluate('globalThis.__mvp.visibleContexts()[0].menu?.items.map((i) => __plain(i.label))');
    assert.deepEqual(labels, ['ファイル(&F)', '編集(&E)', '表示(&V)', 'ヘルプ(&H)']);
    const view = await main.evaluate(`globalThis.__mvp.visibleContexts()[0].menu.items[2].submenu.items.map((i) => __plain(i.label)).filter(Boolean)`);
    assert.deepEqual(view, ['テーマ(&T)...', 'フォントと行間(&F)...']);
    const edit = await main.evaluate(`globalThis.__mvp.visibleContexts()[0].menu.items[1].submenu.items.map((i) => __plain(i.label))`);
    assert.equal(edit.some((l) => l.includes('置換')), false);
  });

  await step('ツールバー 1 段目の並び: 保存 ｜ 拡大縮小・検索 … モード切替（右端）、開くボタン・テーマのボタンは無い', async () => {
    const order = await q(`({
      left: [...document.querySelectorAll('#tb-main > .tb-left > *')].map((e) => e.id || e.className),
      right: [...document.querySelectorAll('#tb-main > .tb-right > *')].map((e) => e.id || e.className),
    })`);
    assert.deepEqual(order, {
      left: ['btn-save', 'btn-save-as', 'sep', 'btn-reload', 'btn-auto-reload', 'sep', 'btn-toc', 'btn-breaks', 'btn-width', 'sep', 'zoom', 'btn-find'],
      right: ['mode-switch'],
    });
    assert.equal(await q(`document.querySelector('#btn-open')`), null);
  });

  await step('表示モード: ツールバーは 1 段、検索はプレビューの表示内容が対象', async () => {
    const r = await q(`({
      tools: getComputedStyle(document.querySelector('#tools')).display,
      find: document.querySelector('#btn-find').disabled,
    })`);
    assert.deepEqual(r, { tools: 'none', find: false });
    assert.equal((await menuState(['編集(&E)', '検索(&F)'])).enabled, true);
    await q(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true }))`);
    assert.equal(await q(`document.querySelector('#search').hidden`), false);
    // 検索バーは 2 段（1 段目: 検索語・閉じる / 2 段目: オプション・件数・前後）
    const rows = await q(`[...document.querySelectorAll('#search > .search-row')].map((r) => [...r.children].map((c) => c.id))`);
    assert.deepEqual(rows, [
      ['search-input', 'search-close'],
      ['search-case', 'search-word', 'search-regex', 'search-count', 'search-prev', 'search-next'],
    ]);
    await q(`(() => { const i = document.querySelector('#search-input'); i.value = '誤記'; i.dispatchEvent(new Event('input')); })()`);
    // 見出し直下の本文 1 件 + 各節の本文 80 件（DOM は書き換えず CSS Highlight で色付け）
    const hl = await q(`({ all: CSS.highlights.get('mvp-hit')?.size, cur: CSS.highlights.get('mvp-hit-cur')?.size,
      marks: document.querySelector('#preview').shadowRoot.querySelectorAll('mark').length })`);
    assert.deepEqual(hl, { all: 80, cur: 1, marks: 0 });
    const pvRuler = await q(`({ hidden: document.querySelector('#pv-ruler').hidden, marks: document.querySelectorAll('#pv-ruler i').length,
      cur: document.querySelectorAll('#pv-ruler i.cur').length })`);
    assert.equal(pvRuler.hidden, false);
    assert.ok(pvRuler.marks > 10, `スクロールバー上のマーク: ${pvRuler.marks}`);
    assert.equal(pvRuler.cur, 1);
    assert.equal(await q(`(() => {
      const pv = document.querySelector('#preview');
      return document.querySelector('#pv-ruler').getBoundingClientRect().right <= pv.getBoundingClientRect().left + pv.clientLeft + pv.clientWidth;
    })()`), true, 'プレビューでもマークはスクロールバーの左に出る');
    assert.match(await q(`document.querySelector('#search-count').textContent`), /^1 \/ 81 件$/);
    // 次へ進むとプレビューがスクロールしてヒットが見える位置に来る
    for (let i = 0; i < 40; i++) {
      await q(`document.querySelector('#search-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))`);
    }
    assert.match(await q(`document.querySelector('#search-count').textContent`), /^41 \/ 81 件$/);
    const vis = await q(`(() => {
      const pv = document.querySelector('#preview');
      const r = [...CSS.highlights.get('mvp-hit-cur')][0].getBoundingClientRect();
      const b = pv.getBoundingClientRect();
      return { scrolled: pv.scrollTop > 0, inView: r.top >= b.top && r.bottom <= b.bottom };
    })()`);
    assert.deepEqual(vis, { scrolled: true, inView: true });
    assert.equal(await q(`document.querySelector('#editor-pane').offsetParent`), null, '編集側は出ていない');
    await q(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    assert.equal(await q(`document.querySelector('#search').hidden`), true);
    assert.equal(await q(`CSS.highlights.has('mvp-hit')`), false, '閉じるとハイライトが消える');
    assert.equal(await q(`document.querySelector('#pv-ruler').hidden`), true, '閉じるとマークも消える');
    await q(`document.querySelector('#preview').scrollTop = 0`);
  });

  await step('2ペインへ切替: ツールバーが 2 段になり、検索は編集側が対象になる', async () => {
    // 表示モードで検索を開いたまま 2 ペインへ切り替えると、対象が編集側へ移る
    await q(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true }))`);
    await q(`(() => { const i = document.querySelector('#search-input'); i.value = '誤記'; i.dispatchEvent(new Event('input')); })()`);
    await q(`document.querySelector('[data-mode=split]').click()`);
    assert.equal(await q(`document.body.dataset.mode`), 'split');
    assert.equal(await q(`getComputedStyle(document.querySelector('#tools')).display`), 'flex');
    assert.equal(await q(`document.querySelectorAll('#ed-mirror .hit').length`), 81);
    assert.equal(await q(`CSS.highlights.get('mvp-hit')?.size ?? 0`), 0, 'プレビュー側は色付けしない');
    const pos = await q(`(() => {
      const s = document.querySelector('#search').getBoundingClientRect();
      const ed = document.querySelector('#editor-pane').getBoundingClientRect();
      return { left: s.left >= ed.left, right: s.right <= ed.right };
    })()`);
    assert.deepEqual(pos, { left: true, right: true }, '検索バーは編集側の上に出る');
    assert.equal(await q(`document.querySelector('#btn-find').getAttribute('aria-pressed')`), 'true');
    await q(`document.querySelector('#btn-find').click()`);
    assert.equal(await q(`document.querySelector('#search').hidden`), true, 'ボタンをもう一度押すと閉じる');
    await q(`document.querySelector('[data-mode=view]').click()`);
    assert.equal(await q(`document.body.dataset.mode`), 'view');
  });

  await step('2ペインの区切り: 縦の「…」が見切れず、ダブルクリックで 50:50 に戻る', async () => {
    await q(`document.querySelector('[data-mode=split]').click()`);
    // グリップは枠線（1px）込みで区切りの内側に収まり、区切りはペインより手前に描かれる
    const fit = await q(`(() => {
      const sp = document.querySelector('#splitter');
      const s = sp.getBoundingClientRect();
      const g = sp.querySelector('.grip').getBoundingClientRect();
      const y = g.top + g.height / 2;
      return {
        inside: g.left - 1 >= s.left - 0.01 && g.right + 1 <= s.right + 0.01,
        front: [g.left + 0.5, g.right - 0.5].every((x) => document.elementFromPoint(x, y) === sp),
        zIndex: getComputedStyle(sp).zIndex,
      };
    })()`);
    assert.deepEqual(fit, { inside: true, front: true, zIndex: '2' });
    await q(`document.querySelector('#workspace').style.setProperty('--split', '30%')`);
    const before = await q(`Math.round(document.querySelector('#editor-pane').getBoundingClientRect().width / document.querySelector('#workspace').getBoundingClientRect().width * 100)`);
    assert.equal(before, 30);
    await q(`document.querySelector('#splitter').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    const r = await q(`({
      split: document.querySelector('#workspace').style.getPropertyValue('--split'),
      saved: localStorage.getItem('mvp.split'),
      ed: document.querySelector('#editor-pane').getBoundingClientRect().width,
      pv: document.querySelector('#preview-pane').getBoundingClientRect().width,
    })`);
    assert.equal(r.split, '50%');
    assert.equal(r.saved, '50%');
    assert.ok(Math.abs(r.ed - r.pv) <= 1, `左右の幅が同じ: ${r.ed} / ${r.pv}`);
    // 編集側は検索バーが見切れない幅より狭くならない
    await q(`document.querySelector('#workspace').style.setProperty('--split', '5%')`);
    await q(`document.querySelector('#btn-find').click()`);
    const narrow = await q(`(() => {
      const ed = document.querySelector('#editor-pane').getBoundingClientRect();
      const sb = document.querySelector('#search').getBoundingClientRect();
      return { edWidth: ed.width, searchWidth: sb.width, fits: sb.left >= ed.left && sb.right <= ed.right };
    })()`);
    assert.equal(narrow.edWidth, 296, '編集側の最小幅');
    assert.ok(narrow.searchWidth <= 260, `検索バーの幅: ${narrow.searchWidth}`);
    assert.equal(narrow.fits, true, '検索バーが編集側に収まる');
    // 件数の最長表示（上限 9999 件）と正規表現エラーが見切れない。フォントの違い（Windows）を見込み 5% 以上の余裕を持つ
    const countFit = await q(`(() => {
      const c = document.querySelector('#search-count');
      const saved = c.textContent;
      const r = {};
      for (const text of ['9999 / 9999+ 件', '正規表現エラー']) {
        c.textContent = text;
        const probe = document.createElement('span');
        probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:' + getComputedStyle(c).font;
        probe.textContent = text;
        document.body.append(probe);
        r[text] = { clipped: c.scrollWidth > c.clientWidth, room: c.clientWidth >= probe.getBoundingClientRect().width * 1.05 };
        probe.remove();
      }
      c.textContent = saved;
      return r;
    })()`);
    assert.deepEqual(countFit, { '9999 / 9999+ 件': { clipped: false, room: true }, '正規表現エラー': { clipped: false, room: true } });
    await q(`document.querySelector('#btn-find').click()`);
    await q(`document.querySelector('#splitter').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await q(`document.querySelector('[data-mode=view]').click()`);
  });

  await step('拡大縮小: 本文だけが拡大し、ツールバーの大きさは変わらない', async () => {
    const size = () => q(`({
      label: document.querySelector('#btn-zoom-reset').textContent,
      toolbar: document.querySelector('#toolbar').getBoundingClientRect().height,
      button: document.querySelector('#btn-find').getBoundingClientRect().height,
      editorFont: getComputedStyle(document.querySelector('#ed-input')).fontSize,
      previewZoom: getComputedStyle(document.querySelector('#preview').shadowRoot.querySelector('article')).zoom,
      pageZoom: window.devicePixelRatio,
    })`);
    const before = await size();
    await q(`document.querySelector('#btn-zoom-in').click()`);
    await q(`document.querySelector('#btn-zoom-in').click()`);
    const after = await size();
    assert.equal(after.label, '125%');
    assert.equal(after.toolbar, before.toolbar, 'ツールバーの高さは変わらない');
    assert.equal(after.button, before.button);
    assert.equal(after.pageZoom, before.pageZoom, 'ページ全体のズームは使わない');
    assert.equal(after.editorFont, '17.5px');
    assert.equal(after.previewZoom, '1.25');
    // Ctrl + ホイールも本文だけ
    await q(`window.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, ctrlKey: true, cancelable: true }))`);
    assert.equal((await size()).label, '110%');
    await q(`document.querySelector('#btn-zoom-reset').click()`);
    const reset = await size();
    assert.equal(reset.label, '100%');
    assert.equal(reset.editorFont, '14px');
  });

  await step('最近開いたファイル: 開いたファイルが記録され、メニューと空の画面の一覧に出る', async () => {
    const saved = JSON.parse(fs.readFileSync(path.join(work, 'userData', 'settings.json'), 'utf8'));
    assert.deepEqual(saved.recent, [samplePath]);
    const items = await main.evaluate(`globalThis.__mvp.visibleContexts()[0].menu.items[0].submenu.items.find((i) => i.label.startsWith('最近開いたファイル')).submenu.items.map((i) => __plain(i.label))`);
    assert.match(items[0], /^&1 sample\.md/);
    assert.ok(items.includes('履歴をクリア(&C)'));
    const list = await q(`[...document.querySelectorAll('#recent-list .recent-name')].map((e) => e.textContent)`);
    assert.deepEqual(list, ['sample.md']);
  });

  await step('編集モード: スクロールバーの上では矢印カーソル、本文の上では I 字カーソル', async () => {
    await q(`document.querySelector('[data-mode=edit]').click()`);
    const cursorAt = (fromRight) => q(`(() => {
      const ta = document.querySelector('#ed-input');
      const r = ta.getBoundingClientRect();
      ta.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.right - ${fromRight}, clientY: r.top + r.height / 2 }));
      return getComputedStyle(ta).cursor;
    })()`);
    assert.equal(await cursorAt(4), 'default', 'スクロールバーの上');
    assert.equal(await cursorAt(200), 'text', '本文の上');
    assert.equal(await cursorAt(4), 'default');
    await q(`document.querySelector('#ed-input').dispatchEvent(new MouseEvent('mouseleave')), true`);
    assert.equal(await q(`getComputedStyle(document.querySelector('#ed-input')).cursor`), 'text', '離れたら元に戻る');
  });

  await step('編集モード: 鏡の textContent が textarea.value と一致する', async () => {
    await q(`document.querySelector('[data-mode=edit]').click()`);
    assert.equal(await q('document.body.dataset.mode'), 'edit');
    assert.equal(await q(`document.querySelector('#ed-mirror').textContent === document.querySelector('#ed-input').value`), true);
    const lines = await q(`document.querySelectorAll('#ed-mirror > .ed-line').length`);
    const expected = await q(`document.querySelector('#ed-input').value.split('\\n').length`);
    assert.equal(lines, expected);
  });

  await step('行番号の欄: 桁数・拡大率が変わっても、背景の帯・行番号・本文の開始位置がずれない', async () => {
    const measure = (zoom) => q(`(async () => {
      document.documentElement.style.setProperty('--zoom', '${zoom}');
      await new Promise((r) => setTimeout(r, 50));
      const mirror = document.querySelector('#ed-mirror');
      const probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;visibility:hidden;width:var(--gutter)';
      mirror.append(probe);
      const stripe = probe.getBoundingClientRect().width;
      probe.remove();
      const textStart = parseFloat(getComputedStyle(mirror).paddingLeft);
      const last = mirror.lastElementChild;
      const before = getComputedStyle(last, '::before');
      const num = document.createElement('span');
      num.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font-size:' + before.fontSize + ';font-family:' + before.fontFamily;
      num.textContent = String(mirror.children.length);
      last.append(num);
      const numWidth = num.getBoundingClientRect().width;
      num.remove();
      return {
        stripeMatches: Math.abs(stripe - textStart) < 0.5,
        numberFits: numWidth <= parseFloat(before.width) + 0.5,
        inputMatches: Math.abs(textStart - parseFloat(getComputedStyle(document.querySelector('#ed-input')).paddingLeft)) < 0.1,
      };
    })()`);
    await q(`document.querySelector('[data-mode=edit]').click()`);
    // 帯は行番号・本文と同じフォントの鏡に描く（外側の #editor に描くと、UI のフォントの文字幅で計算されてずれる）
    assert.deepEqual(
      await q(`[getComputedStyle(document.querySelector('#ed-mirror')).backgroundImage.includes('linear-gradient'), getComputedStyle(document.querySelector('#editor')).backgroundImage]`),
      [true, 'none'],
    );
    const ok = { stripeMatches: true, numberFits: true, inputMatches: true };
    for (const z of ['0.5', '1', '3']) assert.deepEqual(await measure(z), ok, `拡大率 ${z}`);
    // 1 万行を超える（5 桁の）文書でも同じ
    const original = await q(`document.querySelector('#ed-input').value`);
    await q(`(() => { const ta = document.querySelector('#ed-input'); ta.value = Array.from({ length: 12000 }, (_, i) => 'x' + i).join('\\n'); ta.dispatchEvent(new Event('input')); return true; })()`);
    for (const z of ['1', '3']) assert.deepEqual(await measure(z), ok, `5 桁・拡大率 ${z}`);
    await q(`(() => { const ta = document.querySelector('#ed-input'); ta.value = ${JSON.stringify(original)}; ta.dispatchEvent(new Event('input')); document.documentElement.style.setProperty('--zoom', '1'); return true; })()`);
  });

  await step('鏡と textarea の文字位置が重なっている（折り返し・行の高さが一致）', async () => {
    const r = await q(`(() => {
      const ta = document.querySelector('#ed-input');
      const mirror = document.querySelector('#ed-mirror');
      const cs1 = getComputedStyle(ta), cs2 = getComputedStyle(mirror);
      const keys = ['fontFamily','fontSize','lineHeight','paddingTop','paddingLeft','paddingRight','whiteSpace','overflowWrap','tabSize'];
      const diff = keys.filter(k => cs1[k] !== cs2[k]);
      return { diff, sameScrollHeight: Math.abs(ta.scrollHeight - mirror.scrollHeight) <= 1, sameClientWidth: ta.clientWidth === mirror.clientWidth };
    })()`);
    assert.deepEqual(r, { diff: [], sameScrollHeight: true, sameClientWidth: true });
  });

  await step('リアルタイム検索: 入力のたびにヒットが強調される', async () => {
    await q(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true }))`);
    assert.equal(await q(`document.querySelector('#search').hidden`), false);
    await q(`(() => { const i = document.querySelector('#search-input'); i.value = '誤記'; i.dispatchEvent(new Event('input')); })()`);
    assert.equal(await q(`document.querySelectorAll('#ed-mirror .hit').length`), 81);
    assert.equal(await q(`document.querySelectorAll('#ed-mirror .hit-cur').length`), 1);
    assert.match(await q(`document.querySelector('#search-count').textContent`), /^1 \/ 81 件$/);
    assert.equal(await q(`document.querySelector('#ed-mirror').textContent === document.querySelector('#ed-input').value`), true);
    // ヒットした行のクラスと、右側のマーク（左側の目印は付けない。マークはスクロールバーと重ならない）
    const marks = await q(`(() => {
      const ta = document.querySelector('#ed-input');
      const ruler = document.querySelector('#ed-ruler').getBoundingClientRect();
      const scrollbarLeft = ta.getBoundingClientRect().left + ta.clientLeft + ta.clientWidth;
      const line = document.querySelector('#ed-mirror .ln-hit');
      return {
        lines: document.querySelectorAll('#ed-mirror .ed-line.ln-hit').length,
        cur: document.querySelectorAll('#ed-mirror .ed-line.ln-hit-cur').length,
        leftMark: getComputedStyle(line, '::after').content,
        numberWeight: getComputedStyle(line, '::before').fontWeight,
        ruler: document.querySelectorAll('#ed-ruler i').length,
        rulerCur: document.querySelectorAll('#ed-ruler i.cur').length,
        clearOfScrollbar: ruler.right <= scrollbarLeft,
        rulerWidth: ruler.width,
        clearOfText: ruler.left >= ta.getBoundingClientRect().left + ta.clientLeft + ta.clientWidth - parseFloat(getComputedStyle(ta).paddingRight),
      };
    })()`);
    assert.equal(marks.lines, 81);
    assert.equal(marks.cur, 1);
    assert.equal(marks.leftMark, 'none', '左側の目印は無い');
    assert.equal(marks.numberWeight, '400', '行番号は強調しない');
    assert.equal(marks.clearOfScrollbar, true, 'マークはスクロールバーの左に出る');
    assert.equal(marks.rulerWidth, 12, 'マークの幅');
    assert.equal(marks.clearOfText, true, 'マークは本文の右余白に収まる');
    assert.ok(marks.ruler > 10, `スクロールバー上のマーク: ${marks.ruler}`);
    assert.equal(marks.rulerCur, 1);
  });

  await step('元に戻す / やり直し ボタン（ツールバー 2 段目）', async () => {
    await q(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    const r = await q(`(() => {
      const ta = document.querySelector('#ed-input');
      ta.focus(); ta.setSelectionRange(0, 0);
      document.execCommand('insertText', false, 'UNDO-TEST');
      const typed = ta.value.startsWith('UNDO-TEST');
      const dirty = document.title.startsWith('●');
      document.querySelector('#tools [data-action=undo]').click();
      const undone = !ta.value.startsWith('UNDO-TEST');
      document.querySelector('#tools [data-action=redo]').click();
      const redone = ta.value.startsWith('UNDO-TEST');
      document.querySelector('#tools [data-action=undo]').click();
      return { typed, dirty, undone, redone, clean: !document.title.startsWith('●') };
    })()`);
    assert.deepEqual(r, { typed: true, dirty: true, undone: true, redone: true, clean: true });
    assert.equal(await q(`document.querySelectorAll('#ed-mirror .hit').length`), 0);
  });

  await step('記法ボタン: 太字で囲み、もう一度押すと外れる', async () => {
    const r = await q(`(() => {
      const ta = document.querySelector('#ed-input');
      const pos = ta.value.indexOf('末尾');
      ta.focus(); ta.setSelectionRange(pos, pos + 2);
      document.querySelector('[data-tool=bold]').click();
      const once = ta.value.includes('**末尾**');
      document.querySelector('[data-tool=bold]').click();
      return { once, twice: ta.value.includes('**末尾**'), same: document.querySelector('#ed-mirror').textContent === ta.value };
    })()`);
    assert.deepEqual(r, { once: true, twice: false, same: true });
  });

  await step('2ペイン: 編集側のスクロールにプレビューが追従する', async () => {
    await q(`document.querySelector('[data-mode=split]').click()`);
    assert.equal(await q('document.body.dataset.mode'), 'split');
    await sleep(300);
    const r = await q(`(async () => {
      const ta = document.querySelector('#ed-input');
      const pv = document.querySelector('#preview');
      const ed = window.__mvpEditor;
      const line = ta.value.split('\\n').findIndex(l => l === '## 節 40');
      ta.scrollTop = ed.lineTop(line) - ed.paddingTop();
      ta.dispatchEvent(new Event('scroll'));
      await new Promise(r => setTimeout(r, 200));
      const h = [...pv.shadowRoot.querySelectorAll('h2')].find(e => e.textContent === '節 40');
      const off = h.getBoundingClientRect().top - pv.getBoundingClientRect().top;
      return { previewTop: pv.scrollTop, headingOffset: Math.round(off) };
    })()`);
    assert.ok(r.previewTop > 0, 'プレビューがスクロールしていない');
    assert.ok(Math.abs(r.headingOffset) < 60, `対応する見出しが上端付近に無い: ${r.headingOffset}px`);
  });

  await step('保存: Shift_JIS で表せない文字は確認の上「?」になり、文字コードと CRLF は保たれる', async () => {
    await q(`(() => {
      const ta = document.querySelector('#ed-input');
      const pos = ta.value.indexOf('末尾');
      ta.focus(); ta.setSelectionRange(pos, pos);
      document.execCommand('insertText', false, '修正😀');
    })()`);
    assert.equal(await q(`document.querySelector('#ed-input').value.includes('修正😀末尾')`), true, 'キャレット位置に挿入される');
    await main.evaluate('globalThis.__dialogCalls.length = 0');
    await q(`document.querySelector('#btn-save').click()`);
    await waitFor(() => q(`!document.title.startsWith('●')`), { label: '保存完了' });
    assert.equal(await q('window.__mvpState.savedText === document.querySelector("#ed-input").value'), true, '保存後の本文と画面が一致');
    const calls = await main.evaluate('globalThis.__dialogCalls.map(c => c.detail ?? c.message)');
    assert.equal(calls.length, 1);
    assert.match(calls[0], /「😀」/);
    const bytes = fs.readFileSync(samplePath);
    const text = Encoding.convert(bytes, { to: 'UNICODE', from: 'SJIS', type: 'string' });
    assert.ok(text.includes('修正?末尾'), '変換できない文字は ? で保存される');
    assert.equal(text.replace(/\r\n/g, '').includes('\n'), false, 'LF 単独の改行が混ざっていない');
    assert.equal(Encoding.detect(bytes), 'SJIS');
    assert.equal(await q(`document.querySelector('#ed-input').value.includes('修正?末尾')`), true, '編集画面にも反映');
  });

  await step('外部変更: 未編集なら自動で読み直す', async () => {
    const bytes = fs.readFileSync(samplePath);
    const text = Encoding.convert(bytes, { to: 'UNICODE', from: 'SJIS', type: 'string' }).replace('末尾', '外部で変更');
    fs.writeFileSync(samplePath, Buffer.from(Encoding.convert(text, { to: 'SJIS', from: 'UNICODE', type: 'arraybuffer' })));
    await main.evaluate(`globalThis.__mvp.visibleContexts().forEach(c => c.win.emit('focus'))`);
    await waitFor(() => q(`document.querySelector('#ed-input').value.includes('外部で変更')`), { label: '再読み込み' });
    assert.equal(await q('document.body.dataset.mode'), 'split', 'モードは保たれる');
  });

  await step('外部変更: 編集中なら上書きせず通知を出す', async () => {
    await q(`(() => { const ta = document.querySelector('#ed-input'); ta.focus(); ta.setSelectionRange(0, 0); document.execCommand('insertText', false, 'X'); })()`);
    fs.appendFileSync(samplePath, Buffer.from('\r\nappended'));
    await main.evaluate(`globalThis.__mvp.visibleContexts().forEach(c => c.win.emit('focus'))`);
    await waitFor(() => q(`!document.querySelector('#banner').hidden`), { label: '通知' });
    assert.equal(await q(`document.querySelector('#ed-input').value.startsWith('X')`), true);
  });

  await step('テーマ: 明暗とカラーテーマは 表示 > テーマ... の画面 1 つで選ぶ（ツールバーにテーマのボタンは無い）', async () => {
    const dark = () => q(`matchMedia('(prefers-color-scheme: dark)').matches`);
    assert.equal(await q(`document.querySelector('#btn-theme')`), null);
    const before = await q(`document.body.dataset.theme`);
    await clickMenu(['表示(&V)', 'テーマ(&T)...']);
    await waitFor(() => q(`document.querySelector('#theme-dialog').open`), { label: 'テーマ画面（メニュー）' });
    assert.equal(await q(`document.body.dataset.theme`), before, '開くだけでは明暗は変わらない');
    assert.equal(await q(`document.querySelector('#theme-dialog-title').textContent`), 'テーマ');
    assert.equal(await q(`document.querySelector('#theme-dialog .td-mode-label').textContent`), 'Windowsテーマ');
    // 画面の明暗ボタンで切り替え、設定が保存される
    await q(`document.querySelector('.td-mode-btn[data-mode=dark]').click()`);
    await waitFor(() => q(`document.body.dataset.theme === 'dark'`), { label: 'ダーク' });
    assert.equal(await dark(), true);
    assert.equal(await q(`getComputedStyle(document.body).backgroundColor`), 'rgb(13, 17, 23)');
    await q(`document.querySelector('.td-mode-btn[data-mode=light]').click()`);
    await waitFor(() => q(`document.body.dataset.theme === 'light'`), { label: 'ライト' });
    assert.equal(await dark(), false);
    assert.equal(await q(`getComputedStyle(document.body).backgroundColor`), 'rgb(255, 255, 255)');
    const saved = JSON.parse(fs.readFileSync(path.join(work, 'userData', 'settings.json'), 'utf8'));
    assert.equal(saved.theme, 'light');
    await q(`document.querySelector('.td-mode-btn[data-mode=system]').click()`);
    await waitFor(() => q(`document.body.dataset.theme === 'system'`), { label: 'システムに戻す' });
    await q(`document.querySelector('#theme-dialog').close()`);
  });

  await step('カラーテーマ: 専用画面で今の明暗のテーマ 8 つだけが表示され、選ぶと保存される', async () => {
    await clickMenu(['表示(&V)', 'テーマ(&T)...']);
    await waitFor(() => q(`document.querySelector('#theme-dialog').open`), { label: '選択画面' });
    const visible = () => q(`({
      light: [...document.querySelectorAll('.theme-card[data-scheme=light]')].filter((c) => c.offsetParent !== null).length,
      dark: [...document.querySelectorAll('.theme-card[data-scheme=dark]')].filter((c) => c.offsetParent !== null).length,
    })`);
    // 明暗をライトにすると、ライト用の 8 つだけが表示される
    await q(`document.querySelector('.td-mode-btn[data-mode=light]').click()`);
    await waitFor(() => q(`document.body.dataset.theme === 'light'`), { label: 'ライト' });
    await waitFor(async () => (await visible()).light === 8, { label: 'ライト用の表示' });
    assert.deepEqual(await visible(), { light: 8, dark: 0 });
    await q(`document.querySelector('.theme-card[data-scheme=light][data-id=sakura]').click()`);
    await waitFor(() => q(`document.body.dataset.palette === 'light:sakura'`), { label: '桜色' });
    const sakura = await q(`({
      body: getComputedStyle(document.body).backgroundColor,
      preview: getComputedStyle(document.querySelector('#preview').shadowRoot.querySelector('article')).color,
      pressed: document.querySelector('.theme-card[data-scheme=light][data-id=sakura]').getAttribute('aria-pressed'),
    })`);
    assert.deepEqual(sakura, { body: 'rgb(255, 250, 251)', preview: 'rgb(61, 42, 48)', pressed: 'true' });
    // 明暗をダークにすると、ダーク用で選んだ「夜桜」が使われる
    await q(`document.querySelector('.td-mode-btn[data-mode=dark]').click()`);
    await waitFor(() => q(`document.body.dataset.palette === 'dark:standard'`), { label: 'ダーク標準' });
    await waitFor(async () => (await visible()).dark === 8, { label: 'ダーク用の表示' });
    assert.deepEqual(await visible(), { light: 0, dark: 8 });
    await q(`document.querySelector('.theme-card[data-scheme=dark][data-id=yozakura]').click()`);
    await waitFor(() => q(`document.body.dataset.palette === 'dark:yozakura'`), { label: '夜桜' });
    assert.equal(await q(`getComputedStyle(document.body).backgroundColor`), 'rgb(28, 20, 24)');
    const saved = JSON.parse(fs.readFileSync(path.join(work, 'userData', 'settings.json'), 'utf8'));
    assert.deepEqual([saved.theme, saved.lightTheme, saved.darkTheme], ['dark', 'sakura', 'yozakura']);
    // 元に戻す
    await q(`document.querySelector('.theme-card[data-scheme=dark][data-id=standard]').click()`);
    await q(`window.mvp.setPalette('light', 'standard')`);
    await q(`document.querySelector('.td-mode-btn[data-mode=system]').click()`);
    await waitFor(() => q(`document.body.dataset.theme === 'system'`), { label: 'システムに戻す' });
    await q(`document.querySelector('#theme-dialog').close()`);
  });

  await step('区切りのアクティブ時の色は控えめ（アクセント色ではなくテーマの区切り色）', async () => {
    const r = await q(`(() => {
      const sp = document.querySelector('#splitter');
      sp.classList.add('dragging');
      const line = getComputedStyle(sp, '::before').backgroundColor;
      const accent = getComputedStyle(document.querySelector('.mode-switch [aria-pressed=true]')).backgroundColor;
      sp.classList.remove('dragging');
      return { line, accent };
    })()`);
    assert.notEqual(r.line, r.accent);
  });

  await step('サードパーティのライセンス: ヘルプ メニューから開け、組み込んだライブラリの著作権表示とライセンス文がある', async () => {
    await clickMenu(['ヘルプ(&H)', 'サードパーティのライセンス(&L)']);
    await waitFor(() => q(`document.querySelector('#licenses-dialog').open && document.querySelector('#licenses-text').textContent.length > 1000`), { label: 'ライセンス一覧' });
    const text = await q(`document.querySelector('#licenses-text').textContent`);
    for (const word of ['marked', 'DOMPurify', 'gemoji', 'highlight.js', 'encoding-japanese', 'Apache License', 'MIT License', 'BSD 3-Clause License', 'Copyright', 'LICENSES.chromium.html']) {
      assert.ok(text.includes(word), `「${word}」が無い`);
    }
    await q(`document.querySelector('#licenses-dialog').close()`);
  });

  await step('バージョン情報に作成者が表示される', async () => {
    await main.evaluate('globalThis.__dialogCalls.length = 0');
    await clickMenu(['ヘルプ(&H)', 'バージョン情報(&A)']);
    const detail = await waitFor(() => main.evaluate('globalThis.__dialogCalls[0]?.detail'), { label: 'バージョン情報' });
    assert.match(detail, /作成者: Tomoaki Bessho/);
    // バージョン情報の「サードパーティのライセンス...」ボタンからも開ける
    await main.evaluate(`(() => {
      globalThis.__mvp.dialog.showMessageBox = async () => ({ response: 1 });
      return true;
    })()`);
    await clickMenu(['ヘルプ(&H)', 'バージョン情報(&A)']);
    await waitFor(() => q(`document.querySelector('#licenses-dialog').open`), { label: 'バージョン情報からライセンス一覧' });
    await q(`document.querySelector('#licenses-dialog').close()`);
    await main.evaluate(`(() => {
      globalThis.__mvp.dialog.showMessageBox = async (_w, opts) => { globalThis.__dialogCalls.push(opts ?? _w); return { response: 0 }; };
      return true;
    })()`);
  });

  await step('ステータスバー: モード・文字数・未保存・検索件数', async () => {
    const r = await q(`({
      mode: document.querySelector('#st-mode').textContent,
      chars: document.querySelector('#st-chars').textContent,
      dirty: !document.querySelector('#st-dirty').hidden,
    })`);
    assert.equal(r.mode, '2ペイン');
    assert.match(r.chars, /^[\d,]+ 文字$/);
    assert.equal(r.dirty, true, '編集中の変更がある');
    await q(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true }))`);
    await q(`(() => { const i = document.querySelector('#search-input'); i.value = '段落'; i.dispatchEvent(new Event('input')); })()`);
    assert.match(await q(`document.querySelector('#st-search').textContent`), /^検索: 1 \/ \d+ 件$/);
    await q(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    assert.equal(await q(`document.querySelector('#st-search').hidden`), true);
  });

  await step('設定画面: タスクトレイへの常駐を切り替えられる（既定は常駐しない）', async () => {
    assert.equal(await main.evaluate('globalThis.__mvp.tray === null'), true, '既定ではトレイに常駐しない');
    await clickMenu(['ファイル(&F)', '設定(&T)...']);
    await waitFor(() => q(`document.querySelector('#settings-dialog').open`), { label: '設定画面' });
    assert.equal(await q(`document.querySelector('#setting-resident').checked`), false);
    // 外観（明暗・カラーテーマ）は設定画面に置かない（テーマ画面に一本化）
    assert.equal(await q(`document.querySelectorAll('#settings-dialog .td-mode-btn, #settings-dialog .sd-themes').length`), 0);
    await q(`document.querySelector('#setting-resident').click()`);
    await waitFor(() => main.evaluate('globalThis.__mvp.tray !== null'), { label: 'トレイ作成' });
    let saved = JSON.parse(fs.readFileSync(path.join(work, 'userData', 'settings.json'), 'utf8'));
    assert.equal(saved.resident, true);
    await q(`document.querySelector('#setting-resident').click()`);
    await waitFor(() => main.evaluate('globalThis.__mvp.tray === null'), { label: 'トレイ破棄' });
    saved = JSON.parse(fs.readFileSync(path.join(work, 'userData', 'settings.json'), 'utf8'));
    assert.equal(saved.resident, false);
    await q(`document.querySelector('#settings-dialog').close()`);
  });

  await step('空のウィンドウ: 拡大縮小は動作せず、外から開いたファイルはそのウィンドウに読み込まれる', async () => {
    const other = path.join(work, 'other.md');
    fs.writeFileSync(other, '# 別の文書\n\n本文\n');
    // 空のウィンドウを開く（ファイル無しで起動したときと同じ）
    await main.evaluate('globalThis.__mvp.openEmptyWindow().then(() => true)');
    const emptyState = () =>
      main.evaluate(`(async () => {
        const c = globalThis.__mvp.visibleContexts().find((x) => !x.doc);
        if (!c) return null;
        return c.win.webContents.executeJavaScript(\`(() => {
          const before = document.querySelector('#btn-zoom-reset').textContent;
          document.querySelector('#btn-zoom-in').click();
          window.dispatchEvent(new KeyboardEvent('keydown', { key: '+', ctrlKey: true }));
          window.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, cancelable: true }));
          const ids = ['#btn-save', '#btn-save-as', '#btn-reload', '#btn-auto-reload', '#btn-breaks', '#btn-width', '#btn-zoom-in', '#btn-find'];
          const buttons = [...ids.map((s) => document.querySelector(s)), ...document.querySelectorAll('.mode-switch button')];
          return {
            // 1 段目のボタンは隠さず、非活性で見せる（明暗ボタンだけは文書に関係なく使える）
            toolbar: buttons.every((b) => b.offsetParent !== null && b.disabled),
            empty: document.body.classList.contains('is-empty'),
            disabled: ['#btn-zoom-in', '#btn-zoom-out', '#btn-zoom-reset'].map((s) => document.querySelector(s).disabled),
            unchanged: document.querySelector('#btn-zoom-reset').textContent === before,
            zoom: getComputedStyle(document.documentElement).getPropertyValue('--zoom').trim(),
          };
        })()\`);
      })()`);
    const empty = await waitFor(() => emptyState(), { label: '空のウィンドウ' });
    assert.deepEqual(empty, { toolbar: true, empty: true, disabled: [true, true, true], unchanged: true, zoom: '1' });
    const windowsBefore = await main.evaluate('globalThis.__mvp.visibleContexts().length');
    // エクスプローラーのダブルクリック等と同じく、開き先を指定せずにファイルを開く
    await main.evaluate(`globalThis.__mvp.openFile(${JSON.stringify(other)}).then(() => true)`);
    const after = await main.evaluate(`(async () => {
      const list = globalThis.__mvp.visibleContexts();
      const c = list.find((x) => x.doc?.path === ${JSON.stringify(other)});
      return {
        windows: list.length,
        emptyLeft: list.filter((x) => !x.doc).length,
        zoomEnabled: await c.win.webContents.executeJavaScript("!document.querySelector('#btn-zoom-in').disabled"),
      };
    })()`);
    assert.deepEqual(after, { windows: windowsBefore, emptyLeft: 0, zoomEnabled: true }, '新しいウィンドウは増えず、空のウィンドウに読み込まれる');
    // 後片付け（元のウィンドウ 1 つに戻す）
    await main.evaluate(`globalThis.__mvp.visibleContexts().find((x) => x.doc?.path === ${JSON.stringify(other)}).win.close()`);
    await waitFor(() => main.evaluate(`globalThis.__mvp.visibleContexts().length === ${windowsBefore - 1}`), { label: '後片付け' });
  });

  // 別のウィンドウで開いた文書のページに接続する（タイトルにファイル名が入るのを待つ）
  const pageFor = async (fileName) => {
    const target = await waitFor(
      async () => (await targets(rendererPort)).find((t) => t.type === 'page' && t.title.includes(fileName)),
      { label: `${fileName} のウィンドウ` },
    );
    const p = await connect(target.webSocketDebuggerUrl);
    return { q: (expr) => p.evaluate(expr), close: () => p.close() };
  };

  await step('別名で保存: 文字コード・改行コードを保ったまま別ファイルに保存し、以後はそのファイルを編集する', async () => {
    const src = path.join(work, 'saveas-src.md');
    const dst = path.join(work, 'saveas-dst.md');
    fs.writeFileSync(src, Buffer.from(Encoding.convert('# 元の文書\r\n\r\n本文です。\r\n', { to: 'SJIS', from: 'UNICODE', type: 'arraybuffer' })));
    await main.evaluate(`globalThis.__mvp.openFile(${JSON.stringify(src)}).then(() => true)`);
    const w = await pageFor('saveas-src.md');
    await w.q(`document.querySelector('[data-mode=edit]').click()`);
    await w.q(`(() => { const ta = document.querySelector('#ed-input'); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); document.execCommand('insertText', false, '追記\\n'); })()`);
    await main.evaluate(`(() => {
      globalThis.__mvp.dialog.showSaveDialog = async () => ({ canceled: false, filePath: ${JSON.stringify(dst)} });
      return true;
    })()`);
    await w.q(`document.querySelector('#btn-save-as').click()`);
    await waitFor(() => w.q(`document.title === 'saveas-dst.md - MarkdownViewerPlus'`), { label: '別名で保存' });
    const text = Encoding.convert(fs.readFileSync(dst), { to: 'UNICODE', from: 'SJIS', type: 'string' });
    assert.equal(Encoding.detect(fs.readFileSync(dst)), 'SJIS', '文字コードは元のまま');
    assert.equal(text, '# 元の文書\r\n\r\n本文です。\r\n追記\r\n', '改行コード（CRLF）も元のまま');
    assert.equal(Encoding.convert(fs.readFileSync(src), { to: 'UNICODE', from: 'SJIS', type: 'string' }).includes('追記'), false, '元のファイルは変わらない');
    assert.match(await w.q(`document.querySelector('#st-path').textContent`), /saveas-dst\.md$/);
    const recent = JSON.parse(fs.readFileSync(path.join(work, 'userData', 'settings.json'), 'utf8')).recent;
    assert.equal(recent[0], dst, '最近開いたファイルの先頭に入る');
    globalThis.__saveAsWindow = w;
  });

  await step('手動の再読み込み・自動再読み込み（既定はオン）', async () => {
    const w = globalThis.__saveAsWindow;
    const dst = path.join(work, 'saveas-dst.md');
    const writeSjis = (t) => fs.writeFileSync(dst, Buffer.from(Encoding.convert(t, { to: 'SJIS', from: 'UNICODE', type: 'arraybuffer' })));
    const value = () => w.q(`document.querySelector('#ed-input').value`);
    // 既定はオン: 外部で変更されると、フォーカスが無くても自動で読み直す
    assert.equal(await w.q(`document.querySelector('#btn-auto-reload').getAttribute('aria-pressed')`), 'true');
    writeSjis('# 自動で読み直す\r\n');
    await waitFor(async () => (await value()) === '# 自動で読み直す\n', { label: '自動再読み込み', timeout: 8000 });
    // オフにすると読み直さず、通知だけ出す
    await w.q(`document.querySelector('#btn-auto-reload').click()`);
    await waitFor(() => w.q(`document.querySelector('#btn-auto-reload').getAttribute('aria-pressed') === 'false'`), { label: 'オフ' });
    await sleep(1200);
    writeSjis('# 手動で読み直す\r\n');
    await waitFor(() => w.q(`!document.querySelector('#banner').hidden`), { label: '通知', timeout: 8000 });
    assert.equal(await value(), '# 自動で読み直す\n', 'オフのときは読み直さない');
    // 手動の再読み込み（ツールバーのボタン）
    await w.q(`document.querySelector('#btn-reload').click()`);
    await waitFor(async () => (await value()) === '# 手動で読み直す\n', { label: '手動再読み込み' });
    // 編集中なら確認してから読み直す
    await main.evaluate(`(() => {
      globalThis.__dialogCalls.length = 0;
      globalThis.__mvp.dialog.showMessageBox = async (_w, opts) => { globalThis.__dialogCalls.push(opts); return { response: 0 }; };
      return true;
    })()`);
    await w.q(`(() => { const ta = document.querySelector('#ed-input'); ta.focus(); ta.setSelectionRange(0, 0); document.execCommand('insertText', false, 'Y'); })()`);
    await w.q(`document.querySelector('#btn-reload').click()`);
    await waitFor(async () => (await value()) === '# 手動で読み直す\n', { label: '編集中の再読み込み' });
    const calls = await main.evaluate('globalThis.__dialogCalls.map((c) => c.message)');
    assert.equal(calls.length, 1);
    assert.match(calls[0], /読み直しますか/);
    // 設定を元に戻す（オン）
    await w.q(`document.querySelector('#btn-auto-reload').click()`);
    await waitFor(() => w.q(`document.querySelector('#btn-auto-reload').getAttribute('aria-pressed') === 'true'`), { label: 'オンに戻す' });
  });

  await step('改行で折り返す（ツールバーで切替）と表示幅', async () => {
    const w = globalThis.__saveAsWindow;
    fs.writeFileSync(path.join(work, 'saveas-dst.md'), Buffer.from(Encoding.convert('一行目\r\n二行目\r\n三行目\r\n', { to: 'SJIS', from: 'UNICODE', type: 'arraybuffer' })));
    await waitFor(async () => (await w.q(`document.querySelector('#ed-input').value`)) === '一行目\n二行目\n三行目\n', { label: '読み直し', timeout: 8000 });
    await w.q(`document.querySelector('[data-mode=view]').click()`);
    const br = () => w.q(`document.querySelector('#preview').shadowRoot.querySelectorAll('article p br').length`);
    assert.equal(await br(), 0, '既定はオフ（Markdown の標準どおり）');
    await w.q(`document.querySelector('#btn-breaks').click()`);
    await waitFor(async () => (await br()) === 2, { label: '改行で折り返す' });
    await w.q(`document.querySelector('#btn-breaks').click()`);
    await waitFor(async () => (await br()) === 0, { label: '元に戻す' });
    // 表示幅（ボタンのメニューで選ぶのと同じ設定を変更する）
    const width = () => w.q(`getComputedStyle(document.querySelector('#preview').shadowRoot.querySelector('article')).maxWidth`);
    assert.equal(await width(), '980px');
    await w.q(`window.mvp.setSetting('previewWidth', 'narrow')`);
    await waitFor(async () => (await width()) === '720px', { label: '狭い' });
    await w.q(`window.mvp.setSetting('previewWidth', 'full')`);
    await waitFor(async () => (await width()) === 'none', { label: 'ウィンドウいっぱい' });
    await w.q(`window.mvp.setSetting('previewWidth', 'standard')`);
    await waitFor(async () => (await width()) === '980px', { label: '標準に戻す' });
    const saved = JSON.parse(fs.readFileSync(path.join(work, 'userData', 'settings.json'), 'utf8'));
    assert.deepEqual([saved.autoReload, saved.breaks, saved.previewWidth], [true, false, 'standard']);
    // 改行で折り返す・表示幅のボタンは、プレビューを出さない編集モードでだけ無効（オン / オフの表示は残る）
    const disabled = {};
    for (const m of ['view', 'edit', 'split', 'edit', 'view']) {
      await w.q(`document.querySelector('[data-mode=${m}]').click()`);
      disabled[m] = await w.q(`['#btn-breaks', '#btn-width'].map((s) => document.querySelector(s).disabled)`);
    }
    assert.deepEqual(disabled, { view: [false, false], edit: [true, true], split: [false, false] });
    // 編集モードのまま文書を読み直しても（ボタンを一度有効にする処理が走っても）無効のまま
    await w.q(`document.querySelector('[data-mode=edit]').click()`);
    await main.evaluate(`globalThis.__mvp.visibleContexts().find((x) => x.doc?.path.endsWith('saveas-dst.md')).win.webContents.send('menu:command', 'reload'), true`);
    await sleep(500);
    assert.deepEqual(await w.q(`['#btn-breaks', '#btn-width'].map((s) => document.querySelector(s).disabled)`), [true, true]);
    assert.equal(await w.q(`document.body.dataset.mode`), 'edit');
    // 後片付け
    w.close();
    await main.evaluate(`globalThis.__mvp.visibleContexts().find((x) => x.doc?.path.endsWith('saveas-dst.md')).win.close()`);
    await waitFor(() => main.evaluate(`!globalThis.__mvp.visibleContexts().some((x) => x.doc?.path.endsWith('saveas-dst.md'))`), { label: '後片付け' });
  });

  await step('ファイル メニューの「新しいウィンドウ」: 少しずらした位置に空のウィンドウが開き、最近開いたファイルは 3 件分の高さ', async () => {
    const before = await main.evaluate('globalThis.__mvp.visibleContexts().length');
    // 開いているウィンドウから右下へ少しずらした位置を求める（画面に出さないテストではウィンドウの位置が反映されないため、
    // 位置の計算を確かめる。実際に表示したときの位置は temp の実表示の確認で見る）
    const cascade = await main.evaluate(`(() => {
      const ref = globalThis.__mvp.visibleContexts().at(-1).win.getBounds();
      const pos = globalThis.__mvp.cascadePosition([1100, 820]);
      return { dx: pos.x - ref.x, dy: pos.y - ref.y };
    })()`);
    assert.deepEqual(cascade, { dx: 28, dy: 28 });
    await clickMenu(['ファイル(&F)', '新しいウィンドウ(&N)']);
    await waitFor(() => main.evaluate(`globalThis.__mvp.visibleContexts().length === ${before + 1}`), { label: '新しいウィンドウ' });
    // 空のウィンドウは 1 つだけ: もう一度「新しいウィンドウ」やファイル無しの 2 つ目の起動をしても増えず、既存の空のウィンドウを使う
    await clickMenu(['ファイル(&F)', '新しいウィンドウ(&N)']);
    const again = await main.evaluate(`(async () => {
      const first = globalThis.__mvp.visibleContexts().find((x) => !x.doc);
      const ctx = await globalThis.__mvp.openEmptyWindow();
      const list = globalThis.__mvp.visibleContexts();
      return { windows: list.length, empty: list.filter((x) => !x.doc).length, same: ctx === first };
    })()`);
    assert.deepEqual(again, { windows: before + 1, empty: 1, same: true }, '空のウィンドウは増えない');
    // 空のウィンドウのメニューでは「新しいウィンドウ」が無効、文書を開いたウィンドウでは有効
    const enabled = await waitFor(
      () =>
        main.evaluate(`(() => {
          const item = (c) => c.menu?.items.find((m) => __plain(m.label) === 'ファイル(&F)').submenu.items.find((m) => __plain(m.label) === '新しいウィンドウ(&N)').enabled;
          const list = globalThis.__mvp.visibleContexts();
          const r = { empty: item(list.find((x) => !x.doc)), doc: item(list.find((x) => x.doc)) };
          return r.empty === false ? r : null;
        })()`),
      { label: '空のウィンドウのメニュー' },
    );
    assert.deepEqual(enabled, { empty: false, doc: true });
    await waitFor(
      () =>
        main.evaluate(`(async () => {
          const c = globalThis.__mvp.visibleContexts().find((x) => !x.doc);
          await c.ready;
          return c.win.webContents.executeJavaScript("document.body.classList.contains('is-empty')");
        })()`),
      { label: '空の画面' },
    );
    // 最近開いたファイルは 3 件分の高さだけ見せ、それより多いとスクロールバーを出す
    const recent = await main.evaluate(`globalThis.__mvp.visibleContexts().find((x) => !x.doc).win.webContents.executeJavaScript(\`(() => {
      const list = document.querySelector('#recent-list');
      const rows = [...list.children];
      const three = rows.slice(0, 3).reduce((sum, li) => sum + li.getBoundingClientRect().height, 0);
      return { count: rows.length, visible: Math.round(list.clientHeight), three: Math.round(three), scroll: list.scrollHeight > list.clientHeight, overflowY: getComputedStyle(list).overflowY };
    })()\`)`);
    assert.ok(recent.count > 3, `履歴の件数: ${recent.count}`);
    assert.equal(recent.visible, recent.three, '3 件分の高さ');
    assert.deepEqual([recent.scroll, recent.overflowY], [true, 'auto'], 'スクロールバーが出る');
    // ステータスバーは空のウィンドウでも文書を開いたウィンドウと同じ高さで、「ファイルを開いていません」と出す
    const emptyStatus = await main.evaluate(`globalThis.__mvp.visibleContexts().find((x) => !x.doc).win.webContents.executeJavaScript(\`({
      height: document.querySelector('#status').getBoundingClientRect().height,
      text: document.querySelector('#st-path').textContent,
    })\`)`);
    const docStatusHeight = await q(`document.querySelector('#status').getBoundingClientRect().height`);
    assert.deepEqual(emptyStatus, { height: docStatusHeight, text: 'ファイルを開いていません' });
    await main.evaluate(`globalThis.__mvp.visibleContexts().find((x) => !x.doc).win.close()`);
    await waitFor(() => main.evaluate(`globalThis.__mvp.visibleContexts().length === ${before}`), { label: '後片付け' });
  });

  await step('ウィンドウを狭くしてもモード切替・明暗ボタンは見切れない（左側のボタンは後ろから丸ごと隠れる）', async () => {
    const setWidth = (w) => main.evaluate(`(() => { const c = globalThis.__mvp.visibleContexts()[0]; c.win.setSize(${w}, 700); return true; })()`);
    const check = () => q(`(() => {
      const bar = document.querySelector('#tb-main').getBoundingClientRect();
      const right = document.querySelector('.tb-right').getBoundingClientRect();
      const left = document.querySelector('.tb-left');
      const lb = left.getBoundingClientRect();
      // 左側: 1 行目に見えているボタンは全体が見えていて、はみ出す分は 2 行目（見えない所）へ回っている
      const items = [...left.children].filter((e) => !e.classList.contains('sep'));
      const shown = items.filter((e) => e.getBoundingClientRect().top < lb.bottom);
      return {
        rightVisible: right.left >= bar.left && right.right <= bar.right + 0.5,
        noPartial: shown.every((e) => e.getBoundingClientRect().right <= lb.right + 0.5),
        shown: shown.length,
        total: items.length,
      };
    })()`);
    // 最小幅より狭くしようとしても「別名で保存」が隠れない幅で止まる
    await setWidth(300);
    await sleep(400);
    const narrow = await check();
    const size = await main.evaluate(`(() => { const w = globalThis.__mvp.visibleContexts()[0].win; return { width: w.getSize()[0], min: w.getMinimumSize()[0] }; })()`);
    assert.ok(size.min > 300 && size.width === size.min, `最小幅で止まる: ${JSON.stringify(size)}`);
    const saveAsShown = await q(`(() => {
      const lb = document.querySelector('.tb-left').getBoundingClientRect();
      const r = document.querySelector('#btn-save-as').getBoundingClientRect();
      return r.top < lb.bottom && r.right <= lb.right + 0.5;
    })()`);
    assert.equal(saveAsShown, true, '最小幅でも「別名で保存」が隠れない');
    assert.equal(narrow.rightVisible, true, 'モード切替・明暗が見える');
    assert.equal(narrow.noPartial, true, '途中で切れたボタンが無い');
    assert.ok(narrow.shown < narrow.total, `狭いときは左側の一部が隠れる: ${narrow.shown}/${narrow.total}`);
    await setWidth(1100);
    await sleep(300);
    const wide = await check();
    assert.equal(wide.shown, wide.total, '広いときはすべて見える');
  });

  await step('開けるかは中身で判断: テキスト（.java・.js・.cfm）は開き、バイナリはお知らせ（ダイアログなし）で知らせる', async () => {
    const files = {
      exe: path.join(work, 'tool.exe'),
      png: path.join(work, 'photo.png'),
      java: path.join(work, 'Sample.java'),
      js: path.join(work, 'code.js'),
      cfm: path.join(work, 'page.cfm'),
    };
    fs.writeFileSync(files.exe, Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00]));
    fs.writeFileSync(files.png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]));
    fs.writeFileSync(files.java, 'public class Sample {\n  // Java のソース\n}\n');
    fs.writeFileSync(files.js, 'const a = 1; // JavaScript\n');
    fs.writeFileSync(files.cfm, '<cfoutput>#now()#</cfoutput>\n');
    await main.evaluate(`(() => {
      globalThis.__dialogCalls.length = 0;
      globalThis.__mvp.dialog.showMessageBox = async (_w, opts) => { globalThis.__dialogCalls.push(opts ?? _w); return { response: 0 }; };
      return true;
    })()`);
    const toasts = () =>
      main.evaluate(`Promise.all(globalThis.__mvp.visibleContexts().map((c) => c.win.webContents.executeJavaScript(
        "document.querySelector('#toast').hidden ? '' : document.querySelector('#toast-text').textContent"))).then((a) => a.filter(Boolean))`);
    const opened = () => main.evaluate('globalThis.__mvp.visibleContexts().filter((c) => c.doc).map((c) => c.doc.path)');

    // 3 つまとめて開く（ドロップ・開くダイアログと同じ処理）: テキストは開き、バイナリ 2 件は 1 回のお知らせにまとめる
    await main.evaluate(`globalThis.__mvp.openFiles(${JSON.stringify([files.exe, files.png, files.java])}).then(() => true)`);
    const list1 = await waitFor(async () => { const t = await toasts(); return t.length ? t : null; }, { label: 'お知らせ' });
    assert.equal(list1.length, 1, 'お知らせは 1 つだけ');
    assert.match(list1[0], /^3 件中 2 件は開きませんでした: tool\.exe（表示できない種類のファイル）、photo\.png（表示できない種類のファイル）。/);
    assert.ok((await opened()).includes(files.java), '.java はテキストなので開く');

    // .js と .cfm も開ける。1 件だけの exe は、その旨を 1 文で知らせる
    for (const f of [files.js, files.cfm]) await main.evaluate(`globalThis.__mvp.openFile(${JSON.stringify(f)}).then(() => true)`);
    const paths = await opened();
    assert.ok(paths.includes(files.js) && paths.includes(files.cfm), '.js・.cfm も開く');
    await main.evaluate(`globalThis.__mvp.openFile(${JSON.stringify(files.exe)}).then(() => true)`);
    await waitFor(async () => (await toasts()).some((t) => t.startsWith('「tool.exe」は表示できない種類のファイルのため、開きませんでした。')), { label: '1 件のお知らせ' });
    assert.equal(await main.evaluate('globalThis.__dialogCalls.length'), 0, 'ダイアログは出さない');
    // マウスを乗せていても一定時間で自動的に消える（待ち時間を短くして確かめる）
    const autoHide = await main.evaluate(`globalThis.__mvp.visibleContexts().at(-1).win.webContents.executeJavaScript(\`(async () => {
      const el = document.querySelector('#toast');
      el.dispatchEvent(new MouseEvent('mouseenter'));
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      return true;
    })()\`)`);
    assert.equal(autoHide, true);
    await waitFor(async () => (await toasts()).length === 0, { label: 'お知らせが自動で消える', timeout: 12000 });

    // 後片付け（開いたウィンドウを閉じる）
    await main.evaluate(`globalThis.__mvp.visibleContexts().filter((c) => [${[files.java, files.js, files.cfm].map((f) => JSON.stringify(f)).join(',')}].includes(c.doc?.path)).forEach((c) => c.win.close())`);
    await waitFor(() => main.evaluate(`!globalThis.__mvp.visibleContexts().some((c) => /\\.(java|js|cfm)$/.test(c.doc?.path ?? ''))`), { label: '後片付け' });
  });

  await step('ヘルプ > Markdown 記法の一覧: 書き方と表示を並べて表示する', async () => {
    await clickMenu(['ヘルプ(&H)', 'Markdown 記法の一覧(&M)']);
    await waitFor(() => q(`document.querySelector('#syntax-dialog').open`), { label: '記法の一覧' });
    const r = await q(`(() => {
      const root = document.querySelector('#syntax-dialog .syn-host').shadowRoot;
      const out = (name) => [...root.querySelectorAll('.syn-row')].find((row) => row.querySelector('.syn-name').firstChild.textContent === name)?.querySelector('.syn-out');
      return {
        rows: root.querySelectorAll('.syn-row').length,
        table: !!out('表')?.querySelector('table'),
        details: !!out('折りたたみ')?.querySelector('details'),
        kbd: out('キーの表記')?.querySelectorAll('kbd').length,
        emoji: out('絵文字')?.querySelector('.emoji')?.textContent,
        task: out('タスクリスト')?.querySelectorAll('input[type=checkbox]').length,
        unsafe: !!root.querySelector('script, [onclick]'),
        alert: !!out('アラート')?.querySelector('.markdown-alert-note .markdown-alert-title'),
        footnote: !!out('脚注')?.querySelector('.footnotes li#mvp-fn-1'),
        unsupported: root.querySelector('.syn-unsupported')?.textContent.includes('数式') && !root.querySelector('.syn-unsupported').textContent.includes('脚注'),
      };
    })()`);
    assert.ok(r.rows >= 20, `記法の数: ${r.rows}`);
    assert.deepEqual({ ...r, rows: undefined }, { rows: undefined, table: true, details: true, kbd: 2, emoji: '😄', task: 2, unsafe: false, alert: true, footnote: true, unsupported: true });
    await q(`document.querySelector('#syntax-dialog').close()`);
  });

  await step('ファイルを壊さない: 読み取り専用は上書きせず、編集していない行（CP932 の NEC 特殊文字を含む）は元のバイトのまま', async () => {
    const ro = path.join(work, 'readonly.md');
    const dst = path.join(work, 'readonly-copy.md');
    const nec = Buffer.from([0x87, 0x90, 0x87, 0x40]); // ≒①（NEC 特殊文字。変換し直すと別の符号になる文字）
    const original = Buffer.concat([nec, Buffer.from('\r\n'), Buffer.from(Encoding.convert('直す行\r\n', { to: 'SJIS', from: 'UNICODE', type: 'arraybuffer' }))]);
    fs.writeFileSync(ro, original);
    fs.chmodSync(ro, 0o444);
    await main.evaluate(`globalThis.__mvp.openFile(${JSON.stringify(ro)}).then(() => true)`);
    const w = await pageFor('readonly.md');
    assert.equal(await w.q(`!document.querySelector('#st-readonly').hidden`), true, '読み取り専用と表示');
    await w.q(`document.querySelector('[data-mode=edit]').click()`);
    await w.q(`(() => { const ta = document.querySelector('#ed-input'); const i = ta.value.indexOf('直す行'); ta.focus(); ta.setSelectionRange(i, i + 3); document.execCommand('insertText', false, '直した行'); })()`);
    // 保存 → 読み取り専用の案内（キャンセル）: ファイルは変わらない
    await main.evaluate(`(() => {
      globalThis.__dialogCalls.length = 0;
      globalThis.__mvp.dialog.showMessageBox = async (_w, opts) => { globalThis.__dialogCalls.push(opts); return { response: 1 }; };
      return true;
    })()`);
    await w.q(`document.querySelector('#btn-save').click()`);
    await waitFor(() => main.evaluate('globalThis.__dialogCalls.length === 1'), { label: '読み取り専用の案内' });
    assert.match(await main.evaluate('globalThis.__dialogCalls[0].message'), /読み取り専用のため、上書き保存できません/);
    assert.ok(fs.readFileSync(ro).equals(original), '読み取り専用のファイルは変わらない');
    assert.equal(fs.statSync(ro).mode & 0o222, 0, '書き込み禁止のまま');
    // 案内から「別名で保存」を選ぶと、別のファイルに保存され、以後はそのファイルを編集する
    await main.evaluate(`(() => {
      globalThis.__mvp.dialog.showMessageBox = async () => ({ response: 0 });
      globalThis.__mvp.dialog.showSaveDialog = async () => ({ canceled: false, filePath: ${JSON.stringify(dst)} });
      return true;
    })()`);
    await w.q(`document.querySelector('#btn-save').click()`);
    await waitFor(() => w.q(`document.title === 'readonly-copy.md - MarkdownViewerPlus'`), { label: '別名で保存' });
    const saved = fs.readFileSync(dst);
    assert.ok(saved.subarray(0, 6).equals(Buffer.concat([nec, Buffer.from('\r\n')])), '編集していない行（NEC 特殊文字）は元のバイトのまま');
    assert.equal(Encoding.convert(saved.subarray(6), { to: 'UNICODE', from: 'SJIS', type: 'string' }), '直した行\r\n', 'Shift_JIS・CRLF のまま');
    assert.ok(fs.readFileSync(ro).equals(original), '元の読み取り専用ファイルは変わらない');
    // 後片付け
    w.close();
    await main.evaluate(`globalThis.__mvp.visibleContexts().find((x) => x.doc?.path === ${JSON.stringify(dst)}).win.close()`);
    await waitFor(() => main.evaluate(`!globalThis.__mvp.visibleContexts().some((x) => x.doc?.path === ${JSON.stringify(dst)})`), { label: '後片付け' });
    fs.chmodSync(ro, 0o644);
  });

  await step('Ctrl+W・ファイル > 閉じる: 未保存なら確認が出て、キャンセルでは閉じず、保存しないを選ぶと閉じる', async () => {
    const f = path.join(work, 'close-test.md');
    fs.writeFileSync(f, '# 閉じるテスト\n');
    await main.evaluate(`globalThis.__mvp.openFile(${JSON.stringify(f)}).then(() => true)`);
    const win = `globalThis.__mvp.visibleContexts().find((x) => x.doc?.path === ${JSON.stringify(f)})`;
    await waitFor(() => main.evaluate(`Boolean(${win})`), { label: '開く' });
    // 確認の応答を切り替えられるようにし、呼ばれた回数を数える
    await main.evaluate(`(() => {
      globalThis.__closeAsk = 0;
      globalThis.__closeResponse = 2;
      globalThis.__origBox = globalThis.__mvp.dialog.showMessageBox;
      globalThis.__mvp.dialog.showMessageBox = async (w, o) => {
        if (/変更を保存しますか/.test(o?.message)) { globalThis.__closeAsk++; return { response: globalThis.__closeResponse }; }
        return globalThis.__origBox(w, o);
      };
      return true;
    })()`);
    await main.evaluate(`${win}.win.webContents.executeJavaScript("(() => { const ta = document.querySelector('#ed-input'); ta.value += 'x'; ta.dispatchEvent(new Event('input')); return true; })()")`);
    await waitFor(() => main.evaluate(`${win}.dirty === true`), { label: '未保存' });
    // Ctrl+W → キャンセル
    await main.evaluate(`${win}.win.webContents.executeJavaScript("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true })), true")`);
    await waitFor(() => main.evaluate('globalThis.__closeAsk === 1'), { label: 'Ctrl+W で確認' });
    // ファイル > 閉じる → キャンセル
    await main.evaluate(`${win}.win.webContents.send('menu:command', 'close'), true`);
    await waitFor(() => main.evaluate('globalThis.__closeAsk === 2'), { label: '閉じるで確認' });
    await sleep(300);
    assert.ok(await main.evaluate(`Boolean(${win})`), 'キャンセルでは閉じない');
    assert.equal(fs.readFileSync(f, 'utf8'), '# 閉じるテスト\n', '保存されていない');
    // 保存しない → 閉じる
    await main.evaluate('globalThis.__closeResponse = 1, true');
    await main.evaluate(`${win}.win.webContents.executeJavaScript("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true })), true")`);
    await waitFor(() => main.evaluate(`!${win}`), { label: '閉じる' });
    assert.equal(fs.readFileSync(f, 'utf8'), '# 閉じるテスト\n', '保存しないので内容はそのまま');
    await main.evaluate('globalThis.__mvp.dialog.showMessageBox = globalThis.__origBox, true');
  });

  await step('外部で開けない形に置き換わると、読み直せなかったことを知らせ、読み直しを繰り返さない', async () => {
    const f = path.join(work, 'replaced.md');
    fs.writeFileSync(f, '# 元の内容\n');
    await main.evaluate(`globalThis.__mvp.openFile(${JSON.stringify(f)}).then(() => true)`);
    const win = `globalThis.__mvp.visibleContexts().find((x) => x.doc?.path === ${JSON.stringify(f)})`;
    const rq = (expr) => main.evaluate(`${win}.win.webContents.executeJavaScript(${JSON.stringify(expr)})`);
    await waitFor(() => rq(`document.querySelector('#ed-input').value === '# 元の内容\\n'`), { label: '開く' });
    const logFile = path.join(work, 'userData', 'logs', 'main.log');
    const failures = () => (fs.readFileSync(logFile, 'utf8').match(/自動再読み込みに失敗: .*replaced\.md/g) ?? []).length;
    // 外部でバイナリに置き換わる → 読み直せない旨を通知。表示は元の内容のまま
    fs.writeFileSync(f, Buffer.from([0, 1, 2, 3, 0, 0, 255, 0, 7, 0]));
    await waitFor(() => rq(`!document.querySelector('#banner').hidden && document.querySelector('#banner-text').textContent`), { label: '通知', timeout: 8000 });
    assert.match(await rq(`document.querySelector('#banner-text').textContent`), /読み込めませんでした（表示できない種類のファイル）/);
    assert.equal(await rq(`document.querySelector('#ed-input').value`), '# 元の内容\n');
    // 同じ状態のままなら、読み直しを繰り返さない
    await sleep(3000);
    assert.equal(failures(), 1, '読み直しの試みは 1 回だけ');
    // 読める内容に戻れば、自動で読み直して通知も消える
    fs.writeFileSync(f, '# 直った内容\n');
    await waitFor(() => rq(`document.querySelector('#ed-input').value === '# 直った内容\\n' && document.querySelector('#banner').hidden`), { label: '読み直し', timeout: 8000 });
    // 手動の再読み込みで読めないとき（ファイルが無い）も理由を知らせる
    await main.evaluate(`(() => { const c = ${win}; globalThis.__mvp.dialog.showMessageBox = async () => ({ response: 0 }); return true; })()`);
    fs.rmSync(f);
    await sleep(1500);
    await rq(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5' })), true`);
    await waitFor(() => rq(`/ファイルが見つかりません/.test(document.querySelector('#banner-text').textContent) && !document.querySelector('#banner').hidden`), { label: '手動の再読み込みの失敗', timeout: 5000 });
    await main.evaluate(`${win}.win.destroy(), true`);
  });

  // ---- 1.1.0 の機能（変更箇所の目印・変更点の確認・ここを直す・リンク切れ・指定行へ移動・外部変更の差分・ショートカット一覧）----
  const featPath = path.join(work, 'features.md');
  const featText = [
    '# 機能テスト', // 0
    '', // 1
    '最初の段落です。誤記があります。', // 2
    '', // 3
    '## 見出しA', // 4
    '', // 5
    '[無いファイル](nothing.md) [有るファイル](other2.md) [見出しへ](#見出しa) [無い見出し](#nothing) ![無い画像](none.png)', // 6
    '', // 7
    '二つ目の段落。誤記があります。', // 8
    '', // 9
    '末尾の行', // 10
    '',
  ].join('\n');
  fs.writeFileSync(featPath, featText);
  fs.writeFileSync(path.join(work, 'other2.md'), '# other2\n');
  const fwin = `globalThis.__mvp.visibleContexts().find((x) => x.doc?.path === ${JSON.stringify(featPath)})`;
  const fq = (expr) => main.evaluate(`${fwin}.win.webContents.executeJavaScript(${JSON.stringify(`(async () => (${expr}))()`)})`);
  const fkey = (key, opts = '') => fq(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', ${opts} })), true`);
  const fset = (text) => fq(`(() => { const ta = document.querySelector('#ed-input'); ta.value = ${JSON.stringify(text)}; ta.dispatchEvent(new Event('input')); return true; })()`);

  await step('変更箇所の目印: 変更・追加・削除した行に印が付き、元に戻すと消える', async () => {
    await main.evaluate(`globalThis.__mvp.openFile(${JSON.stringify(featPath)}).then(() => true)`);
    await waitFor(() => fq(`document.querySelector('#ed-input').value.startsWith('# 機能テスト')`), { label: '開く' });
    await fkey('2', 'ctrlKey: true');
    const lines = featText.split('\n');
    const edited = [...lines];
    edited[2] = '最初の段落です。誤字があります。'; // 変更
    edited.splice(5, 0, '追加した行'); // 追加（見出しの後）
    edited.splice(10, 1); // 「二つ目の段落」の後の空行を削除（元の 9 行目。追加で 1 つずれて 10）
    await fset(edited.join('\n'));
    const marks = await waitFor(
      () =>
        fq(`(() => {
          const r = {};
          document.querySelectorAll('#ed-mirror > .ed-line').forEach((n, i) => {
            const m = [...n.classList].find((c) => c.startsWith('chg-'));
            if (m) r[i] = m;
          });
          return Object.keys(r).length ? { r, dirty: document.querySelector('#st-dirty').textContent } : null;
        })()`),
      { label: '目印' },
    );
    assert.deepEqual(marks.r, { 2: 'chg-mod', 5: 'chg-add', 10: 'chg-del' });
    assert.equal(marks.dirty, '● 未保存（変更 3 か所）');
    // 保存済みの内容に戻すと、印も未保存の表示も消える
    await fset(featText);
    await waitFor(() => fq(`document.querySelectorAll('#ed-mirror [class*="chg-"]').length === 0 && document.querySelector('#st-dirty').hidden`), { label: '印が消える' });
  });

  await step('変更点の確認（Ctrl+D）: 差分と 1 行の中の変わった部分を表示し、そこから保存できる', async () => {
    await fset(featText.replace('最初の段落です。誤記', '最初の段落です。誤字'));
    await fkey('d', 'ctrlKey: true');
    const view = await waitFor(
      () =>
        fq(`(() => {
          const d = document.querySelector('#diff-dialog');
          if (!d.open) return null;
          return {
            title: d.querySelector('h2').textContent,
            del: [...d.querySelectorAll('.df-del .df-text')].map((t) => t.textContent),
            add: [...d.querySelectorAll('.df-add .df-text')].map((t) => t.textContent),
            marks: [...d.querySelectorAll('mark')].map((m) => m.textContent),
            count: d.querySelector('.df-count').textContent,
            buttons: [...d.querySelectorAll('.df-buttons button')].map((b) => b.textContent),
          };
        })()`),
      { label: '変更点の確認' },
    );
    assert.deepEqual(view, {
      title: '変更点の確認',
      del: ['最初の段落です。誤記があります。'],
      add: ['最初の段落です。誤字があります。'],
      marks: ['記', '字'],
      count: '1 か所',
      buttons: ['保存', '閉じる'],
    });
    await fq(`document.querySelector('#diff-dialog .df-buttons .primary').click(), true`);
    await waitFor(() => fs.readFileSync(featPath, 'utf8').includes('誤字'), { label: '保存' });
    await waitFor(() => fq(`document.querySelector('#st-dirty').hidden && !document.querySelector('#diff-dialog').open`), { label: '保存後' });
    // ステータスバーの「● 未保存」をクリックしても開く
    await fset(featText);
    await waitFor(() => fq(`!document.querySelector('#st-dirty').hidden`), { label: '未保存' });
    await fq(`document.querySelector('#st-dirty').click(), true`);
    await waitFor(() => fq(`document.querySelector('#diff-dialog').open`), { label: 'クリックで開く' });
    await fq(`document.querySelector('#diff-dialog').close('close'), true`);
  });

  await step('2 段目の右端: 右端の「変更点」ボタンで変更点の確認が開き、右から 2 番目で変更した行の印をオン / オフできる（全ウィンドウ共通で保存）', async () => {
    await fkey('2', 'ctrlKey: true');
    const order = await fq(`[...document.querySelectorAll('#tools .tools-right > button')].map((b) => b.id)`);
    assert.deepEqual(order, ['btn-marks', 'btn-changes'], '右端が変更点、その左が印の切り替え');
    // 右端（変更点）は 1 段目の右端（モード切替）とそろう。印の切り替えは 28px 角、間隔は 6px
    const align = await fq(`(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      const marks = r('#btn-marks'), changes = r('#btn-changes'), modes = r('.mode-switch');
      return { size: [marks.width, marks.height], rightAligned: changes.right === modes.right, gap: changes.left - marks.right, height: changes.height };
    })()`);
    assert.deepEqual(align, { size: [28, 28], rightAligned: true, gap: 6, height: 28 });
    // 「変更点」は枠のあるボタン
    assert.notEqual(await fq(`getComputedStyle(document.querySelector('#btn-changes')).borderTopColor`), 'rgba(0, 0, 0, 0)');
    await fset(featText.replace('末尾の行', '末尾の行（変更）'));
    const marked = () => fq(`document.querySelectorAll('#ed-mirror [class*="chg-"]').length`);
    await waitFor(async () => (await marked()) > 0, { label: '印' });
    // オフ: 印が消え、変更の数は出したまま。設定に保存される
    await fq(`document.querySelector('#btn-marks').click(), true`);
    await waitFor(async () => (await marked()) === 0 && (await fq(`document.querySelector('#btn-marks').getAttribute('aria-pressed')`)) === 'false', { label: 'オフ' });
    assert.match(await fq(`document.querySelector('#st-dirty').textContent`), /変更 \d+ か所/, '変更の数は出したまま');
    await waitFor(() => JSON.parse(fs.readFileSync(path.join(work, 'userData', 'settings.json'), 'utf8')).changeMarks === false, { label: '保存' });
    // 入力しても印は出ない
    await fset(featText.replace('末尾の行', '末尾の行（変更 2）'));
    await sleep(300);
    assert.equal(await marked(), 0);
    // オン: 印が戻る
    await fq(`document.querySelector('#btn-marks').click(), true`);
    await waitFor(async () => (await marked()) > 0, { label: 'オン' });
    // 変更点ボタン
    await fq(`document.querySelector('#btn-changes').click(), true`);
    await waitFor(() => fq(`document.querySelector('#diff-dialog').open && document.querySelector('#diff-dialog h2').textContent === '変更点の確認'`), { label: '変更点の確認' });
    await fq(`document.querySelector('#diff-dialog').close('close'), true`);
    // 狭いウィンドウでも右側の 2 つは見切れない（左側の記法ボタンが後ろから隠れる）
    await main.evaluate(`${fwin}.win.setSize(480, 600), true`);
    await sleep(300);
    const fit = await fq(`(() => {
      const row = document.querySelector('#tools').getBoundingClientRect();
      return [...document.querySelectorAll('#tools .tools-right > button')].every((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.left >= row.left && r.right <= row.right + 0.5; });
    })()`);
    assert.equal(fit, true, '右側のボタンが見える');
    await main.evaluate(`${fwin}.win.setSize(1100, 820), true`);
    await fset(featText);
  });

  await step('設定「保存の前に変更点を確認する」: キャンセルでは保存せず、「保存する」で保存する', async () => {
    await fq(`window.mvp.setSetting('confirmDiffOnSave', true), true`);
    await sleep(200);
    await fkey(',', 'ctrlKey: true');
    assert.equal(await fq(`document.querySelector('#setting-confirm-diff').checked`), true, '設定画面に反映');
    await fq(`document.querySelector('#settings-dialog').close(), true`);
    const before = fs.readFileSync(featPath, 'utf8');
    await fkey('s', 'ctrlKey: true');
    await waitFor(() => fq(`document.querySelector('#diff-dialog').open && document.querySelector('#diff-dialog h2').textContent === '保存の前に変更点を確認'`), { label: '確認' });
    await fq(`[...document.querySelectorAll('#diff-dialog .df-buttons button')].find((b) => b.textContent === 'キャンセル').click(), true`);
    await sleep(300);
    assert.equal(fs.readFileSync(featPath, 'utf8'), before, 'キャンセルでは保存しない');
    await fkey('s', 'ctrlKey: true');
    await waitFor(() => fq(`document.querySelector('#diff-dialog').open`), { label: '確認' });
    await fq(`document.querySelector('#diff-dialog .df-buttons .primary').click(), true`);
    await waitFor(() => fs.readFileSync(featPath, 'utf8') === featText, { label: '保存' });
    await fq(`window.mvp.setSetting('confirmDiffOnSave', false), true`);
  });

  await step('表示の文字をダブルクリック: 2 ペインに切り替わり、編集側で同じ文字（同じ段落の）が選択される', async () => {
    await fkey('1', 'ctrlKey: true');
    await sleep(200);
    const r = await fq(`(() => {
      const root = document.querySelector('#preview').shadowRoot;
      const p = [...root.querySelectorAll('p')].find((x) => x.textContent.startsWith('二つ目'));
      const tn = [...p.childNodes].find((n) => n.nodeType === 3);
      const i = tn.data.indexOf('誤記');
      document.getSelection().setBaseAndExtent(tn, i, tn, i + 2);
      p.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }));
      const ta = document.querySelector('#ed-input');
      return { mode: document.body.dataset.mode, selected: ta.value.slice(ta.selectionStart, ta.selectionEnd), start: ta.selectionStart, focus: document.activeElement === ta };
    })()`);
    const expectedStart = featText.indexOf('二つ目の段落。誤記') + '二つ目の段落。'.length;
    assert.deepEqual(r, { mode: 'split', selected: '誤記', start: expectedStart, focus: true });
  });

  await step('リンク切れ: 無いファイル・無い見出し・無い画像に印が付き、ステータスバーから順に移動できる', async () => {
    await fkey('1', 'ctrlKey: true');
    const st = await waitFor(() => fq(`!document.querySelector('#st-links').hidden && document.querySelector('#st-links').textContent`), { label: 'リンク切れ' });
    assert.equal(st, 'リンク切れ 3');
    const broken = await fq(`[...document.querySelector('#preview').shadowRoot.querySelectorAll('.mvp-broken')].map((e) => e.getAttribute('href') ?? e.getAttribute('alt'))`);
    assert.deepEqual(broken, ['nothing.md', '#nothing', '無い画像']);
    await fq(`document.querySelector('#st-links').click(), true`);
    assert.equal(await fq(`window.__mvpState.brokenIndex`), 0);
    // 編集モードでは出さない
    await fkey('2', 'ctrlKey: true');
    assert.equal(await fq(`document.querySelector('#st-links').hidden`), true);
    // 無かったファイルを作ってウィンドウに戻ると、調べ直して減る
    fs.writeFileSync(path.join(work, 'nothing.md'), '# 作った\n');
    await fkey('1', 'ctrlKey: true');
    await sleep(2200);
    await fq(`window.dispatchEvent(new Event('focus')), true`);
    await waitFor(() => fq(`document.querySelector('#st-links').textContent === 'リンク切れ 2'`), { label: '調べ直し' });
  });

  await step('指定行へ移動（Ctrl+G）: 編集側はその行へキャレット、表示モードはその行を表示して強調、範囲外は最後の行', async () => {
    await fkey('2', 'ctrlKey: true');
    await fkey('g', 'ctrlKey: true');
    await waitFor(() => fq(`document.querySelector('#goto-dialog').open`), { label: 'ダイアログ' });
    await fq(`(() => { document.querySelector('#goto-input').value = '9'; document.querySelector('#goto-dialog button[value=go]').click(); return true; })()`);
    // 移動はダイアログが閉じたとき（close イベント）に行う
    const pos9 = featText.split('\n').slice(0, 8).join('\n').length + 1;
    await waitFor(() => fq(`document.querySelector('#ed-input').selectionStart === ${pos9} && !document.querySelector('#goto-dialog').open`), { label: '9 行目へ' });
    // 数字でない入力では閉じない（ブラウザの検査のエラーも出さない）。全角数字は読める
    await fq(`document.querySelector('#st-pos').click(), true`);
    await fq(`(() => { document.querySelector('#goto-input').value = 'abc'; document.querySelector('#goto-dialog button[value=go]').click(); return true; })()`);
    await sleep(100);
    assert.equal(await fq(`document.querySelector('#goto-dialog').open`), true, '数字でなければ閉じない');
    await fq(`(() => { document.querySelector('#goto-input').value = '３'; document.querySelector('#goto-dialog button[value=go]').click(); return true; })()`);
    await waitFor(() => fq(`window.__mvpEditor.caretPosition().line === 3`), { label: '全角数字' });
    // 範囲外は最後の行
    await fq(`document.querySelector('#st-pos').click(), true`);
    await fq(`(() => { document.querySelector('#goto-input').value = '99999'; document.querySelector('#goto-dialog button[value=go]').click(); return true; })()`);
    await waitFor(() => fq(`window.__mvpEditor.caretPosition().line === ${featText.split('\n').length}`), { label: '最後の行へ' });
    // 表示モード: その行を含むブロックを強調
    await fkey('1', 'ctrlKey: true');
    await fkey('g', 'ctrlKey: true');
    await fq(`(() => { document.querySelector('#goto-input').value = '9'; document.querySelector('#goto-dialog button[value=go]').click(); return true; })()`);
    const flashed = await waitFor(() => fq(`(() => { const f = [...document.querySelector('#preview').shadowRoot.querySelectorAll('.mvp-flash')].map((e) => e.textContent.slice(0, 6)); return f.length ? f : null; })()`), { label: '強調' });
    assert.deepEqual(flashed, ['二つ目の段落']);
  });

  await step('外部変更の差分: 編集中に外部で変更されると「差分を見る」から外部の変更と自分の編集を並べて見られる', async () => {
    await fkey('2', 'ctrlKey: true');
    await fset(featText.replace('末尾の行', '末尾の行（自分の編集）'));
    await waitFor(() => main.evaluate(`${fwin}.dirty === true`), { label: '未保存' });
    fs.writeFileSync(featPath, featText.replace('# 機能テスト', '# 機能テスト（外部で変更）'));
    await waitFor(() => fq(`!document.querySelector('#banner').hidden && !document.querySelector('#banner-diff').hidden`), { label: '差分を見るボタン', timeout: 8000 });
    await fq(`document.querySelector('#banner-diff').click(), true`);
    const d = await waitFor(
      () =>
        fq(`(() => {
          const d = document.querySelector('#diff-dialog');
          if (!d.open) return null;
          return {
            title: d.querySelector('h2').textContent,
            sections: [...d.querySelectorAll('.df-section h3')].map((h) => h.firstChild.textContent),
            adds: [...d.querySelectorAll('.df-add .df-text')].map((t) => t.textContent),
            buttons: [...d.querySelectorAll('.df-buttons button')].map((b) => b.textContent),
          };
        })()`),
      { label: '差分の画面' },
    );
    assert.deepEqual(d, {
      title: '外部での変更',
      sections: ['外部の変更（読み込んだ内容 → 今のファイル）', 'あなたの編集（読み込んだ内容 → 編集中の内容）'],
      adds: ['# 機能テスト（外部で変更）', '末尾の行（自分の編集）'],
      buttons: ['外部の変更を読み込む（編集を破棄）', '閉じる'],
    });
    // 閉じると編集はそのまま
    await fq(`document.querySelector('#diff-dialog .df-buttons .primary').click(), true`);
    await sleep(200);
    assert.equal(await fq(`document.querySelector('#ed-input').value.includes('自分の編集')`), true);
    assert.equal(await main.evaluate(`${fwin}.dirty`), true);
  });

  await step('外部変更の通知の「×」: 意味をツールチップで示し、閉じてもステータスバーの印から出し直せる。読み直すと消える', async () => {
    // 直前の手順で、編集中に外部で変更された通知が出ている
    await waitFor(() => fq(`!document.querySelector('#banner').hidden`), { label: '通知' });
    assert.equal(await fq(`document.querySelector('#banner-close').title`), '閉じる（外部の変更は取り込まずに編集を続けます）');
    // ×: 通知は消え、ステータスバーに印が残る。編集はそのまま
    await fq(`document.querySelector('#banner-close').click(), true`);
    assert.deepEqual(await fq(`({ banner: document.querySelector('#banner').hidden, mark: !document.querySelector('#st-external').hidden && document.querySelector('#st-external').textContent, text: document.querySelector('#ed-input').value.includes('自分の編集') })`), {
      banner: true,
      mark: '外部で変更あり',
      text: true,
    });
    // 印をクリックすると通知（差分を見る・再読み込み）が戻り、印は隠れる
    await fq(`document.querySelector('#st-external').click(), true`);
    assert.deepEqual(await fq(`({ banner: !document.querySelector('#banner').hidden, diff: !document.querySelector('#banner-diff').hidden, reload: !document.querySelector('#banner-reload').hidden, mark: document.querySelector('#st-external').hidden })`), {
      banner: true,
      diff: true,
      reload: true,
      mark: true,
    });
    // もう一度閉じてから、再読み込みで外部の変更を取り込むと、印も消える
    await fq(`document.querySelector('#banner-close').click(), true`);
    await fq(`document.querySelector('#st-external').click(), true`);
    await fq(`document.querySelector('#banner-reload').click(), true`);
    await waitFor(() => fq(`document.querySelector('#ed-input').value.startsWith('# 機能テスト（外部で変更）') && document.querySelector('#banner').hidden && document.querySelector('#st-external').hidden`), { label: '読み直しで解決' });
  });

  await step('表のボタン: カーソル行の次に 2 列の表のひな形を入れて見出しを選択し、前後の文字の行とは空行で区切る。元に戻せる', async () => {
    await fkey('3', 'ctrlKey: true');
    const tableBtn = await fq(`(() => { const btns = [...document.querySelectorAll('#tools .tools-left button')].map((b) => b.dataset.tool ?? b.dataset.action); return btns.slice(btns.indexOf('codeblock'), btns.indexOf('hr') + 1); })()`);
    assert.deepEqual(tableBtn, ['codeblock', 'table', 'hr'], 'コードブロックと水平線の間');
    const base = await fq(`document.querySelector('#ed-input').value`);
    const run = (text, caret) =>
      fq(`(() => {
        const ta = document.querySelector('#ed-input');
        ta.value = ${JSON.stringify(text)};
        ta.dispatchEvent(new Event('input'));
        ta.focus();
        ta.setSelectionRange(${caret}, ${caret});
        document.querySelector('#tools [data-tool="table"]').click();
        return { value: ta.value, selected: ta.value.slice(ta.selectionStart, ta.selectionEnd) };
      })()`);
    const T = '| 見出し | 見出し |\n| --- | --- |\n|  |  |';
    // 段落の途中の行（前後に文字）→ 前後に空行
    let r = await run('前の行\n後の行', 2);
    assert.deepEqual(r, { value: `前の行\n\n${T}\n\n後の行`, selected: '見出し' });
    // 段落の直後の空行 → 空行を区切りに残して次の行へ
    r = await run('前の行\n\n後の行', 4);
    assert.deepEqual(r, { value: `前の行\n\n${T}\n\n後の行`, selected: '見出し' });
    // 前後が空行の空の行 → その行に入れる（空行を足さない）
    r = await run('前の行\n\n\n\n後の行', 5);
    assert.deepEqual(r, { value: `前の行\n\n${T}\n\n後の行`, selected: '見出し' });
    // 空の文書
    r = await run('', 0);
    assert.deepEqual(r, { value: T, selected: '見出し' });
    // 文書の末尾
    r = await run('最後の行', 4);
    assert.deepEqual(r, { value: `最後の行\n\n${T}`, selected: '見出し' });
    // プレビューで表として表示される
    await waitFor(() => fq(`!!document.querySelector('#preview').shadowRoot.querySelector('table th')`), { label: '表の表示' });
    // 元に戻す（表の挿入が 1 回の操作で戻る）
    await fq(`(() => { document.querySelector('#ed-input').focus(); document.execCommand('undo'); return true; })()`);
    assert.equal(await fq(`document.querySelector('#ed-input').value`), '最後の行');
    await fset(base);
  });

  await step('目次: ボタン / Ctrl+Shift+O で開閉し、見出しの一覧・クリックで移動・読んでいる見出しの強調・入力で更新', async () => {
    await fkey('1', 'ctrlKey: true');
    assert.equal(await fq(`document.querySelector('#toc').hidden`), true, '既定は閉じている');
    await fq(`document.querySelector('#btn-toc').click(), true`);
    const view = await fq(`(() => ({
      open: !document.querySelector('#toc').hidden,
      pressed: document.querySelector('#btn-toc').getAttribute('aria-pressed'),
      items: [...document.querySelectorAll('#toc-list .toc-item')].map((b) => [b.textContent, b.style.getPropertyValue('--toc-indent')]),
      saved: localStorage.getItem('mvp.toc'),
      width: document.querySelector('#toc').getBoundingClientRect().width,
      workspaceLeft: document.querySelector('#workspace').getBoundingClientRect().left,
    }))()`);
    const lines = (await fq(`document.querySelector('#ed-input').value`)).split('\n');
    const expected = lines.map((l) => /^(#{1,6}) (.*)$/.exec(l)).filter(Boolean).map((m) => [m[2], String(m[1].length - 1)]);
    assert.deepEqual(
      { open: view.open, pressed: view.pressed, items: view.items, saved: view.saved, besideWorkspace: Math.abs(view.width - view.workspaceLeft) <= 1 },
      { open: true, pressed: 'true', items: expected, saved: '1', besideWorkspace: true },
    );
    // 編集モードで見出しをクリック → その行へキャレット、強調も移る
    await fkey('2', 'ctrlKey: true');
    const target = lines.findIndex((l) => l === '## 見出しA');
    await fq(`[...document.querySelectorAll('#toc-list .toc-item')].find((b) => b.textContent === '見出しA').click(), true`);
    assert.equal(await fq(`window.__mvpEditor.caretPosition().line`), target + 1);
    assert.equal(await fq(`document.querySelector('#toc-list .toc-item.current')?.textContent`), '見出しA');
    // 見出しを書き足すと、少し後に一覧に出る
    await fset(`${lines.join('\n')}\n\n## 追加した見出し\n`);
    await waitFor(() => fq(`[...document.querySelectorAll('#toc-list .toc-item')].some((b) => b.textContent === '追加した見出し')`), { label: '一覧の更新' });
    // Ctrl+Shift+O で閉じる（状態は覚える）
    await fkey('O', 'ctrlKey: true, shiftKey: true');
    assert.deepEqual(await fq(`[document.querySelector('#toc').hidden, localStorage.getItem('mvp.toc')]`), [true, '0']);
    await fset(lines.join('\n'));
  });

  await step('改行で折り返す・拡大縮小を繰り返しても、表示位置が少しずつずれていかない', async () => {
    const f = path.join(work, 'drift.md');
    const paras = Array.from({ length: 300 }, (_, i) => `## 節 ${i}\n\n段落 ${i} の一行目です。\n二行目はもう少し長い文章で、改行で折り返すと行が分かれます。\n三行目。\n`);
    fs.writeFileSync(f, paras.join('\n'));
    await main.evaluate(`globalThis.__mvp.openFile(${JSON.stringify(f)}).then(() => true)`);
    const w = `globalThis.__mvp.visibleContexts().find((x) => x.doc?.path === ${JSON.stringify(f)})`;
    const dq = (expr) => main.evaluate(`${w}.win.webContents.executeJavaScript(${JSON.stringify(`(async () => (${expr}))()`)})`);
    await waitFor(() => dq(`document.querySelector('#preview').shadowRoot.querySelectorAll('h2').length === 300`), { label: '表示' });
    const run = (mode, button) =>
      dq(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        document.querySelector('[data-mode=${mode}]').click();
        await wait(100);
        const el = ${mode === 'view' ? "document.querySelector('#preview')" : "document.querySelector('#ed-input')"};
        el.scrollTop = el.scrollHeight * 0.45;
        el.dispatchEvent(new Event('scroll'));
        await wait(100);
        const tops = [];
        for (let i = 0; i < 12; i++) {
          tops.push(el.scrollTop);
          document.querySelector(${button === 'zoom' ? "i % 2 ? '#btn-zoom-out' : '#btn-zoom-in'" : "'#btn-breaks'"}).click();
          await wait(80);
        }
        tops.push(el.scrollTop);
        return tops;
      })()`);
    for (const [mode, button] of [['view', 'breaks'], ['view', 'zoom'], ['edit', 'zoom']]) {
      const tops = await run(mode, button);
      // 同じ状態（偶数回押した後）の位置は毎回同じ
      const even = tops.filter((_, i) => i % 2 === 0);
      assert.ok(even.every((t) => t === even[0]), `${mode} / ${button}: ${tops.join(',')}`);
    }
    await dq(`document.documentElement.style.getPropertyValue('--zoom')`);
    await main.evaluate(`${w}.win.destroy(), true`);
  });

  await step('表示 > フォントと行間: プレビューの本文のフォント・行間を見本を見ながら選ぶと、すぐに反映して保存する（設定画面には無い）', async () => {
    await fkey('1', 'ctrlKey: true');
    // 表示メニューにあり、設定画面には無い
    const viewMenu = await main.evaluate(`${fwin}.menu.items.find((m) => __plain(m.label) === '表示(&V)').submenu.items.map((i) => __plain(i.label))`);
    assert.deepEqual(viewMenu, ['テーマ(&T)...', 'フォントと行間(&F)...']);
    await fkey(',', 'ctrlKey: true');
    assert.equal(await fq(`document.querySelector('#settings-dialog #setting-preview-font')`), null, '設定画面には無い');
    await fq(`document.querySelector('#settings-dialog').close(), true`);
    await main.evaluate(`${fwin}.menu.items.find((m) => __plain(m.label) === '表示(&V)').submenu.items.find((i) => __plain(i.label) === 'フォントと行間(&F)...').click(), true`);
    await waitFor(() => fq(`document.querySelector('#font-dialog').open && !!document.querySelector('#font-dialog #setting-preview-font')`), { label: 'フォントと行間の画面' });
    const style = () =>
      fq(`(() => {
        const a = getComputedStyle(document.querySelector('#preview').shadowRoot.querySelector('article'));
        const sample = document.querySelector('.sd-sample');
        return { font: a.fontFamily, line: a.lineHeight, sampleFont: sample.style.fontFamily, sampleLine: sample.style.lineHeight };
      })()`);
    assert.deepEqual(await fq(`[document.querySelector('#setting-preview-font').value, document.querySelector('#setting-preview-line-height').value]`), ['standard', 'standard']);
    let st = await style();
    assert.match(st.font, /Segoe UI/);
    assert.equal(st.line, '25.5px', '15px × 1.7');
    // 明朝・とても広い
    await fq(`(() => {
      for (const [id, v] of [['#setting-preview-font', 'mincho'], ['#setting-preview-line-height', 'loose']]) {
        const s = document.querySelector(id); s.value = v; s.dispatchEvent(new Event('change'));
      }
      return true;
    })()`);
    await waitFor(async () => (await style()).line === '33px', { label: '反映' });
    st = await style();
    assert.match(st.font, /Mincho/);
    assert.match(st.sampleFont, /Mincho/);
    assert.equal(st.sampleLine, '2.2');
    await waitFor(() => {
      const saved = JSON.parse(fs.readFileSync(path.join(work, 'userData', 'settings.json'), 'utf8'));
      return saved.previewFont === 'mincho' && saved.previewLineHeight === 'loose';
    }, { label: '保存' });
    // 元に戻す
    await fq(`(() => {
      for (const [id, v] of [['#setting-preview-font', 'standard'], ['#setting-preview-line-height', 'standard']]) {
        const s = document.querySelector(id); s.value = v; s.dispatchEvent(new Event('change'));
      }
      document.querySelector('#font-dialog').close();
      return true;
    })()`);
    await waitFor(async () => (await style()).line === '25.5px', { label: '元に戻す' });
  });

  await step('GitHub のアラート・脚注: 表示され、脚注の番号をクリックすると脚注へ、↩ で本文へ移動し、リンク切れにはならない', async () => {
    const base = await fq(`document.querySelector('#ed-input').value`);
    const filler = Array.from({ length: 60 }, (_, i) => `段落 ${i}`).join('\n\n');
    await fset(`# 題\n\n> [!WARNING]\n> 注意の本文\n\n本文に脚注[^1]。\n\n${filler}\n\n[^1]: 脚注の文章\n`);
    await fkey('1', 'ctrlKey: true');
    await waitFor(() => fq(`!!document.querySelector('#preview').shadowRoot.querySelector('.footnotes #mvp-fn-1')`), { label: '表示' });
    const r = await fq(`(() => {
      const root = document.querySelector('#preview').shadowRoot;
      const alert = root.querySelector('.markdown-alert-warning');
      return { title: alert?.querySelector('.markdown-alert-title').textContent, color: getComputedStyle(alert).borderLeftStyle, ref: root.querySelector('sup.footnote-ref a')?.textContent };
    })()`);
    assert.deepEqual(r, { title: '警告', color: 'solid', ref: '1' });
    // 番号 → 脚注（下へスクロール）、↩ → 本文（上へ戻る）
    await fq(`(() => { const pv = document.querySelector('#preview'); pv.scrollTop = 0; pv.shadowRoot.querySelector('sup.footnote-ref a').click(); return true; })()`);
    const down = await fq(`document.querySelector('#preview').scrollTop`);
    assert.ok(down > 300, `脚注へ移動: ${down}`);
    await fq(`document.querySelector('#preview').shadowRoot.querySelector('.footnote-backref').click(), true`);
    assert.ok((await fq(`document.querySelector('#preview').scrollTop`)) < down, '本文へ戻る');
    // #mvp-fn-1 / #mvp-fnref-1 は文書の中にあるのでリンク切れにしない
    await sleep(600);
    assert.equal(await fq(`document.querySelector('#preview').shadowRoot.querySelectorAll('.footnotes .mvp-broken, .footnote-ref .mvp-broken').length`), 0);
    await fset(base);
  });

  await step('保存しておいた 2 ペインの比率が壊れていても、新しく開いたウィンドウの 2 ペインは崩れない', async () => {
    const f = path.join(work, 'split-broken.md');
    fs.writeFileSync(f, '# 比率\n\n本文\n');
    await fq(`localStorage.setItem('mvp.split', 'abc'), true`);
    // 予備ウィンドウは値を入れる前に読み込み済みなので捨て、新しいウィンドウで開く
    await main.evaluate(`(() => { globalThis.__mvp.spare?.win.destroy(); return true; })()`);
    await main.evaluate(`globalThis.__mvp.openFile(${JSON.stringify(f)}).then(() => true)`);
    const w = `globalThis.__mvp.visibleContexts().find((x) => x.doc?.path === ${JSON.stringify(f)})`;
    const s = await main.evaluate(`${w}.win.webContents.executeJavaScript(${JSON.stringify(`(async () => {
      document.querySelector('[data-mode=split]').click();
      await new Promise((r) => setTimeout(r, 300));
      const w = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().width);
      return { ed: w('#editor-pane'), pv: w('#preview-pane'), ws: w('#workspace') };
    })()`)})`);
    assert.ok(s.ed >= 200 && s.pv >= 150 && s.ed + s.pv <= s.ws + 1, JSON.stringify(s));
    await fq(`localStorage.setItem('mvp.split', '50%'), true`);
    await main.evaluate(`${w}.win.destroy(), true`);
  });

  await step('終了をキャンセルすると、どのウィンドウも閉じない（未保存でないウィンドウも残る）', async () => {
    const clean = path.join(work, 'quit-clean.md');
    const dirty = path.join(work, 'quit-dirty.md');
    fs.writeFileSync(clean, '# そのまま\n');
    fs.writeFileSync(dirty, '# 直す\n');
    for (const f of [clean, dirty]) await main.evaluate(`globalThis.__mvp.openFile(${JSON.stringify(f)}).then(() => true)`);
    const dw = `globalThis.__mvp.visibleContexts().find((x) => x.doc?.path === ${JSON.stringify(dirty)})`;
    await main.evaluate(`${dw}.win.webContents.executeJavaScript("(() => { const ta = document.querySelector('#ed-input'); ta.value += 'x'; ta.dispatchEvent(new Event('input')); return true; })()")`);
    await waitFor(() => main.evaluate(`${dw}.dirty === true`), { label: '未保存' });
    const before = await main.evaluate('globalThis.__mvp.visibleContexts().length');
    await main.evaluate(`(() => {
      globalThis.__quitAsked = 0;
      globalThis.__origBox2 = globalThis.__mvp.dialog.showMessageBox;
      globalThis.__mvp.dialog.showMessageBox = async (w, o) => { if (/変更を保存しますか/.test(o?.message)) { globalThis.__quitAsked++; return { response: 2 }; } return globalThis.__origBox2(w, o); };
      globalThis.__mvp.app.quit();
      return true;
    })()`);
    await waitFor(() => main.evaluate('globalThis.__quitAsked >= 1'), { label: '確認' });
    await sleep(500);
    assert.equal(await main.evaluate('globalThis.__mvp.visibleContexts().length'), before, 'ウィンドウは 1 つも閉じない');
    assert.ok(await main.evaluate(`globalThis.__mvp.visibleContexts().some((x) => x.doc?.path === ${JSON.stringify(clean)})`), '未保存でないウィンドウも残る');
    await main.evaluate(`globalThis.__mvp.dialog.showMessageBox = globalThis.__origBox2, true`);
    await main.evaluate(`(() => { for (const c of globalThis.__mvp.visibleContexts()) if (c.doc && [${JSON.stringify(clean)}, ${JSON.stringify(dirty)}].includes(c.doc.path)) c.win.destroy(); return true; })()`);
  });

  await step('キーボード ショートカットの一覧（F1・ヘルプ メニュー）と、新しいメニュー項目', async () => {
    await fkey('F1');
    const list = await waitFor(() => fq(`document.querySelector('#shortcuts-dialog').open && [...document.querySelectorAll('#shortcuts-dialog kbd')].map((k) => k.textContent)`), { label: '一覧' });
    for (const k of ['Ctrl+S', 'Ctrl+G', 'Ctrl+D', 'F1', 'Ctrl+F', 'Alt+F', 'Alt+E', 'Alt+V', 'Alt+H']) assert.ok(list.includes(k), `一覧に ${k}`);
    // 一覧の「メニューを開く」のキーは、メニューの見出しのアクセスキー（& の文字）と一致する
    const access = await main.evaluate(`${fwin}.menu.items.map((m) => 'Alt+' + /&(.)/.exec(m.label)[1].toUpperCase())`);
    assert.deepEqual(access, ['Alt+F', 'Alt+E', 'Alt+V', 'Alt+H']);
    // アクセスキーが表示から消されない形（括弧の直後にゼロ幅スペース）になっている。& の後の文字は元のまま
    const shown = await main.evaluate(`${fwin}.menu.items.map((m) => m.label)`);
    assert.deepEqual(shown, ['ファイル(\u200B&F)', '編集(\u200B&E)', '表示(\u200B&V)', 'ヘルプ(\u200B&H)']);
    // 表示崩れが無い: どの行も「動作」の欄に十分な幅があり、表が枠からはみ出さない
    const layout = await fq(`(() => {
      const body = document.querySelector('#shortcuts-dialog .sc-body').getBoundingClientRect();
      const actions = [...document.querySelectorAll('#shortcuts-dialog .sc-action')].map((a) => a.getBoundingClientRect().width);
      const tables = [...document.querySelectorAll('#shortcuts-dialog .sc-table')].map((t) => t.getBoundingClientRect());
      return { minAction: Math.min(...actions), inside: tables.every((t) => t.right <= body.right + 0.5) };
    })()`);
    assert.ok(layout.minAction >= 120 && layout.inside, JSON.stringify(layout));
    await fq(`document.querySelector('#shortcuts-dialog').close(), true`);
    const menus = await main.evaluate(`(() => {
      const m = ${fwin}.menu.items;
      const labels = (name) => m.find((i) => __plain(i.label) === name).submenu.items.map((i) => __plain(i.label)).filter(Boolean);
      return { edit: labels('編集(&E)'), help: labels('ヘルプ(&H)') };
    })()`);
    assert.ok(menus.edit.includes('指定行へ移動(&G)...') && menus.edit.includes('変更点を確認(&D)...'), menus.edit.join(','));
    assert.equal(menus.help[0], 'キーボード ショートカット(&K)');
    // 後片付け（未保存のまま閉じる）
    await main.evaluate(`${fwin}.win.destroy(), true`);
  });

  await step('予備ウィンドウが先読みされている', async () => {
    await waitFor(() => main.evaluate('Boolean(globalThis.__mvp.spare)'), { label: '予備ウィンドウ', timeout: 5000 });
  });

  await step('未保存で閉じると確認が出て（保存しない）、常駐しないので最後のウィンドウを閉じるとアプリが終了する', async () => {
    // アプリが終了すると main の状態を読めないので、ダイアログの内容は標準出力に書かせて確認する
    await main.evaluate(`(() => {
      globalThis.__mvp.dialog.showMessageBox = async (_w, opts) => {
        process.stdout.write('[E2E-DIALOG] ' + opts.message + '\\n');
        return { response: 1 };
      };
      globalThis.__mvp.visibleContexts()[0].win.close();
    })()`);
    // インスペクタが接続したままだと、Node が切断を待って終了しない（Waiting for the debugger to disconnect）
    page?.close();
    main.close();
    const code = await Promise.race([exited, sleep(10000).then(() => 'timeout')]);
    assert.notEqual(code, 'timeout', 'アプリが終了しない');
    assert.match(log, /\[E2E-DIALOG\] .*変更を保存しますか/);
    // 途中で予期しないエラー（main の例外）が起きていない
    assert.doesNotMatch(log, /\[E2E-ERRORBOX\]/, '予期しないエラーのダイアログが出た');
    const saved = Encoding.convert(fs.readFileSync(samplePath), { to: 'UNICODE', from: 'SJIS', type: 'string' });
    assert.equal(saved.startsWith('X'), false, '保存されていない');
    // 起動・終了の記録（原因を後から調べるためのログ）が残っている
    const logText = fs.readFileSync(path.join(work, 'userData', 'logs', 'main.log'), 'utf8');
    for (const word of ['起動 v', 'ウィンドウ作成', '表示中のウィンドウが無くなったため終了', '終了（終了コード 0）']) {
      assert.ok(logText.includes(word), `ログに「${word}」が無い`);
    }
  });
} catch (err) {
  results.push({ name: '実行', ok: false });
  console.error(err);
} finally {
  page?.close();
  try {
    await main?.evaluate('globalThis.__mvp.app.exit(0)');
  } catch {
    // 既に終了している
  }
  main?.close();
  await Promise.race([exited, sleep(5000)]);
  if (!child.killed && child.exitCode === null) child.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} / ${results.length} 成功`);
if (failed.length > 0) {
  console.log('--- Electron のログ ---');
  console.log(log.split('\n').filter((l) => !/Debugger listening|For help|DevTools listening/.test(l)).join('\n'));
  process.exitCode = 1;
} else {
  fs.rmSync(work, { recursive: true, force: true });
}
