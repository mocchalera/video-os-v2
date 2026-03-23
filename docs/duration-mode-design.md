# Duration Mode Design

## Document Control

- Status: Draft for implementation
- Target file: `docs/duration-mode-design.md`
- Scope: `creative_brief -> /triage -> /blueprint -> compiler -> post-render QA`
- Motivation: 尺を「厳守対象」と「目安」に分離し、素材不足時に quality-first 編集を許容する

## Problem Statement

現行 V2 は `creative_brief.project.runtime_target_sec` と `edit_blueprint.beats[].target_duration_frames` を中心に尺を扱っており、compiler は実質的に「target に収める」前提で動いている。

そのため、以下のケースで挙動が不自然になる。

- CM / 広告 / SNS のように尺を守るべき案件
  - 最終尺を hard gate にしたい
- 成長記録 / keepsake / recaps のように素材品質優先の案件
  - target を満たすために無理な引き延ばしや低品質クリップ採用をしたくない

麓太朗自転車 v3 テストでは、90 秒 target に対して候補素材が約 58 秒しかなく、compiler が target 側に寄りすぎた。この問題は単なる tolerance 調整ではなく、「尺の意味」を mode として contract 化しないと再発する。

## Goals

1. `creative_brief` で尺の扱いを `strict | guide` として明示できる
2. mode が未指定でも、profile 互換マッピングで自然な default が決まる
3. `strict` は target を守るための hard behavior と hard gate を持つ
4. `guide` は target を advisory に落とし、素材品質と peak 活用を優先する
5. `/triage`, `/blueprint`, compiler, post-render QA が同じ duration policy を共有する
6. 既存 brief との後方互換を壊さない

## Non-Goals

- beat decomposition の全面刷新
- profile / policy resolver 全体の再設計
- 新しい editorial profile 群の追加
- render pipeline 自体の redesign

## Current-State Findings

現行コードの duration 依存点は以下。

- `schemas/creative-brief.schema.json`
  - 尺は `project.runtime_target_sec` のみ。mode がない
- `runtime/script/frame.ts`
  - profile defaults から `target_duration_window` を作るが mode-aware ではない
- `runtime/script/evaluate.ts`
  - `duration_pacing` を計算するが gate 判定に使っていない
  - 24fps 固定で計算しており、厳密 gate には弱い
- `runtime/compiler/score.ts`
  - duration fit が常に強い scoring 要素
- `runtime/compiler/assemble.ts`
  - `currentFrame += beat.target_duration_frames` で beat grid を固定しており、guide 用の timeline compaction がない
- `runtime/compiler/resolve.ts`
  - `maxFrame <= totalTargetFrames` の単純判定のみ
- `runtime/compiler/patch.ts`
  - patch 後も bare `targetDurationFrames` だけで再検証している
- `runtime/packaging/qa.ts`
  - post-render QA に duration check が存在しない

旧 repo 側には以下の前例がある。

- `build-edit-plan` skill: 総尺 `±10%` ルール
- `video-edit-agent/CLAUDE.md`: script engine では `target_duration_sec` を advisory として扱う

今回の `guide` は、この advisory 思想を V2 contract に昇格する変更として扱う。

## Key Decision

V2 現行 contract には `target_duration` object が存在しないため、breaking change を避ける。

- 維持する field: `creative_brief.project.runtime_target_sec`
- 追加する field: `creative_brief.project.duration_mode`
- compiler が実際に読む canonical resolved contract:
  - `edit_blueprint.duration_policy`

`duration_mode` を schema の `default: "guide"` だけで済ませてはいけない。AJV validation は default 値を YAML に書き戻さないため、runtime 側で `effective_duration_mode` を必ず resolve する。

## Proposed Contracts

### 1. Creative Brief Schema

`schemas/creative-brief.schema.json` の `project` に additive field を追加する。

```yaml
project:
  runtime_target_sec: 90
  duration_mode: guide
```

Schema:

- field: `project.duration_mode`
- type: `string`
- enum: `["strict", "guide"]`
- default: `"guide"`

Meaning:

- `strict`
  - target `±1s` を厳守する
  - 不足時は埋める方向に compiler が努力する
  - 最終 QA は hard gate
