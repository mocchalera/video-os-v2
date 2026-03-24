# Video OS v2 — Editor AI-Human Workflow Final Design

> Date: 2026-03-24
> Status: Final
> Scope: Web editor に AI artifact 可視化、review patch 操作、clip alternatives、AI rerun を統合する
> Supersedes:
> - `docs/editor-ai-workflow-design.md`
> - `docs/editor-ai-workflow-impl-plan.md`
> Implementation rule: この文書を実装の唯一の参照先とする

---

## 0. 目的

### 0-1. 背景

Phase 2a の Web エディタは `timeline.json` の表示・トリム・音量調整・保存まではできるが、AI が生成した以下の artifact が UI に統合されていない。

- `06_review/review_report.yaml`
- `06_review/review_patch.json`
- `04_plan/selects_candidates.yaml`
- clip / patch ごとの `confidence`
- `compile` / `review` / `render` の再実行状況

その結果、人間はエディタと CLI を往復しながら以下を手作業で行っている。

- AI の判断理由の確認
- レビュー結果の読解
- patch 適用
- 代替候補の探索
- AI 再実行

本設計の目的は、エディタを「AI 編集の閲覧・調整・再実行の単一ハブ」にすることにある。

### 0-2. 成功条件

以下を満たしたら本設計の実装は成功とみなす。

1. 右インスペクタで、選択 clip の AI 判断理由、confidence、quality flags、review findings、代替候補を確認できる。
2. タイムライン上で `review_patch` の対象と変更種別が視覚化される。
3. review patch を UI から安全に適用でき、適用結果は undo スタックに統合される。
4. manual save と AI patch/apply と AI job の競合が `timeline_revision` によって防止される。
5. `compile` / `review` / `render` を HTTP API から非同期起動できる。
6. v1 の進捗通知は `progress.json` polling で成立する。
7. 保存・patch apply・AI job 完了後に `project_state.yaml` が reconcile され、stale 判定と gate 状態が UI に反映される。

### 0-3. 統合判断

本設計では、元の 2 文書の差分を以下の判断で固定する。

| 論点 | 最終判断 |
|---|---|
| 進捗通知 | v1 は `progress.json` polling を採用する。SSE は v2 以降 |
| 競合制御 | `.ai-baseline.json` は採用しない。`timeline_revision` を導入する |
| review 呼び出し | `runReview()` は `ReviewAgent` adapter を介して呼ぶ。`runCompilePhase()` と `runRender()` は直接再利用する |
| patch と undo | patch 適用は server 側で確定し、その前状態を client undo スタックに積む |
| Phase 分割 | Claude 案の `Phase 2b-1` / `2b-2` / `2b-3` を採用する |
| AI diff の基準 | 永続 `.ai-baseline` は作らず、client の `sessionBaseline + baselineRevision` で比較する |

---

## 1. スコープと原則

### 1-1. 今回やること

- AI artifact の read API 追加
- inspector / timeline overlay / command bar の追加
- patch apply API と timeline revision guard の導入
- alternatives browser と diff UI の追加
- AI rerun jobs API と polling UI の追加
- manual save 後 / patch apply 後 / AI job 後の reconcile

### 1-2. 今回やらないこと

- multi-user 同時編集
- CRDT / OT / 自動 merge
- WebSocket 前提の双方向常時接続
- review agent 以外の新しい agent runtime 設計
- candidate の本格動画プレビュー専用 API
- `.ai-baseline.json` の保存

### 1-3. アーキテクチャ原則

- manual 編集は Phase 2a と同じく editor の `PUT /timeline` で保存する
- AI 由来の mutation は `applyPatch()` または `runCompilePhase()` を利用する
- review patch は `review-patch.schema.json` で許可された操作のみ扱う
- 保存系操作の完了後は必ず `reconcileAndPersist()` を呼ぶ
- 競合防止は lock ではなく `timeline_revision` を正とし、lock は UX 保護に使う

---

## 2. 中核データモデル

### 2-1. `timeline_revision`

`timeline_revision` は `05_timeline/timeline.json` のファイル内容から算出する競合制御トークンである。

- 値の意味: file-content hash
- 元実装: `runtime/state/reconcile.ts` の `computeFileHash()`
- API 表現: `sha256:<hex16>`
- 不使用: `timeline.version`

`timeline.version` は schema / semantic version の意味を持つため、同時編集防止には使わない。

### 2-2. session baseline

`.ai-baseline.json` は導入しない。代わりに client は以下を持つ。

```ts
interface SessionBaseline {
  timeline: TimelineIR;
  baselineRevision: string;
  establishedBy: "initial_load" | "reload_after_compile";
}
```

