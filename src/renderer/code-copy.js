// コードブロックのコピーボタン: 表示のコードブロックの右上に出す（マウスを乗せたとき・キーボードで選んだとき）
// ・pre の外側に枠（div.code-block）を作り、ボタンは枠に置く（pre の中に置くと、横にスクロールしたときに一緒に動いてしまう）
// ・ボタンは絵だけで文字を持たないので、表示中の検索・文字の選択・コピーの内容に混ざらない
// ・Mermaid のコードブロック（図に置き換わる）には付けない

const COPY_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1" /><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></svg>';
const DONE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 4.8" /></svg>';
const FAILED_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>';
const LABEL = 'コードをコピー';
// 結果を表示しておく時間
const RESULT_MS = 1500;

/**
 * root の中のコードブロックにコピーボタンを付ける
 * @param {ParentNode} root
 */
export function decorateCodeBlocks(root) {
  const blocks = [...root.querySelectorAll('pre')].filter((pre) => !pre.querySelector('code.language-mermaid') && !pre.closest('.code-block, .mermaid-figure'));
  if (blocks.length === 0) return;
  const doc = blocks[0].ownerDocument;
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'code-copy';
  button.title = LABEL;
  button.setAttribute('aria-label', LABEL);
  button.innerHTML = COPY_ICON;
  for (const pre of blocks) {
    const frame = doc.createElement('div');
    frame.className = 'code-block';
    pre.replaceWith(frame);
    frame.append(pre, button.cloneNode(true));
  }
}

/**
 * コピーする文字（コードの最後の改行は含めない。端末に貼り付けたときに、そのまま実行されてしまわないように）
 * @param {Element} pre
 */
export function codeTextOf(pre) {
  const text = (pre.querySelector('code') ?? pre).textContent;
  return text.replace(/\r?\n$/, '');
}

/**
 * コピーして、結果をボタンの絵で一時的に示す（コードブロックと、選んだ文字のコピーで共通）
 * @param {HTMLButtonElement} button
 * @param {string} text
 * @param {(text: string) => Promise<boolean>} copy
 * @param {string} label ボタンの普段の名前
 */
export async function copyWithResult(button, text, copy, label) {
  let ok = false;
  try {
    ok = await copy(text);
  } catch {
    ok = false;
  }
  clearTimeout(button.__copyTimer);
  const message = ok ? 'コピーしました' : 'コピーできませんでした';
  button.innerHTML = ok ? DONE_ICON : FAILED_ICON;
  button.title = message;
  button.setAttribute('aria-label', message);
  button.classList.add('done');
  button.classList.toggle('failed', !ok);
  button.__copyTimer = setTimeout(() => resetCopyResult(button, label), RESULT_MS);
}

/** ボタンを普段の状態に戻す */
export function resetCopyResult(button, label) {
  clearTimeout(button.__copyTimer);
  button.innerHTML = COPY_ICON;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.classList.remove('done', 'failed');
}

/**
 * コードブロックのボタンが押されたときの処理
 * @param {HTMLButtonElement} button
 * @param {(text: string) => Promise<boolean>} copy
 */
export async function runCodeCopy(button, copy) {
  const pre = button.closest('.code-block')?.querySelector('pre');
  if (pre) await copyWithResult(button, codeTextOf(pre), copy, LABEL);
}
