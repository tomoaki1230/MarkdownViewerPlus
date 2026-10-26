# MarkdownViewerPlus

レビュー中に見つけた誤記をその場で直せる、Windows 向けの軽量な Markdown ビューアです。

## 特長

- 表示 / 編集 / 2 ペイン（編集＋表示）の切り替え
- GFM、Markdown 内の HTML、`:smile:` などの絵文字、コードの色付け、Mermaid の図に対応
- 変更した行の印と変更点（差分）の確認、表示中の文字を選んで「✎ 直す」でその場所を編集
- リンク切れの検出、指定行へ移動
- リアルタイム検索、外部で変更されたファイルの自動再読み込み、ライト / ダークのテーマ

変更点は [CHANGELOG.md](CHANGELOG.md) をご覧ください。

## ご利用の前に

配布しているアプリ（インストーラ・exe）はデジタル署名をしていません。そのため、ダウンロードや初回の起動時に、Windows（SmartScreen）やウイルス対策ソフトの警告が表示される場合があります。

SmartScreen の警告が出た場合は、「詳細情報」→「実行」で起動できます。

### スマート アプリ コントロールについて

Windows 11 の「スマート アプリ コントロール」がオンになっている PC では、デジタル署名をしていないため、インストーラやアプリの実行がブロックされる場合があります。公開前に、スマート アプリ コントロールがオンの Windows 11 で起動できることを確認していますが、ブロックされるかどうかは Microsoft の判定によるため、必ず起動できるとは限りません。

ブロックされた場合、このアプリだけを許可する方法はありません。**解決策は、スマート アプリ コントロールをオフにすることのみです**（「Windows セキュリティ」→「アプリとブラウザーの制御」→「スマート アプリ コントロールの設定」）。

なお、最新の Windows Update を適用していれば、オフにした後も「Windows セキュリティ」から再びオンにできます。オフにするかどうかは、ご自身の判断でお願いします。

## 使用技術

- [Electron](https://www.electronjs.org/)
- [marked](https://marked.js.org/)（Markdown の変換）
- [DOMPurify](https://github.com/cure53/DOMPurify)（HTML の無害化）
- [highlight.js](https://highlightjs.org/)（コードの色付け）
- [Mermaid](https://mermaid.js.org/)（図の表示）
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
