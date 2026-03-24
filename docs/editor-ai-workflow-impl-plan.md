# Video OS v2 エディタ AI-Human連携ワークフロー 実装計画

> Date: 2026-03-24
> Status: Draft
> Scope: 既存 Web エディタに AI artifact 可視化、patch 適用、AI 再実行トリガーを追加するための実装設計

---

## 0. 目的と成功条件

### 0-1. 目的

現状のエディタは `timeline.json` の表示、トリム、音量調整まではできるが、AI が生成した以下の判断が UI に出ていない。

- `selects_candidates.yaml` の代替候補
- `review_report.yaml` の評価結果
- `review_patch.json` の提案差分
- clip / patch ごとの `confidence`

このため、人間が「なぜこのカットなのか」「何を差し替えればよいのか」「AI をどこから再実行すべきか」を UI 上で判断できない。

### 0-2. 成功条件

以下を満たしたらこの設計の実装は成功とみなす。

1. 右インスペクタで、選択 clip に対する代替候補を `selects_candidates` から見られる。
2. タイムライン上で `review_patch` の対象 clip / 挿入位置 / 変更種別が視覚化される。
3. clip の `confidence` と patch の `confidence` が、色・透明度・バッジの組み合わせで読める。
4. `compile` / `review` / `render` を HTTP API から非同期起動できる。
5. 実行中 progress は UI から確認できる。v1 は `progress.json` ポーリングで成立し、SSE に拡張可能である。
6. manual save と AI patch/apply が競合したときに 409 で防げる。
7. AI 適用後に `project_state.yaml` が再 reconcile され、review/approval の stale 判定が反映される。

---

## 1. 現状整理

### 1-1. 既存エディタ

- `editor/server/index.ts`
  - 既存 API は `/api/projects`, `/timeline`, `/preview`, `/media`, `/thumbnail`
- `editor/server/routes/timeline.ts`
  - `GET /api/projects/:id/timeline`
  - `PUT /api/projects/:id/timeline`
  - schema validation はあるが、timeline revision guard はない
- `editor/client/src/hooks/useTimeline.ts`
  - undo/redo は client local の snapshot stack
  - save 時に server の revision を見ていない
- `editor/client/src/components/PropertyPanel.tsx`
  - clip metadata の表示先として最も自然な AI インスペクタ差し込み位置
- `editor/client/src/components/TrackLane.tsx` / `ClipBlock.tsx`
  - overlay layer を追加しやすい構造

### 1-2. 既存 runtime

- `runtime/commands/compile.ts`
  - `runCompilePhase()` を直接 import して使える
- `runtime/commands/review/index.ts`
  - `runReview()` を直接 import できる
  - ただし `ReviewAgent` の concrete 実装は repo 内にないので adapter が必要
  - `requireCompiledTimeline: true` で既存 `timeline.json` をレビューできる
- `runtime/commands/render.ts`
  - `runRender()` を直接 import して使える
- `runtime/compiler/patch.ts`
  - `applyPatch()` が pure function として使える
- `runtime/progress.ts`
  - `ProgressTracker` / `readProgress()` があり、`progress.json` は temp file + rename で原子的に更新される
- `runtime/state/reconcile.ts`
  - `project_state.yaml` の stale 判定、gate 再計算、history 追記が既にある

### 1-3. 実装上の重要な観察

1. `review_patch.timeline_version` は timeline file hash ではなく `timeline.version` を見ている。競合制御には使えない。
2. 現行 `PUT /timeline` は `project_state.yaml` を reconcile しない。保存後に review/approval stale が即反映されない。
3. `progress.json` は project ごと 1 ファイルで、同時に複数 job を走らせる設計ではない。
4. `runReview()` は preflight 内で compile を走らせる経路がある。human 編集済み timeline をレビューする場合は `requireCompiledTimeline: true` を使うべき。

---

## 2. スコープ境界

