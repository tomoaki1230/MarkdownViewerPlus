// 文字コード・BOM・改行コードの保持に関するテスト
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Encoding from 'encoding-japanese';
import {
  buildSaveBytes,
  detectEncoding,
  encodeText,
  findUnconvertible,
  looksBinary,
  parseDocument,
  restoreEols,
  splitEols,
} from '../../src/main/document.js';

const JP = '日本語のテキスト：①髙﨑～';

function sjisBytes(s) {
  return Buffer.from(Encoding.convert(s, { to: 'SJIS', from: 'UNICODE', type: 'arraybuffer' }));
}

// 読み込み → そのまま保存 で 1 バイトも変わらないこと
function assertRoundTrip(bytes) {
  const doc = parseDocument(bytes);
  const { bytes: saved, unconvertible } = buildSaveBytes(doc.text, doc);
  assert.deepEqual(unconvertible, []);
  assert.ok(Buffer.from(saved).equals(Buffer.from(bytes)), `往復で内容が変わった: ${doc.encoding}`);
  return doc;
}

test('UTF-8（BOM なし / あり）を判定し、無変更保存でバイト列が一致する', () => {
  const plain = Buffer.from(`# 見出し\r\n${JP}\r\n`, 'utf8');
  const d1 = assertRoundTrip(plain);
  assert.equal(d1.encoding, 'UTF8');
  assert.equal(d1.bom, false);
  assert.equal(d1.text, `# 見出し\n${JP}\n`);

  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), plain]);
  const d2 = assertRoundTrip(withBom);
  assert.equal(d2.bom, true);
  assert.ok(!d2.text.startsWith('﻿'), 'BOM は本文に含めない');
});

test('Shift_JIS / EUC-JP を判定し、無変更保存でバイト列が一致する', () => {
  const text = `# 見出し\r\n${'日本語の文章です。'.repeat(5)}\r\n`;
  const sjis = sjisBytes(text);
  assert.equal(assertRoundTrip(sjis).encoding, 'SJIS');

  const euc = Buffer.from(Encoding.convert(text, { to: 'EUCJP', from: 'UNICODE', type: 'arraybuffer' }));
  assert.equal(assertRoundTrip(euc).encoding, 'EUCJP');
});

test('UTF-16LE（BOM 付き）を判定し往復できる', () => {
  const text = `# 見出し\r\n${JP}`;
  const body = Buffer.from(text, 'utf16le');
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), body]);
  const doc = assertRoundTrip(bytes);
  assert.equal(doc.encoding, 'UTF16LE');
  assert.equal(doc.bom, true);
});

test('改行コード: CRLF / LF / CR を判定する', () => {
  assert.equal(splitEols('a\r\nb\r\n').label, 'CRLF');
  assert.equal(splitEols('a\nb\n').label, 'LF');
  assert.equal(splitEols('a\rb\r').label, 'CR');
  assert.equal(splitEols('a\r\nb\nc').label, '混在');
});

test('改行コード混在ファイル: 触っていない行の改行は変わらない', () => {
  const raw = 'l1\r\nl2\nl3\r\nl4\nl5';
  const { text, eols, dominant } = splitEols(raw);
  // 3 行目だけ編集
  const edited = text.replace('l3', 'L3 edited');
  assert.equal(restoreEols(edited, text, eols, dominant), 'l1\r\nl2\nL3 edited\r\nl4\nl5');
  // 2 行目の後ろに行を追加（新しい行は多数派の改行）
  const inserted = text.replace('l2\n', 'l2\nnew\n');
  const restored = restoreEols(inserted, text, eols, dominant);
  assert.ok(restored.startsWith('l1\r\nl2'));
  assert.ok(restored.endsWith('l4\nl5'), restored);
  // 行を削除
  const removed = text.replace('l2\n', '');
  assert.equal(restoreEols(removed, text, eols, dominant), 'l1\r\nl3\r\nl4\nl5');
});

test('CRLF ファイルに行を追加しても CRLF のまま保存される', () => {
  const bytes = Buffer.from('a\r\nb\r\n', 'utf8');
  const doc = parseDocument(bytes);
  const { bytes: saved } = buildSaveBytes('a\nx\ny\nb\n', doc);
  assert.equal(Buffer.from(saved).toString('utf8'), 'a\r\nx\r\ny\r\nb\r\n');
});