用途は `DiffPanel` の比較専用であり、server 永続化はしない。

baseline は以下のタイミングで更新する。

- project 初回ロード時
- compile job 成功後に新しい `timeline_revision` を再取得した時

baseline を更新しないもの:

- manual trim / swap / audio edit
- review patch apply
- review rerun
- render

### 2-3. undo スタック統合

patch apply は server 側で timeline を保存した後、client 側で以下を行う。

1. 現在の `present` を `past` に push
2. server 返却の timeline を `present` に置換
3. `timelineRevision` を更新
4. `dirty = false` にする
5. history entry の origin を `patch_apply` として記録する

その後の `Undo` は local state を pre-apply timeline に戻す。戻した状態は unsaved とし、永続化には通常の Save を使う。

```ts
type HistoryOrigin =
  | "manual_trim"
  | "manual_swap"
  | "manual_audio"
  | "patch_apply"
  | "server_reload";
```

### 2-4. lock モデル

per-project 単位で single-flight lock を持つ。

| lock kind | 用途 |
|---|---|
| `saving` | `PUT /timeline` の並行保存抑止 |
| `patching` | `POST /ai/patches/apply` の並行実行抑止 |
| `job:compile` | compile 実行中の他 mutation 抑止 |
| `job:review` | review 実行中の save / patch / compile 競合抑止 |
| `job:render` | render 実行中の全 mutation 抑止 |

戻り値:

- `423 Locked`: 他の save / patch / AI job が実行中

---

## 3. Phase 2b-1: レビュー可視化 + patch 操作

### 3-1. ユーザー価値

最初の出荷では、AI が何を指摘し、どの patch を提案しているかを UI 上で読めて、その patch を安全に適用できることを優先する。

### 3-2. フロントエンド要件

Phase 2b-1 で追加または拡張する UI は以下。

| コンポーネント | 種別 | 責務 |
|---|---|---|
| `PropertyPanelTabs` | 新規 | 右パネルを `Properties / AI Context / Review` のタブに分割する |
| `AiContextPanel` | 新規 | `motivation`, `confidence`, `quality_flags`, blueprint purpose を表示する |
| `ReviewPanel` | 新規 | `summary_judgment`, `strengths`, `weaknesses`, `warnings`, `fatal_issues`, `recommended_next_pass` を表示する |
| `PatchPanel` | 新規 | review patch を一覧表示し、`Apply` / `Apply All` / `Reject` を制御する |
| `ReviewOverlay` | 新規 | タイムライン上部に review 状態バンドを表示する |
| `TimelineAiOverlay` | 新規 | `review_patch` と `review_report` の対象 clip を overlay 表示する |
| `ClipBlock` | 既存拡張 | confidence badge、quality flag icon、review affected border を描画する |
| `TrackLane` | 既存拡張 | clip layer の上に AI overlay layer を重ねる |
| `useAiArtifacts()` | 新規 hook | review report / review patch / blueprint / status を取得し、artifact revision でキャッシュする |
| `useTimeline()` | 既存拡張 | `timelineRevision`, `commitRemoteMutation()`, `sessionBaseline` を持つ |

### 3-3. Phase 2b-1 API 仕様

#### 3-3-1. `GET /api/projects/:id/timeline`

用途:

- editor の timeline 本体取得
- 現在の `timeline_revision` の取得

response headers:

```http
ETag: "sha256:abcd1234ef567890"
```

response body:

```json
{
  "...": "timeline.json content"
}
```

備考:

- body 形式は Phase 2a 互換で raw timeline のまま
- client は `ETag` を `timelineRevision` として保持する

#### 3-3-2. `PUT /api/projects/:id/timeline`

用途:

- manual save
- undo で戻した状態の保存

request headers:

```http
If-Match: "sha256:abcd1234ef567890"
Content-Type: application/json
```

request body:

```json
{
  "...": "normalized timeline content"
}
```

server 処理:

1. project lock `saving` を取得
2. 現在の `timeline_revision` と `If-Match` を比較
3. timeline schema validate
4. temp file + rename で `05_timeline/timeline.json` を atomic save
5. `reconcileAndPersist(projectDir, "editor-ai", "/api/projects/:id/timeline")`
6. 新しい revision を返す

response:

```json
{
  "ok": true,
  "timeline_revision": "sha256:newrevision1234",
  "saved_at": "2026-03-24T12:34:56.000Z",
  "status": {
    "currentState": "timeline_drafted",
    "staleArtifacts": ["review_report"],
    "gates": {
      "review_gate": "blocked"
    }
  }
}
```

failure:

