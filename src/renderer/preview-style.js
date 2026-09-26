// プレビューの本文のフォント・行間（設定画面の「表示」で選ぶ）
// ID は main の settings.js（PREVIEW_FONTS / PREVIEW_LINE_HEIGHTS）と一致させる。
// フォントはその PC に入っていなければ次の候補、最後は標準のゴシックになる（Windows 10 以降は BIZ UD・メイリオ・游明朝を標準で持つ）

export const PREVIEW_FONT_OPTIONS = [
  { id: 'standard', label: '標準（ゴシック）', css: "-apple-system, 'Segoe UI', 'Yu Gothic UI', 'Meiryo', 'Noto Sans JP', sans-serif" },
  { id: 'ud', label: 'UD ゴシック（読みやすさ重視）', css: "'BIZ UDPGothic', 'BIZ UDPゴシック', 'Segoe UI', 'Yu Gothic UI', 'Meiryo', sans-serif" },
  { id: 'meiryo', label: 'メイリオ', css: "'Meiryo', 'メイリオ', 'Segoe UI', 'Noto Sans JP', sans-serif" },
  { id: 'mincho', label: '明朝', css: "'BIZ UDPMincho', 'BIZ UDP明朝 Medium', 'Yu Mincho', 'YuMincho', '游明朝', 'Hiragino Mincho ProN', 'MS PMincho', 'Noto Serif JP', serif" },
];

export const PREVIEW_LINE_HEIGHT_OPTIONS = [
  { id: 'compact', label: '狭い', value: '1.5' },
  { id: 'standard', label: '標準', value: '1.7' },
  { id: 'relaxed', label: '広い', value: '1.9' },
  { id: 'loose', label: 'とても広い', value: '2.2' },
];

export function previewFontCss(id) {
  return (PREVIEW_FONT_OPTIONS.find((o) => o.id === id) ?? PREVIEW_FONT_OPTIONS[0]).css;
}

export function previewLineHeight(id) {
  return (PREVIEW_LINE_HEIGHT_OPTIONS.find((o) => o.id === id) ?? PREVIEW_LINE_HEIGHT_OPTIONS[1]).value;
}
