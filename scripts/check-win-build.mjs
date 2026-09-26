// Windows インストーラ（NSIS / portable）ビルド前の確認
// Linux / WSL から NSIS を作るには wine が必要（electron-builder が内部で使う）。
// 無い場合は分かりにくいエラー（spawn wine ENOENT）で途中停止するため、先に案内して終了する。
import { execFileSync } from 'node:child_process';

if (process.platform !== 'win32') {
  let found = false;
  try {
    execFileSync('wine', ['--version'], { stdio: 'ignore' });
    found = true;
  } catch {
    found = false;
  }
  if (!found) {
    console.error(
      [
        '',
        '[エラー] Windows インストーラ（NSIS）の作成には wine が必要ですが、見つかりません。',
        '',
        '  次のコマンドで wine を入れてから、もう一度 npm run dist:win を実行してください:',
        '    sudo dpkg --add-architecture i386',
        '    sudo apt update',
        '    sudo apt install -y wine wine64 wine32:i386',
        '',
        '  wine を使わずに配布したい場合は zip 版を作成できます:',
        '    npm run dist:win:zip',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
}
