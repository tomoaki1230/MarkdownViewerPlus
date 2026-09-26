// 診断（起動記録・環境の判定）のテスト（一時ファイルは temp/ に作る）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createLogger, isGpuFailure, isNetworkPath, rotate } from '../../src/main/diagnostics.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = path.join(root, 'temp', `test-diagnostics-${process.pid}`);
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('ネットワーク上の場所（UNC パス）を判定する（Windows のみ）', () => {
  for (const p of ['\\\\wsl$\\Ubuntu\\home\\a\\app.exe', '\\\\wsl.localhost\\Ubuntu\\x.exe', '\\\\server\\share\\a.exe', '\\\\?\\UNC\\server\\share\\a.exe', '//server/share/a.exe']) {
    assert.equal(isNetworkPath(p, 'win32'), true, p);
  }
  for (const p of ['C:\\Program Files\\a.exe', '\\\\?\\C:\\a.exe', '\\\\.\\pipe\\x', 'D:/tools/a.exe']) {
    assert.equal(isNetworkPath(p, 'win32'), false, p);
  }
  assert.equal(isNetworkPath('\\\\server\\share\\a.exe', 'linux'), false, 'Windows 以外では判定しない');
});

test('GPU プロセスの異常終了だけを GPU の失敗とみなす', () => {
  assert.equal(isGpuFailure({ type: 'GPU', reason: 'crashed' }), true);
  assert.equal(isGpuFailure({ type: 'GPU', reason: 'launch-failed' }), true);
  assert.equal(isGpuFailure({ type: 'GPU', reason: 'clean-exit' }), false);
  assert.equal(isGpuFailure({ type: 'Utility', reason: 'crashed' }), false);
});

test('ログを追記し、上限を超えたら新しい方だけを残す', () => {
  const file = path.join(dir, 'logs', 'main.log');
  const log = createLogger(file);
  log('一行目');
  log('二行目');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] 一行目\n\[.+\] 二行目\n$/);
  fs.writeFileSync(file, Array.from({ length: 2000 }, (_, i) => `行 ${i}`).join('\n') + '\n');
  rotate(file, 4000);
  const rotated = fs.readFileSync(file, 'utf8');
  assert.ok(Buffer.byteLength(rotated) <= 2100, `サイズ: ${Buffer.byteLength(rotated)}`);
  assert.match(rotated, /行 1999\n$/, '最新の行が残る');
  assert.match(rotated, /^（古い記録を削除しました）\n行 \d+\n/, '行の途中から始まらない');
});