### 2-1. 今回やること

- additive な API 追加
- エディタ右インスペクタへの AI 情報追加
- タイムライン上の AI overlay 追加
- patch apply と AI rerun の非同期制御
- revision / lock / undo 整合の設計

### 2-2. 今回やらないこと

- multi-user 同時編集
- CRDT / OT ベースの自動 merge
- WebSocket 前提の双方向プロトコル
- candidate の動画プレビュー専用 API
- エージェント実装そのものの新規作成

v1 は単一ローカルユーザー前提で十分。高度な共同編集は別設計に分離する。

---

## 3. バックエンド API 追加案

## 3-1. 追加ファイル案

- `editor/server/routes/ai.ts`
- `editor/server/services/artifacts.ts`
- `editor/server/services/jobs.ts`
- `editor/server/services/timeline-revision.ts`
- `editor/server/services/project-lock.ts`
- `editor/server/services/review-agent-adapter.ts`

`index.ts` から `/api/projects` 配下に mount する。

## 3-2. artifact 取得 API

frontend は YAML を直接扱わず、server 側で parse + validate 後の JSON を受け取る。

| Endpoint | 目的 | 実装 |
|---|---|---|
| `GET /api/projects/:id/ai/context` | selects / review_report / review_patch / progress / status を一括取得 | `runtime/artifacts/loaders.ts`, `validateArtifact`, `runStatus`, `readProgress` |
| `GET /api/projects/:id/ai/selects` | `selects_candidates.yaml` 単体取得 | `loadSelects()` |
| `GET /api/projects/:id/ai/review-report` | `review_report.yaml` 単体取得 | YAML parse + `validateArtifact(..., "review-report.schema.json")` |
| `GET /api/projects/:id/ai/review-patch` | `review_patch.json` 単体取得 | JSON parse + `validateArtifact(..., "review-patch.schema.json")` |
| `GET /api/projects/:id/ai/progress` | 現在 progress を取得 | `readProgress()` + `runStatus()` |

推奨レスポンス形:

```json
{
  "project_id": "demo",
  "timeline_revision": "sha256:abcd1234",
  "artifacts": {
    "selects": { "exists": true, "revision": "sha256:...", "data": {} },
    "review_report": { "exists": true, "revision": "sha256:...", "data": {} },
    "review_patch": {
      "exists": true,
      "revision": "sha256:...",
      "data": {},
      "safety": {
        "safe": true,
        "rejectedOps": [],
        "filteredPatch": {}
      }
    }
  },
  "progress": {},
  "status": {}
}
```

補足:

- `review_patch` は fetch 時点で `validatePatchSafety()` をかけ、overlay 表示と apply 可否を同時に返す。
- `timeline_revision` は `timeline.json` の file hash。`timeline.version` とは別物として扱う。

## 3-3. patch 適用 API

### 推奨 endpoint

`POST /api/projects/:id/ai/patches/apply`

### request

```json
{
  "source": "review_patch",
  "base_timeline_revision": "sha256:abcd1234",
  "mode": "current_timeline",
  "allow_partial": false,
  "patch": null
}
```

`source`

- `review_patch`: `06_review/review_patch.json` を読む
- `inline`: client が編集した patch を送る

`mode`

- `current_timeline`: 現在の `timeline.json` に `applyPatch()` を直接かける
- `compile_rebase`: `runCompilePhase({ reviewPatch })` で canonical artifacts から再 compile して patch 適用

### v1 の推奨挙動

- editor 上の human 手修正を守るため、既定値は `current_timeline`
- upstream artifact が変わって review patch が stale のときのみ `compile_rebase` を明示選択

### server 処理

1. project lock を取得
2. current `timeline_revision` を算出し、`base_timeline_revision` と比較
3. patch を load / validate
4. `validatePatchSafety()` を再実行
5. `applyPatch()` で新 timeline を生成
6. schema validate
7. temp file + rename で `05_timeline/timeline.json` を atomic save
8. `reconcileAndPersist(projectDir, "editor-ai", "/apply-patch")` を呼ぶ
9. updated timeline, new revision, rejected ops を返す