- `guide`
  - target は目安
  - 素材品質・story・peak 活用を優先する
  - explicit target がある場合は `±30%` の drift を advisory window として扱う
  - target absent の場合は material-derived target を report 用 proxy として持つが gate には使わない
  - 最終 QA は info only

Validation rule:

- `duration_mode = strict` かつ `runtime_target_sec` が absent / `<= 0` の場合は invalid
  - explicit に `strict` を指定している場合は validation error として reject する
- `guide` は `runtime_target_sec` absent でも許容する
- resolver は profile default から `runtime_target_sec` を補完してはいけない
  - profile default が `strict` を返しても target が absent なら `guide` へ降格する

### 2. Resolved Duration Policy in Blueprint

`edit_blueprint.yaml` に canonical snapshot を追加する。

```yaml
duration_policy:
  mode: guide
  source: explicit_brief
  target_source: explicit_brief
  target_duration_sec: 90
  min_duration_sec: 63
  max_duration_sec: 117
  hard_gate: false
  protect_vlm_peaks: true
```

Schema file update is required:

- `schemas/edit-blueprint.schema.json` は root object が `additionalProperties: false` の closed schema
- そのため `duration_policy` は設計記述だけでは不十分で、root `properties` に追加し、`$defs.durationPolicy` を新設して closed object として定義する必要がある
- `/blueprint` は新規 artifact では常に `duration_policy` を emit する
- migration 中の legacy blueprint は field absent を許容してもよいが、compiler canonical input としては backfill 後に `edit_blueprint.duration_policy` を正とする

Proposed shape:

- `mode: strict | guide`
- `source: explicit_brief | profile_default | global_default`
- `target_source: explicit_brief | material_total`
- `target_duration_sec: number`
- `min_duration_sec: number`
- `max_duration_sec: number | null`
- `hard_gate: boolean`
- `protect_vlm_peaks: boolean`

Rules:

- `strict`
  - `target_source = explicit_brief`
  - `min_duration_sec = target - 1`
  - `max_duration_sec = target + 1`
  - `hard_gate = true`
  - `protect_vlm_peaks = false`
- `guide`
  - `target_source = explicit_brief`
  - `min_duration_sec = target * 0.7`
  - `max_duration_sec = target * 1.3`
  - `hard_gate = false`
  - `protect_vlm_peaks = true`
- `target_duration_sec` が未指定で `guide`
  - `target_source = material_total`
  - `target_duration_sec = selection_audit.total_unique_candidate_duration_sec`
  - `min_duration_sec = 0`
  - `max_duration_sec = null`
  - これは gate 用 target ではなく、planning / reporting 用の advisory proxy target として扱う
- `duration_policy` 自体は `schemas/edit-blueprint.schema.json` に optional additive field として追加する
  - ただし `/blueprint` の正常系出力では必須 emit とする

Runtime rule:

- `max_duration_sec = null` は unbounded upper limit を意味する
- JSON/YAML に `Infinity` は書かない
- `/blueprint` の正常系出力では `target_duration_sec` を `null` にしない
  - `guide + runtime_target_sec absent` は material-derived target を必ず backfill する

Reason for blueprint snapshot:

- `confirmed_preferences` は human/autonomous confirm 用であり、profile default を混ぜない
- `/triage`, compiler, patch re-run, QA が同じ policy snapshot を参照できる

### 3. Timeline / QA Snapshot

`schemas/timeline-ir.schema.json` の `provenance` に additive field を追加する。

```yaml
provenance:
  duration_policy:
    mode: guide
    source: explicit_brief
    target_source: explicit_brief
    target_duration_sec: 90
    min_duration_sec: 63
    max_duration_sec: 117
```

これは downstream QA / handoff が `timeline.json` 単体でも duration intent を読めるようにするため。`timeline_duration_frames` から actual は再計算できるため、actual snapshot は不要。

`runtime/packaging/qa.ts` の `QaReport.metrics` には以下を追加する。

- `duration_mode`
- `target_source`
- `target_duration_sec`
- `actual_duration_sec`
- `duration_delta_sec`
- `duration_delta_pct`

## Duration Mode Resolution

### Precedence

