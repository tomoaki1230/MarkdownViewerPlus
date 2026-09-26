#!/usr/bin/env bash
# WSL/Linux で Electron の実行に必要な共有ライブラリが不足している場合に、
# sudo 無しで temp/syslibs に展開する（システムには何もインストールしない）。
# 展開したライブラリは scripts/run-electron.mjs と test/e2e/smoke.mjs が LD_LIBRARY_PATH で使う。
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p temp/syslibs/deb
cd temp/syslibs/deb
apt-get download libnspr4 libnss3 libasound2t64
for f in *.deb; do dpkg-deb -x "$f" ../root; done
echo "展開しました: temp/syslibs/root/usr/lib/x86_64-linux-gnu"
