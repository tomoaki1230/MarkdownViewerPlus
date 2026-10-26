// レンダラーのビルド（esbuild）
// 起動時間のため、依存を分ける:
//   boot.bundle.js … テーマの色を最初の描画より前に当てる小さなスクリプト（<head> で同期実行）
//   app.bundle.js  … marked / DOMPurify / 絵文字 / アプリ本体（起動時に読み込む）
//   hljs.bundle.js … highlight.js（本文を描画した後に遅延ロード）
//   mermaid.bundle.js … Mermaid（図。図のある文書を開いたときだけ遅延ロード。約 5MB）
// あわせて、assets/icon.png から複数サイズ入りの dist/icon.ico を作る（Windows のウィンドウ・トレイ・exe のアイコン）
// assets/file-icon.png からは dist/file-icon.ico を作る（インストーラが関連付けた .md ファイルのアイコン）
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeIco } from './icon.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src', 'renderer');
const out = path.join(root, 'dist', 'renderer');
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

function copyStatic() {
  fs.copyFileSync(path.join(src, 'index.html'), path.join(out, 'index.html'));
  fs.copyFileSync(path.join(src, 'app.css'), path.join(out, 'app.css'));
  // プレビュー用 CSS に highlight.js のテーマ（ライト / ダーク）を連結する
  const styles = path.join(root, 'node_modules', 'highlight.js', 'styles');
  const light = fs.readFileSync(path.join(styles, 'github.css'), 'utf8');
  const dark = fs.readFileSync(path.join(styles, 'github-dark.css'), 'utf8');
  const preview = fs.readFileSync(path.join(src, 'preview.css'), 'utf8');
  fs.writeFileSync(
    path.join(out, 'preview.css'),
    `${preview}\n/* highlight.js github */\n${light}\n@media (prefers-color-scheme: dark) {\n${dark}\n}\n`,
  );
}

const common = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome130',
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  legalComments: 'none',
  logLevel: 'info',
};

// 絵文字データ（gemoji）は説明・タグ・カテゴリ等を含み大きい。バンドルには「名前と絵文字」だけを入れ、
// 大きなデータは JS のオブジェクト表記より速く読める JSON.parse で展開する（読み込み・評価の時間を減らす）
const compactEmoji = {
  name: 'compact-gemoji',
  setup(b) {
    b.onResolve({ filter: /^gemoji$/ }, () => ({ path: 'gemoji', namespace: 'compact-gemoji' }));
    b.onLoad({ filter: /.*/, namespace: 'compact-gemoji' }, async () => {
      const { gemoji } = await import('gemoji');
      const compact = gemoji.map((e) => ({ emoji: e.emoji, names: e.names }));
      return { contents: `export const gemoji = JSON.parse(${JSON.stringify(JSON.stringify(compact))});`, loader: 'js' };
    });
  },
};

// サードパーティのライセンス一覧（THIRD_PARTY_LICENSES.txt）
// 配布物に組み込むライブラリの著作権表示とライセンス文を 1 つにまとめ、アプリに同梱する（MIT・BSD・Apache の表示義務）。
// バンドルでは著作権表示のコメントを取り除く（legalComments: 'none'）ため、ここで必ず残す。
// 組み込むライブラリを増やしたら THIRD_PARTY に追加すること（node_modules に無ければビルドを失敗させる）
const THIRD_PARTY = [
  { name: 'marked', license: 'MIT', files: ['LICENSE'] },
  {
    name: 'dompurify',
    label: 'DOMPurify',
    license: 'Apache-2.0（MPL-2.0 との選択制。本アプリは Apache License 2.0 の下で利用）',
    files: ['LICENSE'],
  },
  { name: 'gemoji', license: 'MIT', files: ['license'] },
  { name: 'highlight.js', license: 'BSD-3-Clause（コードの色付けと配色テーマ github / github-dark）', files: ['LICENSE'] },
  { name: 'encoding-japanese', license: 'MIT', files: ['LICENSE'] },
];

// Mermaid は多くの部品を内部で使うため、手で書くと漏れる。mermaid.bundle.js に実際に入った部品を
// esbuild の metafile から求め、それぞれの package.json のライセンスと、同梱のライセンス文を載せる
function bundledPackages(metafile) {
  const names = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    // 入れ子の node_modules（部品の中の部品）は、いちばん内側の部品の名前を使う
    const all = [...input.replaceAll('\\', '/').matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)\//g)];
    if (all.length) names.add(all.map((m) => m[0]).join('').replace(/\/$/, ''));
  }
  // もともと一覧に載せている部品（DOMPurify など）は重ねて載せない
  const listed = new Set(THIRD_PARTY.map((l) => `node_modules/${l.name}`));
  return [...names].filter((n) => !listed.has(n)).sort();
}

