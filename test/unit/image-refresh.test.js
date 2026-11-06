// 表示の画像の更新のテスト（URL の印・変更の判定）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageKey, judgeImage, withStamp } from '../../src/renderer/image-refresh.js';

test('imageKey: ローカルの画像だけ。印と # は除き、文書に書かれた ? は残す', () => {
  assert.equal(imageKey('file:///C:/a/b.png'), 'file:///C:/a/b.png');
  assert.equal(imageKey('file:///C:/a/b.png?mvp-v=123#x'), 'file:///C:/a/b.png');
  assert.equal(imageKey('file:///C:/a/b.png?size=1&mvp-v=123'), 'file:///C:/a/b.png?size=1');
  assert.equal(imageKey('https://example.com/a.png'), null);
  assert.equal(imageKey('data:image/png;base64,AAAA'), null);
  assert.equal(imageKey('こわれた'), null);
});

test('withStamp: 印を付ける・付け替える。日本語の名前や文書に書かれた ? を壊さない', () => {
  assert.equal(imageKey(withStamp('file:///C:/%E5%9B%B3.png', '1-2')), 'file:///C:/%E5%9B%B3.png');
  const once = withStamp('file:///C:/a.png?size=1', '1');
  const twice = withStamp(once, '2');
  assert.equal(new URL(twice).searchParams.get('mvp-v'), '2');
  assert.equal(new URL(twice).searchParams.get('size'), '1');
  assert.equal(imageKey(twice), 'file:///C:/a.png?size=1');
});

const st = (mtimeMs, size = 10) => ({ mtimeMs, size });

test('judgeImage: 初めて調べた画像は読み直さない。変わったら、同じ状態が 2 回続いてから読み直す', () => {
  const e = { seen: 1000 };
  assert.equal(judgeImage(e, st(500)), 'none');
  assert.equal(judgeImage(e, st(500)), 'none');
  assert.equal(judgeImage(e, st(2000)), 'recheck', '1 回目は書き込みの途中かもしれない');
  assert.equal(judgeImage(e, st(2100)), 'recheck', 'まだ変わっている');
  assert.equal(judgeImage(e, st(2100)), 'swap');
  assert.equal(judgeImage({ seen: 1000, known: '500-10' }, st(500, 20)), 'recheck', '日時が同じでも大きさが違えば変更');
});

test('judgeImage: 画面の外にある間に変わった画像（表示を作った後の日時）は、初めて調べたときに読み直す', () => {
  const e = { seen: 1000 };
  assert.equal(judgeImage(e, st(1500)), 'recheck');
  assert.equal(judgeImage(e, st(1500)), 'swap');
});

test('judgeImage: 消えた画像はそのまま。作り直されたら読み直す。無かった画像が作られても読み直す', () => {
  const e = { seen: 1000, known: '500-10' };
  assert.equal(judgeImage(e, null), 'none');
  assert.equal(judgeImage(e, st(2000)), 'recheck');
  assert.equal(judgeImage(e, st(2000)), 'swap');
  const missing = { seen: 1000 };
  assert.equal(judgeImage(missing, null), 'none');
  assert.equal(judgeImage(missing, st(500)), 'recheck');
  assert.equal(judgeImage(missing, st(500)), 'swap');
});

test('judgeImage: 読み込めなかった状態は繰り返さず、また変わったら読み直す', () => {
  const e = { seen: 1000, known: '500-10', failed: '2000-10' };
  assert.equal(judgeImage(e, st(2000)), 'none');
  assert.equal(judgeImage(e, st(3000)), 'recheck');
  assert.equal(judgeImage(e, st(3000)), 'swap');
});
