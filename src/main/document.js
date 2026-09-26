// ファイルの読み込み・保存に関する純粋ロジック（Electron 非依存。テスト対象）
// 方針: 保存で文字コード・BOM・改行コードを変えない。
import { createRequire } from 'node:module';

// encoding-japanese は大きく読み込みに時間がかかる（起動時間のため）。
// UTF-8 のファイルでは使わないので、Shift_JIS 等が必要になったときに初めて読み込む
const require = createRequire(import.meta.url);
let encodingLib = null;
function Encoding() {
  encodingLib ??= require('encoding-japanese');
  return encodingLib;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * encoding-japanese を使わずに UTF-8 と判定できるか。
 * NUL（UTF-16/32 の手がかり）と ESC（ISO-2022-JP の手がかり）を含まず、正しい UTF-8 なら、
 * encoding-japanese の自動判定（UTF32 > UTF16 > BINARY > ASCII > JIS > UTF8 > …）も必ず UTF-8 系
 * （ASCII / BINARY / UTF8 → いずれも UTF-8 扱い）になるので、結果は同じになる。
 */
function isPlainUtf8(bytes) {
  if (bytes.includes(0x00) || bytes.includes(0x1b)) return false;
  try {
    utf8Decoder.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

// 対応する文字コードの内部名 → 表示名
export const ENCODING_LABELS = {
  UTF8: 'UTF-8',
  SJIS: 'Shift_JIS',
  EUCJP: 'EUC-JP',
  JIS: 'ISO-2022-JP',
  UTF16LE: 'UTF-16LE',
  UTF16BE: 'UTF-16BE',
};

const BOMS = {
  UTF8: [0xef, 0xbb, 0xbf],
  UTF16LE: [0xff, 0xfe],
  UTF16BE: [0xfe, 0xff],
};

function startsWith(bytes, prefix) {
  if (bytes.length < prefix.length) return false;
  return prefix.every((b, i) => bytes[i] === b);
}

/**
 * バイト列の文字コードと BOM を判定する
 * @param {Uint8Array} bytes
 * @returns {{encoding: string, bom: boolean}}
 */
export function detectEncoding(bytes) {
  for (const [enc, bom] of Object.entries(BOMS)) {
    if (startsWith(bytes, bom)) return { encoding: enc, bom: true };
  }
  if (isPlainUtf8(bytes)) return { encoding: 'UTF8', bom: false };
  const detected = Encoding().detect(bytes);
  switch (detected) {
    case 'SJIS':
    case 'EUCJP':
    case 'JIS':
      return { encoding: detected, bom: false };
    case 'UTF16LE':
    case 'UTF16BE':
      return { encoding: detected, bom: false };
    case 'UTF16':
    case 'UNICODE':
      // BOM 無し UTF-16 はエンディアン不明のため LE とみなす（Windows の慣習）
      return { encoding: 'UTF16LE', bom: false };
    default:
      // ASCII / UTF8 / BINARY / 判定不能 は UTF-8 として扱う
      return { encoding: 'UTF8', bom: false };
  }
}

/**
 * バイト列 → 文字列（BOM を除去）
 */
export function decodeBytes(bytes, encoding, bom) {
  const body = bom ? bytes.subarray(BOMS[encoding].length) : bytes;
  if (encoding === 'UTF8') return Buffer.from(body).toString('utf8');
  return Encoding().convert(body, { to: 'UNICODE', from: encoding, type: 'string' });
}

/**
 * 文字列 → バイト列（BOM を付与）。変換できない文字は encoding-japanese が黙って '?' にするため、
 * ここでは変換結果をそのまま返し、検出は findUnconvertible() で行う。
 */
export function encodeText(text, encoding, bom) {
  let body;
  if (encoding === 'UTF8') {
    body = Buffer.from(text, 'utf8');
  } else {
    body = Buffer.from(Encoding().convert(text, { to: encoding, from: 'UNICODE', type: 'arraybuffer' }));
  }
  if (!bom) return body;
  return Buffer.concat([Buffer.from(BOMS[encoding]), body]);
}

/**
 * 指定の文字コードで表現できない文字を列挙する（往復変換で一致しない文字）
 * @returns {Array<{char: string, line: number, column: number}>} 位置は 1 始まり。同じ文字は最初の出現のみ
 */
export function findUnconvertible(text, encoding) {
  if (encoding === 'UTF8' || encoding === 'UTF16LE' || encoding === 'UTF16BE') {
    // Unicode 系は孤立サロゲート以外すべて表現可能
    return findLoneSurrogates(text);
  }
  // 全体の往復が一致すれば問題なし（高速パス）
  const roundTrip = decodeBytes(encodeText(text, encoding, false), encoding, false);
  if (roundTrip === text) return [];

  const result = [];
  const checked = new Map();
  let line = 1;
  let column = 1;
  for (const ch of text) {
    if (ch === '\n') {
      line++;
      column = 1;
      continue;
    }
    let ok = checked.get(ch);
    if (ok === undefined) {
      ok = decodeBytes(encodeText(ch, encoding, false), encoding, false) === ch;
      checked.set(ch, ok);
      if (!ok) result.push({ char: ch, line, column });
    }
    column++;
  }
  return result;
}

function findLoneSurrogates(text) {
  const result = [];
  let line = 1;
  let column = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0a) {
      line++;
      column = 1;
      continue;
    }
    const isHigh = c >= 0xd800 && c <= 0xdbff;
    const isLow = c >= 0xdc00 && c <= 0xdfff;
    if (isHigh) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        column++;
        continue;
      }
    }
    if (isHigh || isLow) result.push({ char: text[i], line, column });
    column++;
  }
  return result;
}

