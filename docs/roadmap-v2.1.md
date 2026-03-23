# Video OS v2.1 Roadmap — Post-Hackathon Improvement Plan

> Created: 2026-03-23
> Motivation: ハッカソン実運用（32素材 × 2エージェント並列実行）で発見した課題を解消し、プロダクト品質を引き上げる

---

## Milestone 1: 信頼性基盤（M1）

即座にエラーを減らし、デモや実運用の信頼性を確保する。他の全改善の前提。

### M1-1: preflight.ts — 起動前チェックスクリプト
- **依存**: なし（最初にやるべき）
- **課題**: 両エージェントが zsh glob エラーで2回ずつ失敗。API キーの有無も事前確認なし
- **スコープ**:
  - `GEMINI_API_KEY` / `GROQ_API_KEY` 存在確認
  - `ffmpeg` / `ffprobe` バージョン確認（最低要件定義）
  - ディスク空き容量チェック（素材サイズ × 2）
  - シェル互換性（zsh null_glob 自動設定 or 警告）
  - 素材フォルダの読み取り権限
  - 結果を JSON で出力（CI/自動化対応）
- **成果物**: `scripts/preflight.ts` + テスト
- **見積もり**: 小

### M1-2: スキーマバリデーション修正
- **依存**: なし
- **課題**: `validate-schemas.ts` が手動レンダー向け timeline の `nat_sound/bgm` 表現で落ちる
- **スコープ**:
  - `timeline-ir.schema.json` に audio_mix 拡張追加
  - `--profile` オプション（standard / manual-render）でバリデーション切替
  - 既存テストの修正
- **成果物**: スキーマ更新 + プロファイル対応 + テスト
- **見積もり**: 小

---

## Milestone 2: 解析パフォーマンス（M2）

15分→3-5分に短縮。ユーザー体験とデモの実用性に直結。

### M2-1: 解析キャッシュ
- **依存**: M1-1（preflight でキャッシュディレクトリの存在確認）
- **課題**: Codex は既存データを偶然発見して再利用したが、仕組みとして確立されていない
- **スコープ**:
  - ファイルハッシュ（SHA-256 of first 1MB + size + duration）ベースのキャッシュ
  - `03_analysis/cache_manifest.json` でキャッシュヒット管理
  - `--no-cache` フラグでキャッシュ無効化
  - キャッシュヒット時は VLM/STT 呼び出しスキップ
- **成果物**: `analyze.ts` 改修 + テスト
- **見積もり**: 中

### M2-2: VLM 解析並列化
- **依存**: M2-1（キャッシュと並列化は同時に動く必要がある）
- **課題**: 32ファイルを直列で VLM に投げている
- **スコープ**:
  - `--concurrency N` オプション（デフォルト: 3）
  - Gemini API レートリミット対応（429 リトライ + exponential backoff）
  - 進捗表示（`[12/32] Analyzing IMG_0543.MOV...`）
  - ファイル単位のエラーハンドリング（1ファイル失敗でも全体は続行）
- **成果物**: `analyze.ts` 改修 + テスト
- **見積もり**: 中

### M2-3: aspect_ratio 自動推定
- **依存**: M2-1（解析結果の拡張）
- **課題**: Codex が「16:9 でいいですか？」と聞いてきた
- **スコープ**:
  - `assets.json` に `dominant_aspect_ratio` フィールド追加
  - 全素材の解像度から最頻値を自動判定
  - `creative_brief.yaml` の `aspect_ratio: auto` 対応
- **成果物**: 解析出力拡張 + brief テンプレート更新
- **見積もり**: 小

---

## Milestone 3: オーケストレーション改善（M3）

master エージェントからの制御性と可視性を高める。

### M3-1: progress.json — 構造化進捗レポート
- **依存**: M1（安定した基盤の上で進捗トラッキング）
- **課題**: master が `task get` でターミナル出力を読むしか方法がない
- **スコープ**:
  - 各フェーズ完了時に `projects/<id>/progress.json` を自動更新
  - フォーマット: `{"phase": "analysis", "gate": 1, "completed": 18, "total": 32, "eta_sec": 240, "artifacts_created": [...]}`
  - エラー発生時も `progress.json` に記録
  - master 用の `scripts/check-progress.ts <project-id>` CLI
- **成果物**: progress.json 仕様 + パイプライン各所への埋め込み + CLI
- **見積もり**: 中