- `409 Conflict`: timeline revision mismatch
- `423 Locked`: other mutation in progress
- `422 Unprocessable Entity`: invalid timeline

#### 3-3-3. `GET /api/projects/:id/ai/context`

用途:

- inspector 初期表示に必要な AI artifact をまとめて返す

response:

```json
{
  "project_id": "demo",
  "timeline_revision": "sha256:abcd1234ef567890",
  "timeline_version": "1",
  "artifacts": {
    "blueprint": {
      "exists": true,
      "revision": "sha256:bp00112233",
      "data": {
        "beats": [
          {
            "beat_id": "b01",
            "beat_label": "hook",
            "purpose": "Open with a restrained emotional reveal"
          }
        ]
      }
    },
    "review_report": {
      "exists": true,
      "revision": "sha256:rr00112233",
      "data": {}
    },
    "review_patch": {
      "exists": true,
      "revision": "sha256:rp00112233",
      "data": {},
      "safety": {
        "safe": true,
        "rejected_ops": [],
        "filtered_patch": {}
      }
    }
  },
  "status": {
    "currentState": "critique_ready",
    "staleArtifacts": [],
    "nextCommand": "/export or apply patch"
  }
}
```

備考:

- `review_patch` は返却時点で `validatePatchSafety()` を実行する
- UI は `filtered_patch` のみ描画対象にする
- `rejected_ops` は warning banner として表示する

#### 3-3-4. `GET /api/projects/:id/ai/review-report`

用途:

- review report 単体再取得

response:

```json
{
  "exists": true,
  "revision": "sha256:rr00112233",
  "data": {
    "summary_judgment": {
      "status": "needs_revision",
      "rationale": "Hook is strong but pacing drifts in beat b03",
      "confidence": 0.82
    },
    "weaknesses": [],
    "warnings": []
  }
}
```

#### 3-3-5. `GET /api/projects/:id/ai/review-patch`

用途:

- review patch 単体再取得

response:

```json
{
  "exists": true,
  "revision": "sha256:rp00112233",
  "data": {
    "timeline_version": "1",
    "operations": []
  },
  "safety": {
    "safe": true,
    "rejected_ops": [],
    "filtered_patch": {
      "timeline_version": "1",
      "operations": []
    }
  }
}
```

#### 3-3-6. `GET /api/projects/:id/ai/blueprint`

用途:

- beat purpose の参照表示

response:

```json
{
  "exists": true,
  "revision": "sha256:bp00112233",
  "data": {
    "beats": [
      {
        "beat_id": "b01",
        "beat_label": "hook",
        "purpose": "Open with a restrained emotional reveal",
        "duration_target_sec": 4
      }
    ]
  }
}
```

#### 3-3-7. `POST /api/projects/:id/ai/patches/apply`

用途:

- review patch の一部または全部を適用する
- v1 の patch 適用の正規 API

request:

```json
{
  "source": "review_patch",
  "base_timeline_revision": "sha256:abcd1234ef567890",
  "operation_indexes": [0, 2]
}
```

将来拡張用:

```json
{
  "source": "inline",
  "base_timeline_revision": "sha256:abcd1234ef567890",
  "patch": {
    "timeline_version": "1",
    "operations": []
  }
}
```

server 処理:

1. project lock `patching` を取得
2. `base_timeline_revision` を比較
3. patch load
4. `validatePatchSafety()` を再実行
5. `applyPatch()` で新 timeline を生成
6. timeline schema validate
7. temp file + rename で timeline save
8. `reconcileAndPersist(projectDir, "editor-ai", "/apply-patch")`

response:

```json
{
  "ok": true,
  "timeline_revision_before": "sha256:old1111",
  "timeline_revision_after": "sha256:new2222",
  "applied_operation_indexes": [0, 2],
  "rejected_operations": [],
  "timeline": {},
  "status": {
    "currentState": "timeline_drafted",
    "staleArtifacts": ["review_report"]
  }
}
```

failure:

- `409 Conflict`: base revision mismatch
- `422 Unprocessable Entity`: invalid patch or unsafe patch
- `423 Locked`: save or AI job in progress

### 3-4. Phase 2b-1 UI 動作

#### Patch apply

- `dirty = true` の間は `Apply` / `Apply All` を disabled にする
- 表示文言は `Save first to apply AI patch`
- `Reject` は UI ローカル状態のみ変更し、server には保存しない
- `Apply` 成功時に `useTimeline.commitRemoteMutation()` を呼ぶ

#### confidence 表現

| confidence | 表現 |
|---|---|
| `>= 0.85` | 緑 badge |
| `0.65 - 0.84` | 黄 badge |
| `< 0.65` | 赤 badge + diagonal hatch |