### response

```json
{
  "ok": true,
  "mode": "current_timeline",
  "timeline_revision_before": "sha256:old",
  "timeline_revision_after": "sha256:new",
  "applied_ops": 3,
  "rejected_ops": [],
  "timeline": {},
  "status": {}
}
```

### 失敗系

- `409 Conflict`
  - `base_timeline_revision` 不一致
- `422 Unprocessable Entity`
  - patch schema invalid
  - patch safety invalid
- `423 Locked`
  - 他の AI job または save が走っている

## 3-4. AI 再実行 trigger API

### 推奨 endpoint

`POST /api/projects/:id/ai/jobs`

### request

```json
{
  "phase": "compile",
  "options": {
    "apply_review_patch": false,
    "require_compiled_timeline": true,
    "skip_preview": false
  }
}
```

### response

`202 Accepted`

```json
{
  "job_id": "job_20260324_001",
  "phase": "compile",
  "status": "queued",
  "progress_url": "/api/projects/demo/ai/progress",
  "job_url": "/api/projects/demo/ai/jobs/job_20260324_001",
  "events_url": "/api/projects/demo/ai/events"
}
```

### 実装方針

| phase | 呼び先 | 注意点 |
|---|---|---|
| `compile` | `runCompilePhase()` | 直接再利用可 |
| `review` | `runReview()` | `ReviewAgent` adapter が必要。editor workflow では `requireCompiledTimeline: true` を既定値にする |
| `render` | `runRender()` | 直接再利用可 |

### job status API

- `GET /api/projects/:id/ai/jobs/:jobId`
- `GET /api/projects/:id/ai/jobs/current`

server 内では in-memory registry で十分。ただし `progress.json` が単一ファイルなので、同一 project で同時実行は禁止する。

## 3-5. 進捗通知 API

### v1

- `GET /api/projects/:id/ai/progress`
- client が 1000ms-1500ms 間隔で poll

### v1.1

- `GET /api/projects/:id/ai/events`
- SSE で `progress`, `job_status`, `artifacts_updated` を push

## 3-6. 非機能要件

### 信頼性

- timeline 保存系は全て temp file + rename を使う
- AI mutation 系 endpoint は 30s 以上の HTTP keep-open を避け、必ず `202 Accepted` で返す
- job 実行結果は success / failed / blocked を UI に区別して返す

### 性能

- `ai/context` は 1 リクエストで inspector 表示に必要な情報を返し、初回表示の余分な往復を減らす
- polling は job 実行中のみ有効化する
- `review_report` / `selects_candidates` は revision が変わらない限り client cache を許可する

### セキュリティ

- `phase` は `compile | review | render` の enum whitelist のみ許可
- file path は project root 配下に固定し、request body から相対パスを受け取らない
- `inline` patch でも server 側で schema validate と safety validate を必須にする
- `review-agent-adapter` は任意コマンド実行口にしない

### 判断

- WebSocket は不要
- SSE で十分
- ただし既存 `progress.json` があるので、最初の出荷は polling で成立する

理由:

1. 通信は server -> client 一方向がほぼ全て
2. `progress.json` は既に原子的に更新されている
3. 双方向常時接続を要求する要件がない

---

## 4. フロントエンド実装案

## 4-1. state 追加

追加 hook 案:

- `useAiArtifacts(projectId)`
- `useAiJobs(projectId)`
- `useTimelineRevision(projectId)`

追加 type 案:

- `SelectCandidate`
- `ReviewReport`
- `ReviewPatch`
- `PatchOperation`
- `ProgressReport`
- `TimelineRevision`

`useTimeline()` に `timelineRevision` を持たせ、save / patch apply / AI rerun 前後で更新する。

