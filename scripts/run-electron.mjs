// 開発用の起動ラッパー
// ・VSCode 等から起動すると ELECTRON_RUN_AS_NODE=1 が引き継がれ、Electron が Node として動いてしまうため外す
// ・WSL で共有ライブラリが不足する場合、temp/syslibs に展開したライブラリを使う（npm run setup:wsl-libs）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const localLibs = path.join(root, 'temp', 'syslibs', 'root', 'usr', 'lib', 'x86_64-linux-gnu');
if (process.platform === 'linux' && fs.existsSync(localLibs)) {
  env.LD_LIBRARY_PATH = [localLibs, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
}

const child = spawn(electronPath, [root, ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
