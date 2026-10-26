// Mermaid の図: 表示の ```mermaid のコードブロックを図（SVG）に置き換える
// ・Mermaid（約 5MB）は図のある文書を開いたときだけ読み込む（mermaid.bundle.js。起動を遅くしない）
// ・同じ図（中身・配色・フォントが同じ）は描き直さない（2 ペインで入力するたびに描くと重いため、結果を覚えておく）
// ・描けないとき（書き方の誤り）は、理由と元のコードを表示する
// ・安全のため、Mermaid は最も厳しい設定（securityLevel: strict。図の中のスクリプト・HTML・クリック操作を使わせない）で動かし、
//   できた SVG もさらに DOMPurify で無害化してから表示する

const BUNDLE = 'mermaid.bundle.js';
// 覚えておく図の数（古いものから捨てる）
const CACHE_MAX = 200;
// 描けなかった理由の表示の長さ
const ERROR_MAX = 400;

/**
 * @param {object} opts
 * @param {(svg: string) => string} opts.sanitize 図の SVG を無害化する
 * @param {() => {key: string, config: object}} opts.getConfig 今の配色・フォントでの Mermaid の設定（key が変わると描き直す）
 * @param {(root: ParentNode) => void} [opts.onChange] 図を差し替えた後（位置の取り直し・検索の索引の作り直しに使う）
 */
