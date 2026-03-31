# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

Chrome拡張機能を構築するリポジトリ。各拡張は独立したサブフォルダに格納する。

## アーキテクチャ

```text
<extension-name>/    # 拡張ごとのフォルダ（例: nlm-date-sort/）
  manifest.json      # Chrome Manifest V3
  content.js         # Content Script（メインロジック）
  icons/             # 拡張アイコン (16, 48, 128px)
  README.md          # インストール手順・使い方
improvement_list/    # 改修履歴（YYYY-MM-DD_{説明}.md）
```

## 開発方針

- **Manifest V3** を使用する
- Content Script型の拡張では、対象サイトの**CSSクラス名に依存しない**DOM探索を優先する（テキストパターン、URL構造、セマンティック属性を使う）
- 拡張は最小構成（Content Script のみ）を基本とし、必要な場合のみ background / popup を追加する

## テスト方法

1. `chrome://extensions` → デベロッパーモード ON
2. 「パッケージ化されていない拡張機能を読み込む」で対象フォルダを選択
3. 対象サイトをリロードして動作確認
4. 変更後は `chrome://extensions` で拡張の更新ボタンを押してリロード