## 4-2. clip 選択時の代替候補パネル

### 配置

既存 `PropertyPanel` 内に AI セクションを追加するのが最小コスト。

推奨構成:

1. `Clip Info`
2. `Audio`
3. `AI Reasoning`
4. `Alternatives`
5. `Review Findings`

### 候補の作り方

client 側で `selects_candidates` から計算できる。

優先順:

1. 現在 clip の元候補
   - `candidate_ref`
   - fallback で `segment_id`
2. `fallback_candidate_refs`
3. `fallback_segment_ids`
4. 同じ `beat_id` に入れられる候補
   - `eligible_beats` に `clip.beat_id` を含む
   - role が互換
5. semantic rank / confidence 順の予備候補

カードに出す情報:

- `why_it_matches`
- `risks`
- `confidence`
- `transcript_excerpt`
- `quality_flags`
- `evidence`

### v1 の UI

- テキスト中心の候補カード
- `Replace` ボタンで patch apply API に `inline` patch を投げる
- thumbnail / candidate preview は将来追加

これで追加 API を最小化できる。

## 4-3. review patch のタイムライン表示

### 方針

既存 `ClipBlock` を直接複雑化せず、`TrackLane` の上に AI overlay layer を重ねる。

追加 component 案:

- `TimelineAiOverlay.tsx`
- `PatchOverlayBlock.tsx`
- `PatchMarkerChip.tsx`

### 表現ルール

| op | 表現 |
|---|---|
| `replace_segment` | clip 全体のマゼンタ outline |
| `trim_segment` | clip 左右端のアンバー handle overlay |
| `move_segment` | 現位置 outline + 移動先にシアン ghost block |
| `insert_segment` | 指定 frame に紫の insertion caret |
| `remove_segment` | 赤の strike-through |
| `change_audio_policy` | audio clip 下辺の青 strip |
| `add_marker` / `add_note` | ruler / marker 行に chip 表示 |

### interaction

- overlay 本体は `pointer-events: none`
- badge / chip だけ `pointer-events: auto`
- click で対象 clip 選択 + inspector を該当 patch にスクロール

この構成なら既存 trim 操作を壊しにくい。

## 4-4. confidence の表現

confidence は opacity だけに依存しない。低 confidence で clip を見えなくすると編集操作性が落ちるため。

推奨ルール:

| confidence | base clip | 補助表現 |
|---|---|---|
| `>= 0.85` | 現状に近い不透明度 | 細い緑 badge |
| `0.65 - 0.84` | やや淡くする | 黄 badge |
| `< 0.65` | 透明度を落とすが 0.68 未満にはしない | 赤 badge + diagonal hatch |

実装:

- `ClipBlock` の `opacity` に clip confidence を反映
- 上辺 3px の confidence bar を追加
- inspector では数値 `%` を保持

patch confidence は clip confidence と別概念なので、overlay 側の alpha にのみ反映する。

## 4-5. review findings の見せ方

`review_report` の以下を inspector に出す。

- `summary_judgment`
- `fatal_issues`
- `warnings`
- 選択 clip に紐づく `affected_clip_ids`
- `recommended_next_pass.actions`

clip 選択中は `affected_clip_ids` ベースでフィルタした findings を優先表示する。
clip 非選択時は全体サマリを出す。

---

## 5. 技術的制約と対策

## 5-1. 非同期実行と通知

### 結論

- v1: `progress.json` polling で十分
- v1.1: SSE を追加
- WebSocket は不要

### 理由

- 現在の runtime は `ProgressTracker` を既に全 phase で使っている
- `progress.json` の atomic update により partial read が起きにくい
- event 種別は少なく、client -> server push は POST で足りる

### 制約

`progress.json` は project 単位で単一のため、同一 project で複数 AI job を走らせると上書きされる。

### 対策

- `jobs.ts` で per-project single-flight queue を持つ
- queue 中は `423 Locked` を返す

