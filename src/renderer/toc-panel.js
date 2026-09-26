// 目次パネル（見出しの一覧）
// ・見出しをクリックすると、その見出しの位置へ移動する（移動の仕方はモードごとに app.js が決める）
// ・今読んでいる位置の見出しを強調し、一覧の見える範囲に入れる
// 見出しの文字は textContent で入れる（HTML として解釈しない）

/**
 * @param {{panel: HTMLElement, list: HTMLElement, onSelect: (line: number) => void}} opts
 */
export function createTocPanel({ panel, list, onSelect }) {
  let headings = [];
  let key = '';
  let current = -1;

  list.addEventListener('click', (e) => {
    const item = e.target.closest('[data-index]');
    if (!item) return;
    const h = headings[Number(item.dataset.index)];
    if (h) onSelect(h.line);
  });

  /** 見出しの一覧を入れ替える（前と同じなら何もしない） */
  function setHeadings(next) {
    const nextKey = next.map((h) => `${h.level}\u0001${h.line}\u0001${h.text}`).join('\u0002');
    if (nextKey === key) return;
    key = nextKey;
    headings = next;
    current = -1;
    if (next.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'toc-empty';
      empty.textContent = '見出しがありません';
      list.replaceChildren(empty);
      return;
    }
    // いちばん浅い見出しを字下げ 0 にする（## から始まる文書でも左に寄せる）
    const minLevel = Math.min(...next.map((h) => h.level));
    list.replaceChildren(
      ...next.map((h, i) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = `toc-item toc-l${h.level}`;
        item.style.setProperty('--toc-indent', String(h.level - minLevel));
        item.dataset.index = String(i);
        item.textContent = h.text;
        item.title = h.text;
        return item;
      }),
    );
  }

  /** 今読んでいる位置（ソース行）の見出しを強調する */
  function setCurrentLine(line) {
    let index = -1;
    for (let i = 0; i < headings.length && headings[i].line <= line; i++) index = i;
    if (index === current) return;
    list.querySelector('.toc-item.current')?.classList.remove('current');
    current = index;
    const item = index >= 0 ? list.querySelector(`[data-index="${index}"]`) : null;
    if (!item) return;
    item.classList.add('current');
    // 一覧の見える範囲の外なら、その見出しが見える所まで一覧をスクロールする（パネル以外は動かさない）
    const lr = list.getBoundingClientRect();
    const ir = item.getBoundingClientRect();
    if (ir.top < lr.top || ir.bottom > lr.bottom) list.scrollTop += ir.top - lr.top - lr.height / 3;
  }

  return {
    setHeadings,
    setCurrentLine,
    isOpen: () => !panel.hidden,
    get headings() {
      return headings;
    },
  };
}
