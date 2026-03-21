# Video OS v2 — 全体ロードマップ

作成日: 2026-03-21

## 定義

このリポジトリが作るものは「AI動画編集アプリ」ではなく、**Editorial Intent Compiler + Media Intelligence OS** である。

本体は以下の5層:

1. 監督の曖昧な意図を採掘する層
2. 素材を読んで候補を出す層
3. 編集方針を固定する層
4. 実行可能なタイムラインへ落とす層
5. レンダリングと批評で閉じる層

## 設計原則

### 中心に置くもの（モデルに依存しない）
- **Evidence Graph** — 素材から得られた事実の構造化
- **Uncertainty Management** — 迷いを構造化して gate で止める
- **Editorial Blueprint** — 編集意図の明示的な記述
- **Timeline IR** — 内部表現としての timeline.json（OTIO は handoff export）

### モデルの位置づけ
- **Gemini** = 素材読解エンジン（ラッシュの一次理解・区間特定・粗い意味把握）
- **Claude** = 編集意図を言語化し、複数案を批評する AI
- **OpenAI** = 音声理解の本線（STT + 話者分離）
- **FFmpeg** = 事実層（evidence board generator）
- **Remotion** = 最終パッケージング

### エージェント分離
- **Product plane** (runtime agents): 編集OSが動いた後に使う
  - intent-interviewer, footage-triager, blueprint-planner, roughcut-critic
- **Development plane** (impl agents): 編集OS自体を作る
  - spec-guardian, media-mcp-builder, timeline-compiler-builder, e2e-harness-builder

### Non-negotiable gates
1. unresolved blocker があれば timeline compilation 禁止
2. timeline schema が通らなければ final render 禁止
3. review report に fatal があれば final render 禁止
4. agent がメディアを直接書かない
5. render は engine だけが行う
6. timeline.json の変更は compiler だけが行う
7. agent は review_patch[] を発行する（ffmpeg コマンドではなく）

## Canonical Artifacts

| ファイル | 書き手 | 用途 |
|---------|--------|------|
| creative_brief.yaml | intent-interviewer | 編集意図の構造化 |
| unresolved_blockers.yaml | intent-interviewer | 未解決の判断ブロッカー |
| selects_candidates.yaml | footage-triager | 候補セグメントと役割分類 |
| edit_blueprint.yaml | blueprint-planner | ビート構成・ポリシー・rejection rules |
| uncertainty_register.yaml | blueprint-planner | 構造化された不確実性 |
| timeline.json | compiler (engine) | タイムラインの canonical 表現 |
| review_report.yaml | roughcut-critic | 批評レポート |
| review_patch.json | roughcut-critic | パッチ操作の提案 |

## マイルストーン

### Milestone 1: Fixture-Backed Editorial Loop

**ゴール**: API接続なし、fixture データで artifact flow と compiler invariants を証明する

