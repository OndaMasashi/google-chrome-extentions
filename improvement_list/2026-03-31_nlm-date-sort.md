# NotebookLM 作成日順ソート Chrome拡張機能の新規作成

## 対象
- `nlm-date-sort/manifest.json`
- `nlm-date-sort/content.js`
- `nlm-date-sort/README.md`
- `nlm-date-sort/icons/` (icon16.png, icon48.png, icon128.png)
- `.gitignore`

## 変更内容
- NotebookLMのノートブック一覧に「作成日順」ソートボタンを追加するChrome拡張機能を新規作成
- Manifest V3、Content Scriptのみのシンプル構成
- CSSクラス名に依存せず、日付テキストパターン（YYYY/MM/DD）とURL構造（/notebook/UUID）でDOM探索する耐変更設計
- 全祖先スキャンによるコンテナ検出アルゴリズム（おすすめ/最近の2セクションを正しく識別）

## 理由
NotebookLMの標準UIでは「新しい順」（更新日順）のソートのみで、作成日順のソート機能がないため
