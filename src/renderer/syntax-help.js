// ヘルプ > Markdown 記法の一覧（モーダル）
// 各記法の「書き方」と「表示」を並べる。表示は本文と同じ変換・サニタイズの経路（markdown.js の render）で作るので、
// 一覧に載っている記法は実際にこのアプリで表示できる（載っていない記法を案内しない）。

const TINY_IMAGE =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="32"><rect width="48" height="32" rx="4" fill="#0969da"/><text x="24" y="21" font-size="13" text-anchor="middle" fill="#fff" font-family="sans-serif">IMG</text></svg>',
  );

export const SYNTAX_SECTIONS = [
  {
    title: '基本の記法',
    items: [
      { name: '見出し', source: '# 見出し 1\n## 見出し 2\n### 見出し 3', note: '# の数（1〜6）で大きさが変わる' },
      {
        name: '段落と改行',
        source: '1 行目の文章。  \n行末に半角スペース 2 つで改行する。\n\n空行で段落が変わる。',
        note: 'ツールバーの「改行で折り返す」をオンにすると、改行だけでも改行する',
      },
      { name: '強調', source: '*斜体* **太字** ***太字の斜体*** ~~取り消し線~~', note: '* の代わりに _ も使える' },
      { name: 'インラインコード', source: '`console.log()` を実行する' },
      {
        name: 'コードブロック',
        source: '```js\nconst a = 1; // 言語名を書くと色付けされる\n```',
        note: 'バッククォート 3 つ（~~~ も可）で囲む。4 文字の字下げでも可',
      },
      { name: '引用', source: '> 引用文\n>> 入れ子の引用' },
      { name: '箇条書き', source: '- 項目\n- 項目\n  - 入れ子（字下げする）', note: '- の代わりに * や + も使える' },
      { name: '番号付きリスト', source: '1. 一つ目\n1. 二つ目\n1. 三つ目', note: '番号は自動で振られる。1) の形も使える' },
      { name: 'タスクリスト', source: '- [x] 済み\n- [ ] 未着手' },
      {
        name: 'リンク',
        source: '[リンクの文字](https://example.com)\n<https://example.com>\nhttps://example.com',
        note: 'クリックすると既定のブラウザで開く。相対パスの .md は新しいウィンドウで開く',
      },
      { name: '参照リンク', source: '[参照リンク][ref]\n\n[ref]: https://example.com' },
      { name: '見出しへのリンク', source: '[「見出し 1」へ](#見出し-1)', note: '見出しの文字を小文字にし、空白を - にしたもの' },
      { name: '画像', source: `![代替テキスト](${TINY_IMAGE})`, note: 'パスは Markdown ファイルのあるフォルダからの相対パスで書ける' },
      { name: '表', source: '| 左寄せ | 中央 | 右寄せ |\n|:---|:---:|---:|\n| a | b | c |' },
      { name: '水平線', source: '---', note: '*** や ___ でも可' },
      { name: 'エスケープ', source: '\\*記号\\* をそのまま表示する', note: '記号の前に \\ を付ける' },
    ],
  },
  {
    title: 'HTML（Markdown の中に直接書く）',
    items: [
      { name: '折りたたみ', source: '<details>\n<summary>クリックで開く</summary>\n\n中身（空行の後は **Markdown** が使える）\n\n</details>' },
      { name: 'キーの表記', source: '<kbd>Ctrl</kbd> + <kbd>S</kbd>' },
      { name: '文字の色・マーカー', source: '<span style="color:#d1242f">赤い文字</span> と <mark>マーカー</mark>' },
      {
        name: 'ブロック要素の中',
        source: '<div>\n**AAA** は Markdown として解釈されない\n\n**BBB** は空行の後なので解釈される\n</div>',
        note: '<div> などの中は、終了タグか空行までは Markdown として解釈されない',
      },
      {
        name: '安全のため取り除くもの',
        source: '<b onclick="alert(1)">押しても何も起きない</b>\n<script>alert(2)</script>',
        note: 'スクリプト・イベント属性・javascript: の URL などは表示するときに取り除く',
      },
    ],
  },
  {
    title: 'GitHub の拡張',
    items: [
      {
        name: 'アラート',
        source: '> [!NOTE]\n> 補足の説明\n\n> [!WARNING]\n> 注意が必要な点',
        note: '種類は NOTE（注記）/ TIP（ヒント）/ IMPORTANT（重要）/ WARNING（警告）/ CAUTION（注意）。1 行目は [!種類] だけを書く',
      },
      {
        name: '脚注',
        source: '本文に脚注を付ける[^1]。\n\n[^1]: 脚注の文章。文書の最後にまとめて表示される',
        note: '番号をクリックすると脚注へ、↩ で本文へ戻る。[^名前] のように名前も使える',
      },
    ],
  },
  {
    title: '絵文字',
    items: [{ name: '絵文字', source: ':smile: :+1: :heart: :rocket: :memo:', note: 'GitHub と同じ名前が使える。登録されていない名前は文字のまま表示する' }],
  },
];