1. `creative_brief.project.duration_mode`
2. profile-compatible default
3. global default `guide`

### Guarded Resolution Rules

- explicit `duration_mode: strict` + `runtime_target_sec` absent / `<= 0`
  - reject する
- explicit `duration_mode: guide`
  - `runtime_target_sec` があれば explicit target を使う
  - absent なら material-derived target を使う
- profile default が `strict`
  - `runtime_target_sec` があれば `strict` を採用する
  - absent なら strict を採用せず、次順位の global default `guide` へ降格する
- profile default / global default が `guide`
  - `runtime_target_sec` があれば advisory target として使う
  - absent なら material-derived target を使う

Resolver invariant:

- mode default と target default は独立に解決する
- profile default は mode だけを決め、target 自体は補完しない
- strict へ入る経路は必ず explicit target を伴う

### Requested Profile Defaults

| User-facing profile semantic | Default mode |
| --- | --- |
| `keepsake` | `guide` |
| `testimonial` | `guide` |
| `commercial` | `strict` |
| `social` | `strict` |
| `event-recap` | `guide` |
| `tutorial` | `guide` |

### Compatibility Mapping to Current V2 Editorial Profiles

現行 V2 には上の 6 profile 値がそのまま存在しないため、resolver は既存 `resolved_profile.id` から近い semantic に落とす。

| Current V2 resolved profile | Semantic bucket | Default mode |
| --- | --- | --- |
| `interview-highlight` | `testimonial` | `guide` |
| `interview-pro-highlight` | `testimonial` | `guide` |
| `lp-testimonial` | `commercial` | `strict` |
| `vertical-short` | `social` | `strict` |
| `event-recap` | `event-recap` | `guide` |
| `product-demo` | `tutorial` | `guide` |
| `lecture-highlight` | `tutorial` | `guide` |

Notes:

- `keepsake` は現行 V2 に dedicated resolved profile がない
- ただし global default が `guide` なので、profile signal がなくても keepsake 系は自然に柔軟モードへ落ちる
- `lp-testimonial` は名前に testimonial を含むが、LP embed の commercial intent を優先して `strict` に寄せる
- ただし `lp-testimonial` / `vertical-short` でも `runtime_target_sec` が absent なら strict には入れず、warning を出して `guide` へ降格する

Implementation point:

- `runtime/editorial/policy-resolver.ts` で profile 解決後に `resolveDurationMode()` を追加する
- `runtime/script/frame.ts` は `target_duration_window` を profile default ではなく `duration_policy.min/max` から作る

## Assumptions and Dependencies

- compile, patch re-run, package QA は project workspace にアクセスでき、`edit_blueprint.yaml` または `timeline.json` の `duration_policy` snapshot を読める
- final package の actual duration は probe で deterministic に取得できる
- strict 案件では、target 未達のまま通すより hard fail の方が望ましい
- `lp-testimonial` を commercial bucket とみなすことは、現行 repo の LP embed intent を優先した互換ルールである

If any of these assumptions changes, `resolveDurationMode()` の mapping と QA gate 条件を再評価する。

## Runtime Behavior Changes

### /intent

Files:

- `runtime/commands/intent.ts`
- `schemas/creative-brief.schema.json`

Changes:

- `CreativeBrief.project.duration_mode?: "strict" | "guide"` を type に追加
- normalization は mode を上書きしない
- brief 未指定時の default 補完は `/intent` ではなく resolver 側に寄せる

Reason:

- schema validation と runtime defaulting を分離し、既存 fixture を壊さないため

### /blueprint

Files:

- `runtime/commands/blueprint.ts`
- `runtime/script/frame.ts`
- `runtime/script/evaluate.ts`
- `runtime/compiler/types.ts`

Changes:

1. brief + resolved profile + material coverage から `duration_policy` を決定し `edit_blueprint.yaml` に書く
2. `beat_strategy.target_duration_window` を mode-aware にする
3. `duration_pacing` metric を mode-aware にする

Behavior:

- `strict`
  - `duration_pacing` は gate metric
  - planning 時点で `target ±1s` を超える案は reject
