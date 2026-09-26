// 保存でユーザーのファイルを壊さないことのテスト
// ・編集していない行は、元のバイト列のまま（文字コードの往復で変わる文字・読めないバイトも含めて）
// ・文字コード・BOM・改行コードを引き継ぐ
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Encoding from 'encoding-japanese';
import { alignLines, buildSaveBytes, parseDocument, segmentLines } from '../../src/main/document.js';

const sjis = (s) => Buffer.from(Encoding.convert(s, { to: 'SJIS', from: 'UNICODE', type: 'arraybuffer' }));
const eucjp = (s) => Buffer.from(Encoding.convert(s, { to: 'EUCJP', from: 'UNICODE', type: 'arraybuffer' }));

// 読み込み → 編集 → 保存
function edit(bytes, change) {
  const doc = parseDocument(bytes);
  const text = change(doc.text);
  return { doc, text, ...buildSaveBytes(text, doc) };
}

test('無変更で保存すると 1 バイトも変わらない（各文字コード・BOM・改行）', () => {
  const samples = [
    Buffer.from('# 見出し\r\n本文\r\n', 'utf8'),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\nb', 'utf8')]),
    sjis('日本語\r\nの文章\r\n'),
    eucjp('日本語\nの文章\n'),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# 見出し\r\n本文', 'utf16le')]),
    Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('# 見出し\r\n本文', 'utf16le').swap16()]),
    Buffer.from('l1\r\nl2\nl3\rl4', 'utf8'),
    Buffer.from('', 'utf8'),
  ];
  for (const bytes of samples) {
    const { bytes: saved } = edit(bytes, (t) => t);
    assert.ok(saved.equals(bytes), bytes.toString('hex'));
  }
});

test('Shift_JIS: NEC 特殊文字（0x8790 の ≒ 等）を含む行は、別の行を編集しても元のバイトのまま', () => {
  // 0x8790（≒）は読むと U+2252 になり、そのまま変換し直すと 0x81E0 になってしまう文字
  const line1 = Buffer.from([0x87, 0x90, 0x87, 0x40]); // ≒①（NEC 特殊文字）
  const bytes = Buffer.concat([line1, Buffer.from('\r\n'), sjis('直す行\r\n'), sjis('末尾\r\n')]);
  const { bytes: saved, lossyLines } = edit(bytes, (t) => t.replace('直す行', '直した行'));
  assert.ok(saved.subarray(0, 4).equals(line1), '編集していない行のバイトは変わらない');
  assert.ok(saved.equals(Buffer.concat([line1, Buffer.from('\r\n'), sjis('直した行\r\n'), sjis('末尾\r\n')])));
  assert.deepEqual(lossyLines, []);
});

test('正しく読めないバイトを含む行も、編集しなければ元のまま。編集したときは知らせる', () => {
  const broken = Buffer.from([0x82, 0xa0, 0xff, 0x82, 0xa2]); // あ + 不正な 0xFF + い（Shift_JIS）
  const bytes = Buffer.concat([sjis('日本語の文章です。'.repeat(4) + '\r\n'), broken, Buffer.from('\r\n'), sjis('最後の行\r\n')]);
  // 0xFF を含むと文字コード判定は BINARY（UTF-8 扱い）になるため、ここでは Shift_JIS として読んだ場合を確かめる
  const doc = parseDocument(bytes, { encoding: 'SJIS', bom: false });
  const untouched = buildSaveBytes(doc.text.replace('最後の行', '最後'), doc);
  assert.ok(untouched.bytes.includes(broken), '読めないバイトを含む行はそのまま');
  assert.deepEqual(untouched.lossyLines, []);
  const lines = doc.text.split('\n');
  const touched = buildSaveBytes(doc.text.replace(lines[1], lines[1] + '追記'), doc);
  assert.deepEqual(touched.lossyLines, [2], '読めないバイトを含む行を編集したことを知らせる');
});

