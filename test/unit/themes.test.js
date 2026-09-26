// カラーテーマの定義のテスト（件数・キーの網羅・読みやすさ＝コントラスト比）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DARK_THEMES, findTheme, LIGHT_THEMES, THEME_KEYS, themeCssVars } from '../../src/shared/themes.js';

// WCAG 2.x の相対輝度（#rrggbb のみ対象）
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// [前景, 背景, 最低コントラスト比]
const CHECKS = [
  ['fg', 'bg', 7],
  ['fg', 'bgSub', 4.5],
  ['fgMuted', 'bg', 4.5],
  ['fgMuted', 'bgSub', 3],
  ['gutterFg', 'bgSub', 3],
  ['accent', 'bg', 3],
  ['accentFg', 'accent', 3],
  ['danger', 'bg', 3],
  ['tkMark', 'bg', 3],
  ['tkCode', 'bg', 3],
  ['tkLink', 'bg', 3],
  ['tkHtml', 'bg', 3],
  ['tkEmph', 'bg', 3],
  ['tkMuted', 'bg', 3],
  ['pvFg', 'pvBg', 7],
  ['pvMuted', 'pvBg', 4.5],
  ['pvLink', 'pvBg', 4.5],
  ['pvHeading', 'pvBg', 4.5],
  ['pvFg', 'pvPreBg', 4.5],
];

test('ライト用・ダーク用がそれぞれ 8 つあり、ID が重複しない', () => {
  for (const list of [LIGHT_THEMES, DARK_THEMES]) {
    assert.equal(list.length, 8);
    assert.equal(new Set(list.map((t) => t.id)).size, 8);
    assert.equal(list[0].id, 'standard', '先頭は標準');
  }
});

test('すべてのテーマが全キーの色を持つ', () => {
  for (const t of [...LIGHT_THEMES, ...DARK_THEMES]) {
    for (const key of THEME_KEYS) assert.ok(t.colors[key], `${t.name}: ${key} がない`);
    assert.ok(t.name && t.description);
  }
});

test('文字と背景のコントラスト比が十分（読みやすさ）', () => {
  const failures = [];
  for (const [scheme, list] of [
    ['ライト', LIGHT_THEMES],
    ['ダーク', DARK_THEMES],
  ]) {
    for (const t of list) {
      for (const [fgKey, bgKey, min] of CHECKS) {
        const ratio = contrast(t.colors[fgKey], t.colors[bgKey]);
        if (ratio < min) failures.push(`${scheme}/${t.name}: ${fgKey} on ${bgKey} = ${ratio.toFixed(2)} (< ${min})`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('ライト用は明るい背景、ダーク用は暗い背景', () => {
  for (const t of LIGHT_THEMES) assert.ok(luminance(t.colors.bg) > 0.7, t.name);
  for (const t of DARK_THEMES) assert.ok(luminance(t.colors.bg) < 0.05, t.name);
});

test('CSS 変数名への変換と、未知の ID は標準にする', () => {
  const vars = themeCssVars(LIGHT_THEMES[0]);
  assert.equal(vars['--bg-sub'], '#f6f8fa');
  assert.equal(vars['--pv-code-bg'], 'rgba(129, 139, 152, 0.12)');
  assert.equal(vars['--splitter-active'], LIGHT_THEMES[0].colors.splitterActive);
  assert.equal(findTheme('dark', 'no-such').id, 'standard');
  assert.equal(findTheme('light', 'sakura').name, '桜色');
});
