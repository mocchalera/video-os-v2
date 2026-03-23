# Milestone 4.5 Design

## Scope

Milestone 4.5 は、旧 `video-edit-agent` の Script Engine、editing skill、profile / policy の有効知見を
Video OS v2 に移植し、M4 までで成立した artifact flow と render path を壊さずに
「編集として面白い映像」を作るための editorial intelligence を補強する milestone である。

M4.5 の責務は 6 つに分かれる。

1. `selects_candidates.yaml` に stable `candidate_id` を正式化し、downstream artifact では
   `candidate_ref` ベースで candidate を参照できるようにする。
2. `/triage` で `trim_hint` と minimal editorial signal を生成し、`selects_candidates.yaml` を
   compiler-ready な canonical artifact へ拡張する。
3. `/blueprint` の内部に旧 Script Engine の 4 フェーズ
   `frame -> read -> draft -> evaluate`
   を移植し、`edit_blueprint.yaml` を narrative-aware に強化する。
4. 旧 repo の profile 7 個と editing policy 7 個を、structured brief field から解決される
   machine-readable な editorial defaults / constraints として v2 に持ち込む。
5. M2 で既に artifact 化されている `interest_points` を、単なる分析メモではなく
   clip trim 決定に使う compiler input に昇格する。
6. 現行 beat-linear IR で表現できる score / trim / metadata 系 editing skill のみを、
   `normalize -> score -> assemble -> resolve -> export`
   に additive に統合する。

M4.5 で増やすのは「blueprint plane の editorial contract」と「compiler の deterministic hint 層」であり、
M1-M4 の canonical artifact、state machine、render engine、approval loop は壊さない。

一方で、scene / interleave / overlap を要する skill は M4.5 には入れない。
`crosscut_suspense`、`montage_compress`、`j_cut_lead_in`、`l_cut_reaction_hold`、
`cutaway_repair`、`talking_head_pacing` は、editorial IR に
within-beat clip list、thread / section、audio lead / lag primitive を追加する
後続 milestone へ分離する。

## Source Study

この設計は、少なくとも以下を実読した上で行う。

- v2 側
  - `ARCHITECTURE.md`
  - `docs/roadmap.md` の引き継ぎセクション
  - `runtime/compiler/{score.ts,assemble.ts,resolve.ts,patch.ts,index.ts,types.ts,normalize.ts}`
  - `runtime/commands/{intent.ts,triage.ts,blueprint.ts,review.ts}`
  - `agent-src/roles/{intent-interviewer.yaml,footage-triager.yaml,blueprint-planner.yaml,roughcut-critic.yaml}`
  - `schemas/{creative-brief.schema.json,selects-candidates.schema.json,edit-blueprint.schema.json,timeline-ir.schema.json,review-patch.schema.json,segments.schema.json}`
- 旧 repo 側
  - `docs/inventory-ja/skills/`
    - `narrative-design.md`
    - `build-edit-plan.md`
    - `material-reading-review.md`
    - `narrative-continuity-review.md`
    - `quality-judgment.md`
    - `testimonial-tone-check.md`
    - `blueprint-review.md`
  - `docs/inventory-ja/editing-skills/*.md` 全 18 件
  - `docs/inventory-ja/profiles/*.md` 全 7 件
  - `docs/inventory-ja/editing-policies/*.md` 全 7 件
  - `docs/inventory-ja/rules/{narrative-design.md,autonomous-workflow.md}`
  - `AGENTS.md`
  - `docs/unified-roadmap.md`
  - `docs/design/scriptwriting-engine-impl-guide.md`

## In Scope

- `/blueprint` の内部 4 フェーズ化
- `candidate_id` / `candidate_ref` の導入と downstream 参照の統一
- `/triage` による `trim_hint` / minimal editorial signal 生成
- `blueprint-planner` prompt の narrative-design rule 反映
- non-canonical な script engine 中間 artifact の追加
- `creative_brief.yaml` / `selects_candidates.yaml` / `edit_blueprint.yaml` /
  `timeline.json` / `review_patch.json` の additive extension
- profile / policy / editing skill registry の追加
- compiler の skill-aware scoring / assembly / trim
  - ただし現行 IR で表現できる skill のみ
- `interest_points` に基づく adaptive in/out
- `roughcut-critic` の profile / skill-aware review 強化
- M1-M4 既存 fixture を壊さない fallback / compatibility 設計

## Out Of Scope

- 旧 Python pipeline の移植
- public command の追加
  - `vea script frame/read/draft/evaluate` 相当を v2 の slash command として新設すること
- M3/M4 state machine への新 canonical state 追加
- M4 packaging plane の抜本 redesign
- scene / interleave / overlap を表現する editorial IR 拡張
  - within-beat clip list
  - thread / section id
  - audio lead / lag primitive
  - overlap-aware transition spec
- 以下の skill の compile behavior 導入
  - `crosscut_suspense`
  - `montage_compress`
  - `j_cut_lead_in`
  - `l_cut_reaction_hold`
  - `cutaway_repair`
  - `talking_head_pacing`
- visual embedding による cross-asset 重複検出の本実装
  - これは M4.5 では設計上の hook だけを置き、初期実装は transcript / motif / same-window dedupe を主に使う
- audio mastering / caption delivery / BGM search の旧 repo 再導入

## Contract Rules

- `timeline.json` は引き続き唯一の canonical timeline artifact とする。
- M4.5 は M1-M4 の既存 consumer を壊さない。
- 既存 field の rename / remove / semantic break は行わない。
- 新しい editorial intelligence は
  - canonical artifact の additive field
  - non-canonical operational artifact
  - `timeline.json` の additive provenance / candidate ref field
  - `timeline.json.clip.metadata` / `marker.metadata`
  に限定して表現する。
- compiler の deterministic ruleは維持する。
  - LLM は `/intent`, `/triage`, `/blueprint`, `/review` の agent layer にのみ置く。
