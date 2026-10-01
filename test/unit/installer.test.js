// インストーラ（electron-builder / NSIS）の設定のテスト: 関連付けたファイルにアイコンが確実に反映されるための設定
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('関連付けの ProgID はアプリ固有の名前（ほかのアプリの「Markdown」と取り合わない）', () => {
  const [assoc] = pkg.build.fileAssociations;
  assert.equal(assoc.name, 'MarkdownViewerPlus.md');
  assert.equal(assoc.icon, 'dist/file-icon.ico');
  assert.deepEqual(assoc.ext, ['md', 'markdown', 'mdown', 'mkd', 'mkdn']);
});

test('関連付けの登録の後に、エクスプローラーへ関連付けの変更を通知する', () => {
  const include = pkg.build.nsis.include;
  assert.equal(include, 'build/installer.nsh');
  const nsh = fs.readFileSync(path.join(root, include), 'utf8');
  const macro = /!macro customInstall([\s\S]*?)!macroend/.exec(nsh);
  assert.ok(macro, 'customInstall がある');
  // SHCNE_ASSOCCHANGED (0x08000000) と SHCNF_FLUSH (0x1000)
  assert.match(macro[1], /shell32::SHChangeNotify\(i 0x08000000, i 0x1000, i 0, i 0\)/);
});
