// 上書き前の安全確認と、壊さない書き込みのテスト（一時ファイルは temp/ に作る）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkExternalChange, inspectBeforeOverwrite, readStable, safeWriteFile, snapshotStat } from '../../src/main/file-guard.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = path.join(root, 'temp', `test-file-guard-${process.pid}`);
const recoveryDir = path.join(dir, 'recovery');

before(() => fs.mkdirSync(dir, { recursive: true }));
after(() => {
  // 読み取り専用のままだと削除できない環境があるため書き込み可能に戻す
  for (const f of fs.readdirSync(dir)) {
    try {
      fs.chmodSync(path.join(dir, f), 0o755);
    } catch {
      // シンボリックリンク等は無視
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeFile(name, content = 'x') {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

test('通常のファイルは警告なし', () => {
  const p = makeFile('plain.md');
  const r = inspectBeforeOverwrite(p, snapshotStat(p));
  assert.deepEqual(r, { warnings: [], readOnly: false, missing: false });
});

test('外部変更・削除を検出する', () => {
  const p = makeFile('changed.md', 'abc');
  const snap = snapshotStat(p);
  fs.writeFileSync(p, 'abcdef');
  assert.equal(checkExternalChange(p, snap), 'changed');
  assert.match(inspectBeforeOverwrite(p, snap).warnings.join(), /外部で変更/);
  fs.rmSync(p);
  assert.equal(checkExternalChange(p, snap), 'missing');
  assert.equal(inspectBeforeOverwrite(p, snap).missing, true);
});

test('読み取り専用は上書きできない（書き込み禁止を外すこともしない）', (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root では読み取り専用を検出できない');
    return;
  }
  const p = makeFile('ro.md', 'old');
  fs.chmodSync(p, 0o444);
  assert.equal(inspectBeforeOverwrite(p, snapshotStat(p)).readOnly, true);
  assert.throws(() => safeWriteFile(p, Buffer.from('new'), { recoveryDir }), /読み取り専用のため保存できません/);
  assert.equal(fs.readFileSync(p, 'utf8'), 'old', '内容は変わらない');
  assert.equal(fs.statSync(p).mode & 0o222, 0, '書き込み禁止のまま');
});

test('上書き: 内容が置き換わり、短くなっても後ろに古い内容が残らない。控えは消える', () => {
  const p = makeFile('write.md', '長い古い内容です。'.repeat(20));
  safeWriteFile(p, Buffer.from('短い'), { recoveryDir });
  assert.equal(fs.readFileSync(p, 'utf8'), '短い');
  assert.deepEqual(fs.existsSync(recoveryDir) ? fs.readdirSync(recoveryDir) : [], [], '成功したら控えは残さない');
});

test('新しいファイルの作成（削除されたファイルの作り直し・別名で保存）', () => {
  const p = path.join(dir, 'new.md');
  safeWriteFile(p, Buffer.from('新規'), { recoveryDir });
  assert.equal(fs.readFileSync(p, 'utf8'), '新規');
});

test('書き込めない場所では例外になり、元のファイルはそのまま', () => {
  const p = makeFile('keep.md', 'そのまま');
  assert.throws(() => safeWriteFile(path.join(dir, 'no-such-dir', 'x.md'), Buffer.from('x'), { recoveryDir }));
  assert.equal(fs.readFileSync(p, 'utf8'), 'そのまま');
});

test('ハードリンクを検出し、上書きしてもリンクが保たれる', () => {
  const p = makeFile('hard.md', 'old');
  const link = path.join(dir, 'hard-link.md');
  fs.linkSync(p, link);
  assert.match(inspectBeforeOverwrite(p, snapshotStat(p)).warnings.join(), /ハードリンク/);
  safeWriteFile(p, Buffer.from('new'), { recoveryDir });
  assert.equal(fs.readFileSync(link, 'utf8'), 'new', '別名側にも反映される（実体を置き換えていない）');
});

test('シンボリックリンクを検出し、リンク自体は置き換えずリンク先を更新する', (t) => {
  const target = makeFile('target.md', 'old');
  const link = path.join(dir, 'sym.md');
  try {
    fs.symlinkSync(target, link);
  } catch {
    t.skip('シンボリックリンクを作成できない環境');
    return;
  }
  assert.match(inspectBeforeOverwrite(link, snapshotStat(link)).warnings.join(), /シンボリックリンク/);
  safeWriteFile(link, Buffer.from('new'), { recoveryDir });
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readFileSync(target, 'utf8'), 'new');
});

test('読み込み: 書き込み途中を読んだら読み直し、落ち着いた中身と「読む前の状態」を記録する', () => {
  const p = makeFile('writing.md', '完全な内容です。\n'.repeat(10));
  const full = fs.readFileSync(p);
  const real = fs.readFileSync;
  let calls = 0;
  // 1 回目の読み込みは「途中まで書かれた状態」を返し、その直後に書き込みが完了する
  const m = mock.method(fs, 'readFileSync', (file, ...rest) => {
    if (file !== p) return real(file, ...rest);
    calls++;
    if (calls === 1) {
      const partial = full.subarray(0, 10);
      fs.writeFileSync(p, Buffer.concat([full, Buffer.from('追記\n')]));
      return partial;
    }
    return real(file, ...rest);
  });
  try {
    const r = readStable(p);
    assert.equal(calls, 2, '読み直した');
    assert.equal(r.stable, true);
    assert.equal(r.bytes.toString(), `${full.toString()}追記\n`);
    assert.equal(checkExternalChange(p, r.snapshot), 'unchanged');
  } finally {
    m.mock.restore();
  }
});

test('読み込み: 書き込みが続いて落ち着かなくても、記録した状態は古いので後の変化を必ず検知する', () => {
  const p = makeFile('busy.md', 'a');
  const real = fs.readFileSync;
  // 読むたびに他のソフトが書き足す（落ち着かない）
  const m = mock.method(fs, 'readFileSync', (file, ...rest) => {
    const bytes = real(file, ...rest);
    if (file === p) fs.appendFileSync(p, 'b');
    return bytes;
  });
  let r;
  try {
    r = readStable(p, { retries: 2 });
  } finally {
    m.mock.restore();
  }
  assert.equal(r.stable, false);
  // 書き込みが終わった後: 記録した状態（読む前）と違うので「変更あり」になり、読み直し・保存時の確認につながる
  assert.equal(checkExternalChange(p, r.snapshot), 'changed');
  assert.match(inspectBeforeOverwrite(p, r.snapshot).warnings.join(), /外部で変更/);
});

test('上書き前の確認: 更新日時・サイズが同じでも中身が違えば外部変更として警告する', () => {
  const p = makeFile('same-size.md', '誤記があります');
  const time = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(p, time, time);
  const snap = snapshotStat(p, fs.readFileSync(p));
  // 同じ文字数の修正を、同じ更新日時のまま外部で行う（時刻の刻みが粗い場所・時刻を保つコピーなど）
  fs.writeFileSync(p, '誤字があります');
  fs.utimesSync(p, time, time);
  assert.equal(checkExternalChange(p, snap), 'unchanged', '日時・サイズでは区別できない');
  assert.match(inspectBeforeOverwrite(p, snap).warnings.join(), /外部で変更/);
  // 中身も同じなら警告しない
  const same = snapshotStat(p, fs.readFileSync(p));
  assert.deepEqual(inspectBeforeOverwrite(p, same).warnings, []);
});