### M3-2: フェーズ別コマンド分離
- **依存**: M3-1（進捗レポートがあってこそフェーズ分離が有用）
- **課題**: `full-pipeline` がモノリシック。「解析だけ先に」「ここから再開」ができない
- **スコープ**:
  - スラッシュコマンド分離: `/analyze`, `/triage`, `/blueprint`, `/compile`, `/review`, `/render`
  - 各コマンドは `project_state.yaml` のフェーズを確認してゲートチェック
  - `full-pipeline` は上記を順番に呼ぶオーケストレーター（既存互換）
  - `--from <phase>` で途中再開対応
- **成果物**: 6つのスラッシュコマンド + full-pipeline 改修 + テスト
- **見積もり**: 大

---

## Milestone 4: 出力品質向上（M4）

動画の品質とクリエイターへの価値を高める。

### M4-1: 中間プレビュー生成
- **依存**: M3-2（フェーズ分離があると compile 後にプレビューを挟める）
- **課題**: 4分16秒の動画を最終レンダーするまで結果が見えない
- **スコープ**:
  - `scripts/preview-segment.ts` — 特定ビートの低解像度レンダー（720p, 10秒以内）
  - timeline.json 確定後の自動プレビュー（最初の30秒）
  - タイムライン概観画像（コンタクトシート的な1枚画像）自動生成
- **成果物**: preview スクリプト + タイムライン概観画像生成
- **見積もり**: 中

### M4-2: BGM ビート解析
- **依存**: M2（解析パイプラインの拡張として組み込む）
- **課題**: BGM のビート位置・セクション構造を無視してクリップを配置している
- **スコープ**:
  - BGM analyzer（librosa or essentia）: BPM、ビート位置、セクション（イントロ/Aメロ/サビ/アウトロ）
  - `bgm_analysis.json` を `03_analysis/` に出力
  - edit_blueprint のビート構造と BGM セクションの自動アラインメント
  - compiler のスコアリングにダウンビート近接ボーナス追加
- **成果物**: BGM 解析スクリプト + blueprint/compiler 統合 + テスト
- **見積もり**: 大

---

## Milestone 5: 高度な機能（M5）

差別化とプロダクト価値の飛躍。

### M5-1: 2エージェント比較ツール
- **依存**: M3-1（progress.json で成果物パスを取得）
- **課題**: Claude と Codex が同じ素材から2本作ったが比較手段がない
- **スコープ**:
  - `scripts/compare-timelines.ts` — 2つの timeline.json を比較
  - クリップ選択一致率、ビート構成差異、尺配分の比較
  - HTML レポート生成（サイドバイサイド）
  - diff 出力（どのクリップが片方だけに採用されたか）
- **成果物**: 比較スクリプト + HTML レポートテンプレート
- **見積もり**: 中

### M5-2: Premiere roundtrip の実素材テスト
- **依存**: M4-1（プレビューで roundtrip 前後を確認）
- **課題**: FCP7 XML の roundtrip を実素材で検証していない
- **スコープ**:
  - 今回生成した XML を実際に Premiere で読み込み→編集→再インポートのE2Eテスト
  - diff 検出の精度検証
  - unmapped edits のハンドリング改善
- **成果物**: E2E テストケース + ドキュメント
- **見積もり**: 中

---

## 依存関係グラフ

```
M1-1 (preflight) ─────────────────────────────────────┐
M1-2 (schema fix) ──┐                                 │
                     ├─→ M2-1 (cache) ──→ M2-2 (parallel) ──→ M4-2 (BGM)
                     │        │
                     │        └──→ M2-3 (aspect auto)
                     │
                     └─→ M3-1 (progress) ──→ M3-2 (phase split) ──→ M4-1 (preview)
                                    │
                                    └──→ M5-1 (compare)
                                                                    └──→ M5-2 (roundtrip)
```

## 実行順序（推奨）

| 順序 | タスク | 依存 | サイズ |
|------|--------|------|--------|
| 1 | M1-1 preflight.ts | なし | 小 |
| 2 | M1-2 スキーマ修正 | なし | 小 |
| 3 | M2-1 解析キャッシュ | M1-1 | 中 |
| 4 | M2-3 aspect_ratio 自動推定 | M2-1 | 小 |
| 5 | M2-2 VLM 並列化 | M2-1 | 中 |
| 6 | M3-1 progress.json | M1 | 中 |
| 7 | M3-2 フェーズ別コマンド分離 | M3-1 | 大 |
| 8 | M4-1 中間プレビュー | M3-2 | 中 |
| 9 | M4-2 BGM ビート解析 | M2 | 大 |
| 10 | M5-1 2エージェント比較 | M3-1 | 中 |
| 11 | M5-2 Premiere roundtrip E2E | M4-1 | 中 |
