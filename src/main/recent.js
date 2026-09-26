// 最近開いたファイルの一覧操作（純粋関数。テスト対象）
export const MAX_RECENT = 10;

function samePath(a, b, ignoreCase) {
  return ignoreCase ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * 先頭に追加する（重複は除き、最大 MAX_RECENT 件）
 * @param {string[]} recent
 * @param {string} filePath
 * @param {{ignoreCase?: boolean}} [options] Windows ではパスの大文字小文字を区別しない
 * @returns {string[]} 新しい一覧
 */
export function pushRecent(recent, filePath, { ignoreCase = process.platform === 'win32' } = {}) {
  return [filePath, ...recent.filter((p) => !samePath(p, filePath, ignoreCase))].slice(0, MAX_RECENT);
}

/**
 * 一覧から取り除く（開けなかったファイルなど）
 */
export function removeRecent(recent, filePath, { ignoreCase = process.platform === 'win32' } = {}) {
  return recent.filter((p) => !samePath(p, filePath, ignoreCase));
}