test('文字コードの判定がうまくいかない（UTF-8 扱いになった）ファイルでも、編集していない行は元のバイトのまま', () => {
  const broken = Buffer.from([0x82, 0xa0, 0xff, 0x82, 0xa2]);
  const bytes = Buffer.concat([sjis('一行目\r\n'), broken, Buffer.from('\r\n'), Buffer.from('ascii line\r\n')]);
  const doc = parseDocument(bytes);
  assert.equal(doc.encoding, 'UTF8');
  const { bytes: saved } = buildSaveBytes(doc.text.replace('ascii line', 'ASCII LINE'), doc);
  assert.ok(saved.subarray(0, bytes.length - 12).equals(bytes.subarray(0, bytes.length - 12)), '1・2 行目は元のバイト');
  assert.ok(saved.toString('latin1').endsWith('ASCII LINE\r\n'));
});

test('改行コード: 混在ファイルで行を書き換えても、その行の改行コードは元のまま', () => {
  const bytes = Buffer.from('a\r\nb\nc\r\nd\n', 'utf8');
  const { bytes: saved } = edit(bytes, (t) => t.replace('b', 'B'));
  assert.equal(saved.toString('utf8'), 'a\r\nB\nc\r\nd\n');
  // 行を追加すると多数派（ここでは CRLF と LF が同数 → CRLF）
  const added = edit(bytes, (t) => t.replace('c\n', 'c\nnew\n'));
  assert.equal(added.bytes.toString('utf8'), 'a\r\nb\nc\r\nnew\r\nd\n');
  // 行を削除
  const removed = edit(bytes, (t) => t.replace('b\n', ''));
  assert.equal(removed.bytes.toString('utf8'), 'a\r\nc\r\nd\n');
});

test('UTF-16LE / BE（BOM あり）でも行単位で元のバイトを保つ', () => {
  for (const be of [false, true]) {
    const body = Buffer.from('一行目\r\n二行目\r\n三行目', 'utf16le');
    const bytes = Buffer.concat([Buffer.from(be ? [0xfe, 0xff] : [0xff, 0xfe]), be ? Buffer.from(body).swap16() : body]);
    const { bytes: saved } = edit(bytes, (t) => t.replace('二行目', '2 行目'));
    const expected = Buffer.from('一行目\r\n2 行目\r\n三行目', 'utf16le');
    assert.ok(saved.equals(Buffer.concat([bytes.subarray(0, 2), be ? expected.swap16() : expected])), be ? 'BE' : 'LE');
  }
});

test('行の切り分け: 本文の行と対応し、ISO-2022-JP は切り分けない', () => {
  const seg = segmentLines(Buffer.from('a\r\nb\rc\nd'), 'UTF8', false);
  assert.deepEqual(seg.lines.map(String), ['a', 'b', 'c', 'd']);
  assert.deepEqual(seg.eols.map(String), ['\r\n', '\r', '\n']);
  assert.equal(segmentLines(Buffer.from('a'), 'JIS', false), null);
  const jis = Buffer.from(Encoding.convert('日本語\r\nテスト\r\n', { to: 'JIS', from: 'UNICODE', type: 'arraybuffer' }));
  const { bytes: saved } = edit(jis, (t) => t.replace('テスト', 'テスト２'));
  assert.equal(Encoding.convert(saved, { to: 'UNICODE', from: 'JIS', type: 'string' }), '日本語\r\nテスト２\r\n');
});

test('行の対応付け（最長共通部分列）', () => {
  const { match, pair } = alignLines(['a', 'b', 'c', 'd', 'e'], ['a', 'X', 'c', 'Y', 'Z', 'e']);
  assert.deepEqual([...match], [0, -1, 2, -1, -1, 4]);
  assert.deepEqual([...pair], [0, 1, 2, 3, -1, 4], '置き換えた行は同じ区間の元の行と対になる');
});