- `guide`
  - `duration_pacing` は advisory metric
  - drift は warning に残すが `gate_pass` には使わない
  - `runtime_target_sec` absent の場合は `selection_audit.total_unique_candidate_duration_sec` から advisory proxy target を作り、beat 用 `target_duration_frames` もそこから算出する

Additional correction:

- `runtime/script/evaluate.ts` の 24fps 固定をやめ、effective fps を入力として受ける

### /triage

Files:

- `runtime/commands/triage.ts`
- `schemas/selects-candidates.schema.json`

Changes:

1. agent context に resolved duration mode を渡す
2. post-triage で duration coverage audit を追加する
3. `selects_candidates.yaml` に additive `selection_audit` を追加する
4. `segments.json.peak_analysis` から guide peak 保護に必要な signal を `selects_candidates.yaml` へ materialize する

Proposed shape:

```yaml
selection_audit:
  duration_mode: strict
  target_source: explicit_brief
  target_duration_sec: 30
  total_unique_candidate_duration_sec: 18.4
  coverage_ratio: 0.61
  status: warn
  note: candidate pool below strict target; fetch more coverage
```

`status` enum:

- `ok`
- `info`
- `warn`

Schema additions required in `schemas/selects-candidates.schema.json`:

- root `selection_audit`
- `selection_audit.target_source`
- `candidates[].editorial_signals.peak_strength_score`
- `candidates[].editorial_signals.peak_type`
- `candidates[].trim_hint.peak_ref`
- `candidates[].trim_hint.peak_type`

Behavior:

- `strict`
  - target に対して尺フィルタを厳しめに保つ
  - `total_unique_candidate_duration_sec < target_duration_sec` なら warning
  - `selection_notes` に追加候補提案を残す
- `guide`
  - 尺フィルタは relaxed
  - target 未達でも blocker にしない
  - peak / high-confidence / high-authenticity 候補を残す
  - `runtime_target_sec` absent の場合は `selection_audit.target_source = material_total`, `target_duration_sec = total_unique_candidate_duration_sec`, `coverage_ratio = 1.0`, `status = info`

Peak materialization precondition:

- post-triage materializer は `segments.json.peak_analysis` から surviving candidate ごとに peak signal を写像してから schema validate/promote する
- `guide` の peak protection が参照してよい minimum field は `editorial_signals.peak_strength_score` と `trim_hint.peak_ref`
- source mapping は candidate の `segment_id` と source range を primary key にし、同一範囲に対応する peak moment があれば materialize する
- peak signal が存在しない、または source range への対応が曖昧な場合は field を省略し、その candidate は non-peak-protected として通常 scoring に落とす
- compiler score phase は raw `segments.json` を直接読まず、materialize 済み `selects_candidates.yaml` だけを参照する

Why post-triage audit is needed:

- triage agent prompt だけでは deterministic に coverage 不足を記録できない
- `strict` だけ warning を harden し、`guide` は proceed させるため

## Compiler Design

### Phase 1: Normalize

Files:

- `runtime/compiler/types.ts`
- `runtime/compiler/normalize.ts`

Add:

- `DurationMode = "strict" | "guide"`
- `DurationPolicy`
- `NormalizedData.duration_policy`

Rule:

- compiler は `blueprint.duration_policy` を canonical input とする
- `creative_brief` を直接読んで mode 分岐しない

### Phase 2: Score

Files:

- `runtime/compiler/score.ts`

Behavior change:

- `strict`
  - 現行の duration fit weight を維持
  - target mismatch は明確に減点
- `guide`
  - duration fit は soft bonus に落とす
  - semantic rank / quality / peak salience を優先する
  - `editorial_signals.peak_strength_score >= 0.55` または `trim_hint.peak_ref` がある候補は、duration mismatch だけで実質脱落させない

Deterministic rule:

- `guide` では duration mismatch penalty の下限を設ける
- peak-protected candidate には `duration_fit_score` floor を適用する

Peak protection predicate:

- candidate is peak-protected iff `selects_candidates.yaml` 上で `editorial_signals.peak_strength_score >= 0.55` または `trim_hint.peak_ref` が存在する
- 両方 absent の場合は no-signal fallback として通常の `guide` scoring を適用する
- score phase で raw `segments.json.peak_analysis` を直接参照して補完しない

