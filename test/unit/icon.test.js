// アイコン生成（PNG の読み書き・縮小・.ico）のテスト
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodePng, encodeIco, encodePng, ICO_SIZES, makeIco, resize } from '../../scripts/icon.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function solid(width, height, rgba) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return { width, height, data };
}

test('PNG の書き出しと読み込みで画素が変わらない', () => {
  const img = solid(5, 3, [10, 20, 30, 40]);
  img.data.set([255, 0, 0, 255], 7 * 4);
  const back = decodePng(encodePng(img));
  assert.deepEqual([back.width, back.height], [5, 3]);
  assert.deepEqual(back.data, img.data);
});

test('面積平均の縮小: 白黒の縞は灰色に、透明部分の色は混ざらない', () => {
  const img = solid(4, 4, [0, 0, 0, 255]);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x += 2) img.data.set([255, 255, 255, 255], (y * 4 + x) * 4);
  assert.deepEqual([...resize(img, 1).data], [128, 128, 128, 255]);
  const half = solid(2, 2, [255, 0, 0, 255]);
  // 右半分は透明（色は緑だが見えない）
  half.data.set([0, 255, 0, 0], 4);
  half.data.set([0, 255, 0, 0], 12);
  assert.deepEqual([...resize(half, 1).data], [255, 0, 0, 128]);
});

test('.ico: 各サイズが並び、256px は PNG・それ未満はビットマップで格納される', () => {
  const ico = encodeIco([solid(16, 16, [1, 2, 3, 255]), solid(256, 256, [1, 2, 3, 255])]);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 2);
  assert.equal(ico[6], 16);
  assert.equal(ico[6 + 16], 0, '256px は 0 と書く');
  const bmp = ico.readUInt32LE(6 + 12);
  assert.equal(ico.readUInt32LE(bmp), 40, 'ビットマップのヘッダ');
  assert.equal(ico.readInt32LE(bmp + 8), 32, '高さは色と透過マスクの 2 枚分');
  const png = ico.readUInt32LE(6 + 16 + 12);
  assert.equal(ico.toString('latin1', png + 1, png + 4), 'PNG');
});

test('アプリのアイコン・ファイル用のアイコンから全サイズ入りの .ico を作れる', () => {
  for (const name of ['icon.png', 'file-icon.png']) {
    const ico = makeIco(fs.readFileSync(path.join(root, 'assets', name)));
    const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico[6 + 16 * i] || 256);
    assert.deepEqual(sizes, ICO_SIZES, name);
  }
});