test('末尾改行の有無が保たれる', () => {
  for (const raw of ['a\r\nb', 'a\r\nb\r\n']) {
    const doc = parseDocument(Buffer.from(raw, 'utf8'));
    const { bytes } = buildSaveBytes(doc.text.replace('a', 'A'), doc);
    assert.equal(Buffer.from(bytes).toString('utf8'), raw.replace('a', 'A'));
  }
});

test('Shift_JIS で表現できない文字を検出する（encoding-japanese は黙って ? にするため）', () => {
  const text = 'abc\n日本😀語\n𠮷野家';
  const found = findUnconvertible(text, 'SJIS');
  assert.deepEqual(
    found.map((f) => [f.char, f.line, f.column]),
    [
      ['😀', 2, 3],
      ['𠮷', 3, 1],
    ],
  );
  assert.deepEqual(findUnconvertible('普通の日本語', 'SJIS'), []);
  assert.deepEqual(findUnconvertible('😀', 'UTF8'), []);
});

test('buildSaveBytes は変換不能文字を報告する', () => {
  const doc = parseDocument(sjisBytes('テスト\r\n'.repeat(3)));
  const { unconvertible, bytes } = buildSaveBytes('テスト😀\n', doc);
  assert.equal(unconvertible.length, 1);
  assert.equal(parseDocument(bytes).text.includes('😀'), false);
});

test('detectEncoding: ASCII のみは UTF-8 扱い', () => {
  assert.deepEqual(detectEncoding(Buffer.from('hello\n')), { encoding: 'UTF8', bom: false });
  assert.equal(encodeText('a', 'UTF8', true).length, 4);
});

test('UTF-8 の高速判定は encoding-japanese の自動判定と同じ結果になる', () => {
  const toKey = (d) => {
    // parseDocument と同じ対応付け（ASCII / BINARY / UTF8 / 判定不能 は UTF-8）
    if (['SJIS', 'EUCJP', 'JIS'].includes(d)) return d;
    if (d === 'UTF16LE' || d === 'UTF16BE') return d;
    if (d === 'UTF16' || d === 'UNICODE') return 'UTF16LE';
    return 'UTF8';
  };
  const samples = [
    Buffer.from('ascii only\r\n'),
    Buffer.from('制御文字\u0001\u0007を含む UTF-8'),
    Buffer.from(`# 見出し\n${JP}\n😀𠮷`),
    sjisBytes('日本語の文章です。'.repeat(3)),
    Buffer.from(Encoding.convert('日本語の文章です。', { to: 'EUCJP', from: 'UNICODE', type: 'arraybuffer' })),
    Buffer.from(Encoding.convert('日本語の文章です。', { to: 'JIS', from: 'UNICODE', type: 'arraybuffer' })),
    Buffer.from([0xe3, 0x81]), // 途中で切れた UTF-8
    Buffer.from([0xff, 0x41, 0x42]),
    Buffer.from('a\u0000b\u0000', 'latin1'),
  ];
  for (const bytes of samples) {
    assert.equal(detectEncoding(bytes).encoding, toKey(Encoding.detect(bytes)), bytes.toString('hex').slice(0, 40));
  }
});

test('開けるかどうかは中身で判断する: テキストは拡張子に関係なく開け、バイナリは開かない', () => {
  const isBinary = (bytes) => looksBinary(parseDocument(bytes).text);
  // テキスト（.java / .js / .cfm などの内容）
  assert.equal(isBinary(Buffer.from('public class A {\n  // コメント\n}\n')), false, 'Java');
  assert.equal(isBinary(Buffer.from('const a = 1;\t// タブも可\r\n')), false, 'JavaScript');
  assert.equal(isBinary(Buffer.from('<cfset x = "テスト">\n<cfoutput>#x#</cfoutput>\n')), false, 'ColdFusion');
  assert.equal(isBinary(sjisBytes('Shift_JIS のテキスト\r\n'.repeat(5))), false, 'Shift_JIS');
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# 見出し\r\n本文', 'utf16le')]);
  assert.equal(isBinary(utf16), false, 'UTF-16');
  assert.equal(isBinary(Buffer.from('')), false, '空のファイル');
  // バイナリ
  assert.equal(isBinary(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00])), true, 'exe');
  assert.equal(isBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48])), true, 'PNG');
  // NUL を含まないが、制御文字や読めないバイトが混ざったもの（圧縮データ等を想定した乱雑なバイト列）
  let seed = 12345;
  const noise = Buffer.from(
    Array.from({ length: 4000 }, () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return 1 + (seed % 255); // 0x01〜0xFF
    }),
  );
  assert.equal(isBinary(noise), true, '乱雑なバイト列');
});
