// アイコン画像の生成（外部ライブラリを使わない）
// 元の大きな PNG（assets/icon.png）を、面積平均で高品質に縮小して、Windows 用の複数サイズ入り .ico を作る。
// Windows は大きな PNG を 16px 等へ縮小するとき粗く間引くため、タイトルバーやタスクバーのアイコンが汚くなる。
// あらかじめ各サイズを用意しておけば、Windows はそのサイズをそのまま使う。
import zlib from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * PNG を RGBA の画素へ展開する（8bit・インターレース無しの RGBA / RGB / グレースケールに対応）
 * @returns {{width: number, height: number, data: Uint8Array}}
 */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('PNG ではありません');
  let off = 8;
  let width, height, bitDepth, colorType, interlace;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const channelsOf = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const ch = channelsOf[colorType];
  if (bitDepth !== 8 || !ch || interlace !== 0) {
    throw new Error(`対応していない PNG 形式です（bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace}）`);
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const pixels = new Uint8Array(height * stride);
  // 行ごとのフィルタを戻す
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? pixels[dst + x - ch] : 0;
      const b = y > 0 ? pixels[dst - stride + x] : 0;
      const c = x >= ch && y > 0 ? pixels[dst - stride + x - ch] : 0;
      let v = raw[src + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[dst + x] = v & 0xff;
    }
  }
  // RGBA へそろえる
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * ch;
    const gray = ch <= 2;
    data[i * 4] = pixels[s];
    data[i * 4 + 1] = gray ? pixels[s] : pixels[s + 1];
    data[i * 4 + 2] = gray ? pixels[s] : pixels[s + 2];
    data[i * 4 + 3] = ch === 4 ? pixels[s + 3] : ch === 2 ? pixels[s + 1] : 255;
  }
  return { width, height, data };
}

/**
 * 面積平均で縮小する（各出力画素が覆う元画素の面積で重み付けし、透明部分の色が混ざらないよう
 * アルファを掛けた状態で平均する）。正方形でない場合は中央に置いて正方形にする
 */
export function resize(img, size) {
  const scale = Math.max(img.width, img.height) / size;
  const ox = (Math.max(img.width, img.height) - img.width) / 2;
  const oy = (Math.max(img.width, img.height) - img.height) / 2;
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const y0 = y * scale - oy;
    const y1 = y0 + scale;
    for (let x = 0; x < size; x++) {
      const x0 = x * scale - ox;
      const x1 = x0 + scale;
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = Math.max(0, Math.floor(y0)); sy < Math.min(img.height, Math.ceil(y1)); sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        for (let sx = Math.max(0, Math.floor(x0)); sx < Math.min(img.width, Math.ceil(x1)); sx++) {
          const w = wy * (Math.min(x1, sx + 1) - Math.max(x0, sx));
          const i = (sy * img.width + sx) * 4;
          const wa = (w * img.data[i + 3]) / 255;
          r += img.data[i] * wa;
          g += img.data[i + 1] * wa;
          b += img.data[i + 2] * wa;
          a += wa;
        }
      }
      const o = (y * size + x) * 4;
      const area = scale * scale;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / area) * 255);
    }
  }
  return { width: size, height: size, data: out };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** RGBA の画素を PNG にする */
export function encodePng(img) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8; // bitDepth
  ihdr[9] = 6; // RGBA
  const stride = img.width * 4;
  const raw = Buffer.alloc(img.height * (stride + 1));
  for (let y = 0; y < img.height; y++) {
    raw[y * (stride + 1)] = 0; // フィルタ無し
    Buffer.from(img.data.buffer, img.data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// .ico の 1 枚分（256px 未満は互換性の高いビットマップ形式、256px は PNG 形式で格納する）
function icoEntryData(img) {
  if (img.width >= 256) return encodePng(img);
  const { width: w, height: h, data } = img;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(w, 4);
  header.writeInt32LE(h * 2, 8); // 色と透過マスクの 2 枚分の高さ
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(w * h * 4);
  const maskStride = Math.ceil(w / 32) * 4;
  const mask = Buffer.alloc(maskStride * h);
  for (let y = 0; y < h; y++) {
    const row = h - 1 - y; // 下の行から格納する
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const d = (row * w + x) * 4;
      pixels[d] = data[s + 2];
      pixels[d + 1] = data[s + 1];
      pixels[d + 2] = data[s];
      pixels[d + 3] = data[s + 3];
      if (data[s + 3] === 0) mask[row * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([header, pixels, mask]);
}

/** 複数サイズの画像から .ico を作る */
export function encodeIco(images) {
  const dir = Buffer.alloc(6 + 16 * images.length);
  dir.writeUInt16LE(1, 2); // 種類: アイコン
  dir.writeUInt16LE(images.length, 4);
  const bodies = images.map(icoEntryData);
  let offset = dir.length;
  images.forEach((img, i) => {
    const e = 6 + 16 * i;
    dir[e] = img.width >= 256 ? 0 : img.width;
    dir[e + 1] = img.height >= 256 ? 0 : img.height;
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(bodies[i].length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += bodies[i].length;
  });
  return Buffer.concat([dir, ...bodies]);
}

// Windows の表示倍率（100%〜300%）で使われる大きさをそろえる
export const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

/** 元の PNG から、複数サイズ入りの .ico を作る */
export function makeIco(pngBytes) {
  const src = decodePng(pngBytes);
  return encodeIco(ICO_SIZES.map((s) => resize(src, s)));
}
