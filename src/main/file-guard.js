// 上書き保存の安全確認と、ユーザーのファイルを壊さない書き込み
// ・読み取り専用のファイルには書き込まない（書き込み禁止を外して上書きすることもしない）
// ・外部変更・削除・ハードリンク・シンボリックリンクは、上書き前に確認する
//   外部変更は更新日時・サイズに加え、上書きの直前には中身（ハッシュ）でも確かめる（同じ大きさ・同じ時刻の変更も見逃さない）
// ・読み込みは「読む前の状態」を記録する（書き込み途中を読んでも、その後の変化を必ず検知できるように）
// ・書き込みは「実体への上書き」（リネーム方式を使わないので、ハードリンク・シンボリックリンク・属性を保つ）。
//   途中で失敗してもファイルを壊さないよう、元の内容の控えを取り、書き込み後に読み戻して照合し、失敗したら元に戻す
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function hashBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * 読み込み時点のファイル状態を記録する
 * @param {string} filePath
 * @param {Buffer} [bytes] そのとき読んだ（書いた）中身。渡すと上書き前に中身でも外部変更を確かめる
 */
export function snapshotStat(filePath, bytes) {
  const st = fs.statSync(filePath);
  return { mtimeMs: st.mtimeMs, size: st.size, ...(bytes ? { hash: hashBytes(bytes) } : {}) };
}

/**
 * 他のソフトが書き込んでいる途中でも、ちぐはぐな状態を記録しないように読む。
 * 状態（更新日時・サイズ）は**読む前**に取る。読んだ後の状態と食い違えば（書き込み途中）読み直す。
 * 何度読んでも落ち着かなければ、最後に読んだ中身を「読む前の状態」とともに返す。
 * 記録した状態は実際より古いので、書き込みが終わった後の変化として必ず検知され、読み直し・保存時の確認につながる
 * （読んだ後の状態を記録すると、書き込み途中の中身のまま変化を見逃し、保存で外部の内容を上書きしてしまう）
 * @returns {{bytes: Buffer, snapshot: {mtimeMs: number, size: number, hash: string}, stable: boolean}}
 */
export function readStable(filePath, { retries = 3 } = {}) {
  let result;
  for (let i = 0; i <= retries; i++) {
    const before = fs.statSync(filePath);
    const bytes = fs.readFileSync(filePath);
    const after = fs.statSync(filePath);
    const stable = before.mtimeMs === after.mtimeMs && before.size === after.size && bytes.length === after.size;
    result = { bytes, snapshot: { mtimeMs: before.mtimeMs, size: before.size, hash: hashBytes(bytes) }, stable };
    if (stable) break;
  }
  return result;
}

/** 書き込めるか（Windows の読み取り専用属性・アクセス権を含む） */
export function isWritable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 読み込み時点から外部で変更されたかを判定する
 * @returns {'unchanged' | 'changed' | 'missing'}
 */
export function checkExternalChange(filePath, snapshot) {
  let st;
  try {
    st = fs.statSync(filePath);
  } catch {
    return 'missing';
  }
  if (st.mtimeMs !== snapshot.mtimeMs || st.size !== snapshot.size) return 'changed';
  return 'unchanged';
}

/**
 * 上書き前に確認すべき事項を調べる
 * @param {string} filePath
 * @param {{mtimeMs: number, size: number} | null} snapshot 読み込み時の状態（null なら外部変更は調べない）
 * @returns {{warnings: string[], readOnly: boolean, missing: boolean}}
 *   readOnly が true のときは上書きしてはいけない（呼び出し側で保存を止める）
 */
