# Video OS v2 — 全体ロードマップ

作成日: 2026-03-21
最終更新: 2026-03-21（公開リポジトリ調査に基づく設計ブラッシュアップ統合）

## 定義

このリポジトリが作るものは「AI動画編集アプリ」ではなく、**Editorial Intent Compiler + Media Intelligence OS** である。

本体は以下の5層:

1. 監督の曖昧な意図を採掘する層
2. 素材を読んで候補を出す層
3. 編集方針を固定する層
4. 実行可能なタイムラインへ落とす層
5. レンダリングと批評で閉じる層

そしてこの5層は **一方向パイプラインではない**。
AIが構造を作る ↔ 人間がGUIで最終編集判断をする ↔ その差分をAI系に戻す、
という **往復可能な交換層** が中心にある。

```text
Intent -> Analysis -> Blueprint -> timeline.json <-> OTIO exchange boundary <-> Human GUI edit
                                            \                               /
                                             -> diff / import / recompile --
                                                      |
                                                      -> preview / render
```

## 設計原則

### 中心に置くもの（モデルに依存しない）
- **Evidence Graph** — 素材から得られた事実の構造化
- **Uncertainty Management** — 迷いを構造化して gate で止める
- **Editorial Blueprint** — 編集意図の明示的な記述
- **Timeline IR** — 内部正本は `timeline.json`。
  **OTIO は handoff export/import を担う exchange boundary** とする。
  round-trip は loss-aware / diffable / stable-id-based で扱う。

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
8. OTIO export 前に、すべての clip / segment / track に stable ID が付与されていること
9. round-trip import で unmapped edit が出た場合は、自動確定せず review 必須
10. final render 前に source of truth を宣言すること（engine render 正 or NLE finishing 正）
11. NLE handoff は capability profile で許可された編集面に限定すること

## Canonical Artifacts

### AI 由来

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
| project_state.yaml | state-machine runtime | プロジェクト状態の永続化（multi-session 復帰用） |

### Human round-trip 由来

| ファイル | 書き手 | 用途 |
|---------|--------|------|
| handoff_manifest.yaml | compiler | handoff 対象 NLE、許容編集面、source map、注意事項 |
| handoff_timeline.otio | compiler | 人間編集者に渡す交換ファイル |
| imported_handoff.otio | roundtrip-importer | GUI 編集後に戻された OTIO |
| roundtrip_import_report.yaml | roundtrip-importer | 読み戻し成功/失敗、lossy 項目、未対応変更 |
| human_revision_diff.yaml | roundtrip-diff-analyzer | 人間が何をどう変えたかの構造的要約 |
| human_notes.yaml | human reviewer | 人間レビュアーの自由形式コメント（タイムスタンプ付き） |
| nle_capability_profile.yaml | adapters | NLE ごとの保持可能/不可情報の定義 |

## Human GUI 編集の許可範囲

### 最初に許可する編集（round-trip 可能）
- trim（in/out 調整）
- reorder（クリップ順序変更）
- enable / disable（クリップの有効/無効）
- track move（トラック間移動）
- simple transition（ディゾルブ、ワイプ等）
- marker / note（マーカー・メモ追加）

### 最初は許可しないか、one-way 扱いにする編集
- complex titles / MOGRT
- plugin effects
- full color finish
- advanced audio finish

これらは OTIO round-trip で再現不能な変更になる。
「人間が最終審美をやる」が editorial judgment（尺・順序・切り位置・Bロール差し込み）を指すなら round-trip と相性が良い。
full finishing まで含むなら NLE を source of truth にする one-way handoff になり、engine render は放棄する。
この判断は M3.5 で明示的に行う。

## マイルストーン

### Milestone 1: Fixture-Backed Editorial Loop + Minimal Round-Trip

**ゴール**: API接続なし、fixture データで artifact flow、compiler invariants、**最小 round-trip** を証明する