This satisfies:

- `target_duration_frames is scoring hint`
- `VLM peak のあるクリップは品質理由でドロップしない`

### Phase 3: Assemble

Files:

- `runtime/compiler/assemble.ts`
- `runtime/compiler/trim.ts`

This is the most important behavior split.

#### Strict mode

- beat grid は現行どおり `beat.target_duration_frames` ベース
- `currentFrame += beat.target_duration_frames`
- 不足分は後段の duration adjustment で埋める

#### Guide mode

- beat target は placement grid ではなく editorial hint として扱う
- 各 beat の timeline advance は `actualBeatDurationFrames` で決める
- `actualBeatDurationFrames` は、その beat に採用された primary clips の実 duration の最大値で決める
- これにより、素材が短いときに timeline を compaction し、空白尺を作らない

Reason:

現行 `assemble.ts` は beat target 分だけ `currentFrame` を進めるため、guide を scoring だけで緩めても timeline 上の dead air / artificial tail が残る。guide を本当に quality-first にするには、timeline placement 自体を advisory 化する必要がある。

Frame placement invariant:

- `strict` は `assemble.ts` の `currentFrame` prefix sum を beat window の canonical start として固定する
- `guide` は `actualBeatDurationFrames` を使って downstream beat の `timeline_in_frame` を再計算してよい
- `resolve.ts` の actual duration は現状どおり video tracks (`V1`, `V2`) の `max(end_frame)` を正とするため、strict underfill 回復もこの definition に合わせる

### Phase 3.5: Duration Adjustment

New deterministic step after assemble/trim and before resolve.

Suggested module:

- `runtime/compiler/duration-adjust.ts`

#### Strict mode

If `actual < min_duration`:

1. `beatStartFrame = marker.frame`, `beatEndFrame = beatStartFrame + beat.target_duration_frames` で strict beat window を固定する
2. 各 beat window ごとに `coveredEndFrame = max(end_frame of V1/V2 clips with same beat_id, beatStartFrame)` を計算する
3. `gapFrames = beatEndFrame - coveredEndFrame` がある場合、まずその beat 内の last-ending non-dialogue video clip を in-place で延長する
   - `extendFrames = min(gapFrames, sourceExtendableFrames, beatEndFrame - clipEndFrame)`
   - clip の `timeline_in_frame` は変えず `timeline_duration_frames += extendFrames` のみ許可する
4. gap が残る場合、同 beat の unused fallback `support | texture | transition` candidate を `timeline_in_frame = coveredEndFrame` に挿入する
   - inserted duration は `min(gapFrames, sourceDurationFrames, beatEndFrame - coveredEndFrame)` とする
   - 挿入後は `coveredEndFrame += insertedDurationFrames`
5. 同 beat で埋まらない場合のみ、隣接 beat から repeat-safe clip を借りて `V2` tail に配置する
   - repeat-safe は non-dialogue かつ peak-protected ではない clip に限定する
6. どの段でも next beat の `marker.frame` と既存 clip の `timeline_in_frame` は前倒し・後ろ倒ししない
7. 全 beat を走査しても `actualEndFrame < minTargetFrames` なら strict failure とする

If `actual > max_duration`:

1. `overflowFrames = actualEndFrame - maxTargetFrames` を計算する
2. latest-ending `support | texture | transition` video clip から逆順で tail trim する
3. trim しても解消しない場合のみ whole-clip drop を許可する
4. それでも超過する場合に限り non-protected hero clip を tail trim する
5. `actualEndFrame == maxTargetFrames` は pass、`maxTargetFrames + 1 frame` は fail とする

Guardrails:

- dialogue clip の repeat は禁止
- peak-protected clip の drop は最後の最後まで避ける
- zero-duration clip は禁止
- strict adjustment は beat window 外へのはみ出しを禁止する

#### Guide mode

- duration adjustment を行わない
- compaction 後の actual timeline をそのまま採用
- drift は resolve report に advisory として残す

### Phase 4: Resolve

Files:

- `runtime/compiler/resolve.ts`
- `runtime/compiler/index.ts`
- `runtime/compiler/patch.ts`

`ResolutionReport` を以下へ拡張する。