opacity だけで表現しない。clip 可読性を維持するため clip opacity の下限は `0.68` とする。

#### review overlay

| review element | 表現 |
|---|---|
| `summary_judgment.status = approved` | 緑 band |
| `needs_revision` | 黄 band |
| `blocked` | 赤 band |
| `weakness` | clip 周囲の赤 dashed border |
| `warning` | clip 周囲の黄 dashed border |

#### patch overlay

| op | 表現 |
|---|---|
| `replace_segment` | clip 全体のマゼンタ outline |
| `trim_segment` | 左右端のアンバー overlay |
| `move_segment` | 元位置 outline + 移動先のシアン ghost |
| `insert_segment` | ruler 上の紫 caret |
| `remove_segment` | 赤 strike-through |
| `change_audio_policy` | audio lane 下辺の青 strip |
| `add_marker` / `add_note` | marker chip |

### 3-5. Phase 2b-1 完了条件

- review report が inspector と timeline 上で可視化される
- review patch が一覧で表示される
- patch を UI から安全に適用できる
- patch apply 前の状態が undo で戻せる
- stale save が `409` になる

---

## 4. Phase 2b-2: clip 差し替え + diff

### 4-1. ユーザー価値

Phase 2b-2 では、AI の提案に不同意な時に人間が別候補へ差し替えられること、そして何を変えたかが可視化されることを優先する。

### 4-2. フロントエンド要件

| コンポーネント | 種別 | 責務 |
|---|---|---|
| `AlternativesPanel` | 新規 | 現在 clip に対する代替候補一覧、filter、swap 操作 |
| `DiffPanel` | 新規 | `sessionBaseline` と current timeline の clip-level diff を表示 |
| `ThumbnailCard` | 新規 | 候補 clip のサムネイル、confidence、risks、eligible beats を表示 |
| `useSelects()` | 新規 hook | `selects_candidates.yaml` の取得、候補 ranking、clip ごとの alternatives 算出 |
| `useDiff()` | 新規 hook | `sessionBaseline` と current timeline の差分計算 |
| `ClipBlock` | 既存拡張 | `manual edit` marker と change origin を表示 |

### 4-3. Phase 2b-2 API 仕様

#### 4-3-1. `GET /api/projects/:id/ai/selects`

用途:

- `selects_candidates.yaml` を JSON で返す

response:

```json
{
  "exists": true,
  "revision": "sha256:sel00112233",
  "data": {
    "version": "1",
    "project_id": "demo",
    "candidates": [
      {
        "segment_id": "SEG_0025",
        "asset_id": "AST_005",
        "src_in_us": 1400000,
        "src_out_us": 6000000,
        "role": "hero",
        "why_it_matches": "sunrise flare provides a restrained reveal of warmth",
        "risks": ["minor highlight clipping may need a shorter trim"],
        "confidence": 0.93,
        "semantic_rank": 1,
        "quality_flags": ["minor_highlight_clip"],
        "eligible_beats": ["b01", "b04"],
        "trim_hint": {
          "source_center_us": 3700000,
          "preferred_duration_us": 4600000
        }
      }
    ]
  }
}
```

#### 4-3-2. `GET /api/projects/:id/thumbnail/:assetId`

用途:

- alternatives card の thumbnail を返す

query:

```text
frame_us=<number>&width=<number>&height=<number>
```

response:

- `image/webp` または `image/jpeg`

server 実装:

- 既存 thumbnail route を拡張して `assetId + frame_us` 指定に対応
- キャッシュ先は `projects/:id/.cache/thumbs/`

### 4-4. alternatives 算出ルール

候補の優先順は以下。

1. `candidate_ref` に一致する元候補
2. `fallback_segment_ids`
3. `eligible_beats` に現在 `beat_id` を含む候補
4. 同じ role の候補
5. `semantic_rank`, `confidence` 順の予備候補

除外:

- `role = reject`
- clip duration に対して極端に短すぎる候補

### 4-5. swap 操作

swap は review patch API を使わず、manual edit として local state に反映する。

理由:

- 人間の意思決定であり AI patch ではない
- undo / redo と相性がよい
- save 時の `timeline_revision` guard で十分に保護できる

`swapClip()` の更新対象:

- `segment_id`
- `asset_id`
- `src_in_us`
- `src_out_us`
- `candidate_ref`
- `motivation = "[Manual swap] ..."`
- `confidence`
- `quality_flags`

この変更は history origin `manual_swap` として記録する。

### 4-6. diff 表示

`DiffPanel` は `sessionBaseline.timeline` と current timeline を比較し、以下を clip 単位で出す。

