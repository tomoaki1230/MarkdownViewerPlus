// 表示の画像の更新: ファイルが変わったら、最新の画像に差し替える
// 画面は同じ URL の画像を読み直さない（表示を作り直しても古いまま）ので、URL に印（?mvp-v=…）を付けて読み直させる。
// ・調べるのは、見えている画像と上下 1 画面分のローカルの画像だけ。更新日時と大きさを読むだけで、中身は読まない
// ・書き込みの途中を読まないよう、同じ状態が 2 回続いてから、裏で読み込めた画像だけに差し替える（失敗したら古い画像を残す）
// ・表示を作り直しても古い画像に戻らないよう、付けた印を覚えておいて付け直す

const STAMP_PARAM = 'mvp-v';
export const CHECK_INTERVAL_MS = 1000;
// 書き込みの途中かもしれないときに、もう一度調べるまでの時間
const RECHECK_MS = 300;
// 確認に時間がかかる場所（ネットワークドライブなど）では、かかった時間の 10 倍あける
const SLOW_FACTOR = 10;
const MAX_INTERVAL_MS = 30000;
const SCROLL_DELAY_MS = 150;

/** 画像の URL から印を除いたもの（画像を見分ける名前）。ローカルの画像でなければ null */
export function imageKey(src) {
  let url;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.protocol !== 'file:') return null;
  url.searchParams.delete(STAMP_PARAM);
  url.hash = '';
  return url.href;
}

/** 画像の URL に印を付ける（文書に書かれた ? や # は残す） */
export function withStamp(src, stamp) {
  const url = new URL(src);
  url.searchParams.set(STAMP_PARAM, stamp);
  return url.href;
}

/**
 * 調べた結果から、次にすることを決める（entry を更新する）
 * @param {{seen: number, known?: string|null, pending?: string|null, failed?: string|null}} entry
 * @param {{mtimeMs: number, size: number}|null} stat ファイルが無ければ null
 * @returns {'none' | 'recheck' | 'swap'} recheck: 少し後にもう一度調べる / swap: 読み直す
 */
export function judgeImage(entry, stat) {
  const sig = stat ? `${stat.mtimeMs}-${stat.size}` : null;
  if (entry.known === undefined) {
    // 初めて調べる画像。表示を作った後に変わっていれば読み直す（画面の外にある間に変わった場合）
    if (!stat || stat.mtimeMs <= entry.seen) {
      entry.known = sig;
      return 'none';
    }
    entry.known = null;
  }
  // 消えた画像は古い表示のまま残す。同じ名前で作り直されたら読み直す
  if (!sig) {
    entry.pending = null;
    return 'none';
  }
  if (sig === entry.known) {
    entry.pending = null;
    return 'none';
  }
  if (sig === entry.failed) return 'none';
  if (entry.pending === sig) return 'swap';
  entry.pending = sig;
  return 'recheck';
}

/**
 * @param {object} opts
 * @param {ParentNode} opts.root 表示の本文
 * @param {HTMLElement} opts.scroller スクロールする要素
 * @param {(urls: string[]) => Promise<Array<{mtimeMs: number, size: number}|null>>} opts.stat
 * @param {() => boolean} opts.isActive 調べてよい状態か（自動再読み込みがオン・表示が見えている など）
 * @param {() => (() => void)} opts.keepPosition 差し替えの前に呼ぶ。返した関数を、高さが変わったときに呼ぶ
 */
