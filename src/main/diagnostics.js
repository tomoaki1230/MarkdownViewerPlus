// 起動・終了・異常終了の記録（userData/logs/main.log）と、起動を妨げる環境への対策の判定
// 「一瞬ウィンドウが出て終了する」など、利用者の環境でしか起きない問題の原因を後から調べられるようにする。
import fs from 'node:fs';
import path from 'node:path';

const MAX_LOG_BYTES = 256 * 1024;

/**
 * ログの書き込み先を作る。大きくなったら古い前半を捨てる（最新の記録を残す）
 * @param {string} file ログファイルのパス
 * @returns {(message: string) => void}
 */
export function createLogger(file) {
  let ready = false;
  return (message) => {
    try {
      if (!ready) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        ready = true;
        rotate(file);
      }
      const now = new Date();
      const stamp = `${now.toLocaleDateString('sv-SE')} ${now.toLocaleTimeString('sv-SE')}.${String(now.getMilliseconds()).padStart(3, '0')}`;
      fs.appendFileSync(file, `[${stamp}] ${message}\n`);
    } catch {
      // 記録できなくてもアプリの動作には影響させない
    }
  };
}

/** ログが上限を超えていたら後半（新しい方）だけを残す */
export function rotate(file, max = MAX_LOG_BYTES) {
  try {
    const st = fs.statSync(file);
    if (st.size <= max) return;
    const buf = fs.readFileSync(file);
    const tail = buf.subarray(buf.length - Math.floor(max / 2));
    const firstNewline = tail.indexOf(0x0a);
    fs.writeFileSync(file, Buffer.concat([Buffer.from('（古い記録を削除しました）\n'), tail.subarray(firstNewline + 1)]));
  } catch {
    // ファイルが無い等は無視
  }
}

/**
 * ネットワーク上の場所（UNC パス。\\wsl$ や \\wsl.localhost、\\server\share など）か。
 * Windows ではこの場所から起動すると、Chromium のサンドボックスが GPU / 表示用のプロセスを起動できず、
 * 「GPU process isn't usable. Goodbye.」で終了することがある
 */
export function isNetworkPath(p, platform = process.platform) {
  if (platform !== 'win32' || typeof p !== 'string') return false;
  return /^[\\/]{2}(?![?.][\\/])/.test(p) || /^[\\/]{2}\?[\\/]UNC[\\/]/i.test(p);
}

/**
 * GPU プロセスの異常終了かどうか（正常終了・利用者による終了は除く）
 * @param {{type: string, reason: string}} details app の child-process-gone イベントの内容
 */
export function isGpuFailure(details) {
  return details?.type === 'GPU' && !['clean-exit', 'killed'].includes(details.reason);
}