- unresolved blocker / fatal review / compiler ownership などの
  `ARCHITECTURE.md` gate は維持する。
- M4.5 導入後も `/blueprint` が canonical artifact promotion の唯一入口である。
- M4.5 の compiler IR は beat-linear のままとする。
  - 1 beat あたり primary clip は 1 本
  - within-beat multi-clip sequence は持たない
  - audio overlap / lead / lag primitive は持たない
- `segment_id` は media locator として残すが、editorial な identity / fallback / patch safety は
  `candidate_ref` を正とする。
- `pacing.confirmed_preferences` は human または autonomous planner の確定判断専用に維持し、
  profile / policy default を投影しない。

## Success Criteria

M4.5 は、以下がすべて満たされたとき完了とする。

1. `/blueprint` は 4 フェーズ相当の内部 workflow を持ち、`edit_blueprint.yaml` と
   `uncertainty_register.yaml` に加えて script engine operational artifact を書ける。
2. `selects_candidates.yaml` は `candidate_id` を正式 field として持ち、`/triage` が
   `trim_hint` と minimal editorial signal を additive に保持できる。
3. `edit_blueprint.yaml` は story arc、resolved profile / policy、supported active editing skills、
   dedupe rule、quality target、trim policy、candidate plan を additive に保持できる。
4. compiler は profile と supported active skill を読んで score / assemble / resolve を
   変化させられる。
  - scene / interleave / overlap 系 skill は M4.5 の success criteria に含めない
5. `interest_points` が存在する candidate では、fixed `src_in_us/src_out_us` だけでなく
   center-based trim が使える。
6. `timeline.json` と `review_patch.json` は `candidate_ref` ベースの provenance / fallback /
   patch safety を保持できる。
7. `timeline.json.provenance` は `compiler_defaults_hash` と `editorial_registry_hash` を持ち、
   registry 更新起因の差分を追跡できる。
8. 新 field が存在しない旧 artifact では、M4 以前と同じ compile behavior に fail-open する。

## Artifact Model

### Canonical / Operational Split

M4.5 では旧 Script Engine の 4 フェーズを、そのまま canonical artifact にせず、
`/blueprint` 配下の operational artifact として保持する。

| Artifact | Kind | Producer | Purpose |
| --- | --- | --- | --- |
| `04_plan/message_frame.yaml` | operational | `/blueprint` Phase A | brief から hook / setup / closing intent と profile / policy 仮説を固定 |
| `04_plan/material_reading.yaml` | operational | `/blueprint` Phase B | beat slot ごとの primary / backup candidate_ref、coverage、dedupe map を固定 |
| `04_plan/script_draft.yaml` | operational | `/blueprint` Phase C | sequence 草案、candidate_ref assignment、supported skill activation 草案を固定 |
| `04_plan/script_evaluation.yaml` | operational | `/blueprint` Phase D | deterministic な quality metric、candidate_ref ベース repair、missing beat を固定 |
| `04_plan/edit_blueprint.yaml` | canonical | `/blueprint` projection | compiler が読む最終 editorial contract |
| `04_plan/uncertainty_register.yaml` | canonical | `/blueprint` | 未確定事項と blocker を保持 |

理由:

- 旧 repo の 4 フェーズは価値があるが、v2 で canonical source of truth を増やしすぎるべきではない。
- operator が中間思考を audit できる一方で、compiler と review は引き続き
  `edit_blueprint.yaml` を唯一の canonical plan として読める。
- state machine は変えず、`selects_ready -> blueprint_ready` を維持できる。

### New / Extended Schemas

M4.5 で追加または拡張する schema は以下とする。

- additive extension
  - `schemas/creative-brief.schema.json`
  - `schemas/selects-candidates.schema.json`
  - `schemas/edit-blueprint.schema.json`
  - `schemas/timeline-ir.schema.json`
  - `schemas/review-patch.schema.json`
- new operational schemas
  - `schemas/message-frame.schema.json`
  - `schemas/material-reading.schema.json`
  - `schemas/script-draft.schema.json`
  - `schemas/script-evaluation.schema.json`

いずれも root は closed に保つ。`timeline.json` の extension point は既存どおり
`clip.metadata` と `marker.metadata` を使うが、`candidate_ref` / provenance hash のように
review patch safety と compile reproducibility に直結する field は top-level additive field として持つ。

### Stable Candidate Reference

M4.5 は identity と media locator を分離する。

- `selects_candidates.yaml.candidates[].candidate_id`
  - 新規に formalize する stable id
  - `/triage` が deterministic に生成し、新規 artifact は必須で出力する
- `candidate_ref`
  - downstream artifact が使う参照文字列
  - M4.5 では `candidate_ref = candidate_id` とする
- `segment_id`
  - 引き続き media locator と provenance のために保持する
  - editorial decision や fallback safety の primary key には使わない

downstream で `candidate_ref` を使う箇所:

- `material_reading.yaml.top_candidates[]`
- `material_reading.yaml.backup_candidates[]`
- `script_draft.yaml.beat_assignments[].primary_candidate_ref`
- `script_draft.yaml.beat_assignments[].backup_candidate_refs[]`
- `script_evaluation.yaml.repairs[].from_candidate_ref` / `to_candidate_ref`
- `edit_blueprint.yaml.beats[].candidate_plan`
- `timeline.json.clips[].candidate_ref` / `fallback_candidate_refs[]`
- `timeline.json.clip.metadata.editorial.candidate_ref`
- `review_patch.json.operations[].with_candidate_ref`

互換性:

- 旧 artifact のために `segment_id` と `fallback_segment_ids` は残す
- 旧 `selects_candidates.yaml` に `candidate_id` がない場合だけ、
  in-memory shim として `legacy:{segment_id}:{src_in_us}:{src_out_us}` を合成する
- `review_patch.json` も legacy timeline 向けに `with_segment_id` を残してよいが、
  新規 patch は `with_candidate_ref` を正とする
- shim は compile compatibility のためだけに使い、新規 canonical artifact へは書き戻さない