- `duration_mode`
- `target_source`
- `min_target_frames`
- `max_target_frames`
- `duration_status: pass | advisory | fail`
- `duration_delta_frames`
- `duration_delta_pct`

Behavior:

- `strict`
  - `min_target_frames <= actual <= max_target_frames` で PASS
  - それ以外は FAIL
- `guide`
  - `actual > 0` なら PASS
  - `actual` が advisory window 外でも `duration_status = advisory`
  - log / report に drift を残す
  - `target_source = material_total` の場合、drift は report-only とし `duration_status` は downgrade しない

`patch.ts` の `reRunPhase4()` も bare `targetDurationFrames` ではなく `DurationPolicy` を受けるようにする。review patch で strict timeline を window 外へ押し出した場合は patch failure、guide は advisory downgrade にする。

### Frame Boundary Semantics

Files:

- `runtime/compiler/types.ts`
- `runtime/compiler/index.ts`
- `runtime/compiler/resolve.ts`
- `runtime/compiler/patch.ts`

Canonical conversion rules:

- 秒から frame への換算は decimal `29.97` ではなく rational `fpsNum / fpsDen` を使う
- NTSC 系 fixture は `30000/1001` を渡し、`30/1` へ丸めない
- `target_frames = round(target_duration_sec * fpsNum / fpsDen)`
- `min_target_frames = ceil(min_duration_sec * fpsNum / fpsDen)`
- `max_target_frames = floor(max_duration_sec * fpsNum / fpsDen)` (`max_duration_sec = null` の場合は unbounded)
- 判定は inclusive
  - `actual == min_target_frames` は in-window
  - `actual == max_target_frames` は in-window
  - `actual == min_target_frames - 1` は out-of-window
  - `actual == max_target_frames + 1` は out-of-window
- `guide` の `±30%` も同じ helper で frame 化し、ちょうど `70%` / `130%` 境界は advisory window 内として扱う
- patch 後の strict 再検証も同一 helper を使い、1 frame でも window 外なら patch failure とする
- `guide + target_source = material_total` では `target_frames` は material-derived target から算出する
  - `duration_delta_sec` / `duration_delta_pct` は `null` ではなく、その derived target に対する差分を返す
  - ただし `min_target_frames = 0`, `max_target_frames = null` のため gate には使わない

### Phase 5: Export

Files:

- `runtime/compiler/export.ts`
- `schemas/timeline-ir.schema.json`

Add:

- `timeline.provenance.duration_policy`

No other timeline schema change is required.

## Non-Functional Requirements

### Determinism

- 同一 brief / blueprint / selects / compiler defaults / fps なら duration outcome は同一であること
- mode defaulting は resolver の pure function で決まり、LLM output に依存しないこと

### Reliability

- `strict` で target 達成不能な場合は、silent degrade ではなく actionable failure を返す
- `guide` では zero-length timeline を絶対に出さない
- patch 後も strict window 判定を再実行し、review で duration drift が混入しないこと

### Performance

- duration mode による追加コストは candidate 数に対して線形または `O(n log n)` に収める
- `guide` compaction のために全候補を再探索し続ける backtracking は入れない

### Security / Safety

- 新規 field は enum / numeric validation で閉じる
- 外部 API や network permission は追加しない
- repeat 処理は non-dialogue clip に限定し、意味改変リスクの高い台詞重複を防ぐ

## Observability

最低限、以下の log / report を各段で残す。

- `/triage`
  - `duration_mode`
  - `target_source`
  - `target_duration_sec`
  - `total_unique_candidate_duration_sec`
  - `coverage_ratio`
  - `selection_audit.status`
- compiler resolution
  - `duration_mode`
  - `target_source`
  - `target_duration_sec`
  - `actual_duration_sec`
  - `duration_delta_sec`
  - `duration_delta_pct`
  - `duration_status`
- post-render QA
  - `duration_policy_valid`
  - `duration_mode`
  - `target_source`
  - `target_duration_sec`
  - `actual_duration_sec`
  - `duration_delta_sec`
  - `duration_delta_pct`

When `target_source = material_total`, delta fields are recorded against the derived material target rather than left `null`.

This is required so that `guide` without an explicit target remains distinguishable from accidental underfill while staying non-gating.