function licenseFiles(dir) {
  return fs.readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)/i.test(f) && fs.statSync(path.join(dir, f)).isFile());
}

function autoEntries(paths, note) {
  return paths.map((rel) => {
    const dir = path.join(root, rel);
    const name = rel.replace(/^.*node_modules\//, '');
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const files = licenseFiles(dir);
    let license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type;
    // package.json に記載が無いときは、ライセンス文から種類を読み取る
    if (!license && files.length) {
      const text = fs.readFileSync(path.join(dir, files[0]), 'utf8');
      license = [[/MIT License|Permission is hereby granted, free of charge/i, 'MIT'], [/ISC License/i, 'ISC'], [/Apache License/i, 'Apache-2.0'], [/BSD/i, 'BSD']].find(([re]) => re.test(text))?.[1];
      if (license) license += '（ライセンス文より）';
    }
    if (!license) throw new Error(`ライセンスが分からない部品があります: ${name}`);
    const repo = String((typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url) ?? pkg.homepage ?? '')
      .replace(/^git\+/, '')
      .replace(/\.git$/, '')
      .replace(/^github:/, 'https://github.com/');
    // EPL・MPL・LGPL などは、配布するときにソースコードの入手先を示す
    const source = /^(EPL|MPL|LGPL|CDDL)/i.test(license) && repo ? `ソースコードは ${repo} から入手できます。` : null;
    return { name, dir, license: `${license}（${note}）`, files, optionalFiles: true, source };
  });
}

function writeThirdPartyLicenses(extra = []) {
  const sections = [...THIRD_PARTY, ...extra].map((lib) => {
    const dir = lib.dir ?? path.join(root, 'node_modules', lib.name);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
    const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    const texts = lib.files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim());
    if (texts.length === 0 && lib.optionalFiles) texts.push('（この部品にはライセンス文のファイルが含まれていないため、package.json の記載のライセンスに従います）');
    return [
      '='.repeat(78),
      `${lib.label ?? lib.name} ${pkg.version}`,
      `ライセンス: ${lib.license}`,
      author ? `作者: ${author}` : null,
      pkg.homepage || repo ? `配布元: ${pkg.homepage ?? repo}` : null,
      lib.source ?? null,
      '='.repeat(78),
      '',
      ...texts,
      '',
    ]
      .filter((l) => l !== null)
      .join('\n');
  });
  const header = [
    'MarkdownViewerPlus が利用しているサードパーティのソフトウェアとライセンス',
    '',
    '本アプリは次のソフトウェアを利用しています。各ソフトウェアの著作権は、それぞれの著作権者に帰属します。',
    '',
    'Electron（Chromium・Node.js を含む）のライセンスは、アプリのフォルダにある',
    'LICENSE.electron.txt と LICENSES.chromium.html を参照してください。',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(out, 'THIRD_PARTY_LICENSES.txt'), `${header}\n${sections.join('\n')}`);
}

const entries = [
  { entryPoints: [path.join(src, 'boot.js')], outfile: path.join(out, 'boot.bundle.js') },
  { entryPoints: [path.join(src, 'app.js')], outfile: path.join(out, 'app.bundle.js'), plugins: [compactEmoji] },
  { entryPoints: [path.join(src, 'hljs-entry.js')], outfile: path.join(out, 'hljs.bundle.js') },
  { entryPoints: [path.join(src, 'mermaid-entry.js')], outfile: path.join(out, 'mermaid.bundle.js') },
];

copyStatic();
// mermaid.bundle.js に入る部品を求めて、ライセンス一覧に載せる（書き出しはしない）
const mermaidMeta = await esbuild.build({ ...common, entryPoints: [path.join(src, 'mermaid-entry.js')], write: false, metafile: true, logLevel: 'error' });
writeThirdPartyLicenses(autoEntries(bundledPackages(mermaidMeta.metafile), '図の表示 Mermaid とその部品'));
fs.writeFileSync(path.join(root, 'dist', 'icon.ico'), makeIco(fs.readFileSync(path.join(root, 'assets', 'icon.png'))));
fs.writeFileSync(path.join(root, 'dist', 'file-icon.ico'), makeIco(fs.readFileSync(path.join(root, 'assets', 'file-icon.png'))));
if (watch) {
  for (const e of entries) {
    const ctx = await esbuild.context({ ...common, ...e });
    await ctx.watch();
  }
  fs.watch(src, (_ev, file) => {
    if (/\.(html|css)$/.test(file ?? '')) copyStatic();
  });
  console.log('監視中… (Ctrl+C で終了)');
} else {
  await Promise.all(entries.map((e) => esbuild.build({ ...common, ...e })));
  for (const f of fs.readdirSync(out)) {
    const size = fs.statSync(path.join(out, f)).size;
    console.log(`  ${f.padEnd(18)} ${(size / 1024).toFixed(1).padStart(8)} KB`);
  }
}