### Translation Matrix

旧 repo の主要知見は、v2 では以下の形で受け取る。

| 旧 surface | 旧 artifact / rule | v2 translation |
| --- | --- | --- |
| Material unit identity | `candidate_id` / `material_unit_id` | `selects_candidates.yaml.candidates[].candidate_id` + downstream `candidate_ref` |
| Script Engine Phase A | `state/message-frame.json` | `04_plan/message_frame.yaml` |
| Script Engine Phase B | `state/material-reading.json` | `04_plan/material_reading.yaml` |
| Script Engine Phase C | `state/script-blueprint.json` | `04_plan/script_draft.yaml` |
| Script Engine Phase C eval | `state/script-evaluation.json` | `04_plan/script_evaluation.yaml` |
| Script Engine final | `state/narrative-design.json` | `edit_blueprint.yaml.story_arc` + beat metadata + quality targets |
| Build Edit Plan | `state/edit-plan.json` | `edit_blueprint.yaml` + compiler defaults + `timeline.json.clip.metadata.editorial` |
| Editing Skills prose rules | `profiles/editing-skills/*.yaml` | `runtime/editorial/skills/*.yaml` registry |
| Profiles | `profiles/*.yaml` | `runtime/editorial/profiles/*.yaml` + resolver |
| Editing Policies | `profiles/editing-policies/*.yaml` | `runtime/editorial/policies/*.yaml` + blueprint constraints |

この translation は「旧 artifact 名を維持する」ためではなく、
旧知見の責務を v2 の canonical / operational contract に割り直すために行う。

## 0. Candidate Ref And Triage Signal Spine

M4.5 は script engine や skill より先に、candidate identity と signal producer を固定する。
ここが曖昧だと adaptive trim、backup、dedupe、review patch safety がすべて不安定になる。

### `/triage` Ownership

`selects_candidates.yaml` の canonical owner は引き続き `/triage` とする。

- `footage-triager` は raw candidate proposal と evidence を返す
- `runtime/commands/triage.ts` が canonicalization を担う
  - `candidate_id` 付与
  - `trim_hint` 正規化
  - supported skill 用 `editorial_signals` 正規化
  - profile resolution に必要な `editorial_summary` 集計
- `/blueprint` と compiler は `/triage` が確定した signal だけを読む

これにより、signal producer のいない field に Phase C / D や compiler が依存する状態を避ける。

### Deterministic `candidate_id`

`candidate_id` は authored candidate window 単位で安定していなければならない。
M4.5 の生成規則は以下とする。

- hash input
  - `project_id`
  - `segment_id`
  - `asset_id`
  - `src_in_us`
  - `src_out_us`
  - `role`
- hash output
  - URL-safe な短い stable string
- stability contract
  - 同一 authored candidate window なら rerun でも同じ id になる
  - adaptive trim の resolved in/out では `candidate_id` を変えない
  - adaptive trim の結果は `candidate_ref` の下にぶら下がる resolved trim metadata で表現する

## 1. Script Engine 統合

### Entry Point

public command は増やさない。`/blueprint` を単一入口のまま維持し、内部で以下の 4 フェーズを実行する。

| 旧 phase | v2 ownership | Output | 性質 |
| --- | --- | --- | --- |
| frame | `blueprint-planner` agent + profile resolver | `message_frame.yaml` | creative |
| read | `/triage` signal output + deterministic reader + optional agent correction | `material_reading.yaml` | semi-deterministic |
| draft | `blueprint-planner` agent | `script_draft.yaml` | creative |
| evaluate | deterministic validator + review rules | `script_evaluation.yaml` | deterministic |

旧 repo の `narrative-design` skill は、v2 では `blueprint-planner` prompt と
`message_frame.yaml` / `story_arc` contract へ翻訳する。
旧 `build-edit-plan` skill は、v2 では agent に final plan を書かせず、
`edit_blueprint.yaml` と compiler defaults に分解して移植する。

### Prompt Strengthening

`agent-src/roles/blueprint-planner.yaml` は以下を明示的に含むよう拡張する。

- story を keyword checklist ではなく coherent arc として作る
- strongest material を `hook / setup / experience / closing` の role で考える
- `interviewer` / `question` 発話は profile が許す場合のみ support として使う
- single strongest hook を opening window に集中させる
- profile / policy が strict chronology を要求しない限り、source chronology と reveal order を分離してよい
- blueprint finalize 前に以下の review を internal pass として行う
  - `material-reading-review`
  - `testimonial-tone-check`（interview 系のみ）
  - `blueprint-review`

### 4 フェーズの v2 workflow

#### Phase A: Frame

`message_frame.yaml` に少なくとも以下を持たせる。

- `story_promise`
- `hook_angle`
- `closing_intent`
- `resolved_profile_candidate`
- `resolved_policy_candidate`
- `beat_strategy`
  - beat count
  - role sequence
  - chronology bias
  - target duration window
- `quality_targets`

ここでは素材詳細をまだ再編集しない。旧 Script Engine の設計に従い、
brief と profile / policy をもとに「どんな編集を作るか」を先に固定する。

#### Phase B: Read

`material_reading.yaml` は `/triage` 済み `selects_candidates.yaml` を読み、beat ごとに以下を整理する。

- `top_candidates`
  - `candidate_ref`
  - `why_primary`
- `backup_candidates`
  - `candidate_ref`
  - `why_backup`
- `coverage_gaps`
- `asset_concentration`
- `dedupe_groups`
- `speaker_risks`
- `tone_risks`

ここで `material-reading-review.md` と `testimonial-tone-check.md` の観点を deterministic rule に変換する。

- dangling opener
- standalone meaning の弱さ
- beat type misalignment
- asset concentration
- self-deprecating qualifier
- negative sentiment opening
- excessive hedging
- interviewer contamination

これらは compile blocker にはせず、`script_evaluation.yaml` と
`uncertainty_register.yaml` に warning / blocker として落とす。

