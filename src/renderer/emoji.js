// 絵文字ショートコード（:smile: 等）→ Unicode 絵文字（とほほ 5.4 絵文字）
// 名前の一覧は GitHub の gemoji を使う
import { gemoji } from 'gemoji';

/** @type {Map<string, string>} ショートコード名 → 絵文字 */
export const emojiMap = new Map();
for (const entry of gemoji) {
  for (const name of entry.names) emojiMap.set(name, entry.emoji);
}

const SHORTCODE = /^:([a-z0-9_+-]+):/i;

/**
 * marked のインライン拡張。登録済みの名前だけを変換し、それ以外は文字のまま残す
 */
export function emojiExtension(map = emojiMap) {
  return {
    extensions: [
      {
        name: 'emoji',
        level: 'inline',
        start(src) {
          const i = src.indexOf(':');
          return i < 0 ? undefined : i;
        },
        tokenizer(src) {
          const m = SHORTCODE.exec(src);
          if (!m) return undefined;
          const emoji = map.get(m[1]) ?? map.get(m[1].toLowerCase());
          if (!emoji) return undefined;
          return { type: 'emoji', raw: m[0], name: m[1], emoji };
        },
        renderer(token) {
          return `<span class="emoji" title=":${token.name}:">${token.emoji}</span>`;
        },
      },
    ],
  };
}