| change type | 判定 |
|---|---|
| `trimmed` | `src_in_us` or `src_out_us` が変更 |
| `swapped` | `segment_id` or `asset_id` が変更 |
| `audio_adjusted` | `audio_policy` が変更 |
| `moved` | `timeline_in_frame` が変更 |
| `added` | current のみに存在 |
| `removed` | baseline のみに存在 |
| `patch_apply` | remote mutation 由来で追加された差分 |

No `.ai-baseline.json`:

- diff は client session の比較結果とする
- baseline は project reload か compile 成功時にだけ更新する

### 4-7. Phase 2b-2 完了条件

- 選択 clip に対して alternatives が見える
- thumbnail 付きで候補比較ができる
- one-click swap ができる
- human edits と patch apply の差分が `DiffPanel` で見える

---

## 5. Phase 2b-3: AI 再実行 + 高度な比較

### 5-1. ユーザー価値

Phase 2b-3 で GUI 上から AI loop を閉じる。対象は `compile`, `review`, `render` で、進捗通知は v1 では polling とする。

### 5-2. フロントエンド要件

| コンポーネント | 種別 | 責務 |
|---|---|---|
| `CommandBar` | 新規 | `Save`, `Review`, `Compile`, `Render` を表示し、実行条件に応じて enable/disable する |
| `RunStatus` | 新規 | job state, progress %, errors, obsolete を表示する |
| `PatchPreviewPanel` | 新規 | patch preview の before/after diff を表示する |
| `useAiJobs()` | 新規 hook | job 起動、current job 取得、progress polling |
| `useProgressPolling()` | 新規 hook | running job 中のみ 1000-1500ms 間隔で `progress.json` を poll する |

### 5-3. Phase 2b-3 API 仕様

#### 5-3-1. `POST /api/projects/:id/ai/jobs`

用途:

- `compile`, `review`, `render` の非同期起動

request:

```json
{
  "phase": "review",
  "base_timeline_revision": "sha256:abcd1234ef567890",
  "options": {
    "require_compiled_timeline": true,
    "skip_preview": false
  }
}
```

phase ごとの options:

| phase | options |
|---|---|
| `compile` | `created_at?`, `fps_num?` |
| `review` | `require_compiled_timeline` default `true`, `skip_preview` default `false` |
| `render` | `output_profile?` |

response:

```json
{
  "job_id": "job_20260324_001",
  "phase": "review",
  "status": "queued",
  "base_timeline_revision": "sha256:abcd1234ef567890",
  "progress_url": "/api/projects/demo/ai/progress",
  "job_url": "/api/projects/demo/ai/jobs/job_20260324_001"
}
```

server 実行:

- `compile`: `runCompilePhase()`
- `review`: `runReview(projectDir, reviewAgentAdapter, { requireCompiledTimeline: true })`
- `render`: `runRender()`

failure:

- `409 Conflict`: `base_timeline_revision` mismatch
- `423 Locked`: same project で他 job または save/patch が実行中
- `422 Unprocessable Entity`: unsupported phase or invalid options
- `503 Service Unavailable`: review adapter 未設定で `phase = review`

#### 5-3-2. `GET /api/projects/:id/ai/jobs/current`

用途:

- 現在の job 状態確認

response:

```json
{
  "exists": true,
  "job": {
    "job_id": "job_20260324_001",
    "phase": "review",
    "status": "running",
    "started_at": "2026-03-24T12:35:00.000Z",
    "base_timeline_revision": "sha256:abcd1234ef567890"
  }
}
```

#### 5-3-3. `GET /api/projects/:id/ai/jobs/:jobId`

用途:

- job 完了 / 失敗 / obsolete の詳細確認

response:

```json
{
  "job_id": "job_20260324_001",
  "phase": "review",
  "status": "succeeded",
  "started_at": "2026-03-24T12:35:00.000Z",
  "finished_at": "2026-03-24T12:35:14.000Z",
  "artifacts_updated": [
    "06_review/review_report.yaml",
    "06_review/review_patch.json"
  ],
  "timeline_revision_before": "sha256:abcd1234ef567890",
  "timeline_revision_after": "sha256:abcd1234ef567890",
  "status_summary": {
    "currentState": "critique_ready",
    "staleArtifacts": []
  }
}
```

status enum:

- `queued`
- `running`
- `succeeded`
- `failed`
- `blocked`
- `obsolete`

#### 5-3-4. `GET /api/projects/:id/ai/progress`

用途:

- `progress.json` の polling

response:

```json
{
  "project_id": "demo",
  "phase": "review",
  "gate": 5,
  "status": "running",
  "completed": 3,
  "total": 5,
  "eta_sec": 8,
  "artifacts_created": [],
  "errors": [],
  "started_at": "2026-03-24T12:35:00.000Z",
  "updated_at": "2026-03-24T12:35:06.000Z"
}
```