#### Phase C: Draft

`script_draft.yaml` は canonical artifact ではないが、`edit_blueprint.yaml` の下書き source になる。

含める内容:

- delivery order
- beat-to-candidate_ref assignment
- `story_role`
- transition proposal
- supported active skill draft
- backup map
  - `primary_candidate_ref`
  - `backup_candidate_refs[]`
- rationale

ここでは旧 `script-blueprint.json` と `script-evaluation.json` の役割を分け、
creative draft と deterministic evaluation を切り離す。

#### Phase D: Evaluate

`script_evaluation.yaml` は LLM を使わず、以下を行う。

- utterance uniqueness check
- semantic near-duplicate detection
- story continuity check
- closing support check
- profile / policy violation check
- quality metric calculation
- repair
  - backup への差し替え
    - `from_candidate_ref`
    - `to_candidate_ref`
  - unsupported beat の削除
  - `missing_beats` への記録

旧 repo の `narrative-continuity-review` と `quality-judgment` はここへ翻訳する。

fail-closed:

- closing beat が未支持のまま残る
- `interview` policy なのに interviewer contamination が primary hook / closing に残る
- hard dedupe violation が primary beats に残る

#### Phase D Deterministic Metric Spec

M4.5 で compile gate に使う metric と advisory metric を分ける。

| Metric | Inputs | Deterministic rule | Fallback | Enforcement |
| --- | --- | --- | --- | --- |
| `hook_density` | `story_role`, `speech_intensity_score`, `surprise_signal`, `authenticity_score`, `confidence` | opening beats のうち salience score `>= 0.65` の比率 | signal 不足時は `confidence >= 0.85` を salience とみなす | gate |
| `novelty_rate` | `semantic_dedupe_key`, `candidate_ref` | primary beat に使われた unique key 数 / primary beat 数 | key 不在時は `candidate_ref` を使う | gate |
| `duration_pacing` | beat target duration、resolved trim、resolved duration target | total duration が resolved default の `+-10%` 内に収まるか | resolved duration target 不在時は `project.runtime_target_sec` | gate |
| `emotion_gradient` | `emotion_curve`, `speech_intensity_score`, `reaction_intensity_score`, `afterglow_score` | expected curve の up / hold / down と actual beat intensity の向き一致率 | 3 beat 未満または signal 不足時は `advisory_skipped` | advisory |
| `causal_connectivity` | `story_arc.causal_links`, `semantic_cluster_id`, `motif_tags`, beat order | 隣接 beat のうち causal link または shared cluster で説明可能な比率 | causal input 不足時は `advisory_skipped` | advisory |

`tone_integrity` と `source_fidelity` は M4.5 では roughcut review 側 advisory に留める。
compile gate に昇格するのは、入力 field と fallback が固定できる metric だけに限定する。

### `edit_blueprint.yaml` の additive extension

`edit_blueprint.yaml` には少なくとも以下を追加する。

- `story_arc`
  - `summary`
  - `strategy`
    - `chronological`
    - `peak_first`
    - `testimonial_highlight`
    - `problem_to_solution`
    - `release_after_peak`
  - `chronology_bias`
  - `allow_time_reorder`
  - `causal_links[]`
- `resolved_profile`
  - `id`
  - `source`
  - `rationale`
- `resolved_policy`
  - `id`
  - `source`
  - `rationale`
- `active_editing_skills`
- `dedupe_rules`
  - `utterance_consumption: unique`
  - `semantic_similarity_threshold`
  - `allow_intentional_repetition`
- `quality_targets`
  - `hook_density_min`
  - `novelty_rate_min`
  - `duration_pacing_tolerance_pct`
  - `emotion_gradient_min`
    - advisory only
  - `causal_connectivity_min`
    - advisory only
- `trim_policy`
  - `mode`
  - `default_preferred_duration_frames`
  - `default_min_duration_frames`
  - `default_max_duration_frames`
- `pacing`
  - `default_duration_target_sec`

beat level の additive field:

- `story_role`
  - `hook | setup | experience | closing`
- `skill_hints`
- `candidate_plan`
  - `primary_candidate_ref`
  - `fallback_candidate_refs[]`
- `candidate_constraints`
  - `allow_interviewer_support`
  - `force_unique_utterances`

### Story Arc

旧 repo の中核知見は、「素材の source chronology」ではなく
`hook -> setup -> experience -> closing`
の delivery role で設計することだった。

v2 では以下を採用する。

- beat 配列順 = reveal order
- `story_role` = narrative role
- `story_arc.strategy` = 旧 policy の `timeline_template` を translation した reveal rule

これにより、たとえば `highlight` policy では
`experience` 素材を最初の beat に置いて hook として機能させ、
後から `setup` を入れる非時系列配置ができる。

### 冗長排除

M4.5 では dedupe を 2 層に分ける。

hard dedupe:

- 同一 `utterance_id` は primary beat で一度しか消費しない
- 同一 source range の再利用は禁止

soft dedupe:

- `semantic_dedupe_key` が同一、または similarity threshold 超過の candidate は
  隣接 beat に置かない
- intentional repetition は `closing` など明示 beat だけ許可

translation rule:

- 旧 repo の「fragment opener」「consecutive keyword repetition」「standalone viewer test」は
  `script_evaluation.yaml` の dedupe / continuity warning に変換する
- `interview-highlight` 系では interviewer question を
  `support` 以外で使わないのを既定にする
- hard dedupe / backup / repair は常に `candidate_ref` 単位で記録する

### 台本品質評価

`script_evaluation.yaml` で少なくとも以下を計算する。

- `hook_density`
  - opening window に含まれる high-salience beat の密度
  - profile ごとに target を変える
- `novelty_rate`
  - primary beat 群のうち semantic duplicate でない比率
- `emotion_gradient`
  - brief の `emotion_curve` と beat intensity の整合度
  - M4.5 では advisory
