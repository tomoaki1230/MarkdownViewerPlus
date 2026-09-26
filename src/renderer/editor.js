// 生テキストエディタ: 透明な textarea の上下関係は「鏡(pre) の上に透明 textarea」
// 文字の描画（色分け・検索ヒット・行番号）は鏡が担い、入力・キャレット・選択・IME は textarea が担う。
import { buildLineElement, computeLineClasses, distributeHits, tokenizeLine } from './mirror.js';

export class MirrorEditor {
  /**
   * @param {{textarea: HTMLTextAreaElement, mirror: HTMLElement, root: HTMLElement,
   *          isEmoji?: (name: string) => boolean, onInput?: () => void, onScroll?: () => void}} opts
   */
  constructor({ textarea, mirror, root, isEmoji, onInput, onScroll }) {
    this.textarea = textarea;
    this.mirror = mirror;
    this.root = root;
    this.isEmoji = isEmoji ?? (() => true);
    this.onInput = onInput ?? (() => {});
    this.onScroll = onScroll ?? (() => {});
    this.lineTexts = [];
    this.lineNodes = [];
    this.matches = [];
    this.currentMatch = -1;
    this.digits = 0;
    this.refreshQueued = false;
    this.debug = false;
    // 休止中（表示モードでエディタが隠れているとき）は鏡を作らない。stale は「鏡が textarea に追いついていない」印
    this.suspended = true;
    this.stale = true;

    textarea.addEventListener('input', () => {
      this.refresh();
      this.onInput();
    });
    textarea.addEventListener('scroll', () => {
      this.syncMirrorScroll();
      this.onScroll();
    });
    // 幅が変わると折り返し位置が変わるので、鏡のスクロール位置も合わせ直す
    new ResizeObserver(() => this.syncMirrorScroll()).observe(textarea);
  }

  get value() {
    return this.textarea.value;
  }

  /** 内容を丸ごと差し替える（ファイル読み込み時）。取り消し履歴は引き継がない */
  setValue(text) {
    this.textarea.value = text;
    this.textarea.setSelectionRange(0, 0);
    this.textarea.scrollTop = 0;
    this.refresh();
  }

  /**
   * 取り消し可能な形で選択範囲を置き換える（記法ボタン・置換で使う）
   */
  replaceRange(start, end, text, { selectStart, selectEnd } = {}) {
    const ta = this.textarea;
    const v = ta.value;
    const expected = v.slice(0, start) + text + v.slice(end);
    // 実際に変わる区間だけを置き換える（全体置換でも取り消し単位・キャレットが安定する）
    const old = v.slice(start, end);
    let head = 0;
    while (head < old.length && head < text.length && old[head] === text[head]) head++;
    let tail = 0;
    while (tail < old.length - head && tail < text.length - head && old[old.length - 1 - tail] === text[text.length - 1 - tail]) tail++;
    const from = start + head;
    const to = end - tail;
    const insert = text.slice(head, text.length - tail);

    if (from !== to || insert !== '') {
      ta.focus();
      ta.setSelectionRange(from, to);
      // execCommand は textarea の取り消し履歴に積まれる（value 直接代入では Ctrl+Z が効かない）
      const ok = insert === '' ? document.execCommand('delete') : document.execCommand('insertText', false, insert);
      // Chromium は末尾の改行を含む挿入で改行を補うことがあるため、結果を必ず検証する
      if (!ok || ta.value !== expected) {
        ta.value = expected;
        ta.dispatchEvent(new Event('input'));
      }
    }
    if (selectStart !== undefined) ta.setSelectionRange(selectStart, selectEnd ?? selectStart);
  }

  /** 検索ヒットを設定して鏡を更新する */
  setMatches(matches, currentIndex) {
    this.matches = matches;
    this.currentMatch = currentIndex;
    this.refresh();
  }

  /** 休止の切り替え。再開したときに鏡が古ければ作り直す */
  setSuspended(suspended) {
    this.suspended = suspended;
    if (!suspended && this.stale) this.render();
  }

  /** 休止中のまま、鏡を先に作っておく（手が空いたときに呼び、編集モードへの切り替えを速くする） */
  prebuild() {
    if (this.stale) this.render();
  }

  /** 行数（鏡を作っていなくても数えられる） */
  lineCount() {
    if (!this.stale) return this.lineTexts.length;
    const v = this.textarea.value;
    let n = 1;
    for (let i = v.indexOf('\n'); i >= 0; i = v.indexOf('\n', i + 1)) n++;
    return n;
  }

  /**
   * 鏡を textarea の内容に合わせる（休止中は印だけ付けて後回し）
   */
  refresh() {
    if (this.suspended) {
      this.stale = true;
      return;
    }
    this.render();
  }