test('ランダムな編集を繰り返しても、編集していない行のバイトは変わらず、内容は編集どおりになる', () => {
  let seed = 7;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const words = ['見出し', '本文', '≒', '①', 'ｱｲｳ', 'abc', '～', '髙', '𠮷', ''];
  const eolKinds = ['\r\n', '\n', '\r'];
  for (let round = 0; round < 300; round++) {
    const enc = ['UTF8', 'SJIS', 'EUCJP', 'UTF16LE'][round % 4];
    // 元のファイル（Shift_JIS では NEC 特殊文字のバイトも直接混ぜる）
    const lineCount = 1 + rand(12);
    const origLines = Array.from({ length: lineCount }, () => words[rand(words.length)] + words[rand(words.length)]);
    const chunks = [];
    origLines.forEach((l, i) => {
      const safe = enc === 'UTF8' || enc === 'UTF16LE' ? l : l.replace(/𠮷/g, '吉');
      chunks.push(
        enc === 'UTF8'
          ? Buffer.from(safe, 'utf8')
          : enc === 'UTF16LE'
            ? Buffer.from(safe, 'utf16le')
            : Buffer.from(Encoding.convert(safe, { to: enc, from: 'UNICODE', type: 'arraybuffer' })),
      );
      if (enc === 'SJIS' && rand(3) === 0) chunks.push(Buffer.from([0x87, 0x90])); // 往復で変わる文字
      if (i < lineCount - 1 || rand(2)) {
        const e = eolKinds[rand(3)];
        chunks.push(enc === 'UTF16LE' ? Buffer.from(e, 'utf16le') : Buffer.from(e));
      }
    });
    const bytes = Buffer.concat(chunks);
    const doc = parseDocument(bytes, { encoding: enc, bom: false });
    assert.ok(doc.segments, `${enc} は行ごとに切り分けられる`);
    // ランダムに編集（書き換え・挿入・削除）
    const lines = doc.text.split('\n');
    const ops = 1 + rand(3);
    for (let k = 0; k < ops; k++) {
      const at = rand(lines.length);
      const op = rand(3);
      if (op === 0) lines[at] = `${lines[at]}追記`;
      else if (op === 1) lines.splice(at, 0, '新しい行');
      else if (lines.length > 1) lines.splice(at, 1);
    }
    const text = lines.join('\n');
    const { bytes: saved } = buildSaveBytes(text, doc);
    // 内容は編集どおり
    const back = parseDocument(saved, { encoding: enc, bom: false });
    assert.equal(back.text, text, `round ${round} ${enc}`);
    // 編集していない行は元のバイト列のまま
    const { match } = alignLines(doc.text.split('\n'), lines);
    match.forEach((m, i) => {
      if (m >= 0) assert.ok(back.segments.lines[i].equals(doc.segments.lines[m]), `round ${round} ${enc} 行 ${i + 1}`);
    });
  }
});

test('ISO-2022-JP: 変換し直して元のバイト列に戻らないファイルは、保存時に知らせる', () => {
  const exact = Buffer.from(Encoding.convert('日本語\r\nテスト\r\n', { to: 'JIS', from: 'UNICODE', type: 'arraybuffer' }));
  const doc1 = parseDocument(exact);
  assert.equal(doc1.encoding, 'JIS');
  assert.deepEqual(buildSaveBytes(doc1.text + 'x', doc1).lossyLines, [], 'エンコーダと同じ書き方なら知らせない');
  // 行末で ASCII に戻す位置が違う（冗長な切り替えがある）ファイル
  const esc = (s) => Buffer.from(s, 'latin1');
  const odd = Buffer.concat([esc('\x1b$B'), esc('F|K\\'), esc('\x1b(B'), esc('\x1b(B'), Buffer.from('\r\nabc\r\n')]);
  const doc2 = parseDocument(odd, { encoding: 'JIS', bom: false });
  assert.deepEqual(buildSaveBytes(doc2.text, doc2).lossyLines, [0]);
});