## 5-2. lock 機構

### 必要性

必要。理由は 3 つある。

1. save API に revision guard がない
2. AI patch apply は `timeline.json` を書き換える
3. `runReview()` と `runCompilePhase()` は timeline を更新しうる

### 推奨仕様

- hard lock: AI mutation 実行中
- soft lock: inspector 上の read-only notice

lock 対象:

- manual `PUT /timeline`
- `POST /ai/patches/apply`
- `POST /ai/jobs` with `compile`
- `POST /ai/jobs` with `review`
- `POST /ai/jobs` with `render`

### 実装

- lock file でも in-memory でもよいが、v1 は in-memory で十分
- 真の競合防止は lock ではなく `base_timeline_revision` でやる

つまり lock は UX、revision check は整合性保証の役割を持つ。

## 5-3. undo/redo と patch 適用の整合性

### 現状

- undo/redo は client local のみ
- server 側 timeline 変更と自動 merge しない

### v1 の方針

- dirty 状態では AI patch apply / AI rerun を禁止
- 実行前に `Save first` を要求する
- 成功後は server 返却 timeline を `present` として採用し、直前 local state を `past` に push

これで local history は壊れない。

### やらないこと

- dirty local timeline と server-side AI patch の自動 merge
- local unsaved edits を patch に変換して再適用

## 5-4. timeline version と revision の分離

`review_patch.timeline_version` は file hash ではないため、以下を分ける必要がある。

- semantic version: `timeline.version`
- concurrency token: `timeline_revision`

API では常に `timeline_revision` を採用する。

## 5-5. review 実行時の source of truth

editor で human が trim / volume を触った後に AI review したいケースでは、`runReview(..., { requireCompiledTimeline: true })` を既定値にする。

これにより:

- current `timeline.json` をそのまま critique できる
- review preflight の compile で human 編集を潰さずに済む

canonical artifacts から再構築してレビューしたい場合だけ明示的に `requireCompiledTimeline: false` を使う。

## 5-6. render 中の timeline 変更

`render` は timeline を直接書き換えないが、途中で timeline が変わると package artifact が即 stale になる。

v1 の方針:

- render 実行中は timeline save / patch apply / compile / review を禁止
- render 開始時の `timeline_revision` を job metadata に保持
- 完了時に revision が変わっていたら成功扱いにせず `obsolete` 相当の failed UI を返してもよい

最小実装では lock のみでもよいが、job metadata に base revision を残しておくと後で判定を強化しやすい。

---

## 6. 既存コードの活用方針

## 6-1. そのまま再利用できるもの

| 既存コード | 再利用方法 |
|---|---|
| `runCompilePhase()` | compile job API から直接呼ぶ |
| `runRender()` | render job API から直接呼ぶ |
| `runReview()` | review agent adapter を挟んで呼ぶ |
| `applyPatch()` | patch apply API で直接使う |
| `validatePatchSafety()` | review_patch fetch / apply 前 validation に使う |
| `readProgress()` | progress polling API に使う |
| `runStatus()` | UI 用 status summary に使う |
| `reconcileAndPersist()` | patch apply / manual save 後の state 更新に使う |
| `validateArtifact()` / `loadSelects()` | artifact read API に使う |

## 6-2. そのままでは使えないもの

| 対象 | 理由 | 対応 |
|---|---|---|
| `runReview()` の agent 部分 | concrete `ReviewAgent` が repo にない | `review-agent-adapter.ts` を追加 |
| 現行 `PUT /timeline` | revision guard がない | `base_timeline_revision` or `If-Match` を追加 |
| `progress.json` | 同時 job 非対応 | per-project single-flight を追加 |

## 6-3. `progress.json` を polling に使えるか

使える。v1 の第一選択でよい。

ただし制限は明確にある。

- coarse progress しか出ない
- 同一 project の複数 job を表現できない
- step message の粒度は phase 実装依存