## Post-Render QA Gate

Files:

- `runtime/packaging/qa.ts`
- `runtime/commands/package.ts`

New check:

- `duration_policy_valid`

Inputs:

- `final_video` actual duration from probe
- `timeline.provenance.duration_policy`

Behavior:

- `strict`
  - required check
  - `actual_duration_sec` must be within `min/max`
  - fail if outside
- `guide`
  - info-only check
  - report `actual`, `target`, `delta`, `delta_pct`
  - `target_source = material_total` でも fail にはしない
  - never flips package to failed by duration alone

`getRequiredChecks()`:

- `engine_render` / `nle_finishing` ともに `strict` のときだけ required
- `guide` では report に出すが required list には含めない

## Acceptance Criteria

### Strict

- brief に `duration_mode: strict`
- target 30s
- compiler / patch / QA の全段で `29s <= actual <= 31s`
- outside window は hard fail

### Guide

- brief に `duration_mode: guide`
- target 90s
- candidate pool が約 60s 相当
- timeline は compaction により約 60s 前後で確定
- peak-protected clip が duration drift だけで落とされない
- QA report は advisory として drift を出すが PASS

### Guide Without Target

- brief に `duration_mode: guide`
- `runtime_target_sec` absent
- compiler は `duration_policy.target_source = material_total`, `target_duration_sec = total_unique_candidate_duration_sec`, `min_duration_sec = 0`, `max_duration_sec = null` を生成する
- timeline は actual material duration で compile success する
- QA / resolution report の delta fields は material-derived target に対して計算される
- drift は report-only であり gate には使わない

### Exact Boundary

- strict で `actual == min_target_frames` または `actual == max_target_frames` は PASS
- strict で `actual` が 1 frame でも window 外なら FAIL
- guide で advisory window ちょうどは `duration_status = pass`
- guide で advisory window を 1 frame 外れた場合は `duration_status = advisory`
- 29.97fps fixture は `30000/1001` 換算で同じ結論になる

### Defaulting

- brief に `duration_mode` 未指定
- `vertical-short` / `lp-testimonial` は `runtime_target_sec` がある場合のみ `strict`
- `vertical-short` / `lp-testimonial` で `runtime_target_sec` absent の場合は warning 付きで `guide` へ降格
- `event-recap` / `product-demo` / `lecture-highlight` / `interview-highlight` は `guide`
- profile signal が何も取れない場合は `guide`

## Test Strategy

### Unit Tests

Add or extend:

- `tests/m45-profile-policy.test.ts`
  - profile 互換マッピングから mode default を検証
  - explicit `strict` + target absent が reject されること
  - strict profile default + target absent が `guide` に降格すること
- `tests/m45-script-engine.test.ts`
  - `duration_policy` 生成
  - `guide` は `duration_pacing` が advisory
  - `strict` は gate
  - `guide + runtime_target_sec absent` では `target_source = material_total`, `target_duration_sec = total_unique_candidate_duration_sec`, `min = 0`, `max = null`
- `tests/compiler.test.ts`
  - strict 30s fixture -> `duration_status = pass`, `±1s`
  - guide 90s target / 60s material fixture -> actual short timeline で PASS
  - guide + target absent fixture -> material-derived target frames が使われ、duration delta が `null` にならないこと
  - peak-protected candidate が survive すること
  - no-signal fallback: `peak_strength_score` / `peak_ref` absent でも compile success し、implicit peak protection を掛けないこと
  - exact-boundary regression: `±1s` ちょうど, `±30%` ちょうど, 1 frame outside を検証すること
  - NTSC regression: `30000/1001` で同じ boundary helper が使われること
- `tests/m4-qa.test.ts`
  - `duration_policy_valid` strict pass/fail
  - guide advisory logging
  - `guide + runtime_target_sec absent` で material-derived target と delta が report されつつ info-only になること

### Fixture / Integration Tests

1. strict commercial fixture
   - target 30s
   - candidate pool 35-40s
   - final output 29-31s
2. guide keepsake fixture
   - target 90s
   - candidate pool 55-65s
   - final output 55-65s