/**
 * 改行コードを解析し、エディタ用に LF へ正規化する
 * @returns {{text: string, eols: string[], dominant: string, label: string}}
 *   eols[i] は i 行目の後ろの改行コード（最終行の後ろには無いので lines.length - 1 個）
 */
export function splitEols(raw) {
  const eols = [];
  const counts = { '\r\n': 0, '\n': 0, '\r': 0 };
  const text = raw.replace(/\r\n|\r|\n/g, (m) => {
    eols.push(m);
    counts[m]++;
    return '\n';
  });
  let dominant = '\n';
  if (counts['\r\n'] >= counts['\n'] && counts['\r\n'] >= counts['\r'] && counts['\r\n'] > 0) dominant = '\r\n';
  else if (counts['\r'] > counts['\n']) dominant = '\r';
  // 改行を含まないファイルは OS の慣習に合わせる（新規行を足したときに使う）
  if (eols.length === 0) dominant = process.platform === 'win32' ? '\r\n' : '\n';
  const kinds = Object.values(counts).filter((n) => n > 0).length;
  return { text, eols, dominant, label: eolLabel(kinds > 1 ? 'mixed' : dominant, eols.length === 0) };
}

export function eolLabel(eol, none = false) {
  if (eol === 'mixed') return '混在';
  const name = { '\r\n': 'CRLF', '\n': 'LF', '\r': 'CR' }[eol];
  return none ? `${name}(改行なし)` : name;
}

/**
 * 編集後テキスト（LF 正規化済み）に、元の改行コードを復元する。
 * 変更されていない先頭・末尾の行は元の改行コードをそのまま使い、
 * 変更区間は行数が同じなら同じ位置の改行コード、異なれば多数派の改行コードを使う。
 * これにより改行コードが混在したファイルでも、触っていない行の改行は変わらない。
 */
export function restoreEols(newText, origText, origEols, dominant) {
  const newLines = newText.split('\n');
  const oldLines = origText.split('\n');
  const newEolCount = newLines.length - 1;
  if (newEolCount === 0) return newText;

  let prefix = 0;
  const maxPrefix = Math.min(newLines.length, oldLines.length);
  while (prefix < maxPrefix && newLines[prefix] === oldLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < newLines.length - prefix &&
    suffix < oldLines.length - prefix &&
    newLines[newLines.length - 1 - suffix] === oldLines[oldLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  const newMid = newLines.length - prefix - suffix;
  const oldMid = oldLines.length - prefix - suffix;

  const eolAt = (i) => {
    // i 行目の後ろの改行コード
    if (i < prefix) return origEols[i] ?? dominant;
    if (i >= newLines.length - suffix) {
      const oldIndex = oldLines.length - (newLines.length - i);
      return origEols[oldIndex] ?? dominant;
    }
    if (newMid === oldMid) return origEols[i] ?? dominant;
    return dominant;
  };

  let out = '';
  for (let i = 0; i < newLines.length; i++) {
    out += newLines[i];
    if (i < newEolCount) out += eolAt(i);
  }
  return out;
}

const BINARY_SAMPLE_CHARS = 64 * 1024;

/**
 * 文字として読めない（バイナリの）内容か。開けるかどうかは拡張子ではなく中身で判断する
 * （.java・.js・.cfm などのテキストファイルも開ける。exe・画像・圧縮ファイルなどは開かない）。
 * - NUL 文字がある: 正しく読めたテキストには現れない（UTF-16 のファイルは文字コードの判定で正しく読むので残らない）
 * - 制御文字や、読めないバイト（U+FFFD）の割合が高い: バイナリをテキストとして読んだときの特徴
 * 判定は先頭 64K 文字で行う
 */
export function looksBinary(text) {
  const sample = text.length > BINARY_SAMPLE_CHARS ? text.slice(0, BINARY_SAMPLE_CHARS) : text;
  if (sample.includes('\u0000')) return true;
  let odd = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    // タブ・改行・改ページ等以外の制御文字と、読めないバイトを数える
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0b && c !== 0x0c && c !== 0x0d && c !== 0x1b) || c === 0x7f || c === 0xfffd) {
      odd++;
    }
  }
  return odd > Math.max(8, sample.length * 0.01);
}