polling 仕様:

- interval: `1000ms - 1500ms`
- running / queued の間だけ polling
- terminal state 受信後に停止し、`ai/context` と `timeline` を再取得

#### 5-3-5. `POST /api/projects/:id/ai/patches/preview`

用途:

- 高度な before/after 比較
- save せず patch 結果だけ確認する

request:

```json
{
  "source": "review_patch",
  "base_timeline_revision": "sha256:abcd1234ef567890",
  "operation_indexes": [0]
}
```

response:

```json
{
  "ok": true,
  "timeline_preview": {},
  "diff_summary": {
    "changed_clip_ids": ["CLP_0001"],
    "change_types": ["replace_segment"]
  },
  "rejected_operations": []
}
```

### 5-4. 実行ルール

#### review

- default は `require_compiled_timeline = true`
- human 編集済み timeline を compile preflight で潰さないため
- `ReviewAgent` concrete 実装は `review-agent-adapter.ts` で提供する

#### `ReviewAgent` adapter

`review-agent-adapter.ts` は runtime の `ReviewAgent` interface を満たす server-side adapter とする。

責務:

- `ReviewAgentContext` を受け取り review provider に委譲する
- `ReviewReport` と `ReviewPatch` を schema-valid な形で返す
- 任意コマンド実行口を持たない
- editor server の設定不足時は明示的に失敗させる

失敗時の扱い:

- adapter 未設定: `POST /ai/jobs` phase=`review` は `503 Service Unavailable`
- adapter 実行失敗: job status は `failed`

#### compile

- 現在の upstream artifact から timeline を再生成する
- 成功後は `GET /timeline` を再取得し `sessionBaseline` を新 revision に更新する

#### render

- `approved` または `packaged` 状態のみ許可
- render 中は save / patch / compile / review を禁止する

### 5-5. Phase 2b-3 完了条件

- GUI から `compile`, `review`, `render` を起動できる
- job 中に progress が見える
- job 完了後に関係 artifact が自動再読込される
- review だけ `ReviewAgent` adapter を経由して動く

---

## 6. フロントエンドコンポーネント一覧と責務

### 6-1. 既存コンポーネントの拡張

| ファイル | 責務 | 変更内容 |
|---|---|---|
| `editor/client/src/App.tsx` | レイアウト統括 | `CommandBar`, tabbed inspector, AI reload orchestration, disable rules を追加 |
| `editor/client/src/hooks/useTimeline.ts` | timeline state, save, undo/redo | `timelineRevision`, `sessionBaseline`, `commitRemoteMutation()`, revision-aware save を追加 |
| `editor/client/src/components/PropertyPanel.tsx` | 右インスペクタ | タブ shell に分離し、AI sections を統合 |
| `editor/client/src/components/ClipBlock.tsx` | clip 表示 | confidence badge, quality flags, review border, edit marker を追加 |
| `editor/client/src/components/TrackLane.tsx` | track row | overlay layer を追加 |
| `editor/client/src/components/Timeline.tsx` | timeline canvas | AI overlay, review markers, preview ghost を追加 |

### 6-2. 新規コンポーネント

| コンポーネント | Phase | 責務 |
|---|---|---|
| `PropertyPanelTabs.tsx` | 2b-1 | `Properties / AI Context / Alternatives / Diff / Review` の切替 |
| `AiContextPanel.tsx` | 2b-1 | clip の AI reasoning を表示 |
| `ReviewPanel.tsx` | 2b-1 | review report を表示 |
| `PatchPanel.tsx` | 2b-1 | patch 一覧と apply 導線 |
| `ReviewOverlay.tsx` | 2b-1 | review summary band |
| `TimelineAiOverlay.tsx` | 2b-1 | patch / review の timeline overlay |
| `AlternativesPanel.tsx` | 2b-2 | candidate browser と swap |
| `DiffPanel.tsx` | 2b-2 | baseline diff |
| `CommandBar.tsx` | 2b-3 | AI command controls |
| `RunStatus.tsx` | 2b-3 | job status / progress |
| `PatchPreviewPanel.tsx` | 2b-3 | before/after 比較 |

### 6-3. 新規 hooks

| hook | Phase | 責務 |
|---|---|---|
| `useAiArtifacts()` | 2b-1 | `ai/context`, report, patch, blueprint の取得 |
| `useSelects()` | 2b-2 | selects の取得と alternatives 算出 |
| `useDiff()` | 2b-2 | baseline diff 算出 |
| `useAiJobs()` | 2b-3 | jobs API 呼び出しと current job 管理 |
| `useProgressPolling()` | 2b-3 | progress polling と stop condition 管理 |