export function createMermaidView({ sanitize, getConfig, onChange = () => {} }) {
  const cache = new Map();
  // 図の要素 → 元の Mermaid の文字・描いたときの設定（配色が変わったら描き直すため）
  const figures = new WeakMap();
  let loading = null;
  let seq = 0;
  // 描き直しの世代（文書を描き直したら、描いている途中の古い図は使わない）
  const generations = new WeakMap();

  function load() {
    if (window.mermaid) return Promise.resolve(window.mermaid);
    loading ??= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = BUNDLE;
      s.onload = () => (window.mermaid ? resolve(window.mermaid) : reject(new Error('Mermaid を読み込めませんでした')));
      s.onerror = () => reject(new Error('Mermaid を読み込めませんでした'));
      document.head.appendChild(s);
    }).catch((err) => {
      loading = null;
      throw err;
    });
    return loading;
  }

  function remember(key, value) {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  /** 図の要素を作る（描けなかったときは理由と元のコード） */
  function makeFigure(doc, source, configKey, result, line) {
    const fig = doc.createElement('div');
    fig.className = result.svg ? 'mermaid-figure' : 'mermaid-figure mermaid-failed';
    if (line !== null) fig.dataset.line = line;
    if (result.svg) {
      fig.innerHTML = result.svg;
      const svg = fig.querySelector('svg');
      svg?.setAttribute('role', 'img');
      svg?.setAttribute('aria-label', '図（Mermaid）');
    } else {
      const msg = doc.createElement('p');
      msg.className = 'mermaid-error';
      msg.textContent = `図を表示できません（Mermaid の書き方を確認してください）: ${result.error}`;
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      code.textContent = source;
      pre.append(code);
      fig.append(msg, pre);
    }
    figures.set(fig, { source, configKey });
    return fig;
  }

  /** コードブロック（pre）か、配色の変わった図を、新しい図に差し替える */
  function replace(target, source, configKey, result) {
    const line = target.getAttribute('data-line');
    const fig = makeFigure(target.ownerDocument, source, configKey, result, line);
    target.replaceWith(fig);
  }

  async function renderOne(mermaid, source) {
    const id = `mvp-mermaid-${++seq}`;
    try {
      const { svg } = await mermaid.render(id, source);
      return { svg: sanitize(svg) };
    } catch (err) {
      const text = String(err?.message ?? err ?? '不明なエラー').trim();
      return { error: text.length > ERROR_MAX ? `${text.slice(0, ERROR_MAX)}…` : text };
    } finally {
      // 描けなかったときに Mermaid が残す一時的な要素を片付ける
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  }

  /**
   * root の中の Mermaid のコードブロックを図にする（覚えている図はすぐに、無ければ読み込んでから順に描く）
   * @param {ParentNode} root 表示の本文（Shadow DOM の article）など
   */
  function apply(root) {
    const { key: configKey, config } = getConfig();
    const generation = (generations.get(root) ?? 0) + 1;
    generations.set(root, generation);
    const pending = [];
    let changed = false;
    const targets = [
      ...[...root.querySelectorAll('pre > code.language-mermaid')].map((code) => ({ el: code.parentElement, source: code.textContent })),
      ...[...root.querySelectorAll('.mermaid-figure')]
        .map((fig) => ({ el: fig, ...figures.get(fig) }))
        .filter((t) => t.source !== undefined && t.configKey !== configKey),
    ];
    for (const t of targets) {
      const cacheKey = `${configKey}\u0001${t.source}`;
      const hit = cache.get(cacheKey);
      if (hit) {
        replace(t.el, t.source, configKey, hit);
        changed = true;
      } else {
        t.el.classList.add('mermaid-pending');
        pending.push({ ...t, cacheKey });
      }
    }
    if (changed) onChange(root);
    if (pending.length === 0) return Promise.resolve();
    return (async () => {
      let mermaid;
      try {
        mermaid = await load();
      } catch (err) {
        for (const t of pending) if (t.el.isConnected) replace(t.el, t.source, configKey, { error: err.message });
        onChange(root);
        return;
      }
      mermaid.initialize(config);
      for (const t of pending) {
        if (generations.get(root) !== generation) return;
        const result = cache.get(t.cacheKey) ?? (await renderOne(mermaid, t.source));
        remember(t.cacheKey, result);
        if (generations.get(root) !== generation) return;
        if (t.el.isConnected) {
          replace(t.el, t.source, configKey, result);
          onChange(root);
        }
      }
    })();
  }

  /** root に Mermaid の図（またはそのコードブロック）があるか */
  function has(root) {
    return Boolean(root.querySelector('pre > code.language-mermaid, .mermaid-figure'));
  }

  return { apply, has };
}

/**
 * 今のカラーテーマの色から、Mermaid の設定を作る（16 のテーマに図の色を合わせる）
 * @param {Record<string, string>} vars テーマの CSS 変数（--pv-bg など）
 * @param {{dark: boolean, fontFamily: string}} opts
 */
export function mermaidConfig(vars, { dark, fontFamily }) {
  const v = (name) => vars[`--${name}`];
  const themeVariables = {
    darkMode: dark,
    fontFamily,
    background: v('pv-bg'),
    // 図の箱はコードブロックと同じ背景、文字は本文の色
    primaryColor: v('pv-pre-bg'),
    primaryTextColor: v('pv-fg'),
    primaryBorderColor: v('pv-muted'),
    secondaryColor: v('pv-code-bg'),
    tertiaryColor: v('pv-bg'),
    lineColor: v('pv-muted'),
    textColor: v('pv-fg'),
    titleColor: v('pv-heading'),
    edgeLabelBackground: v('pv-bg'),
    clusterBkg: v('pv-code-bg'),
    clusterBorder: v('pv-border'),
    noteBkgColor: v('banner-bg'),
    noteTextColor: v('pv-fg'),
    noteBorderColor: v('banner-border'),
  };
  // 色で区別する図（円グラフ・ガント・マインドマップなど）は、テーマの色分けの色を順に使う
  // （箱の色をもとにすると、暗いテーマでどれも同じような灰色になり見分けられない）
  // テーマによっては同じ色を使い回している項目があるので、重なる色は除いて、ほかの項目から補う
  const candidates = ['accent', 'tk-code', 'tk-html', 'tk-emph', 'tk-link', 'danger', 'tk-mark', 'pv-heading', 'pv-link', 'pv-mark', 'banner-border', 'splitter-active', 'tk-muted', 'pv-muted'];
  const series = [...new Set(candidates.map((name) => v(name)?.toLowerCase()).filter(Boolean))].slice(0, 8);
  series.forEach((color, i) => {
    themeVariables[`pie${i + 1}`] = color;
    themeVariables[`cScale${i}`] = color;
  });
  Object.assign(themeVariables, {
    // 色の付いた部分の上の文字は背景の色（明るいテーマでは白、暗いテーマでは黒に近い）にして読みやすくする
    pieSectionTextColor: v('pv-bg'),
    pieTitleTextColor: v('pv-fg'),
    pieLegendTextColor: v('pv-fg'),
    pieStrokeColor: v('pv-bg'),
    pieOuterStrokeColor: v('pv-border'),
    taskBkgColor: v('accent'),
    taskBorderColor: v('accent'),
    taskTextColor: v('accent-fg'),
    taskTextOutsideColor: v('pv-fg'),
    taskTextDarkColor: v('pv-fg'),
    activeTaskBkgColor: v('tk-link'),
    activeTaskBorderColor: v('tk-link'),
    doneTaskBkgColor: v('pv-muted'),
    doneTaskBorderColor: v('pv-muted'),
    sectionBkgColor: v('pv-code-bg'),
    altSectionBkgColor: v('pv-bg'),
    gridColor: v('pv-border'),
    todayLineColor: v('danger'),
  });
  const config = {
    startOnLoad: false,
    // 図の中のスクリプト・HTML・クリック操作（click）を使わせない
    securityLevel: 'strict',
    theme: 'base',
    themeVariables,
    fontFamily,
    // 文字は SVG の text で描く（HTML の部品 foreignObject を使わない。無害化で取り除かずに済む）
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    // 描けないときに、Mermaid 自身が画面にエラーの図を出さないようにする（アプリが理由を表示する）
    suppressErrorRendering: true,
  };
  return { key: JSON.stringify(themeVariables), config };
}