export const UNSUPPORTED_SYNTAX = [
  '数式（$...$）',
  'Mermaid・PlantUML の図',
  'Qiita のメッセージ（:::note）',
  'コード内の色の表示（`#f00` の色見本）',
];

const LOCAL_STYLE = `
.syn { color: var(--pv-fg); font: 13px/1.6 'Segoe UI', 'Yu Gothic UI', 'Meiryo UI', system-ui, sans-serif; }
.syn h3 { margin: 18px 0 4px; font-size: 14px; color: var(--pv-heading); border-bottom: 1px solid var(--pv-border); padding-bottom: 4px; }
.syn h3:first-child { margin-top: 0; }
.syn-head, .syn-row { display: grid; grid-template-columns: 8.5em minmax(0, 1fr) minmax(0, 1fr); gap: 12px; padding: 8px 0; }
.syn-head { color: var(--pv-muted); font-size: 12px; padding-bottom: 0; }
.syn-row { border-top: 1px solid var(--pv-border); }
.syn-name { font-weight: 600; }
.syn-note { display: block; margin-top: 4px; font-weight: normal; font-size: 11px; color: var(--pv-muted); }
.syn-src { margin: 0; padding: 8px; border-radius: 6px; background: var(--pv-pre-bg); font: 12px/1.5 'BIZ UDGothic', Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.syn-out.markdown-body { zoom: 1; max-width: none; margin: 0; padding: 0; font-size: 14px; }
.syn-out.markdown-body > :last-child { margin-bottom: 0; }
.syn-unsupported { margin: 16px 0 0; padding: 10px 12px; border: 1px dashed var(--pv-border); border-radius: 6px; color: var(--pv-muted); }
.syn-unsupported ul { margin: 4px 0 0; padding-left: 1.5em; }
`;

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * @param {{dialog: HTMLDialogElement, render: (src: string) => string}} opts render は本文と同じ変換（サニタイズ済み HTML を返す）
 */
function buildSyntaxHelp({ dialog, render }) {
  const form = el('form', 'td-inner');
  form.method = 'dialog';
  const head = el('header', 'td-head');
  const title = el('h2', '', 'Markdown 記法の一覧');
  title.id = 'syntax-dialog-title';
  const close = el('button', 'td-close', '×');
  close.value = 'close';
  close.setAttribute('aria-label', '閉じる');
  head.append(title, close);

  // 表示の列はプレビューと同じ見た目にするため、プレビュー用の CSS を読み込んだ Shadow DOM に入れる
  const host = el('div', 'syn-host');
  const shadow = host.attachShadow({ mode: 'open' });
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'preview.css';
  const style = document.createElement('style');
  style.textContent = LOCAL_STYLE;
  const root = el('div', 'syn');
  shadow.append(link, style, root);

  for (const section of SYNTAX_SECTIONS) {
    root.append(el('h3', '', section.title));
    const header = el('div', 'syn-head');
    header.append(el('span', '', '記法'), el('span', '', '書き方'), el('span', '', '表示'));
    root.append(header);
    for (const item of section.items) {
      const row = el('div', 'syn-row');
      const name = el('div', 'syn-name', item.name);
      if (item.note) name.append(el('span', 'syn-note', item.note));
      const out = el('div', 'syn-out markdown-body');
      out.innerHTML = render(item.source);
      row.append(name, el('pre', 'syn-src', item.source), out);
      root.append(row);
    }
  }
  const unsupported = el('div', 'syn-unsupported');
  unsupported.append(el('strong', '', '未対応の記法（書いても文字のまま表示される）'));
  const ul = el('ul');
  for (const s of UNSUPPORTED_SYNTAX) ul.append(el('li', '', s));
  unsupported.append(ul);
  root.append(unsupported);

  const foot = el('footer', 'td-foot');
  foot.append(el('span'));
  const ok = el('button', 'tb-btn primary', '閉じる');
  ok.value = 'close';
  foot.append(ok);

  form.append(head, host, foot);
  dialog.append(form);
  dialog.setAttribute('aria-labelledby', title.id);
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  // リンクは開かない（記法の見本なので、クリックしても画面を移動しない）
  shadow.addEventListener('click', (e) => {
    if (e.target.closest?.('a')) e.preventDefault();
  });

  return {
    host,
    shadow,
    open() {
      if (!dialog.open) dialog.showModal();
      dialog.querySelector('.syn-host').scrollTop = 0;
    },
  };
}

/**
 * 画面の中身は初めて開くときに作る。開くたびに今のカラーテーマの色をプレビュー用の変数へ写す
 * （プレビュー用 CSS は :host に標準テーマの既定値を持つため、ホスト要素に直接設定して上書きする）
 */
export function createSyntaxHelp(opts) {
  let built = null;
  return {
    open(themeVars) {
      built ??= buildSyntaxHelp(opts);
      for (const [name, value] of Object.entries(themeVars ?? {})) built.host.style.setProperty(name, value);
      built.open();
      for (const code of built.shadow.querySelectorAll('pre code[class*="language-"]')) {
        if (window.hljs && !code.classList.contains('hljs')) window.hljs.highlightElement(code);
      }
    },
  };
}