/**
 * 元のバイト列を行ごとに切り分ける（改行のバイト位置で切る）。本文の行と 1 対 1 に対応する。
 * 保存時に、編集していない行を元のバイト列のまま書き戻すために使う
 * （文字コードの往復変換でバイトが変わる文字 ― Shift_JIS の NEC 特殊文字・IBM 拡張文字の重複や、
 *   正しく読めないバイト ― を、触っていない行では絶対に変えないため）。
 * UTF-8 / Shift_JIS / EUC-JP は 2 バイト目以降に 0x0A・0x0D が現れないのでバイト単位で、
 * UTF-16 は 2 バイト単位で探す。ISO-2022-JP は行をまたぐ切り替え状態があるため切り分けない（null）
 * @returns {{lines: Buffer[], eols: Buffer[]} | null}
 */
export function segmentLines(bytes, encoding, bom) {
  if (encoding === 'JIS') return null;
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = bom ? BOMS[encoding].length : 0;
  const unit = encoding === 'UTF16LE' || encoding === 'UTF16BE' ? 2 : 1;
  if ((buf.length - start) % unit !== 0) return null;
  const read = unit === 1 ? (i) => buf[i] : encoding === 'UTF16LE' ? (i) => buf.readUInt16LE(i) : (i) => buf.readUInt16BE(i);
  const lines = [];
  const eols = [];
  let lineStart = start;
  let i = start;
  while (i < buf.length) {
    const c = read(i);
    if (c === 0x0d || c === 0x0a) {
      let len = unit;
      if (c === 0x0d && i + unit < buf.length && read(i + unit) === 0x0a) len = unit * 2;
      lines.push(buf.subarray(lineStart, i));
      eols.push(buf.subarray(i, i + len));
      i += len;
      lineStart = i;
    } else {
      i += unit;
    }
  }
  lines.push(buf.subarray(lineStart));
  return { lines, eols };
}

/**
 * バイト列を読み込み、エディタに渡せる形にする
 * @param {Uint8Array} bytes
 * @param {{encoding: string, bom: boolean}} [known] 文字コードが分かっているとき（保存直後の読み直し等。判定し直さない）
 */
export function parseDocument(bytes, known = null) {
  const { encoding, bom } = known ?? detectEncoding(bytes);
  const raw = decodeBytes(bytes, encoding, bom);
  const { text, eols, dominant, label } = splitEols(raw);
  let segments = segmentLines(bytes, encoding, bom);
  // 本文の行と対応しないときは使わない（安全側: 全体を変換し直す方式にする）
  if (segments && segments.eols.length !== eols.length) segments = null;
  // 全体を変換し直す方式のとき、無変更で変換し直して元のバイト列に戻るか（戻らなければ保存前に知らせる）
  const wholeRewriteExact = segments ? true : encodeText(raw, encoding, bom).equals(Buffer.from(bytes));
  return { text, encoding, bom, eols, dominant, eolLabel: label, segments, wholeRewriteExact };
}

const MAX_LCS_CELLS = 4_000_000;

/**
 * 編集後の各行が、元のどの行とそのまま一致するかを求める（先頭・末尾の一致 + 中央部分は最長共通部分列）。
 * 一致しない行は、同じ区間の元の行と先頭から順に対にする（改行コードを引き継ぐため）
 * @returns {{match: Int32Array, pair: Int32Array}} match[i]: 内容が一致する元の行（無ければ -1）、
 *   pair[i]: 改行コードを引き継ぐ元の行（一致した行はその行、置き換えた行は対になる元の行、無ければ -1）
 */