- `causal_connectivity`
  - 隣接 beat が `because / therefore / despite / payoff` のいずれかで説明可能な比率
  - M4.5 では advisory

補助指標:

- `tone_integrity`
- `source_fidelity`
- `duration_pacing`

これらは旧 `quality-judgment.md` の
`claim_support`, `source_fidelity`, `narrative_coherence`, `audience_alignment`, `duration_pacing`
を v2 向けに再編したものとして扱う。

## 2. Editing Skills 統合

### Registry Model

旧 repo の 18 skill は prose のままでは compiler から読めないため、
v2 では registry 化する。ただし M4.5 で有効化するのは、現行 beat-linear IR で
compile behavior を持てる skill だけに限定する。

新規ファイル:

- `runtime/editorial/skills/*.yaml`
- `runtime/editorial/profiles/*.yaml`
- `runtime/editorial/policies/*.yaml`
- `runtime/editorial/matrix.yaml`

各 skill registry は少なくとも以下を持つ。

- `id`
- `category`
  - `linear_sequence | trim | metadata`
- `primary_phase`
  - `normalize | score | assemble | resolve | export`
- `required_signals`
- `when`
- `avoid_when`
- `effects`
  - `score_bonus`
  - `score_penalty`
  - `transition_override`
  - `trim_bias`
  - `duration_bias_frames`
  - `metadata_tags`

deferred skill registry も同居してよいが、M4.5 では `status: deferred_ir_required` として持ち、
compiler activation 対象にしない。

### Skill Activation

activation は 4 段階で決める。

1. resolved profile の default active skill 集合を読む
2. resolved policy の suppression / enforcement を適用する
3. candidate の `editorial_signals` を見て `minimum_viable` を満たすか判定する
4. beat ごとに local activation へ落とす

結果は `edit_blueprint.yaml.active_editing_skills` と
`beats[].skill_hints` に書き、compiler はこれを deterministic に消費する。

M4.5 では skill activation が新しい clip topology を暗黙に要求してはいけない。
activation 結果は、以下のどれかに落ちる必要がある。

- candidate score weight の変化
- candidate eligibility / suppression
- beat order bias
- trim bias
- export metadata tag

### Compiler Phase Mapping

M4.5 先行導入 skill:

| Skill | Primary phase | Compiler effect |
| --- | --- | --- |
| `axis_hold_dialogue` | `assemble` | 話者切替時に orientation continuity を優先し accidental axis break を避ける |
| `b_roll_bridge` | `score + assemble` | topic shift で support / texture を bridge 候補として加点し crossfade を提案 |
| `build_to_peak` | `normalize + assemble` | beat intensity を漸増配置し peak を後半へ寄せる |
| `cooldown_resolve` | `assemble + resolve` | peak 後の release beat と長め hold / fade を許容する |
| `deliberate_axis_break` | `assemble` | emotional turn でのみ axis break を許可し、それ以外は hard fail 扱い |
| `exposition_release` | `score + assemble` | explanation-heavy 候補に対し lighter bridge 候補を加点する |
| `match_cut_bridge` | `score + assemble` | visual similarity bridge を bonus として扱う |
| `punch_in_emphasis` | `resolve + export` | high-intensity line に zoom metadata を付ける |
| `reveal_then_payoff` | `normalize` | setup-before-payoff の causal order を enforced する |
| `shot_reverse_reaction` | `score + assemble` | reaction payoff 候補を加点し dialogue followability を確保する |
| `silence_beat` | `resolve` | afterglow 区間に intentional hold / fade を置く |
| `smash_cut_energy` | `assemble` | 大きな energy contrast で hard cut を選ぶ |

後続 milestone へ分離する skill:

| Skill | 先送り理由 |
| --- | --- |
| `crosscut_suspense` | thread の interleave を表現する IR が必要 |
| `montage_compress` | within-beat multi-clip list が必要 |
| `j_cut_lead_in` | audio lead-in primitive が必要 |
| `l_cut_reaction_hold` | audio carry-over / reaction hold primitive が必要 |
| `cutaway_repair` | cover clip の追加挿入と overlap-aware resolve が必要 |
| `talking_head_pacing` | secondary cutaway / zoom orchestration を表す IR が必要 |

### Required Candidate Signals

skill を deterministic に適用するには、`selects_candidates.yaml` に minimal signal が必要である。

top-level additive field:

- `editorial_summary`
  - `dominant_visual_mode`
    - `talking_head | screen_demo | event_broll | mixed | unknown`
  - `speaker_topology`
    - `solo_primary | interviewer_guest | multi_speaker | unknown`
  - `motion_profile`
    - `low | medium | high | unknown`
  - `transcript_density`
    - `sparse | medium | dense | unknown`

candidate additive field:

- `candidate_id`
- `utterance_ids`
- `speaker_role`
  - `primary | interviewer | secondary | unknown`
- `semantic_dedupe_key`
- `editorial_signals`
  - `silence_ratio`
  - `afterglow_score`
  - `speech_intensity_score`
  - `reaction_intensity_score`
  - `authenticity_score`
  - `surprise_signal`
  - `hope_signal`
  - `face_detected`
  - `visual_tags`
  - `semantic_cluster_id`
- `trim_hint`
  - `source_center_us`
  - `preferred_duration_us`
  - `min_duration_us`
  - `max_duration_us`
  - `window_start_us`
  - `window_end_us`
  - `interest_point_label`
  - `interest_point_confidence`

この signal 層は旧 skill の prose rule を v2 artifact contract に翻訳するための最小面積である。
audio overlap や multi-clip montage を直接表現する signal は M4.5 には追加しない。

### Example

`interview-highlight` / `interview` policy では、既定 active skill を以下とする。

- `axis_hold_dialogue`
- `b_roll_bridge`
- `build_to_peak`
- `reveal_then_payoff`
- `silence_beat`
- `shot_reverse_reaction`

conditional:

- `punch_in_emphasis`
  - face + intensity 条件を満たす場合のみ