export function createImageRefresher({ root, scroller, stat, isActive, keepPosition }) {
  const entries = new Map();
  const stamps = new Map();
  let generation = 0;
  let timer = null;
  let running = false;
  let scrollTimer = null;

  const images = () => [...root.querySelectorAll('img[src]')];

  /** 見えている画像と上下 1 画面分 */
  function nearKeys() {
    const pane = scroller.getBoundingClientRect();
    const margin = pane.height;
    const keys = new Set();
    for (const img of images()) {
      const rects = img.getClientRects();
      if (rects.length === 0) continue; // 畳まれた details の中など
      const r = rects[0];
      if (r.bottom < pane.top - margin || r.top > pane.bottom + margin) continue;
      const key = imageKey(img.src);
      if (key) keys.add(key);
    }
    return keys;
  }

  function load(url) {
    return new Promise((resolve) => {
      const probe = new Image();
      probe.onload = () => resolve(true);
      probe.onerror = () => resolve(false);
      probe.src = url;
    });
  }

  /** 読み込めた画像だけ、表示の URL を差し替える。読んでいる位置は保つ */
  async function swap(list) {
    const gen = generation;
    const results = await Promise.all(list.map(async ({ key, stamp }) => ({ key, stamp, ok: await load(withStamp(key, stamp)) })));
    if (gen !== generation) return results;
    const good = new Map(results.filter((r) => r.ok).map((r) => [r.key, r.stamp]));
    if (good.size === 0) return results;
    const targets = images().filter((img) => good.has(imageKey(img.src)));
    const before = targets.map((img) => img.getBoundingClientRect().height);
    const restore = keepPosition();
    for (const [key, s] of good) stamps.set(key, s);
    for (const img of targets) img.src = withStamp(img.src, good.get(imageKey(img.src)));
    await Promise.allSettled(targets.map((img) => img.decode()));
    if (gen === generation && targets.some((img, i) => img.isConnected && img.getBoundingClientRect().height !== before[i])) restore();
    return results;
  }

  async function check() {
    if (running) return;
    timer = null;
    let delay = CHECK_INTERVAL_MS;
    if (isActive()) {
      running = true;
      const gen = generation;
      const started = performance.now();
      try {
        const keys = [...nearKeys()];
        if (keys.length > 0) {
          const stats = await stat(keys);
          if (gen === generation) {
            const toSwap = [];
            let recheck = false;
            keys.forEach((key, i) => {
              const entry = entries.get(key) ?? { seen: Date.now() };
              entries.set(key, entry);
              const verdict = judgeImage(entry, stats[i] ?? null);
              if (verdict === 'recheck') recheck = true;
              if (verdict === 'swap') toSwap.push({ key, stamp: entry.pending, entry });
            });
            if (recheck) delay = RECHECK_MS;
            if (toSwap.length > 0) {
              const results = await swap(toSwap);
              results.forEach((res, i) => {
                const { entry, stamp } = toSwap[i];
                if (res.ok) entry.known = stamp;
                else entry.failed = stamp;
                entry.pending = null;
              });
            }
          }
        }
      } catch {
        // 調べられなくても、次の機会にまた調べる
      } finally {
        running = false;
      }
      delay = Math.min(MAX_INTERVAL_MS, Math.max(delay, (performance.now() - started) * SLOW_FACTOR));
    }
    clearTimeout(timer);
    timer = setTimeout(check, delay);
  }

  /** すぐに調べる（スクロールが止まった・ウィンドウに戻った・モードが変わったとき） */
  function kick() {
    if (running) return;
    clearTimeout(timer);
    timer = setTimeout(check, 0);
  }

  scroller.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(kick, SCROLL_DELAY_MS);
  });
  timer = setTimeout(check, CHECK_INTERVAL_MS);

  return {
    kick,
    /** 表示を作り直した直後に呼ぶ: 覚えている印を付け直し、初めて見る画像の時刻を覚える */
    afterRender() {
      const now = Date.now();
      for (const img of images()) {
        const key = imageKey(img.src);
        if (!key) continue;
        if (!entries.has(key)) entries.set(key, { seen: now });
        const s = stamps.get(key);
        if (s) img.src = withStamp(img.src, s);
      }
    },
    /** 別の文書を読み込むとき */
    reset() {
      generation++;
      entries.clear();
      stamps.clear();
    },
    /** 更新ボタン: 見えていない画像も含めて全部読み直す（更新日時が変わらない差し替えも直る） */
    async reloadAll() {
      const stamp = `r${Date.now()}`;
      const keys = [...new Set(images().map((img) => imageKey(img.src)).filter(Boolean))];
      if (keys.length === 0) return;
      for (const key of keys) entries.set(key, { seen: Date.now() });
      await swap(keys.map((key) => ({ key, stamp })));
    },
  };
}
