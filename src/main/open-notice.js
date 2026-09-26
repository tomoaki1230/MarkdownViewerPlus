// 開けなかったファイルのお知らせ（ダイアログではなく、ウィンドウ内に控えめに表示する文言）
// 「種類が違う」「大きすぎる」など利用者の操作で避けられる理由は、責めない言い方で、次に何をすればよいかを添える。
// 権限が無い・読み込みに失敗したなどの本当のエラーは、ここではなくエラーダイアログで知らせる。

/** 利用者の操作で避けられる「開かなかった理由」（お知らせで伝えるもの） */
export class OpenNotice extends Error {
  /**
   * @param {'binary' | 'too-large' | 'folder'} reason
   */
  constructor(reason) {
    super(REASONS[reason] ?? reason);
    this.name = 'OpenNotice';
    this.reason = reason;
  }
}

const REASONS = {
  binary: '表示できない種類のファイル',
  'too-large': '大きすぎるファイル（50MB まで）',
  folder: 'フォルダ',
};

const MAX_NAMES = 3;

/**
 * お知らせの文言を作る
 * @param {Array<{name: string, reason: string}>} notices 開かなかったファイル
 * @param {number} total 開こうとしたファイルの数
 * @returns {string}
 */
export function buildOpenNotice(notices, total) {
  if (notices.length === 0) return '';
  const hint = 'Markdown やテキストのファイルを開けます。';
  if (total <= 1 && notices.length === 1) {
    const { name, reason } = notices[0];
    return `「${name}」は${REASONS[reason] ?? reason}のため、開きませんでした。${hint}`;
  }
  const listed = notices.slice(0, MAX_NAMES).map((n) => `${n.name}（${REASONS[n.reason] ?? n.reason}）`);
  const more = notices.length > MAX_NAMES ? ` ほか ${notices.length - MAX_NAMES} 件` : '';
  const head = notices.length >= total ? `${total} 件とも開きませんでした` : `${total} 件中 ${notices.length} 件は開きませんでした`;
  return `${head}: ${listed.join('、')}${more}。${hint}`;
}