- `cooldown_resolve`
  - closing / release beat がある場合のみ

suppressed by default:

- `smash_cut_energy`
- `deliberate_axis_break`
- `crosscut_suspense`
- `montage_compress`
- `j_cut_lead_in`
- `l_cut_reaction_hold`
- `cutaway_repair`
- `talking_head_pacing`

## 3. Profile / Policy 統合

### Resolution Flow

profile / policy は 2 段階で解決する。

1. `creative_brief.yaml`
   - explicit hint があれば採用
2. `/blueprint`
   - hint がなければ structured brief field + `/triage` summary から infer

`creative_brief.yaml` additive extension:

- `editorial`
  - `distribution_channel`
    - `web_lp | social_feed | product_page | presentation | event_recap | unknown`
  - `aspect_ratio`
    - `16:9 | 9:16 | 1:1 | 4:5 | unknown`
  - `embed_context`
    - `standalone | lp_embed | deck_insert | kiosk | unknown`
  - `hook_priority`
    - `credibility_first | balanced | aggressive`
  - `credibility_bias`
    - `high | medium | low`
  - `profile_hint`
  - `policy_hint`
  - `allow_inference`

resolved value は `edit_blueprint.yaml` に書く。
canonical source of truth は `resolved_profile` / `resolved_policy` であり、
creative brief の hint は request にすぎない。

M4.5 では free-form prose からの profile inference は行わない。
`allow_inference = true` かつ required structured field が揃っている場合だけ infer し、
条件を満たさなければ `uncertainty_register.yaml` に `insufficient_editorial_signal` を記録して
explicit hint を要求する。

### Inference Rules

初期 rule は deterministic table に限定する。文字列 heuristics は使わない。

| Structured condition | Resolved profile |
| --- | --- |
| `profile_hint` exists | hint をそのまま採用 |
| `dominant_visual_mode = screen_demo` | `product-demo` |
| `speaker_topology = solo_primary` + `aspect_ratio = 16:9` + `runtime_target_sec = 40-90` + `hook_priority != aggressive` | `interview-highlight` |
| `speaker_topology = solo_primary` + `embed_context = lp_embed` + `hook_priority = aggressive` + `runtime_target_sec <= 60` | `lp-testimonial` |
| `transcript_density = dense` + `runtime_target_sec >= 90` + `credibility_bias = high` | `lecture-highlight` |
| `dominant_visual_mode = event_broll` + `motion_profile = high` + `aspect_ratio = 9:16` | `event-recap` |
| `aspect_ratio = 9:16` + `runtime_target_sec <= 45` + `hook_priority = aggressive` | `vertical-short` |
| `profile_hint = interview-pro-highlight` | `interview-pro-highlight` |

policy default mapping:

| Profile | Default policy |
| --- | --- |
| `interview-highlight` | `interview` |
| `interview-pro-highlight` | `interview` |
| `lp-testimonial` | `interview` |
| `lecture-highlight` | `tutorial` |
| `product-demo` | `tutorial` |
| `event-recap` | `highlight` |
| `vertical-short` | `highlight` |

override:

- brief に chronology 必須がある場合
  - `event-recap` でも `chronological-recap` へ切り替えてよい
- `credibility_bias = high` かつ `hook_priority = credibility_first` の場合
  - `lecture-highlight` / `interview-highlight` を `documentary` policy に切り替えてよい

### Profile -> Compiler Defaults

profile は旧 repo の巨大 YAML をそのまま移さず、v2 compiler が本当に使う default に正規化する。

最低限移すもの:

- `target_duration_sec`
- `opening_cadence` / `middle_cadence` / `ending_cadence`
- `max_shot_length_frames`
- `default_transition`
- `crossfade_frames`
- `adjacency_penalty_overrides`
- `dedupe_threshold_overrides`
- `active_editing_skills`
- `quality_target_overrides`
- `trim_policy_overrides`

`resolved_profile` には compile-relevant snapshot も残す。

- `defaults.duration_target_sec_snapshot`
- `defaults.active_editing_skills_snapshot`
- `defaults.trim_policy_snapshot`

移さないもの:

- 旧 repo 固有の provider 名
- caption font サイズや loudness など、M4 packaging plane が持つべき detail

### Policy -> Blueprint Constraints

旧 policy の主要 field は `edit_blueprint.yaml` に以下のように投影する。

| Policy field | v2 projection |
| --- | --- |
| `timeline_template` | `story_arc.strategy` |
| `chronology_bias` | `story_arc.chronology_bias` + `allow_time_reorder` |
| `tempo` | `pacing.*_cadence` と trim bias |
| `avoid_mid_sentence` | `dialogue_policy.preserve_natural_breath` + resolve hard guard |
| `avoid_mid_action` | `trim_policy.action_cut_guard` |
| `identity_continuity` | adjacency / same-speaker continuity penalty |
| `selection_weights` | compiler score weights override |
| `output.duration_sec` | `pacing.default_duration_target_sec` |

これにより policy は prose ではなく compiler-consumable な constraint になる。
`confirmed_preferences` は別途、human-confirmed または autonomous planner-confirmed な意思決定だけに使う。

## 4. Interest Point 強化

### Current Gap

M2 で `segments.json.interest_points[]` は既に存在するが、現状 compiler はこれを読まず、
`selects_candidates.yaml` の固定 `src_in_us / src_out_us` をそのまま使う。

その結果:

- 同一 long segment から少しずつずれた subclip が繰り返されやすい
- center-first ではなく range-first なので「面白い瞬間の周辺を切る」編集にならない
- `silence_beat`, `punch_in_emphasis`, `cooldown_resolve` などの supported skill が trim と連携できない

### Additive Contract

`selects_candidates.yaml` には fixed range を残しつつ、adaptive trim hint を追加する。

- `src_in_us` / `src_out_us`
  - authored safety window
- `trim_hint.source_center_us`
  - center point
- `trim_hint.preferred_duration_us`
  - ideal