export function alignLines(oldLines, newLines) {
  const n = newLines.length;
  const o = oldLines.length;
  const match = new Int32Array(n).fill(-1);
  let prefix = 0;
  while (prefix < n && prefix < o && newLines[prefix] === oldLines[prefix]) {
    match[prefix] = prefix;
    prefix++;
  }
  let suffix = 0;
  while (suffix < n - prefix && suffix < o - prefix && newLines[n - 1 - suffix] === oldLines[o - 1 - suffix]) {
    match[n - 1 - suffix] = o - 1 - suffix;
    suffix++;
  }
  const nm = n - prefix - suffix;
  const om = o - prefix - suffix;
  if (nm > 0 && om > 0 && nm * om <= MAX_LCS_CELLS) {
    // 中央部分の最長共通部分列（行単位）
    const dp = new Uint32Array((nm + 1) * (om + 1));
    const w = om + 1;
    for (let a = nm - 1; a >= 0; a--) {
      for (let b = om - 1; b >= 0; b--) {
        dp[a * w + b] =
          newLines[prefix + a] === oldLines[prefix + b] ? dp[(a + 1) * w + b + 1] + 1 : Math.max(dp[(a + 1) * w + b], dp[a * w + b + 1]);
      }
    }
    let a = 0;
    let b = 0;
    while (a < nm && b < om) {
      if (newLines[prefix + a] === oldLines[prefix + b]) {
        match[prefix + a] = prefix + b;
        a++;
        b++;
      } else if (dp[(a + 1) * w + b] >= dp[a * w + b + 1]) a++;
      else b++;
    }
  }
  // 一致しない行を、前後の一致した行の間（区間）で元の行と先頭から対にする
  const pair = Int32Array.from(match);
  let i = 0;
  let prevOld = -1;
  while (i < n) {
    if (match[i] >= 0) {
      prevOld = match[i];
      i++;
      continue;
    }
    let j = i;
    while (j < n && match[j] < 0) j++;
    const nextOld = j < n ? match[j] : o;
    for (let k = 0; k < j - i && prevOld + 1 + k < nextOld; k++) pair[i + k] = prevOld + 1 + k;
    i = j;
  }
  return { match, pair };
}

/**
 * 保存用のバイト列を作る。
 * - 編集していない行は、読み込んだときのバイト列（改行を含む）をそのまま書き戻す
 * - 編集した行・追加した行だけを元の文字コードで変換する。改行は、置き換えた元の行の改行コードを引き継ぎ、
 *   無ければ（行が増えた等）多数派の改行コードにする
 * - BOM は元のまま
 * @param {string} text LF 正規化済みの編集後テキスト
 * @param {{text: string, encoding: string, bom: boolean, eols: string[], dominant: string, segments?: object}} base 読み込み時（または前回保存時）の情報
 * @returns {{bytes: Buffer, unconvertible: Array, lossyLines: number[]}} lossyLines: 置き換えた元の行のうち、
 *   文字コードとして正しく読めない部分があったため保存で内容が変わる行（元の行番号、1 始まり）。
 *   0 だけのときは「全体を変換し直すため、編集していない部分のバイト列も変わる」ことを表す
 */
export function buildSaveBytes(text, base) {
  const unconvertible = findUnconvertible(text, base.encoding);
  if (!base.segments) {
    // 行ごとの切り分けができない文字コード（ISO-2022-JP）: 全体を変換し直す。
    // 無変更でも元のバイト列に戻らないファイルなら、編集していない部分も変わることを知らせる（lossyLines に 0）
    const restored = restoreEols(text, base.text, base.eols, base.dominant);
    return { bytes: encodeText(restored, base.encoding, base.bom), unconvertible, lossyLines: base.wholeRewriteExact === false ? [0] : [] };
  }
  const enc = base.encoding;
  const { lines: oldBytes, eols: oldEolBytes } = base.segments;
  const oldLines = base.text.split('\n');
  const newLines = text.split('\n');
  const { match, pair } = alignLines(oldLines, newLines);
  const dominantBytes = encodeText(base.dominant, enc, false);

  const parts = [];
  if (base.bom) parts.push(Buffer.from(BOMS[enc]));
  for (let i = 0; i < newLines.length; i++) {
    parts.push(match[i] >= 0 ? oldBytes[match[i]] : encodeText(newLines[i], enc, false));
    if (i < newLines.length - 1) {
      const p = pair[i];
      parts.push(p >= 0 && p < oldEolBytes.length ? oldEolBytes[p] : dominantBytes);
    }
  }

  // 置き換えた（一致しなかった）元の行に、往復変換でバイトが変わる部分があれば知らせる
  const used = new Uint8Array(oldLines.length);
  for (const m of match) if (m >= 0) used[m] = 1;
  const lossyLines = [];
  for (let k = 0; k < oldLines.length; k++) {
    if (used[k]) continue;
    if (!encodeText(oldLines[k], enc, false).equals(oldBytes[k])) lossyLines.push(k + 1);
  }
  return { bytes: Buffer.concat(parts), unconvertible, lossyLines };
}

export function encodingDisplay(encoding, bom) {
  const name = ENCODING_LABELS[encoding] ?? encoding;
  if (encoding === 'UTF8') return bom ? 'UTF-8 (BOM付き)' : 'UTF-8';
  return bom ? `${name} (BOM付き)` : name;
}
