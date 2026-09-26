# MarkdownViewerPlus

レビュー中に見つけた誤記をその場で直せる、Windows 向けの軽量な Markdown ビューアです。

## 特長

- 表示 / 編集 / 2 ペイン（編集＋表示）の切り替え
- GFM、Markdown 内の HTML、`:smile:` などの絵文字、コードの色付けに対応
- 保存時に文字コード・BOM・改行コードを保ち、編集していない行は変更しない
- 読み取り専用のファイルには書き込まない
- リアルタイム検索、外部で変更されたファイルの自動再読み込み、ライト / ダークのテーマ

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