- `trim_hint.min_duration_us`
  - lower bound
- `trim_hint.max_duration_us`
  - upper bound
- `trim_hint.window_start_us` / `window_end_us`
  - hard clamp
- `trim_hint.interest_point_label`
- `trim_hint.interest_point_confidence`

### Compiler Logic

M4.5 では `resolve` の前に trim subphase を追加する。

1. center を決める
   - `trim_hint.source_center_us` があれば最優先
   - なければ candidate range 内の highest-confidence `interest_point`
   - どちらもなければ midpoint
2. desired duration を決める
   - beat target duration
   - profile default
     - Phase 3 単独導入時は未解決なら使わない
   - skill bias
   を合成し、`preferred / min / max` で clamp する
3. asymmetry を適用する
   - `dialogue`
     - pre-roll をやや長くする
   - `reaction` / `silence_beat` / `cooldown_resolve`
     - post-roll をやや長くする
   - `build_to_peak` / `smash_cut_energy`
     - center を payoff 側へ寄せる
4. authored window に clamp する
5. result を `candidate_ref` に紐づく resolved trim として記録する
6. `timeline.json.clip.metadata.trim` に残す

### `timeline.json` Reflection

`clip.metadata.editorial` の内訳は既存 extension point を使うが、
`candidate_ref` / `fallback_candidate_refs` と provenance hash は additive schema extension として明示する。

`clip.metadata.editorial` 例:

- `resolved_profile`
- `resolved_policy`
- `applied_skills`
- `candidate_ref`
- `trim`
  - `mode`
  - `source_center_us`
  - `preferred_duration_us`
  - `resolved_src_in_us`
  - `resolved_src_out_us`
  - `interest_point_label`

`timeline.json` top-level additive field:

- `provenance.compiler_defaults_hash`
- `provenance.editorial_registry_hash`

`clip` additive field:

- `candidate_ref`
- `fallback_candidate_refs`

これにより M3.5 handoff や M4 packaging は canonical surface を壊さずに編集意図を参照できる。
review patch safety も `fallback_candidate_refs` を正として使える。

## Non-Functional Requirements

- deterministic ownership
  - compiler は remote API を呼ばない
  - Phase D evaluation も remote API を呼ばない
- compatibility
  - 新 field 不在時は現行 compile path を使う
  - 新 operational artifact 不在でも canonical compile / review は継続できる
  - `candidate_id` 不在の legacy selects は in-memory shim で fail-open する
- complexity budget
  - score / assemble / resolve は `O(beats * candidates)` を大きく超えない
  - candidate signal は skill 実装に必要な最小 subset に限定する
- state safety
  - M4.5 では新 state を追加しない
  - planning gate / compile gate / review gate の意味は変えない
- freshness
  - operational artifact は `/blueprint` ごとに再生成し、freshness は
    `brief_hash`, `selects_hash`, `style_hash` から導く
  - stale 判定の canonical source of truth は引き続き `edit_blueprint.yaml` と `uncertainty_register.yaml`
- observability
  - applied skill、resolved profile / policy、trim provenance は `timeline.json.clip.metadata.editorial` に残す
  - `compiler_defaults_hash` と `editorial_registry_hash` を `timeline.json.provenance` に残す
  - review report は profile / skill mismatch を明示的に指摘できること

## Command / Runtime Changes

M4.5 で主に手を入れる場所は以下である。

- commands
  - `runtime/commands/intent.ts`
  - `runtime/commands/triage.ts`
  - `runtime/commands/blueprint.ts`
  - `runtime/commands/review.ts`
- role prompts
  - `agent-src/roles/intent-interviewer.yaml`
  - `agent-src/roles/footage-triager.yaml`
  - `agent-src/roles/blueprint-planner.yaml`
  - `agent-src/roles/roughcut-critic.yaml`
- compiler
  - `runtime/compiler/types.ts`
  - `runtime/compiler/normalize.ts`
  - `runtime/compiler/score.ts`
  - `runtime/compiler/assemble.ts`
  - `runtime/compiler/resolve.ts`
  - `runtime/compiler/patch.ts`
  - `runtime/compiler/export.ts`
  - new `runtime/compiler/trim.ts`
- editorial resolver
  - new `runtime/editorial/*.ts`
  - new `runtime/editorial/{profiles,policies,skills}/*.yaml`
- schemas
  - `creative-brief.schema.json`
  - `selects-candidates.schema.json`
  - `edit-blueprint.schema.json`
  - `timeline-ir.schema.json`
  - `review-patch.schema.json`
  - new operational schemas

## Roughcut Critic Integration

`roughcut-critic` は以下を追加で読む。

- `resolved_profile`
- `resolved_policy`
- `active_editing_skills`
- `story_arc`
- `quality_targets`
- `candidate_plan`
- `timeline clips[].candidate_ref`
- `timeline clips[].fallback_candidate_refs`

追加観点:

- continuity break が intentional skill か accidental bug か
- `interview` policy なのに `smash_cut_energy` 的な tone break がないか
- `highlight` policy なのに hook density が低すぎないか
- `story_arc.causal_links` に対して timeline の reveal order が崩れていないか
- patch の replacement source が `fallback_candidate_refs` に含まれているか

旧 `narrative-continuity-review` はここでも再利用し、
timeline 上の regression を `mismatches_to_blueprint` として出せるようにする。

## Implementation Order

### Phase 1: Candidate Ref And Schema Spine

やること:

- `candidate_id` / `candidate_ref` contract を追加
- `timeline-ir` / `review-patch` まで含めて schema に additive field を追加
- legacy shim を定義する
- 旧 artifact が field 不在でも validate / compile できるようにする

Done when:

- schema regression が壊れない
- `candidate_ref` が downstream field 名として固定される
- old fixture compile が従来どおり通る

### Phase 2: `/triage` Signal Generation

やること:

- `/triage` が `trim_hint` と supported `editorial_signals` を出力する
- `editorial_summary` を canonicalize する
- `candidate_id` を deterministic に付与する

