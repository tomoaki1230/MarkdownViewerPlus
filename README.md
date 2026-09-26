# MarkdownViewerPlus

レビュー中に見つけた誤記をその場で直せる、Windows 向けの軽量な Markdown ビューアです。

## 特長

- 表示 / 編集 / 2 ペイン（編集＋表示）の切り替え
- GFM、Markdown 内の HTML、`:smile:` などの絵文字、コードの色付けに対応
- リアルタイム検索、外部で変更されたファイルの自動再読み込み、ライト / ダークのテーマ

## ご利用の前に

配布しているアプリ（インストーラ・exe）はデジタル署名をしていません。そのため、ダウンロードや初回の起動時に、Windows（SmartScreen）やウイルス対策ソフトの警告が表示される場合があります。

SmartScreen の警告が出た場合は、「詳細情報」→「実行」で起動できます。

## 使用技術

- [Electron](https://www.electronjs.org/)
- [marked](https://marked.js.org/)（Markdown の変換）
- [DOMPurify](https://github.com/cure53/DOMPurify)（HTML の無害化）
- [highlight.js](https://highlightjs.org/)（コードの色付け）
- [gemoji](https://github.com/wooorm/gemoji)（絵文字）
- [encoding-japanese](https://github.com/polygonplanet/encoding.js)（文字コードの判定・変換）
- [esbuild](https://esbuild.github.io/) / [electron-builder](https://www.electron.build/)（ビルド）

## ビルド

Node.js 24 と npm が必要です。

```bash
npm install
npm start          # 起動
npm test           # テスト
npm run dist:win   # Windows 用の配布物を release/ に作成（Linux / WSL では wine が必要）
```

## ライセンス

MIT © Tomoaki Bessho

同梱ライブラリのライセンスは、アプリの「ヘルプ > サードパーティのライセンス」で確認できます。