**入力**:
- projects/sample/01_intent/creative_brief.yaml
- projects/sample/04_plan/selects_candidates.yaml
- projects/sample/03_analysis/* (fixture)

**出力**:
- timeline.json
- review_patch.json
- review_report.yaml
- preview artifact

**達成条件（4つだけ）**:
1. schema validate が通る
2. compiler が決定論的に動く（同一入力 → 同一出力）
3. critic が patch を返せる
4. patch を compiler が再適用できる

**実装順序**:
1. スキーマ定義（5つの不足スキーマ） ← 進行中
2. fixture project（自己整合的なサンプルデータ） ← 進行中
3. schema validator（全artifact検証スクリプト）
4. timeline compiler（決定論的コンパイラ、Phase 1-5）
5. review patch applicator（patch → compiler 再実行）
6. E2E harness（golden test、1本通し検証）

### Milestone 2: Live Analysis Pipeline

**ゴール**: 実素材から analysis artifacts を生成し、Milestone 1 のループに接続する

**接続する connectors**:
- ffmpeg/ffprobe → assets.json, segments.json, contact sheets, waveforms
- Gemini Video Understanding → visual tags, interest points, visual descriptions
- OpenAI STT (gpt-4o-transcribe-diarize) → transcripts, diarization

**追加する analysis_policy**:
- セグメント種別ごとの adaptive サンプリング
  - static: 0.5 FPS
  - action: 3-5 FPS
  - dialogue: STT + diarization 優先
  - music_driven: waveform + beat alignment 優先

**接続方法**:
- media-mcp の fixture-backed tools を live connector に差し替え
- tool interface は変更なし（契約は Milestone 1 で確定済み）

### Milestone 3: Product Agents + Interactive Loop

**ゴール**: 4つの product-plane agents を interactive mode で運用する

**動かすもの**:
- intent-interviewer: human → creative_brief.yaml
- footage-triager: analysis → selects_candidates.yaml
- blueprint-planner: brief + selects → blueprint + uncertainty register
- roughcut-critic: timeline + preview → review_report + patch

**実素材で E2E**:
- sample-bicycle `/path/to/downloads/子ども自転車`（成長記録ムービー）
- AX-1 D4887 `/path/to/footage/D4887.MP4`（インタビュー）

### Milestone 4: Caption + Audio + Packaging

**ゴール**: 完成品質のメディア出力

**追加する機能**:
- 字幕2系統: SpeechCaption（セリフ）+ TextOverlay（演出、縦書き対応）
- `caption_policy` を必須化し、language / delivery_mode / source / styling_class を artifact 契約として固定
- BGM: ducking, beat sync, fade
- music cue 契約を追加し、A2 track の entry 条件・cue timing・ducking 前提を machine-readable にする
- 音声マスタリング: loudnorm, 2-pass
- Remotion rendering: assembly.mp4 → ffmpeg post → final.mp4
- OTIO export: timeline.json → .otio（人間の編集者への handoff）

**引き継ぐ知見**:
- 現行 video-edit-agent の caption segmentation ルール
- BGM beat sync の設計（bgm-analysis.json）
- 音声責務分離（Remotion = 配置、ffmpeg = mastering）

### Milestone 5: Automation + Batch

**ゴール**: headless で editorial loop を回す

**手段**:
- Claude Agent SDK
- Codex SDK / codex exec
- CI gates（schema validation, golden test）

**前提**: Milestone 1-3 が interactive で安定稼働していること

## 進め方のルール

1. **interactive first** — いきなり automation しない。最初は human が明示的に narrow task を投げる
2. **1 task = 1 artifact** — タスクの粒度は1つの artifact か 1つの module に限定
3. **fixture first** — API 接続より先に artifact flow を固める
4. **設計→レビュー→修正ループ** — 大きな指摘がなくなるまで回す
5. **automation は「1本通しが動いてから」** — 順番を逆にしない

## 現行リポジトリからの引き継ぎ

### そのまま移植可能
- Agent Skills 20個（.claude/skills/）→ product agents に統合
- Remotion コンポーネント 8個 + lib 4個
- Profiles 7個 + Editing Policies 7個 + Editing Skills 18個

### 知見として引き継ぐ
- BinSense 4フェーズ（shot boundary + interest point + coverage board）
- LLM soft critic パターン（→ roughcut-critic に統合）
- Caption segmentation（意味単位優先、CPS言語別calibration）
- Interest Point アーキテクチャ（中心点 → adaptive in/out）
- E2E テスト教訓（unified-roadmap.md に集約済み）

### 引き継がない
- Python パイプラインコード（新規実装）
- 2パスレンダー
- audio_overlap_sec
- _split_long_units（ワークアラウンド）

## 参照ドキュメント

| ドキュメント | 場所 |
|-------------|------|
| ゼロベース再設計案 | /Dev/video-edit-agent/docs/draft/ゼロベース再設計案.md |
| ARCHITECTURE.md | /Dev/video-os-v2-spec/ARCHITECTURE.md |
| media-mcp contract | /Dev/video-os-v2-spec/contracts/media-mcp.md |
| M1 設計書 | /Dev/video-os-v2-spec/docs/milestone-1-design.md |
| 現行リポジトリ引き継ぎ棚卸し | /Dev/video-edit-agent/docs/inventory-ja/ |
| 現行 unified-roadmap | /Dev/video-edit-agent/docs/unified-roadmap.md |