  /**
   * 鏡を作る。変化した行の箱だけを作り直す
   */
  render() {
    this.stale = false;
    const value = this.textarea.value;
    const lines = value.split('\n');
    const lineClasses = computeLineClasses(lines);
    const hitsByLine = distributeHits(lines, this.matches, this.currentMatch);

    // 行番号の桁数に合わせて左余白（ガター）を調整
    const digits = Math.max(3, String(lines.length).length);
    if (digits !== this.digits) {
      this.digits = digits;
      this.root.style.setProperty('--gutter', `calc(${digits}ch + 20px)`);
    }

    // 先頭・末尾の一致しない区間だけ箱を入れ替える（行の挿入・削除でも全体を作り直さない）
    const old = this.lineTexts;
    let prefix = 0;
    const maxPrefix = Math.min(old.length, lines.length);
    while (prefix < maxPrefix && old[prefix] === lines[prefix]) prefix++;
    let suffix = 0;
    while (suffix < old.length - prefix && suffix < lines.length - prefix && old[old.length - 1 - suffix] === lines[lines.length - 1 - suffix]) {
      suffix++;
    }
    const removeCount = old.length - prefix - suffix;
    const insertCount = lines.length - prefix - suffix;
    for (let i = 0; i < removeCount; i++) this.lineNodes[prefix + i].remove();
    const placeholders = new Array(insertCount).fill(null);
    this.lineNodes.splice(prefix, removeCount, ...placeholders);
    this.lineTexts = lines;
    // 新しい行の箱は、変化しなかった末尾側の最初の箱の直前へ順に挿入する
    const anchor = this.lineNodes[prefix + insertCount] ?? null;

    const doc = this.mirror.ownerDocument;
    for (let i = 0; i < lines.length; i++) {
      const hits = hitsByLine.get(i) ?? [];
      const isLast = i === lines.length - 1;
      const key = `${lineClasses[i]}\u0001${isLast ? 1 : 0}\u0001${hits.map((h) => `${h.start},${h.end},${h.current ? 1 : 0}`).join(';')}\u0001${lines[i]}`;
      const node = this.lineNodes[i];
      if (node && node.__key === key) continue;
      const tokens = tokenizeLine(lines[i], lineClasses[i], this.isEmoji);
      // 検索でヒットした行にはクラスを付ける（現在のヒットの行を薄く塗る。文字は増やさない）
      const hitClass = hits.length === 0 ? '' : hits.some((h) => h.current) ? ' ln-hit ln-hit-cur' : ' ln-hit';
      const el = buildLineElement(doc, lines[i], `${lineClasses[i]}${hitClass}`.trim(), tokens, hits, !isLast);
      el.__key = key;
      if (node) {
        node.replaceWith(el);
      } else {
        this.mirror.insertBefore(el, anchor);
      }
      this.lineNodes[i] = el;
    }

    if (this.debug && this.mirror.textContent !== value) {
      console.error('[MirrorEditor] 鏡と textarea の内容が一致しません。色分け・検索・スクロール同期が狂います。');
    }
    this.syncMirrorScroll();
  }

  syncMirrorScroll() {
    this.mirror.scrollTop = this.textarea.scrollTop;
    this.mirror.scrollLeft = this.textarea.scrollLeft;
  }

  // ---------------------------------------------------------------------
  // 行 ⇔ 位置（スクロール同期・検索ヒットへの移動に使う）
  // ---------------------------------------------------------------------

  /** 行 i の箱の上端（鏡のスクロール座標） */
  lineTop(i) {
    const node = this.lineNodes[Math.max(0, Math.min(i, this.lineNodes.length - 1))];
    return node ? node.offsetTop : 0;
  }

  /** スクロール座標 y にある行を、小数付きの行番号で返す */
  lineAtOffset(y) {
    const nodes = this.lineNodes;
    if (nodes.length === 0) return 0;
    let lo = 0;
    let hi = nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (nodes[mid].offsetTop <= y) lo = mid;
      else hi = mid - 1;
    }
    const node = nodes[lo];
    const h = node.offsetHeight || 1;
    return lo + Math.min(1, Math.max(0, (y - node.offsetTop) / h));
  }

  /** 表示先頭の行（小数付き） */
  topLine() {
    return this.lineAtOffset(this.textarea.scrollTop + this.paddingTop());
  }

  /** 小数付き行番号が表示先頭に来るようにスクロールする */
  scrollToLine(line) {
    const i = Math.floor(line);
    const node = this.lineNodes[Math.max(0, Math.min(i, this.lineNodes.length - 1))];
    if (!node) return;
    const y = node.offsetTop + (line - i) * node.offsetHeight - this.paddingTop();
    this.textarea.scrollTop = Math.max(0, y);
    this.syncMirrorScroll();
  }

  paddingTop() {
    return parseFloat(getComputedStyle(this.mirror).paddingTop) || 0;
  }

  /** 文字位置 → 行番号（0 始まり） */
  lineOfOffset(pos) {
    let n = 0;
    const v = this.textarea.value;
    for (let i = v.indexOf('\n'); i >= 0 && i < pos; i = v.indexOf('\n', i + 1)) n++;
    return n;
  }

  /** 行番号 → その行の先頭の文字位置 */
  offsetOfLine(line) {
    const v = this.textarea.value;
    let pos = 0;
    for (let n = 0; n < line; n++) {
      const i = v.indexOf('\n', pos);
      if (i < 0) return v.length;
      pos = i + 1;
    }
    return pos;
  }

  /** 範囲が見える位置までスクロールする（画面の 1/3 付近に置く） */
  revealRange(start) {
    const line = this.lineOfOffset(start);
    const node = this.lineNodes[line];
    if (!node) return;
    const ta = this.textarea;
    const top = node.offsetTop;
    const bottom = top + node.offsetHeight;
    if (top < ta.scrollTop || bottom > ta.scrollTop + ta.clientHeight) {
      ta.scrollTop = Math.max(0, top - ta.clientHeight / 3);
      this.syncMirrorScroll();
    }
  }

  /** キャレット位置の行・列（1 始まり） */
  caretPosition() {
    const ta = this.textarea;
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos);
    const line = before.split('\n').length;
    const col = pos - before.lastIndexOf('\n');
    return { line, col, selected: Math.abs(ta.selectionEnd - ta.selectionStart) };
  }
}
