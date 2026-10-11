// Windows のスマート アプリ コントロール（SAC）で、作った配布物がブロックされないかを確かめる（npm run dist:win の最後に実行）
// ・アプリは署名していないため、SAC がオンの Windows 11 では Microsoft のクラウドの判定次第でブロックされうる。
//   判定はファイルの中身ごとなので、版を上げるたびに確かめ直す。
// ・WSL から、ホストの Windows（SAC がオン）で実際に起動して確かめる。ダウンロードした場合と同じく
//   「インターネットから取得した」印（Zone.Identifier）を付け、画面には出さずに起動し、すぐ終了させる。
// ・確かめられない環境（WSL でない・SAC がオンでない）では、その旨を出して成功扱いで終わる。ブロックされたら失敗（終了コード 1）。
// 手動で実行: node scripts/check-sac.mjs（--app-only: インストーラを除く。zip 版だけを作ったとき）
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const setup = path.join(root, 'release', `MarkdownViewerPlus Setup ${version}.exe`);
const unpacked = path.join(root, 'release', 'win-unpacked');
const appOnly = process.argv.includes('--app-only');

function skip(reason) {
  console.log(`\n[SAC の確認] 確かめられないため省略しました（${reason}）。`);
  process.exit(0);
}

if (!fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop') && !process.env.WSL_DISTRO_NAME) skip('WSL 上ではありません');
if ((!appOnly && !fs.existsSync(setup)) || !fs.existsSync(path.join(unpacked, 'MarkdownViewerPlus.exe'))) skip('配布物が見つかりません');

// Windows のコマンドを実行して標準出力を返す（cwd を Windows のフォルダにしないと警告が出る）
const win = (file, args) => execFileSync(file, args, { cwd: '/mnt/c', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\r/g, '');
const ps = (command) => win('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`]);

let state;
try {
  state = ps('(Get-MpComputerStatus).SmartAppControlState').trim();
} catch {
  skip('Windows の状態を読めません');
}
if (state !== 'On') skip(`ホストの SAC が「${state || '不明'}」で、オンではありません`);

// ホストの一時フォルダ（ローカル）へコピーする（WSL のパスのまま起動すると、ネットワーク上の場所として扱われるため）
const tempWin = win('cmd.exe', ['/c', 'echo %TEMP%']).trim();
const workWin = `${tempWin}\\mvp-sac-check`;
const work = win('wslpath', ['-u', workWin]).trim();
// WSL から Windows のフォルダ（/mnt/c）への書き込みは、まれに中断される（EINTR など。90 回中 3 回起きた）。
// SAC とは関係の無い失敗でビルドが止まらないよう、少し待って最初からやり直す
const RETRYABLE = new Set(['EINTR', 'EAGAIN', 'EBUSY', 'EIO', 'EPERM', 'EACCES', 'ENOTEMPTY']);
function withRetry(label, fn, times = 5) {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (err) {
      if (i >= times || !RETRYABLE.has(err.code)) throw err;
      console.log(`  （${label}が中断されたため、やり直します: ${err.code}、${i} 回目）`);
      execFileSync('sleep', [String(i)]);
    }
  }
}

withRetry('一時フォルダへのコピー', () => {
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  fs.cpSync(unpacked, path.join(work, 'app'), { recursive: true });
  if (!appOnly) fs.copyFileSync(setup, path.join(work, 'setup.exe'));
  fs.writeFileSync(path.join(work, 'test.md'), '# SAC の確認\n');
});

const script = `
$ErrorActionPreference = 'Continue'
$base = '${workWin}'
$zone = "[ZoneTransfer]\`r\`nZoneId=3"
Get-ChildItem $base -Recurse -File | Where-Object { $_.Extension -in '.exe', '.dll', '.node' } | ForEach-Object { Set-Content -LiteralPath $_.FullName -Stream Zone.Identifier -Value $zone }
$start = Get-Date
function Try-Run($label, $file, $arguments) {
  try {
    if ($arguments) { $p = Start-Process -FilePath $file -ArgumentList $arguments -WindowStyle Hidden -PassThru -ErrorAction Stop }
    else { $p = Start-Process -FilePath $file -WindowStyle Hidden -PassThru -ErrorAction Stop }
    Start-Sleep -Seconds 6
    $p.Refresh()
    if ($p.HasExited) { "RESULT $label NG 起動後すぐ終了した（終了コード $($p.ExitCode)）" } else { "RESULT $label OK 起動した" }
    Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $p.Id } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  } catch {
    "RESULT $label NG 起動できない: $($_.Exception.Message)"
  }
}
# アプリは画面に出さない（MVP_E2E_HIDDEN）。設定は専用の場所に保存する
$env:MVP_E2E = '1'
$env:MVP_E2E_HIDDEN = '1'
$env:MVP_USER_DATA = Join-Path $base 'ud'
Try-Run 'アプリ' (Join-Path $base 'app\\MarkdownViewerPlus.exe') ('"' + (Join-Path $base 'test.md') + '"')
# インストーラは最初の画面のまま（インストールはしない）、非表示で起動して終了させる
if (Test-Path (Join-Path $base 'setup.exe')) { Try-Run 'インストーラ' (Join-Path $base 'setup.exe') $null }
Start-Sleep -Seconds 1
Get-Process | Where-Object { $_.Path -like "$base*" } | Stop-Process -Force -ErrorAction SilentlyContinue
Get-WinEvent -LogName 'Microsoft-Windows-CodeIntegrity/Operational' -ErrorAction SilentlyContinue |
  Where-Object { $_.TimeCreated -ge $start.AddSeconds(-2) -and $_.Message -like '*mvp-sac-check*' } |
  ForEach-Object { "BLOCK ID=$($_.Id) " + (($_.Message -replace '\\s+', ' ').Substring(0, [Math]::Min(300, ($_.Message -replace '\\s+', ' ').Length))) }
`;
// Windows PowerShell 5 は BOM の無いスクリプトを UTF-8 として読まない
withRetry('確認用スクリプトの書き込み', () => fs.writeFileSync(path.join(work, 'check.ps1'), `\uFEFF${script}`));

console.log(`\n[SAC の確認] ${version} の配布物を、ホストの Windows（SAC: オン）で起動して確かめます（画面には出しません）`);
let out = '';
try {
  out = ps(`& '${workWin}\\check.ps1'`);
} finally {
  // 起動したプロセスが掴んでいることがあるので、少し待ってから消す
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(work, { recursive: true, force: true });
      break;
    } catch {
      execFileSync('sleep', ['1']);
    }
  }
}
const results = out.split('\n').filter((l) => l.startsWith('RESULT '));
const blocks = out.split('\n').filter((l) => l.startsWith('BLOCK '));
for (const l of results) console.log(`  ${l.replace(/^RESULT (\S+) OK/, '✔ $1:').replace(/^RESULT (\S+) NG/, '✖ $1:')}`);
for (const l of blocks) console.log(`  ✖ ブロックの記録: ${l.slice(6)}`);
const expected = appOnly ? 1 : 2;
const ok = results.length === expected && results.every((l) => / OK /.test(l)) && blocks.length === 0;
if (!ok) {
  if (results.length !== expected) console.log(out);
  console.error('\n[SAC の確認] ブロックされました（またはそのおそれがあります）。このまま公開すると、SAC がオンの Windows 11 では使えない可能性があります。');
  process.exit(1);
}
console.log('[SAC の確認] ブロックされませんでした。');
