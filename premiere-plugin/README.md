# Video OS Watcher — Premiere Pro UXP Plugin

FCP7 XML ファイルの変更を監視し、Premiere Pro に自動インポートするプラグイン。

## インストール手順

### 1. UXP Developer Tool のインストール

1. [Adobe Creative Cloud](https://creativecloud.adobe.com/) から **UXP Developer Tool** をインストール
2. Premiere Pro 2023 (v23.0) 以降が必要

### 2. プラグインの読み込み

1. UXP Developer Tool を起動
2. **Add Plugin** → `premiere-plugin/manifest.json` を選択
3. **Load** ボタンでプラグインを読み込む
4. Premiere Pro のメニュー: **Window → Extensions → Video OS Watcher**

### 3. 開発モード（毎回の手順）

```bash
# UXP Developer Tool CLI を使う場合
uxp plugin load /path/to/video-os-v2-spec/premiere-plugin
```

### 4. パッケージ化（配布用）

```bash
# UXP Developer Tool で .ccx パッケージを作成
uxp plugin package /path/to/video-os-v2-spec/premiere-plugin
# → 生成された .ccx を Premiere Pro にインストール
```

## 使い方

1. Premiere Pro でプロジェクトを開く
2. **Video OS Watcher** パネルを表示
3. **FCP7 XML Path** にエージェントが出力する XML ファイルのパスを入力
   - 例: `/Users/you/projects/my-project/09_output/PRJ001_premiere.xml`
4. **Watch** ボタンで監視開始
5. エージェントが XML を更新すると、自動的にシーケンスがインポートされる

## ワークフロー

```
Agent (timeline.json → FCP7 XML) → ファイル書き出し
                                      ↓
                         UXP Plugin が変更検知
                                      ↓
                         Premiere Pro に自動インポート
                                      ↓
                         ユーザーが Premiere で微調整
                                      ↓
                         Premiere から XML エクスポート
                                      ↓
Agent (FCP7 XML → timeline.json) ← import-premiere-xml.ts
```

## 設定

| 項目 | デフォルト | 説明 |
|------|-----------|------|
| Poll Interval | 2000ms | ファイル変更チェックの間隔 |

## 制限事項

- UXP API はサンドボックス内で動作するため、ファイルアクセスにはフルアクセス権限が必要
- Premiere Pro のバージョンによっては `importFiles()` の挙動が異なる場合がある
- XML パースエラー時は通知のみ（Premiere が内部でエラーハンドリング）
- プラグインのテストは Premiere Pro 上での手動確認が前提
