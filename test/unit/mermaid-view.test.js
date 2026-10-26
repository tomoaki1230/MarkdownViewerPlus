// Mermaid の設定（テーマの色から作る）と、表示中の検索が図の装飾を対象にしないことのテスト
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { mermaidConfig } from '../../src/renderer/mermaid-view.js';
import { buildTextIndex } from '../../src/renderer/preview-search.js';
import { DARK_THEMES, LIGHT_THEMES, themeCssVars } from '../../src/shared/themes.js';

test('Mermaid の設定: 安全な設定（strict・HTML の部品を使わない・エラーの図を出さない）で、16 のテーマすべての色が入る', () => {
  for (const [dark, list] of [[false, LIGHT_THEMES], [true, DARK_THEMES]]) {
    for (const theme of list) {
      const { key, config } = mermaidConfig(themeCssVars(theme), { dark, fontFamily: 'Meiryo' });
      assert.equal(config.securityLevel, 'strict');
      assert.equal(config.htmlLabels, false);
      assert.equal(config.flowchart.htmlLabels, false);
      assert.equal(config.suppressErrorRendering, true);
      assert.equal(config.startOnLoad, false);
      const tv = config.themeVariables;
      assert.equal(tv.darkMode, dark);
      assert.equal(tv.fontFamily, 'Meiryo');
      for (const [name, value] of Object.entries(tv)) {
        if (typeof value === 'string' && name !== 'fontFamily') assert.match(value, /^(#[0-9a-f]{3,8}|rgba?\(.+\))$/i, `${theme.id} の ${name}: ${value}`);
      }
      // 円グラフの色は見分けられるよう、すべて違う色
      const pie = Array.from({ length: 8 }, (_, i) => tv[`pie${i + 1}`].toLowerCase());
      assert.equal(new Set(pie).size, 8, `${theme.id} の円グラフの色`);
      assert.equal(typeof key, 'string');
    }
  }
  // テーマが変わると key も変わる（図を描き直す）
  const a = mermaidConfig(themeCssVars(LIGHT_THEMES[0]), { dark: false, fontFamily: 'A' }).key;
  const b = mermaidConfig(themeCssVars(DARK_THEMES[0]), { dark: true, fontFamily: 'A' }).key;
  const c = mermaidConfig(themeCssVars(LIGHT_THEMES[0]), { dark: false, fontFamily: 'B' }).key;
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test('表示中の検索の索引: 図（SVG）の中の文字は含め、図の装飾（SVG の style の中身）は含めない', () => {
  const { window } = new JSDOM('<div id="r"><p>本文</p><svg><style>.node{stroke:#000}</style><text>図の文字</text></svg></div>');
  const index = buildTextIndex(window.document.querySelector('#r'));
  assert.ok(index.text.includes('図の文字'));
  assert.ok(index.text.includes('本文'));
  assert.ok(!index.text.includes('stroke'));
});