この制約下でも、compile/review/render のジョブバー表示には十分。

---

## 7. 実装タスク分解

### Phase 1: API read path

- `ai/context`, `ai/selects`, `ai/review-report`, `ai/review-patch`, `ai/progress` を追加
- `timeline_revision` を返す
- `review_patch` に safety 情報を付ける

完了条件:

- sample project で 3 artifact と progress/status が JSON で読める

### Phase 2: Frontend read-only AI UI

- `useAiArtifacts()` 追加
- inspector に `AI Reasoning`, `Alternatives`, `Review Findings` を追加
- timeline overlay を read-only で表示

完了条件:

- clip 選択で alternatives が出る
- review patch が timeline 上に色分け表示される

### Phase 3: Patch apply

- `POST /ai/patches/apply` 追加
- revision guard
- save 後 reconcile

完了条件:

- patch apply 後に `timeline.json` と UI が同時更新される
- stale revision では 409 になる

### Phase 4: AI rerun jobs

- `POST /ai/jobs`
- `GET /ai/jobs/:jobId`
- per-project queue
- progress polling

完了条件:

- compile/review/render が 202 で起動し、UI で進捗が見える

### Phase 5: save と state の整合性

- `PUT /timeline` に revision guard を追加
- manual save 後 `reconcileAndPersist()` 実行
- dirty state 時の AI 操作禁止

完了条件:

- manual save 後に review stale が UI に反映される
- stale client save が AI 出力を上書きしない

---

## 8. テスト戦略と受け入れ条件

## 8-1. backend

- artifact endpoint が schema-valid JSON を返す
- patch apply が
  - 正常適用
  - stale revision 409
  - unsafe patch 422
  - lock 中 423
  を返す
- job API が
  - 202 を返す
  - progress polling で status 更新される

## 8-2. frontend

- clip 選択で candidate ranking が正しい
- overlay が `op` ごとに正しい色と位置に出る
- dirty 状態では AI apply / rerun ボタンが disabled
- apply 後に history stack が破綻しない

## 8-3. E2E 受け入れ

1. `projects/demo` を開く
2. clip を選ぶ
3. alternatives が見える
4. review patch overlay が見える
5. patch apply で timeline が更新される
6. review rerun で progress が見える
7. render を起動すると AI job lock が効く

## 8-4. 運用確認

- server 再起動後も editor は既存 timeline 編集機能で復帰できる
- AI job 中に server が落ちても、次回 `runStatus()` と `readProgress()` で project を再同期できる
- feature flag を切れば AI overlay / AI jobs だけ無効化できる

---

## 9. リスク・代替案・ロールバック

### 9-1. 主なリスク

- `runReview()` の concrete agent 不在
- revision guard を `PUT /timeline` に入れないと AI 変更を stale save が上書きする
- low confidence を opacity のみで表現すると可読性が落ちる

### 9-2. 代替案

- review job だけ外部 orchestrator に委譲
- overlay を clip 自体ではなく専用 annotation lane に分離
- SSE が不安定なら polling のまま固定

### 9-3. ロールバック

- AI 関連 UI を feature flag で囲う
- API は additive に保ち、既存 timeline edit UX を壊さない
- job API を止めても editor の現行 MVP 機能は維持される

---

## 10. 結論

最小実装としては、以下の順が最も堅い。

1. artifact read API + `timeline_revision`
2. inspector の alternatives / review summary
3. timeline AI overlay
4. patch apply API
5. AI rerun job API + `progress.json` polling

この順にすると、まず「AI が何を考えているか」を可視化し、その後に「AI の提案を適用する」、最後に「AI を再実行する」を安全に積める。現行コードベースでは `compile`, `render`, `applyPatch`, `progress`, `reconcile` は十分再利用可能で、最大の追加設計点は `timeline_revision` と `ReviewAgent` adapter の 2 点である。