3. profile default fixture
   - `event-recap` => guide
   - `vertical-short` + target present => strict
   - `vertical-short` + target absent => guide downgrade
4. strict patch boundary fixture
   - exact boundary patch は通る
   - patch 後に 1 frame over/under した場合は failure

### Regression Tests

- 既存 `projects/sample` は mode 未指定でも compile success
- existing timeline schema validation remains green
- review patch flow still re-runs Phase 4 deterministically
- no-signal fallback で raw `segments.json` direct read に戻らない
- exact-boundary helper が resolve / patch / QA で共通化されている

## Migration and Rollout

### Backward Compatibility

- existing briefs without `duration_mode` remain valid
- runtime default is `guide`
- commercial / social fixtures that need old hard behavior should add explicit `duration_mode: strict` and `runtime_target_sec`

### Rollout Order

1. contract and resolver
   - brief schema
   - blueprint snapshot
2. planning plane
   - `/blueprint`
   - `/triage`
3. compiler plane
   - normalize / score / assemble / resolve / patch / export
4. packaging plane
   - post-render duration QA
5. fixture backfill

### Rollback Plan

- keep `project.duration_mode` additive only
- if compiler rollout regresses, ignore `duration_policy` and fall back to current target behavior
- because old `runtime_target_sec` remains untouched, rollback does not require data migration

## Risks and Alternatives

### Risk 1: `guide` を scoring だけで実装すると timeline が不自然

Reason:

- `assemble.ts` が beat target 分 cursor を進めるため、実尺不足でも timeline 全体が target に引っ張られる

Mitigation:

- guide mode では placement compaction を必須にする

### Risk 2: peak protection が強すぎると commercial strict が崩れる

Mitigation:

- peak protection は `guide` だけで有効化する

### Risk 3: schema default 依存で silent drift する

Mitigation:

- runtime resolver で `effective_duration_mode` を必ず確定する

### Rejected Alternative 1

`runtime_target_sec` を廃止して `target_duration: { sec, mode }` へ全面移行する案。

Rejected because:

- `intent`, `blueprint`, compiler, fixtures, tests の影響が広すぎる
- 今回は additive 変更で十分

### Rejected Alternative 2

`confirmed_preferences` に duration mode を混ぜる案。

Rejected because:

- human-confirmed decision と profile default が同居して source-of-truth が濁る

## Implementation Task Breakdown

1. Contract
   - `schemas/creative-brief.schema.json`
   - `schemas/edit-blueprint.schema.json`
   - `schemas/selects-candidates.schema.json`
   - `schemas/timeline-ir.schema.json`
   - `runtime/compiler/types.ts`
2. Resolver and planning
   - `runtime/editorial/policy-resolver.ts`
   - `runtime/script/frame.ts`
   - `runtime/script/evaluate.ts`
   - `runtime/commands/intent.ts`
   - `runtime/commands/blueprint.ts`
   - `runtime/commands/triage.ts`
3. Compiler
   - `runtime/compiler/normalize.ts`
   - `runtime/compiler/score.ts`
   - `runtime/compiler/assemble.ts`
   - new `runtime/compiler/duration-adjust.ts`
   - `runtime/compiler/resolve.ts`
   - `runtime/compiler/patch.ts`
   - `runtime/compiler/index.ts`
   - `runtime/compiler/export.ts`
4. QA
   - `runtime/packaging/qa.ts`
   - `runtime/commands/package.ts`
5. Tests
   - `tests/m45-profile-policy.test.ts`
   - `tests/m45-script-engine.test.ts`
   - `tests/compiler.test.ts`
   - `tests/m4-qa.test.ts`

## Final Check

- 目的: 尺を hard target と advisory target に分ける
- 制約: 現行 `runtime_target_sec` を壊さない
- 仕様: brief -> blueprint -> compiler -> QA で `duration_policy` を一本化
- 受け入れ条件: strict は `±1s` hard pass、guide は実尺 compaction + advisory drift report
- 運用: 未指定 default は `guide`、commercial/social は target がある場合のみ `strict`、target がなければ `guide` へ降格

この設計では、麓太朗自転車 v3 のような素材不足案件で quality-first 編集を許容しつつ、CM / SNS の strict duration も deterministic に保証できる。