---

## 7. 技術的制約と対処方針

| 制約 | 影響 | 対処 |
|---|---|---|
| `progress.json` は project ごと単一ファイル | 同時複数 job を表現できない | per-project single-flight queue を採用する |
| `timeline.version` は concurrency token ではない | stale save を防げない | `timeline_revision` を導入する |
| `PUT /timeline` は現状 reconcile しない | stale review / approval が UI に反映されない | save 後に `reconcileAndPersist()` を必須にする |
| `runReview()` に concrete `ReviewAgent` がない | review job を直接起動できない | `review-agent-adapter.ts` を追加する |
| local undo/redo は server mutation を知らない | patch apply 後に history が壊れうる | `commitRemoteMutation()` で remote result を history に統合する |
| render 中に timeline が変わると成果物が stale | render 後の package artifact が信用できない | render 中は mutation を禁止し、job metadata に base revision を記録する |
| low confidence を opacity のみで表現すると見づらい | 編集操作性が落ちる | badge + hatch + top bar の複合表現にする |
| `.ai-baseline.json` を永続化すると concurrency token と責務が重複 | 設計が二重化する | baseline は client session 限定にする |

### 7-1. dirty state の扱い

`dirty = true` の時は以下を禁止する。

- review patch apply
- compile
- review
- render

UI は `Save first` を表示する。これにより local unsaved edits と remote mutation の自動 merge を避ける。

### 7-2. feature flag

AI workflow 全体は feature flag で無効化可能にする。

- flag off 時も既存 timeline editor は動作する
- additive API / UI として実装する

### 7-3. v2 以降の拡張余地

- SSE / `GET /ai/events`
- multi-job queue
- candidate inline video preview
- collaborative editing

---

## 8. 実装順序と依存関係

### 8-1. 実装順序

1. `timeline_revision` の導入
2. `PUT /timeline` の revision guard と reconcile
3. AI artifact read API (`ai/context`, report, patch, blueprint)
4. read-only frontend (`AI Context`, `Review`, overlay)
5. patch apply API と undo 統合
6. selects API と alternatives UI
7. diff UI
8. jobs API と progress polling
9. patch preview と高度比較

### 8-2. 依存関係

| 項目 | 依存 |
|---|---|
| `PatchPanel` | `ai/review-patch`, `timeline_revision`, `commitRemoteMutation()` |
| `AlternativesPanel` | `ai/selects`, thumbnail route, `PropertyPanelTabs` |
| `DiffPanel` | `sessionBaseline` を持つ `useTimeline()` |
| `CommandBar` | jobs API, progress polling, disable rules, save revision guard |
| `review` job | `review-agent-adapter.ts`, `runReview()` |
| `compile` / `render` jobs | lock service, jobs registry, progress polling |

### 8-3. Phase ごとの実装単位

#### Phase 2b-1

- backend
  - `timeline_revision`
  - `PUT /timeline` guard
  - `ai/context`
  - `ai/review-report`
  - `ai/review-patch`
  - `ai/blueprint`
  - `ai/patches/apply`
- frontend
  - tabbed inspector
  - review overlay
  - patch panel
  - patch apply + undo integration

#### Phase 2b-2

- backend
  - `ai/selects`
  - thumbnail route 拡張
- frontend
  - alternatives panel
  - swap flow
  - diff panel

#### Phase 2b-3

- backend
  - jobs registry
  - project lock service
  - `review-agent-adapter.ts`
  - `ai/jobs`
  - `ai/progress`
  - `ai/patches/preview`
- frontend
  - command bar
  - run status
  - polling
  - auto reload

---

## 9. 既存コードの活用箇所

### 9-1. そのまま再利用するもの

| 既存コード | 活用方法 |
|---|---|
| `runtime/commands/compile.ts#runCompilePhase()` | compile job の本体として直接呼ぶ |
| `runtime/commands/render.ts#runRender()` | render job の本体として直接呼ぶ |
| `runtime/commands/review/index.ts#runReview()` | review agent adapter を挟んで呼ぶ |
| `runtime/commands/review/index.ts#validatePatchSafety()` | review patch fetch 時と apply 時の両方で使う |
| `runtime/compiler/patch.ts#applyPatch()` | patch apply API と patch preview API で使う |
| `runtime/progress.ts#readProgress()` | progress polling API に使う |
| `runtime/progress.ts#ProgressTracker` | compile/review/render の進捗生成にそのまま使う |
| `runtime/commands/status.ts#runStatus()` | UI 向け status summary に使う |
| `runtime/commands/shared.ts#reconcileAndPersist()` | save / patch apply / job 完了後の state 更新に使う |
| `runtime/artifacts/loaders.ts#loadSelects()` | selects read API に使う |
| `runtime/artifacts/loaders.ts#loadBlueprint()` | blueprint read API に使う |
| `runtime/artifacts/loaders.ts#validateArtifact()` | review report / patch parse 後の schema validate に使う |
| `runtime/state/reconcile.ts#computeFileHash()` | `timeline_revision` 算出に使う |