export function inspectBeforeOverwrite(filePath, snapshot) {
  const warnings = [];
  let change = snapshot ? checkExternalChange(filePath, snapshot) : fs.existsSync(filePath) ? 'unchanged' : 'missing';
  if (change === 'missing') {
    warnings.push('ファイルが外部で削除（または移動）されています。保存すると同じ場所に作り直します。');
    return { warnings, readOnly: false, missing: true };
  }
  if (!isWritable(filePath)) return { warnings, readOnly: true, missing: false };
  // 更新日時・サイズが同じでも、中身が変わっていれば外部変更とみなす（時刻の刻みが粗い場所・同じ文字数の修正）
  if (change === 'unchanged' && snapshot?.hash) {
    try {
      if (hashBytes(fs.readFileSync(filePath)) !== snapshot.hash) change = 'changed';
    } catch {
      // 読めない場合は後の書き込みで失敗として扱われる
    }
  }
  if (change === 'changed') {
    warnings.push('ファイルが開いた後に外部で変更されています。保存すると外部の変更は失われます。');
  }
  const lst = fs.lstatSync(filePath);
  if (lst.isSymbolicLink()) {
    let target = '(不明)';
    try {
      target = fs.realpathSync(filePath);
    } catch {
      // リンク切れなどで解決できない場合はそのまま
    }
    warnings.push(`このファイルはシンボリックリンクです。リンク先を上書きします:\n  ${target}`);
  }
  const st = fs.statSync(filePath);
  if (st.nlink > 1) {
    warnings.push(`このファイルはハードリンクです（リンク数 ${st.nlink}）。同じ実体を共有する他のパスの内容も変わります。`);
  }
  return { warnings, readOnly: false, missing: false };
}

// ファイルへ全体を書き、ディスクへ確定させる（途中で止まっても中途半端な状態を残さないよう fsync する）
function writeAllSync(filePath, bytes, flags) {
  const fd = fs.openSync(filePath, flags);
  try {
    let off = 0;
    while (off < bytes.length) off += fs.writeSync(fd, bytes, off, bytes.length - off);
    fs.ftruncateSync(fd, bytes.length);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function sameContent(filePath, bytes) {
  try {
    return fs.readFileSync(filePath).equals(bytes);
  } catch {
    return false;
  }
}

/** 空き容量が足りるか（調べられないときは足りるとみなす） */
function hasFreeSpace(dir, needed) {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize >= needed;
  } catch {
    return true;
  }
}

/**
 * ユーザーのファイルを壊さずに上書き（または新規作成）する。
 * 1. 読み取り専用なら書かない（例外）
 * 2. 空き容量を確かめる
 * 3. 既存のファイルなら、元の内容の控えを recoveryDir に取る（停電等で途中で止まっても戻せるように）
 * 4. 実体へ上書きし（r+ で開くので、開けない場合に中身を消してしまうことがない）、ディスクへ確定させる
 * 5. 読み戻して照合する。失敗・不一致なら元の内容へ戻す。戻せなければ控えの場所を知らせる
 * 6. 成功したら控えを消す
 * @param {string} filePath
 * @param {Buffer} bytes
 * @param {{recoveryDir: string}} options
 */
export function safeWriteFile(filePath, bytes, { recoveryDir }) {
  const exists = fs.existsSync(filePath);
  if (exists && !isWritable(filePath)) throw new Error('読み取り専用のため保存できません。');
  const dir = path.dirname(filePath);

  if (!exists) {
    if (!hasFreeSpace(dir, bytes.length + 1024 * 1024)) throw new Error('保存先の空き容量が足りません。');
    try {
      writeAllSync(filePath, bytes, 'wx');
      if (!sameContent(filePath, bytes)) throw new Error('書き込んだ内容を確認できませんでした。');
    } catch (err) {
      // 作りかけのファイルは残さない（元から無かったファイルなので消しても利用者のデータは失われない）
      if (err.code !== 'EEXIST') fs.rmSync(filePath, { force: true });
      throw err;
    }
    return;
  }

  const original = fs.readFileSync(filePath);
  if (!hasFreeSpace(dir, Math.max(0, bytes.length - original.length) + 1024 * 1024)) {
    throw new Error('保存先の空き容量が足りません。');
  }
  fs.mkdirSync(recoveryDir, { recursive: true });
  const recoveryFile = path.join(recoveryDir, `${Date.now()}-${path.basename(filePath)}`);
  fs.writeFileSync(recoveryFile, original);

  try {
    writeAllSync(filePath, bytes, 'r+');
    if (!sameContent(filePath, bytes)) throw new Error('書き込んだ内容を確認できませんでした。');
  } catch (err) {
    // 元の内容へ戻す（開けなかった場合など、元のままなら何もしない）
    if (!sameContent(filePath, original)) {
      try {
        writeAllSync(filePath, original, 'r+');
      } catch {
        // 戻せなかった
      }
      if (!sameContent(filePath, original)) {
        err.message += `\n元の内容の控え: ${recoveryFile}`;
        err.recoveryFile = recoveryFile;
        throw err;
      }
    }
    fs.rmSync(recoveryFile, { force: true });
    throw err;
  }
  fs.rmSync(recoveryFile, { force: true });
}