**入力**:
- projects/sample/01_intent/creative_brief.yaml
- projects/sample/04_plan/selects_candidates.yaml
- projects/sample/03_analysis/* (fixture)

**出力**:
- timeline.json
- review_patch.json
- review_report.yaml
- preview artifact
- handoff_timeline.otio（export）
- imported_handoff.otio（fixture human edit を模擬）
- roundtrip_import_report.yaml
- human_revision_diff.yaml

**達成条件**:
1. schema validate が通る
2. compiler が決定論的に動く（同一入力 → 同一出力）
3. critic が patch を返せる
4. patch を compiler が再適用できる
5. exported OTIO が再 import 可能である
6. 人間編集差分を loss-aware に要約できる
7. round-trip 後も stable ID が維持される

**実装順序**:
1. スキーマ定義（5つの不足スキーマ） ← 完了
2. fixture project（自己整合的なサンプルデータ） ← 完了
3. schema validator（全artifact検証スクリプト） ← 完了（24テスト）
4. timeline compiler（決定論的コンパイラ、Phase 1-5） ← 進行中
5. review patch applicator（patch → compiler 再実行）
6. OTIO exchange layer（export + fixture import + diff + report）
7. E2E harness（golden test、1本通し + round-trip 検証）

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

**ゴール**: 4つの product-plane agents を interactive mode で運用し、operator UX を整備する

**動かすもの**:
- intent-interviewer: human → creative_brief.yaml
- footage-triager: analysis → selects_candidates.yaml
- blueprint-planner: brief + selects → blueprint + uncertainty register
- roughcut-critic: timeline + preview → review_report + patch

**Slash command による対話的起動**:
- `.claude/commands/` と `.codex/commands/` に agent 起動コマンドを定義
- `/intent`, `/triage`, `/blueprint`, `/review`, `/status`, `/export`
- 各コマンドは `project_state.yaml` を読み、適切な state から開始する
- 参考: claude-code-video-toolkit の command 設計

**blueprint-planner の preference interview フェーズ**:
- rough cut 前に pacing / structure / duration の preference を人間から明示的に取得する
- `creative_brief.yaml > autonomy` 設定と連動:
  - `autonomy: full` → AI が自律決定
  - `autonomy: collaborative` → preference を確認してから blueprint を固定
- `edit_blueprint.yaml > pacing` に confirmed_preferences フィールドを追加
- 参考: ButterCut の preference interview パターン

**Project state 永続化（multi-session lifecycle）**:
- `projects/*/project_state.yaml` でプロジェクト状態を永続化
- セッション復帰時に state machine の現在位置を自動検出
- 各 slash command 起動時にこれを読んで適切なフェーズから開始
- 参考: HarnessGG/studio の project contract 設計

**実素材で E2E**:
- sample-bicycle `/path/to/downloads/子ども自転車`（成長記録ムービー）
- AX-1 D4887 `/path/to/footage/D4887.MP4`（インタビュー）

### Milestone 3.5: Human Handoff Round-Trip

**ゴール**: AIが handoff package を出し、人間が NLE で editorial edits を行い、OTIO を再 import し、AIが差分を理解して次案に反映する

**フロー**:
1. compiler が handoff_manifest.yaml + handoff_timeline.otio を出力
2. 人間が DaVinci Resolve / Premiere 等で editorial edits を実行
3. 編集済み OTIO を戻す
4. roundtrip-importer が import report + human revision diff を生成
5. AI（roughcut-critic or blueprint-planner）が diff を読んで次の blueprint/patch を提案
6. compiler が再構成し、preview を更新

**達成条件**:
- 実 NLE で trim / reorder / disable を行い、round-trip で diff が正しく検出される
- unmapped edits（NLE が追加したエフェクト等）が loss report に記録される
- stable ID が維持され、AI が「どのクリップに何が変わったか」を追跡できる

**NLE capability profile**:
- DaVinci Resolve 用 profile を最初に作成
- 保持可能: clip ID (metadata), trim, reorder, transitions, markers
- lossy: color grades, Fusion effects, Fairlight advanced audio

**人間レビューの受け皿**:
- `projects/*/06_review/human_notes.yaml` — 人間レビュアーの自由形式コメント
  - タイムスタンプ・クリップ参照付きの observation 配列
  - roughcut-critic が次パスで参照し、patch 提案に反映する
- `projects/*/STYLE.md` — プロジェクト固有の制作スタイルガイド
  - creative_brief が「何を作るか」を定義するのに対し、STYLE.md は「どう作るか」を定義
  - カット率の傾向、色温度のトーン、フォント指定、トランジション方針など
  - 参考: HarnessGG/studio の STYLE.md パターン

### Milestone 4: Caption + Audio + Packaging

**ゴール**: 完成品質のメディア出力

**追加する機能**:
- 字幕2系統: SpeechCaption（セリフ）+ TextOverlay（演出、縦書き対応）
- `caption_policy` を必須化し、language / delivery_mode / source / styling_class を artifact 契約として固定
- BGM: ducking, beat sync, fade
- music cue 契約を追加し、A2 track の entry 条件・cue timing・ducking 前提を machine-readable にする
- 音声マスタリング: loudnorm, 2-pass
- Remotion rendering: assembly.mp4 → ffmpeg post → final.mp4

**マルチステップ Render Pipeline**:
- `runtime/render-pipeline-defaults.yaml` でフェーズ定義を導入
- assembly（Remotion）→ caption_burn（ffmpeg）→ audio_master（ffmpeg）→ package（ffmpeg）
- フェーズごとに skip 条件を持つ（例: sidecar 字幕なら caption_burn をスキップ）
- 参考: proj の stepwise FFmpeg export pipeline

**Source of truth 宣言**（Gate 10）:
- engine render path: AI → compile → render → final.mp4 が正
- NLE finishing path: AI → compile → OTIO → NLE → NLE export が正
- プロジェクトごとに `project_state.yaml.handoff_resolution` で宣言し、混在させない

**引き継ぐ知見**:
- 現行 video-edit-agent の caption segmentation ルール
- BGM beat sync の設計（bgm-analysis.json）
- 音声責務分離（Remotion = 配置、ffmpeg = mastering）

### Milestone 5: Automation + Batch

**ゴール**: headless で editorial loop を回す

**手段**:
- Claude Agent SDK
- Codex SDK / codex exec
- CI gates（schema validation, golden test, round-trip regression）

**前提**: Milestone 1-3.5 が interactive で安定稼働していること

## 進め方のルール

1. **interactive first** — いきなり automation しない。最初は human が明示的に narrow task を投げる
2. **1 task = 1 artifact** — タスクの粒度は1つの artifact か 1つの module に限定
3. **fixture first** — API 接続より先に artifact flow を固める
4. **round-trip early** — OTIO 往復は最初期の IR 設計に食い込むので後回しにしない
5. **設計→レビュー→修正ループ** — 大きな指摘がなくなるまで回す
6. **automation は「1本通しが動いてから」** — 順番を逆にしない

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
