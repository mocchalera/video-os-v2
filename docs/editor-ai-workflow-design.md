# Video OS v2 — エディタ AI-Human ワークフロー設計書

> Date: 2026-03-24
> Phase: 2b (editor-mvp-design.md Phase 2a の後続)
> Status: Draft
> Scope: AI 粗編集と人間微調整のシームレスな往復ワークフローを Web エディタに統合
> Depends on: editor-mvp-design.md (Phase 2a), ARCHITECTURE.md, schemas/*.schema.json

---

## 0. 動機

### 0-1. 現状の問題

Phase 2a エディタは timeline.json の直接操作を実現したが、AI パイプラインとの接続が断絶している:

| 問題 | 影響 |
|------|------|
| AI の意思決定が不透明 | `motivation`, `confidence` は PropertyPanel に表示されるが、比較・代替の文脈がない |
| レビュー結果が手作業 | `review_report.yaml` を読み、`review_patch.json` を手動で CLI 適用 |
| クリップ差し替えが盲目的 | `selects_candidates.yaml` を直接見ないと代替候補がわからない |
| AI 再実行がエディタ外 | ターミナルで `/review`, `/compile`, `/render` を実行する必要がある |
| 編集履歴が AI 出力と切り離し | 人間がどこを変えたかの追跡が困難 |

### 0-2. 解決方針

エディタを「AI 編集の閲覧・調整・再実行の統合ハブ」にする。
AI は判断を下し、人間がその判断を検証・修正し、必要に応じて AI に再評価を依頼する。

```
AI パイプライン
  ↓ timeline.json + review_report.yaml + review_patch.json + selects_candidates.yaml
Web エディタ（本設計）
  ↓ 人間が検証・修正
  ↓ timeline.json を保存
  ↓ エディタから AI 再実行をキック
AI パイプライン（再評価）
  ↓ 新しい review_report.yaml
Web エディタ（差分確認）
  ↓ ... 繰り返し
```

### 0-3. アーキテクチャ原則との整合

ARCHITECTURE.md の制約を遵守する:

- **「Only compiler mutates timeline.json」** → エディタの人間編集は `useTimeline` 経由で直接 timeline.json を更新する（これは Phase 2a で確立済み）。AI 再実行時は `/compile` がパッチモードで適用
- **「Agents may emit review_patch[], not arbitrary ffmpeg commands」** → レビューパッチ UI はこの制約に沿った操作のみ提供
- **Provenance 追跡** → 人間の編集も `provenance.editor_version`, `provenance.last_editor_save` で記録

---

## 1. 機能設計

### 1-1. エージェント判断の可視化

#### 1-1-1. クリップレベルの AI メタデータ表示

**データソース**: `timeline.json` の各 Clip オブジェクト

```typescript
// 既存 Clip インターフェース（types.ts）から利用するフィールド
interface Clip {
  motivation: string;        // なぜ選んだか
  confidence?: number;       // 確信度 0-1
  quality_flags?: string[];  // 品質警告
  fallback_segment_ids?: string[];  // 代替セグメント
  beat_id?: string;          // どのビートに属するか
  candidate_ref?: string;    // selects_candidates へのバックリファレンス
}
```

**UI 変更**:

| コンポーネント | 変更内容 |
|---------------|---------|
| `ClipBlock.tsx` | confidence バッジ（色分け: 🟢≥0.8, 🟡≥0.6, 🔴<0.6）をクリップ右上に常時表示 |
| `ClipBlock.tsx` | quality_flags がある場合は ⚠️ アイコンをクリップ左上に表示 |
| `PropertyPanel.tsx` | 「AI Decision」セクションを追加: motivation 全文、confidence バー、quality_flags リスト、fallback_segment_ids |
| `PropertyPanel.tsx` | beat_id に対応する blueprint の purpose を参照表示（edit_blueprint.yaml から取得） |

**Confidence バッジのカラースキーム**:

```
≥ 0.8  → #22C55E (green-500)  — AI は自信あり
≥ 0.6  → #EAB308 (yellow-500) — 検討の余地あり
< 0.6  → #EF4444 (red-500)    — 人間レビュー推奨
```

#### 1-1-2. レビューレポートのタイムラインオーバーレイ

**データソース**: `06_review/review_report.yaml`

```yaml
# review_report.yaml の構造（review-report.schema.json 準拠）
summary_judgment:
  status: approved | needs_revision | blocked
  confidence: 0.82
weaknesses:
  - summary: "CLP_0001 hook hero clip has minor highlight clipping"
    affected_clip_ids: [CLP_0001]
    affected_beat_ids: [b01]
warnings:
  - summary: "CLP_0007 in b03 has slight_wind quality flag"
    severity: warning
    affected_clip_ids: [CLP_0007]
```

**UI 変更**:

| コンポーネント | 変更内容 |
|---------------|---------|
| `Timeline.tsx` (Canvas) | review マーカーを既存の Marker 描画ロジックに統合。`kind: 'review'` のマーカーを赤の破線で描画 |
| `ClipBlock.tsx` | affected_clip_ids にマッチするクリップにレビュー警告ボーダー（赤 or 黄の点線枠）を追加 |
| 新規: `ReviewOverlay.tsx` | タイムライン上部にレビューサマリーバンド表示。status に応じた色（approved=green, needs_revision=yellow, blocked=red） |
| 新規: `ReviewPanel.tsx` | PropertyPanel の下部タブ or 切り替えで、strengths / weaknesses / warnings / recommended_next_pass を一覧表示 |

**レビュー情報の Marker 変換ロジック**:

```typescript
// review_report.yaml → Marker[] 変換（サーバーサイド）
function reviewToMarkers(report: ReviewReport, timeline: TimelineIR): Marker[] {
  const markers: Marker[] = [];
  for (const weakness of report.weaknesses) {
    for (const clipId of weakness.affected_clip_ids) {
      const clip = findClip(timeline, clipId);
      if (clip) {
        markers.push({
          frame: clip.timeline_in_frame,
          kind: 'review',
          label: weakness.summary,
          metadata: {
            severity: 'weakness',
            affected_clip_ids: weakness.affected_clip_ids,
            affected_beat_ids: weakness.affected_beat_ids,
          }
        });
      }
    }
  }
  // warnings も同様
  return markers;
}
```

**データフロー**:

```
サーバー: GET /api/projects/:id/review
  → 06_review/review_report.yaml を読み込み
  → JSON 変換してレスポンス
クライアント: useReview() hook
  → ReviewPanel, ReviewOverlay, ClipBlock の警告表示に利用
  → reviewToMarkers() で timeline.markers に追加注入（表示専用、永続化しない）
```

---

### 1-2. レビューパッチの操作化

#### 1-2-1. パッチ操作一覧 UI

**データソース**: `06_review/review_patch.json`

```json
// review-patch.schema.json 準拠
{
  "timeline_version": "1",
  "operations": [
    {
      "op": "replace_segment",
      "target_clip_id": "CLP_0001",
      "with_segment_id": "SEG_0014",
      "new_src_in_us": 1000000,
      "new_src_out_us": 6000000,
      "reason": "Stronger opening; reduces highlight clipping",
      "confidence": 0.85
    },
    {
      "op": "trim_segment",
      "target_clip_id": "CLP_0003",
      "new_src_in_us": 2000000,
      "new_src_out_us": 4500000,
      "new_duration_frames": 60,
      "reason": "Tighter pacing for b02 support",
      "confidence": 0.78
    }
  ]
}
```

**新規コンポーネント: `PatchPanel.tsx`**

```
┌─────────────────────────────────────────────┐
│ Review Patches (3 proposals)          [All] │
│─────────────────────────────────────────────│
│ 1. replace_segment  CLP_0001    conf: 85%  │
│    "Stronger opening; reduces highlight..." │
│    [✓ Apply] [✗ Reject] [👁 Preview]       │
│─────────────────────────────────────────────│
│ 2. trim_segment     CLP_0003    conf: 78%  │
│    "Tighter pacing for b02 support"        │
│    [✓ Apply] [✗ Reject] [👁 Preview]       │
│─────────────────────────────────────────────│
│ 3. change_audio     CLP_0005    conf: 91%  │
│    "Reduce ducking for clearer dialogue"   │
│    [✓ Apply] [✗ Reject] [👁 Preview]       │
│─────────────────────────────────────────────│
│                    [Apply All] [Reject All] │
└─────────────────────────────────────────────┘
```

**操作タイプ別の適用ロジック**:

| op | 適用内容 | UI 表示 |
|----|---------|---------|
| `replace_segment` | segment_id, src_in/out_us を差し替え | Before/After のセグメント比較 |
| `trim_segment` | src_in/out_us と duration_frames を更新 | トリム範囲のビジュアル表示 |
| `move_segment` | timeline_in_frame を変更 | 移動先のゴースト表示 |
| `insert_segment` | 新クリップを指定位置に挿入 | 挿入位置のギャップ表示 |
| `remove_segment` | クリップを削除 | 削除対象のストライクスルー表示 |
| `change_audio_policy` | audio_policy フィールドを更新 | 変更前後の値を並列表示 |
| `add_marker` | markers 配列に追加 | マーカー位置のプレビュー |
| `add_note` | markers に note マーカーを追加 | ノート内容のツールチップ |

#### 1-2-2. パッチ適用前後のプレビュー比較

**`PatchPreview` モード**:

1. ユーザーが「👁 Preview」をクリック
2. timeline の現在状態をスナップショット（`previewBaseline`）
3. パッチを仮適用した状態を `previewPatched` として計算
4. Timeline を左右分割 or 上下分割で Before / After 表示
5. 差分があるクリップをハイライト（黄色ボーダー）
6. 「Apply」で確定（undo スタックに積む）、「Cancel」で元に戻す

```typescript
// パッチ適用の型定義
interface PatchOperation {
  op: 'replace_segment' | 'trim_segment' | 'move_segment' |
      'insert_segment' | 'remove_segment' | 'change_audio_policy' |
      'add_marker' | 'add_note';
  target_clip_id?: string;
  with_segment_id?: string;
  new_src_in_us?: number;
  new_src_out_us?: number;
  new_timeline_in_frame?: number;
  new_duration_frames?: number;
  reason: string;
  confidence?: number;
  evidence?: string[];
  audio_policy?: Partial<AudioPolicy>;
  beat_id?: string;
  role?: ClipRole;
  label?: string;
  with_candidate_ref?: string;
}

interface ReviewPatch {
  timeline_version: string;
  operations: PatchOperation[];
}

// パッチステータス管理
type PatchStatus = 'pending' | 'applied' | 'rejected' | 'previewing';

interface PatchState {
  patch: ReviewPatch;
  statuses: Map<number, PatchStatus>; // operation index → status
}
```

**データフロー**:

```
サーバー: GET /api/projects/:id/review-patch
  → 06_review/review_patch.json を読み込み
クライアント: usePatch() hook
  → PatchPanel に操作一覧を表示
  → Apply 時: applyPatchOp() → useTimeline.updateClip() → undo スタックに記録
  → Reject 時: ステータスを rejected に更新（表示のみ、永続化しない）
```

---

### 1-3. クリップ差し替え（代替候補ブラウザ）

#### 1-3-1. 代替候補パネル

**データソース**: `04_plan/selects_candidates.yaml`

```yaml
# selects-candidates.schema.json 準拠
candidates:
  - segment_id: SEG_0025
    asset_id: AST_005
    src_in_us: 1400000
    src_out_us: 6000000
    role: hero
    why_it_matches: "sunrise flare provides a restrained reveal of warmth"
    risks: ["minor highlight clipping may need a shorter trim"]
    confidence: 0.93
    semantic_rank: 1
    quality_flags: ["minor_highlight_clip"]
    eligible_beats: ["b01", "b04"]
    motif_tags: ["sunrise", "release"]
    trim_hint:
      source_center_us: 3700000
      preferred_duration_us: 4600000
      interest_point_label: "flare peak"
      interest_point_confidence: 0.88
```

**新規コンポーネント: `AlternativesPanel.tsx`**

クリップ選択時に PropertyPanel の右側 or タブ切り替えで表示:

```
┌─────────────────────────────────────────────┐
│ Alternatives for CLP_0001 (b01 hero)        │
│ Current: SEG_0025 (conf: 93%)               │
│─────────────────────────────────────────────│
│ ┌─────────┐                                 │
│ │ ░░░░░░░ │ SEG_0025 ★ current   rank #1   │
│ │ thumb   │ "sunrise flare provides..."     │
│ │         │ conf: 93%  ⚠ highlight_clip     │
│ └─────────┘ beats: b01, b04  4.6s           │
│─────────────────────────────────────────────│
│ ┌─────────┐                                 │
│ │ ░░░░░░░ │ SEG_0031               rank #2  │
│ │ thumb   │ "morning mist over ridge..."    │
│ │         │ conf: 88%  ✓ no flags           │
│ └─────────┘ beats: b01  3.8s                │
│           [↔ Swap]  [👁 Preview]            │
│─────────────────────────────────────────────│
│ ┌─────────┐                                 │
│ │ ░░░░░░░ │ SEG_0042               rank #3  │
│ │ thumb   │ "hands on trail map..."         │
│ │         │ conf: 72%  ⚠ slight_motion_blur │
│ └─────────┘ beats: b01, b02  5.1s           │
│           [↔ Swap]  [👁 Preview]            │
└─────────────────────────────────────────────┘
```

**フィルタリングロジック**:

選択クリップから代替候補を絞り込む条件:

```typescript
function findAlternatives(
  selectedClip: Clip,
  candidates: SelectCandidate[],
): SelectCandidate[] {
  return candidates
    .filter(c => c.role !== 'reject')
    .filter(c =>
      // 同じビートに対応可能な候補
      c.eligible_beats?.includes(selectedClip.beat_id ?? '') ||
      // 同じロールの候補
      c.role === selectedClip.role
    )
    .sort((a, b) => (a.semantic_rank ?? 999) - (b.semantic_rank ?? 999));
}
```

#### 1-3-2. サムネイル表示

**サーバー API 拡張**:

```
GET /api/projects/:id/thumbnail/:assetId?frame_us=3700000&width=160&height=90
  → 03_analysis/contact_sheets/ または ffmpeg で動的生成
  → キャッシュ: ファイルシステムに .cache/thumbs/ として保存
```

**表示内容**:

| フィールド | 表示形式 |
|-----------|---------|
| segment_id | `SEG_0031` |
| why_it_matches | テキスト（最大 2 行に truncate） |
| confidence | パーセンテージ + カラーバッジ |
| quality_flags | ⚠️ アイコン + ツールチップ |
| eligible_beats | ビートラベル一覧 |
| risks | 赤テキストで表示 |
| trim_hint.preferred_duration_us | 秒数表示 |

#### 1-3-3. ドラッグ差し替え操作

1. AlternativesPanel のカード上で「↔ Swap」をクリック
2. 選択クリップの segment_id, src_in/out_us, candidate_ref を代替候補の値で上書き
3. motivation を `"[Manual swap] {候補の why_it_matches}"` に更新
4. confidence を候補の値に更新
5. undo スタックに記録
6. 変更マーカー（`kind: 'note'`, `label: 'Human swap: SEG_XXXX → SEG_YYYY'`）を追加

```typescript
function swapClip(
  clip: Clip,
  candidate: SelectCandidate,
  fps: number,
): Partial<Clip> {
  const durationUs = candidate.trim_hint?.preferred_duration_us
    ?? (candidate.src_out_us - candidate.src_in_us);
  return {
    segment_id: candidate.segment_id,
    asset_id: candidate.asset_id,
    src_in_us: candidate.src_in_us,
    src_out_us: candidate.src_in_us + durationUs,
    candidate_ref: `${candidate.segment_id}:${candidate.src_in_us}:${candidate.src_in_us + durationUs}`,
    motivation: `[Manual swap] ${candidate.why_it_matches}`,
    confidence: candidate.confidence,
    quality_flags: candidate.quality_flags ?? [],
  };
}
```

---

### 1-4. AI 再実行トリガー

#### 1-4-1. コマンドパネル

**新規コンポーネント: `CommandBar.tsx`**

TransportBar の横 or 上部に配置するコマンドバー:

```
┌───────────────────────────────────────────────────┐
│ [💾 Save] [🔍 Review] [⚙ Compile] [🎬 Render]   │
│                                 Status: idle      │
└───────────────────────────────────────────────────┘
```

**各ボタンの動作**:

| ボタン | API | 事前処理 | 事後処理 |
|-------|-----|---------|---------|
| 💾 Save | `PUT /api/projects/:id/timeline` | バリデーション | 成功通知 |
| 🔍 Review | `POST /api/projects/:id/run/review` | Save を先に実行 | review_report.yaml を自動読み込み、ReviewPanel 更新 |
| ⚙ Compile | `POST /api/projects/:id/run/compile` | Save を先に実行 | timeline.json をリロード（diff 表示付き） |
| 🎬 Render | `POST /api/projects/:id/run/render` | Save → バリデーション | プレビュー URL を PreviewPlayer に反映 |

#### 1-4-2. サーバーサイド API

```typescript
// 新規エンドポイント: /api/projects/:id/run/:command
// command = 'review' | 'compile' | 'render'

interface RunRequest {
  command: 'review' | 'compile' | 'render';
  options?: {
    patchMode?: boolean;      // compile 時: パッチ適用モード
    resolution?: '720p' | '1080p';  // render 時
  };
}

interface RunResponse {
  status: 'started' | 'completed' | 'failed';
  jobId: string;
  message?: string;
  artifacts?: string[];  // 生成されたファイルパス
}

// 実行は子プロセスとして実行し、SSE or ポーリングで進捗を返す
// POST /api/projects/:id/run/review
//   → spawns: claude code skill /review in project directory
//   → monitors: 06_review/review_report.yaml の生成を watch
//   → returns: SSE stream of progress events
```

#### 1-4-3. 実行ステータス表示

**新規コンポーネント: `RunStatus.tsx`**

CommandBar 内にインラインで表示:

```
[🔍 Review] ← クリック
  ↓
[🔍 Running... ████░░ 60%] ← 実行中（無効化）
  ↓
[🔍 Review ✓] ← 完了（通知 + ReviewPanel 自動更新）
```

**実行状態の管理**:

```typescript
type RunState = 'idle' | 'saving' | 'running' | 'completed' | 'failed';

interface CommandState {
  review: RunState;
  compile: RunState;
  render: RunState;
  lastRun?: {
    command: string;
    timestamp: string;
    jobId: string;
  };
}
```

---

### 1-5. 編集履歴と diff

#### 1-5-1. AI 初回出力と人間編集の差分追跡

**設計方針**: timeline.json を初回ロード時にスナップショットし、以降の変更を追跡する。

```typescript
interface EditHistory {
  // AI が生成した初回タイムライン
  aiBaseline: TimelineIR;
  // 現在の状態（人間編集後）
  current: TimelineIR;
  // 変更されたクリップの ID セット
  humanEditedClipIds: Set<string>;
  // 各クリップの変更種別
  clipChanges: Map<string, ClipChangeType>;
}

type ClipChangeType =
  | 'trimmed'        // src_in/out_us が変更された
  | 'swapped'        // segment_id が変更された
  | 'audio_adjusted' // audio_policy のみ変更
  | 'moved'          // timeline_in_frame が変更された
  | 'added'          // 人間が新規追加
  | 'removed';       // 人間が削除
```

#### 1-5-2. 変更マーカーの UI 表示

| コンポーネント | 変更内容 |
|---------------|---------|
| `ClipBlock.tsx` | 人間が変更したクリップに ✏️ マーカー（左下に小アイコン）を表示 |
| `ClipBlock.tsx` | ClipChangeType に応じた色付きドット: 🔵 trimmed, 🟢 swapped, 🟡 audio, 🟣 moved |
| `Timeline.tsx` | フィルタトグル: 「Show human edits only」で変更クリップのみハイライト |

#### 1-5-3. Diff パネル

**新規コンポーネント: `DiffPanel.tsx`**

PropertyPanel のタブとして追加。選択クリップの Before (AI) / After (Human) を比較:

```
┌────────────────────────────────────────┐
│ Diff: CLP_0001  ✏️ swapped            │
│────────────────────────────────────────│
│ Field        │ AI Original │ Current   │
│──────────────┼─────────────┼──────────│
│ segment_id   │ SEG_0025    │ SEG_0031  │
│ src_in_us    │ 1,400,000   │ 2,100,000 │
│ src_out_us   │ 6,000,000   │ 5,900,000 │
│ motivation   │ "sunrise.." │ "[Swap].."│
│ confidence   │ 93%         │ 88%       │
│────────────────────────────────────────│
│           [↩ Revert to AI Original]    │
└────────────────────────────────────────┘
```

#### 1-5-4. AI ベースラインの永続化

timeline.json を AI が生成したタイミングで `.ai-baseline.json` としてスナップショットを保存:

```
projects/:id/05_timeline/
  timeline.json          ← 現在の状態（人間編集を含む）
  .ai-baseline.json      ← AI 最終出力のスナップショット（read-only）
```

**サーバーサイド**:

```
GET /api/projects/:id/timeline/ai-baseline
  → 05_timeline/.ai-baseline.json を返す
  → 存在しない場合は timeline.json を返す（初回互換）

POST /api/projects/:id/run/compile 完了時
  → timeline.json を .ai-baseline.json にコピー
  → provenance に ai_baseline_hash を記録
```

---

## 2. データフローまとめ

```
┌─────────────────────────────────────────────────────────┐
│ サーバー (Express)                                        │
│                                                           │
│  既存 API:                                                │
│    GET/PUT  /projects/:id/timeline                        │
│    POST     /projects/:id/preview                         │
│    GET      /projects/:id/media/:filename                 │
│                                                           │
│  新規 API:                                                │
│    GET      /projects/:id/review                          │
│    GET      /projects/:id/review-patch                    │
│    GET      /projects/:id/selects                         │
│    GET      /projects/:id/timeline/ai-baseline            │
│    GET      /projects/:id/thumbnail/:assetId              │
│    POST     /projects/:id/run/:command                    │
│    GET      /projects/:id/run/:jobId/status  (SSE)        │
│    GET      /projects/:id/blueprint                       │
└──────────────────────────┬──────────────────────────────┘
                           │ HTTP
┌──────────────────────────▼──────────────────────────────┐
│ クライアント (React + Vite)                               │
│                                                           │
│  既存 Hooks:                                              │
│    useTimeline()  — timeline CRUD + undo/redo             │
│    usePlayback()  — 再生 + プレビュー                      │
│    useSelection() — クリップ選択                           │
│                                                           │
│  新規 Hooks:                                              │
│    useReview()    — review_report 読み込み + Marker 変換   │
│    usePatch()     — review_patch 読み込み + 適用/却下管理  │
│    useSelects()   — selects_candidates 読み込み + 絞り込み │
│    useAiBaseline()— AI ベースライン比較 + diff 計算        │
│    useCommand()   — AI コマンド実行 + ステータス管理       │
│                                                           │
│  既存 Components:                                         │
│    App / Timeline / ClipBlock / TrackLane                  │
│    PropertyPanel / PreviewPlayer / TransportBar            │
│                                                           │
│  新規 Components:                                         │
│    ReviewOverlay   — タイムライン上部のレビューステータス  │
│    ReviewPanel     — strengths/weaknesses/warnings 一覧   │
│    PatchPanel      — パッチ操作一覧 + Apply/Reject        │
│    AlternativesPanel — 代替候補ブラウザ                    │
│    CommandBar      — AI 再実行ボタン群                     │
│    RunStatus       — 実行ステータスインジケータ            │
│    DiffPanel       — AI vs Human 差分表示                  │
└─────────────────────────────────────────────────────────┘
```

---

## 3. レイアウト設計

### 3-1. パネル配置（Phase 2b 完成形）

```
┌──────────────────────────────────────────────────────────────┐
│ CommandBar: [Save] [Review] [Compile] [Render]    Status     │
├────────────────────────────────┬─────────────────────────────┤
│                                │  [Properties | AI | Diff]   │
│    PreviewPlayer               │                             │
│    (HTML5 video / mock)        │  PropertyPanel              │
│                                │   or ReviewPanel            │
│                                │   or AlternativesPanel      │
│                                │   or DiffPanel              │
├────────────────────────────────┤   or PatchPanel             │
│  ReviewOverlay (warning band)  │                             │
├────────────────────────────────┤                             │
│                                │                             │
│  Timeline Canvas               │                             │
│  (ruler + tracks + markers     │                             │
│   + review overlay markers)    │                             │
│                                │                             │
├────────────────────────────────┴─────────────────────────────┤
│ TransportBar: [Play] 00:12.345  frame: 296    Zoom: ──●──   │
└──────────────────────────────────────────────────────────────┘
```

### 3-2. 右パネルのタブ構成

PropertyPanel 領域をタブ化:

| タブ名 | 内容 | 表示条件 |
|-------|------|---------|
| Properties | 既存の PropertyPanel（クリップ情報 + オーディオ + フェード） | クリップ選択時 |
| AI Context | motivation 詳細, confidence, quality_flags, blueprint purpose | クリップ選択時 |
| Alternatives | 代替候補リスト + サムネイル + Swap ボタン | クリップ選択時 |
| Diff | AI original vs current の比較テーブル | クリップ選択時かつ変更あり |
| Review | レビューサマリー + パッチ操作一覧 | review_report 存在時 |

---

## 4. フェーズ分割と優先順位

### Phase 2b-1: レビュー可視化 + パッチ操作（最優先）

**理由**: AI 粗編集の結果を人間が理解し、AI の提案を操作可能にする最小セット。これがないと人間は CLI とエディタを往復し続ける。

| タスク | 成果物 | 工数目安 |
|-------|-------|---------|
| サーバー: GET /projects/:id/review エンドポイント | review route | S |
| サーバー: GET /projects/:id/review-patch エンドポイント | patch route | S |
| クライアント: `useReview()` hook | review_report → state | S |
| クライアント: `usePatch()` hook | review_patch → state + apply/reject | M |
| クライアント: `ReviewOverlay.tsx` | タイムライン上部のステータスバンド | S |
| クライアント: `ReviewPanel.tsx` | strengths/weaknesses/warnings 一覧 | M |
| クライアント: `PatchPanel.tsx` | パッチ操作一覧 + Apply/Reject UI | L |
| クライアント: ClipBlock.tsx 拡張 | confidence バッジ + quality_flags 警告 + review 警告ボーダー | M |
| クライアント: PropertyPanel タブ化 | 右パネルのタブ切り替え基盤 | M |
| クライアント: AI Context タブ | motivation 詳細, blueprint purpose 参照表示 | S |
| サーバー: GET /projects/:id/blueprint エンドポイント | blueprint の beat purpose 取得用 | S |

**Phase 2b-1 の完了条件**:
- レビューレポートがタイムライン上に可視化される
- パッチ操作をワンクリックで適用/却下できる
- クリップの confidence がタイムライン上で確認できる
- パッチ適用は undo/redo で取り消せる

---

### Phase 2b-2: クリップ差し替え + 編集 diff（次に実装）

**理由**: 代替候補の閲覧と差し替えは「AI の判断に不同意な場合」の主要な操作パス。diff は変更の追跡性を確保する。

| タスク | 成果物 | 工数目安 |
|-------|-------|---------|
| サーバー: GET /projects/:id/selects エンドポイント | selects route | S |
| サーバー: GET /projects/:id/thumbnail/:assetId エンドポイント | サムネイル生成 + キャッシュ | M |
| サーバー: GET /projects/:id/timeline/ai-baseline エンドポイント | ベースライン読み込み | S |
| サーバー: /compile 完了時の .ai-baseline.json 自動保存 | ベースラインスナップショット | S |
| クライアント: `useSelects()` hook | selects_candidates → state + フィルタ | M |
| クライアント: `useAiBaseline()` hook | ベースライン比較 + diff 計算 | M |
| クライアント: `AlternativesPanel.tsx` | 代替候補一覧 + サムネイル + Swap | L |
| クライアント: `DiffPanel.tsx` | Before/After 比較テーブル | M |
| クライアント: ClipBlock.tsx 拡張 | ✏️ 変更マーカー + 変更種別カラードット | S |
| クライアント: swapClip() ユーティリティ | 差し替えロジック + undo 統合 | M |
| クライアント: Timeline フィルタ | 「Show human edits only」トグル | S |

**Phase 2b-2 の完了条件**:
- 選択クリップの代替候補をサムネイル付きで閲覧できる
- ワンクリックでクリップを差し替えられる
- AI 出力と人間編集の差分がクリップごとに確認できる
- 変更クリップが視覚的に識別できる

---

### Phase 2b-3: AI 再実行 + 高度な比較（最後に実装）

**理由**: AI 再実行は人間の修正を AI に反映させる「ループを閉じる」機能。Phase 2b-1/2 でエディタ側の操作が整った後に意味を持つ。

| タスク | 成果物 | 工数目安 |
|-------|-------|---------|
| サーバー: POST /projects/:id/run/:command エンドポイント | コマンド実行ルート | L |
| サーバー: CLI スキル呼び出し基盤 | 子プロセス spawn + ログ収集 | L |
| サーバー: GET /projects/:id/run/:jobId/status (SSE) | 実行ステータスストリーム | M |
| クライアント: `useCommand()` hook | コマンド実行 + SSE ステータス管理 | M |
| クライアント: `CommandBar.tsx` | Review / Compile / Render ボタン | M |
| クライアント: `RunStatus.tsx` | 実行進捗インジケータ | S |
| クライアント: 自動リロード | Compile/Review 完了後の timeline/review 自動読み込み | M |
| クライアント: PatchPanel 拡張 | パッチ適用前後の比較プレビュー（Before/After 分割表示） | L |
| クライアント: DiffPanel 拡張 | 全クリップの diff サマリービュー + 統計（変更数、変更率） | M |
| サーバー: 実行履歴ログ | run_history.jsonl に実行記録を追記 | S |

**Phase 2b-3 の完了条件**:
- エディタから /review, /compile, /render を実行できる
- 実行進捗がリアルタイムで確認できる
- AI 再評価後の結果が自動的にエディタに反映される
- 完全な AI ↔ Human ループが GUI のみで完結する

---

## 5. 型定義の追加・変更まとめ

### 5-1. 新規型定義（`types.ts` に追加）

```typescript
// --- Review ---
export interface ReviewStrengthWeakness {
  summary: string;
  details?: string;
  evidence?: string[];
  affected_beat_ids?: string[];
  affected_clip_ids?: string[];
}

export interface ReviewWarning {
  summary: string;
  severity: 'warning' | 'fatal';
  evidence?: string[];
  affected_beat_ids?: string[];
  affected_clip_ids?: string[];
}

export interface ReviewReport {
  version: string;
  project_id: string;
  timeline_version: string;
  created_at?: string;
  summary_judgment: {
    status: 'approved' | 'needs_revision' | 'blocked';
    rationale: string;
    confidence: number;
  };
  strengths: ReviewStrengthWeakness[];
  weaknesses: ReviewStrengthWeakness[];
  fatal_issues?: ReviewStrengthWeakness[];
  warnings: ReviewWarning[];
  mismatches_to_brief?: ReviewStrengthWeakness[];
  mismatches_to_blueprint?: ReviewStrengthWeakness[];
  recommended_next_pass?: {
    goal?: string;
    actions: string[];
    preserve?: string[];
    alternative_directions?: string[];
  };
}

// --- Review Patch ---
export type PatchOp =
  | 'replace_segment'
  | 'trim_segment'
  | 'move_segment'
  | 'insert_segment'
  | 'remove_segment'
  | 'change_audio_policy'
  | 'add_marker'
  | 'add_note';

export interface PatchOperation {
  op: PatchOp;
  target_clip_id?: string;
  with_segment_id?: string;
  new_src_in_us?: number;
  new_src_out_us?: number;
  new_timeline_in_frame?: number;
  new_duration_frames?: number;
  reason: string;
  confidence?: number;
  evidence?: string[];
  audio_policy?: Partial<AudioPolicy>;
  beat_id?: string;
  role?: ClipRole;
  label?: string;
  with_candidate_ref?: string;
}

export interface ReviewPatch {
  timeline_version: string;
  operations: PatchOperation[];
}

export type PatchStatus = 'pending' | 'applied' | 'rejected' | 'previewing';

// --- Selects Candidates ---
export interface TrimHint {
  source_center_us?: number;
  preferred_duration_us?: number;
  min_duration_us?: number;
  max_duration_us?: number;
  window_start_us?: number;
  window_end_us?: number;
  interest_point_label?: string;
  interest_point_confidence?: number;
}

export interface EditorialSignals {
  silence_ratio?: number;
  afterglow_score?: number;
  speech_intensity_score?: number;
  reaction_intensity_score?: number;
  authenticity_score?: number;
  surprise_signal?: number;
  peak_strength_score?: number;
  peak_type?: 'action_peak' | 'emotional_peak' | 'visual_peak';
  visual_tags?: string[];
}

export interface SelectCandidate {
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  role: 'hero' | 'support' | 'transition' | 'texture' | 'dialogue' | 'reject';
  why_it_matches: string;
  risks: string[];
  confidence: number;
  semantic_rank?: number;
  quality_flags?: string[];
  evidence?: string[];
  eligible_beats?: string[];
  transcript_excerpt?: string;
  motif_tags?: string[];
  rejection_reason?: string;
  candidate_id?: string;
  editorial_signals?: EditorialSignals;
  trim_hint?: TrimHint;
}

export interface SelectsCandidates {
  version: string;
  project_id: string;
  created_at?: string;
  candidates: SelectCandidate[];
  editorial_summary?: {
    dominant_visual_mode?: string;
    speaker_topology?: string;
    motion_profile?: string;
    transcript_density?: string;
  };
}

// --- Blueprint (read-only reference) ---
export interface BlueprintBeat {
  beat_id: string;
  beat_label: string;
  purpose: string;
  hero_roles?: string[];
  support_roles?: string[];
  duration_target_sec?: number;
  pacing_intent?: string;
}

// --- Edit History ---
export type ClipChangeType =
  | 'trimmed'
  | 'swapped'
  | 'audio_adjusted'
  | 'moved'
  | 'added'
  | 'removed';

// --- Command Execution ---
export type RunCommand = 'review' | 'compile' | 'render';
export type RunState = 'idle' | 'saving' | 'running' | 'completed' | 'failed';

export interface CommandState {
  review: RunState;
  compile: RunState;
  render: RunState;
  lastRun?: {
    command: RunCommand;
    timestamp: string;
    jobId: string;
  };
}
```

### 5-2. 既存型への変更なし

現行の `Clip`, `TimelineIR`, `Marker` 等は変更不要。すべての AI メタデータフィールド（`motivation`, `confidence`, `quality_flags`, `fallback_segment_ids`, `candidate_ref`）は Phase 2a ですでに定義済み。

---

## 6. サーバー API 一覧（新規）

| メソッド | パス | 説明 | Phase |
|---------|------|------|-------|
| GET | `/projects/:id/review` | review_report.yaml を JSON で返す | 2b-1 |
| GET | `/projects/:id/review-patch` | review_patch.json を返す | 2b-1 |
| GET | `/projects/:id/blueprint` | edit_blueprint.yaml の beats を JSON で返す | 2b-1 |
| GET | `/projects/:id/selects` | selects_candidates.yaml を JSON で返す | 2b-2 |
| GET | `/projects/:id/thumbnail/:assetId` | セグメントサムネイルを返す | 2b-2 |
| GET | `/projects/:id/timeline/ai-baseline` | .ai-baseline.json を返す | 2b-2 |
| POST | `/projects/:id/run/:command` | AI コマンド実行をキック | 2b-3 |
| GET | `/projects/:id/run/:jobId/status` | 実行ステータス（SSE） | 2b-3 |

---

## 7. 非機能要件

### 7-1. パフォーマンス

- サムネイル生成は遅延実行 + キャッシュ（`projects/:id/.cache/thumbs/`）
- review_report と selects_candidates はプロジェクトロード時にプリフェッチ
- PatchPanel のパッチ適用はクライアントサイドで即時反映（サーバー保存は Save ボタン経由）
- SSE ストリームは 30 秒のハートビート + 10 分のタイムアウト

### 7-2. エラーハンドリング

- review_report.yaml が存在しない → ReviewPanel に「Run /review to generate」メッセージ
- review_patch.json が存在しない → PatchPanel を非表示
- selects_candidates.yaml が存在しない → AlternativesPanel に「Run /select to generate」メッセージ
- AI コマンド実行失敗 → RunStatus にエラーメッセージ + ログへのリンク
- .ai-baseline.json が存在しない → DiffPanel に「No baseline available」メッセージ

### 7-3. アーキテクチャ制約の遵守

| 制約 | 本設計での対応 |
|------|-------------|
| Only compiler mutates timeline.json | 人間編集は useTimeline 経由。AI 再コンパイル時はサーバーが /compile を実行 |
| Agents emit review_patch[], not ffmpeg commands | PatchPanel は review-patch.schema.json の操作のみ提供 |
| No final render if review report contains fatal issues | Render ボタンは fatal_issues が存在する場合に警告 + 確認ダイアログ |
| Provenance tracking | 人間編集時に provenance.editor_version, provenance.last_editor_save を更新 |

---

## 8. 将来の拡張候補（Phase 2c 以降）

本設計のスコープ外だが、次のステップとして検討する項目:

| 項目 | 概要 |
|------|------|
| リアルタイムプレビュー差し替え | Swap 前後の映像をインラインプレビューで比較 |
| AI 提案の理由説明チャット | 選択理由を対話的に掘り下げる LLM チャット |
| 複数レビューラウンドの履歴 | review_report v1, v2, ... の変遷を比較 |
| コラボレーション | 複数人での同時編集（OT or CRDT） |
| Premiere 往復の差分表示 | /import-premiere 後の変更を diff 表示 |
| ブラウザベースのセグメントプレビュー | AlternativesPanel 内でセグメントの動画をインライン再生 |
| AI 信頼度の学習 | 人間の Accept/Reject 傾向から AI の confidence キャリブレーションを改善 |

---

## 9. 用語集

| 用語 | 定義 |
|------|------|
| AI Baseline | AI パイプラインが最後に生成した timeline.json のスナップショット |
| Confidence | AI がそのクリップ選択に対して持つ確信度（0-1） |
| Motivation | AI がクリップを選んだ理由の自然言語説明 |
| Review Patch | AI レビューが提案するタイムライン修正操作の配列 |
| Selects Candidates | AI がソース素材から選出したクリップ候補のランク付きリスト |
| Beat | edit_blueprint 内のナラティブ構成単位（b01, b02, ...） |
| Human Edit Marker | 人間がエディタで変更したクリップを示す視覚的インジケータ |
| Run Command | エディタから AI パイプラインスキルを実行するトリガー |