### 9-2. 拡張する既存 editor コード

| 既存コード | 拡張内容 |
|---|---|
| `editor/server/index.ts` | AI routes mount と CORS headers (`If-Match`, `ETag`) 追加 |
| `editor/server/routes/timeline.ts` | revision guard, atomic save, reconcile を追加 |
| `editor/client/src/hooks/useTimeline.ts` | revision-aware save と remote mutation 統合 |
| `editor/client/src/components/PropertyPanel.tsx` | tab shell 化 |
| `editor/client/src/components/ClipBlock.tsx` | AI badge / markers |
| `editor/client/src/components/TrackLane.tsx` | overlay layer |
| `editor/client/src/App.tsx` | AI workflow 全体の orchestration |

### 9-3. 新規追加する server モジュール

| 新規ファイル | 責務 |
|---|---|
| `editor/server/routes/ai.ts` | AI artifact / patch / jobs API |
| `editor/server/services/artifacts.ts` | YAML/JSON parse, revision 付与, response shaping |
| `editor/server/services/timeline-revision.ts` | `timeline_revision` 取得・比較 |
| `editor/server/services/project-lock.ts` | per-project lock / queue |
| `editor/server/services/jobs.ts` | in-memory job registry と current job 管理 |
| `editor/server/services/review-agent-adapter.ts` | `ReviewAgent` concrete 実装 |

---

## 10. テスト戦略と受け入れ条件

### 10-1. Backend

- `GET /timeline` が `ETag` を返す
- `PUT /timeline`
  - 正常保存
  - stale revision で `409`
  - invalid timeline で `422`
  - lock 中に `423`
- `GET /ai/context` が schema-valid JSON を返す
- `POST /ai/patches/apply`
  - 正常適用
  - unsafe patch で `422`
  - stale revision で `409`
- `POST /ai/jobs`
  - `compile`, `review`, `render` を適切に dispatch
  - same project concurrent start で `423`
- `GET /ai/progress` が `progress.json` を返す

### 10-2. Frontend

- clip 選択で AI Context が出る
- review findings が clip に紐づいて表示される
- patch overlay が `op` ごとに正しい位置と色で出る
- dirty state では patch apply と AI rerun が disabled
- patch apply 後に undo で pre-apply state に戻れる
- alternatives ranking が規則通り
- diff panel が baseline と current の差を正しく表示する

### 10-3. E2E

1. `projects/demo` を開く
2. clip を選択する
3. AI Context と Review が見える
4. patch overlay と patch list が見える
5. `Apply` で timeline が更新される
6. `Undo` で local state が戻る
7. `Save` で revision guard 付き保存が通る
8. alternatives から swap できる
9. `Review` を起動すると progress が表示される
10. `Render` 中は他 mutation が禁止される

### 10-4. 運用確認

- server 再起動後に editor は `GET /timeline` から復帰できる
- job 実行中に server が落ちても、再起動後 `runStatus()` と `readProgress()` で状態確認できる
- feature flag off で AI workflow UI をまとめて無効化できる

---

## 11. リスクとロールバック

### 11-1. 主リスク

- `ReviewAgent` adapter の初期実装が不安定だと review job だけ遅れる
- revision guard を save に入れないと AI mutation を stale save が上書きする
- patch apply の undo 統合を誤ると local history が壊れる

### 11-2. 代替案

- review job だけ先に feature flag で hidden にする
- patch preview は 2b-3 に遅らせ、2b-1 は apply のみとする
- thumbnail が重ければ 2b-2 初期はテキストカードだけで出荷する

### 11-3. ロールバック

- AI routes を止めても Phase 2a editor は継続利用可能
- feature flag で AI panels / overlay / jobs を無効化できる
- save API は additive に拡張し、timeline 編集の既存導線は残す

---

## 12. 最終実装メモ

- v1 の進捗通知は polling で十分。SSE はこの設計に含めない
- concurrency token は `timeline_revision` のみを正とする
- `.ai-baseline.json` は作らない
- review だけは adapter が必要で、compile / render は runtime 既存関数を直接使う
- patch apply は server authoritative、undo は client history に統合する