Done when:

- producer のいない signal field がなくなる
- `selects_candidates.yaml` だけで adaptive trim と profile inference の前提が満たせる

### Phase 3: Adaptive Trim

やること:

- `trim_hint` contract
- trim subphase
- `interest_points` 由来の center-based in/out

Done when:

- fixed range だけでなく center-based trim が効く
- same long segment の微ズレ連打が減る

### Phase 4: Profile / Policy Resolution

やること:

- `creative_brief.editorial` structured field 追加
- explicit / inferred resolution
- `edit_blueprint.yaml.resolved_profile` / `resolved_policy` 出力
- `pacing.default_duration_target_sec` 追加

Done when:

- structured signal だけで profile が再現可能に解決される
- no-hint / signal 不足時は deterministic に blocker へ落とせる

### Phase 5: `/blueprint` Internal Script Engine

やること:

- `message_frame.yaml`
- `material_reading.yaml`
- `script_draft.yaml`
- `script_evaluation.yaml`
- `edit_blueprint.yaml` への projection

Done when:

- `/blueprint` が single entrypoint のまま 4 フェーズ artifact を書ける
- `script_draft` / `script_evaluation` / `edit_blueprint` が `candidate_ref` ベースで揃う
- closing unsupported は fail-closed する

### Phase 6: Skill-Aware Compiler

やること:

- supported skill だけを score / assemble / resolve に追加
- `clip.metadata.editorial` を export

Done when:

- profile ごとに supported active skill が変わる
- same fixture で interview / highlight の compile behavior 差が説明可能になる
- deferred skill が compile path に入らない

### Phase 7: Review And Regression Gates

やること:

- roughcut-critic prompt 更新
- patch safety を `candidate_ref` 前提に更新
- integration / e2e fixture 追加

Done when:

- review report が profile / skill misuse を検出できる
- review patch safety が `fallback_candidate_refs` を使って判定できる
- M1-M4 の baseline fixture が壊れない

### Deferred Milestone: Editorial IR Expansion

M4.5 の完了条件には含めないが、以下は別 milestone で扱う。

- within-beat clip list
- thread / section id
- audio lead / lag primitive
- overlap-aware transition spec
- deferred skill の再導入

## Validation Strategy

unit:

- schema validation for additive fields
- `candidate_id` generation / legacy shim
- `candidate_ref` propagation
- `/triage` signal normalization
- profile / policy resolution
- supported skill activation matrix
- dedupe hard / soft rules
- trim center resolution
- timeline provenance hash emission
- review patch candidate_ref safety

integration:

- `/intent -> /triage -> /blueprint` で operational artifact 生成
- `edit_blueprint.yaml` から supported skill-aware compile
- `review` で profile-aware mismatch detection

e2e:

- `interview-highlight`
- `lp-testimonial`
- `product-demo`
- `event-recap`
- `vertical-short`

non-regression:

- 新 field なしの legacy fixture は現行 M4 と同等の compile result を出す
- new field が無効なときは old path に fail-open する
- deferred skill が registry に存在しても compile behavior は変わらない

## Migration Plan

導入は additive migration で行う。

1. schema を先に広げる
   - 旧 artifact はそのまま valid
2. `candidate_id` / `candidate_ref` と `/triage` signal を追加する
   - まだ compiler behavior は変えない
3. adaptive trim を単独で有効化する
   - field 不在時は midpoint / fixed range fallback
4. profile / policy resolver を structured brief field 前提で追加する
5. `/blueprint` が operational artifact を書けるようにする
   - canonical output は従来のまま
6. compiler が supported skill と new field を読めるようにする
   - field 不在時は old path
7. roughcut-critic を new field aware にする

rollback 条件:

- compile regression が 1 つでも出た場合
- old fixture の byte-level または semantic regression が説明不能な場合
- adaptive trim で same-source repetition が改善せず continuity を悪化させる場合

## Risks And Rollback

### Risks

- schema surface を広げすぎると `/triage` と `/blueprint` の責務が曖昧になる
- skill ごとの required signal を広げすぎると `selects_candidates.yaml` が肥大化する
- `interest_points` quality が低い素材では adaptive trim が逆効果になる
- profile inference を強くしすぎると user intent より template が勝つ
- `candidate_ref` と legacy `segment_id` の二重系が長く残ると safety guard が複雑化する

### Mitigation

- canonical artifact には distilled contract だけを残し、中間情報は operational artifact に分離する
- signal は旧 skill の prose を実装する minimal subset に限定する
- adaptive trim は `trim_hint` 不在時に midpoint fallback し、profile ごとに opt-in にする
- explicit `profile_hint` / `policy_hint` は inference より常に優先する
- patch safety / fallback は `candidate_ref` を正、`segment_id` を legacy compatibility として扱う

### Rollback

- feature flag 的に field presence で有効化する
- `resolved_profile` / `active_editing_skills` / `trim_hint` / `candidate_ref` がない場合は current compiler path を使う
- state machine と canonical artifact 名は変えないため、M4 baseline へ戻しやすい

## Final Design Decision

M4.5 では、旧 repo の知見を「prompt を長くする」だけでは移植しない。
移植単位は以下とする。

- stable candidate reference
  - `candidate_id` formalization + downstream `candidate_ref`
- triage signal spine
  - `trim_hint` + minimal editorial signal + `editorial_summary`
- Script Engine
  - `/blueprint` 内部の operational artifact と candidate_ref-aware evaluation rule
- editing skill
  - 現行 IR で表現できる subset の registry + compiler hook
- profile / policy
  - structured brief field 前提の resolver + blueprint contract
- interest point
  - adaptive trim hint + resolve subphase

これにより、旧 repo の narrative intelligence を v2 の artifact-first / compiler-owned architecture に適合させつつ、
M1-M4 の gate と canonical truth を維持できる。
scene / interleave / overlap 系 skill は、IR 拡張を伴う別 milestone で扱う。
