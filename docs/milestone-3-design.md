# Milestone 3 Design

## Scope

Milestone 3 は、Milestone 2 で live 化された `03_analysis/` evidence layer を前提に、4 つの
product-plane agent を Claude Code / Codex の interactive mode で運用し、operator が
multi-session で editorial loop を回せるようにする milestone である。

M3 で追加するのは「reasoning の運用面」であり、deterministic engine の責務は引き続き分離する。
agent は artifact を提案し、validator と engine が gate を担保する。`timeline.json` は compiler
のみが更新し、preview / QC / patch apply も deterministic runtime 側で実行する。

### In Scope

- 4 つの product-plane agent の interactive 運用
  - `intent-interviewer`
  - `footage-triager`
  - `blueprint-planner`
  - `roughcut-critic`
- `.claude/commands/` と `.codex/commands/` による `/intent`, `/triage`, `/blueprint`,
  `/review`, `/status`, `/export`
- `projects/*/project_state.yaml` の永続化、session 復帰、state reconcile
- agent output の draft 化、schema validate 後 promotion、downstream invalidation
- `timeline.json` から `review.mp4` と QC を作る deterministic review preflight
- 実素材 2 ケースでの E2E smoke
  - `sample-bicycle`
  - `AX-1 D4887`

### Out Of Scope

- OTIO handoff / re-import / diff の round-trip 本体
- caption / audio mastering / final packaging
- remote API fallback を前提にした headless orchestration
- M1/M2 の media-mcp surface 変更
- M1/M2 compiler の scoring policy や deterministic phase 変更

### Contract Rule

M3 は M1/M2 の契約意味論を壊さない。既存 field の rename / remove / semantic change は行わない。
必要な schema 変更は additive extension のみとする。

- 新規 schema:
  - `project-state.schema.json`
  - `human-notes.schema.json`
- additive field:
  - `creative_brief.yaml > autonomy.mode`
  - `edit_blueprint.yaml > pacing.confirmed_preferences`

既存 consumer はこれらの追加 field を無視しても動作できることを条件にする。

### Success Criteria

Milestone 3 は、以下がすべて満たされたとき完了とする。

1. operator が `/intent` から `/review` までを interactive に実行でき、各段階で
   schema-valid な canonical artifact のみが確定される。
2. `project_state.yaml` が state machine の現在位置、gate 状態、resume 可能な pending step、
   `approval_record` / `analysis_override` / `style_hash` / `human_notes_hash` を永続化し、
   session を跨いでも `/status` が正しい再開地点を復元できる。
3. `footage-triager` は M2 の live `03_analysis/` と既存 `media-mcp` tools だけを使って
   `selects_candidates.yaml` を生成できる。
4. `blueprint-planner` は `autonomy.mode` に従い、`collaborative` のときは preference
   interview を必ず実行し、その結果を `pacing.confirmed_preferences` に残す。
5. `/review` は `blueprint_ready` からでも deterministic compile -> preview render -> QC ->
   critique まで進められ、`review_report.yaml` と `review_patch.json` を生成できる。
6. `roughcut-critic` は `human_notes.yaml` を優先 evidence として取り込み、unsafe な patch を
   emit せず、safe でない論点は report-only に落とせる。
7. fixture project で mock LLM ベースの full loop test が通る。
8. 実素材 2 ケースで human-in-the-loop の smoke を回し、少なくとも `critique_ready` まで
   到達できる。

### Test Gates

上記 success criteria は以下の gate で受け入れる。

- unit:
  - project state reconcile / transition / invalidation
  - agent artifact promotion と schema repair
  - autonomy mode と preference interview branching
  - roughcut patch safety rule
- integration:
  - slash command preflight
  - mock LLM role run -> artifact validation -> state update
  - `/review` preflight の compile / render / QC handoff
- e2e:
  - `projects/sample/` を使った interactive loop の mock end-to-end
  - `sample-bicycle` と `AX-1 D4887` の manual smoke
- manual:
  - candidate approval
  - preference confirmation
  - preview judgment
  - final acceptance / override

### M2 To M3 Connection

M3 が M2 から受け取る surface は 2 つだけである。

- canonical analysis artifacts under `projects/*/03_analysis/`
- それを背後に持つ unchanged `media-mcp`

M3 は raw connector output を直接読む必要がある場合でも、creative reasoning の主要入口は
`media-mcp` とする。role prompt が raw `03_analysis/*.json` を直読みに依存してよいのは
fixture/debug と validator 補助に限る。`footage-triager` は `media.project_summary` の
`qc_status` が `ready` であることを preflight gate とし、`partial` は debug/manual
investigation 用に限定する。

このため、M2 が担う state transition は引き続き `intent_locked -> media_analyzed` であり、M3 は
`media_analyzed` 以降の editorial loop に責務を限定する。

### M3 To M3.5 Handoff

M3.5 に入る前に、M3 で以下が整っている必要がある。

- `project_state.yaml` により multi-session resume が安定している
- `timeline.json` の `clip_id`, `segment_id`, `fallback_segment_ids`, provenance が stable
- `/review` が `human_notes.yaml` を取り込み、AI critique と human feedback を同じ loop に載せられる
- `/export` が round-trip 前の review bundle を吐ける
- `approved` までの gate が artifact と state の双方で追跡でき、
  `approval_record` により clean approval / creative override を self-heal できる

M3 の `/export` は review bundle までを扱う。OTIO handoff 自体は M3.5 の責務とし、
`packaged` state は M3 では積極利用しない。

## Common Agent Contract

4 role すべてに共通する実行 contract を先に固定する。

### Draft Then Promote

agent は canonical path に直接 final write しない。各 command は role ごとに draft path を発行し、
validator 通過後に atomic promote する。

共通フロー:

1. command が `project_state.yaml` を読み、artifact hash と gate を reconcile する
2. role agent に canonical input path、draft output path、allowed tools を渡す
3. agent は draft artifact を書く
4. targeted schema validation を実行する
5. validate 失敗時は canonical artifact を保持したまま repair loop に戻す
6. validate 成功時のみ canonical path に promote し、`project_state.yaml` を更新する

この rule により、interactive mode でも「invalid artifact が canonical directory に残る」状態を
作らない。

### Human Confirmation Shape

各 role は次の 3 phase を共通に持つ。

1. evidence gathering
2. draft proposal
3. human confirmation

ただし confirmation の深さは role ごとに異なる。

- `intent-interviewer`: brief readback の確認が必須
- `footage-triager`: candidate board approval が必須
- `blueprint-planner`: autonomy に応じて preference interview が必須
- `roughcut-critic`: human notes があれば必ず優先し、report の最終判断を operator が受ける

### Runtime Invariants

- agent は final media を直接書かない
- agent は `timeline.json` を直接 mutate しない
- `review_patch.json` は allowed patch ops のみ
- slash command は preflight / validation / state update の薄い wrapper であり、business rule は
  shared runtime 側に寄せる

## Product Agent Design

### 1. `intent-interviewer`

`intent-interviewer` は人間との対話から `creative_brief.yaml` と
`unresolved_blockers.yaml` を生成する。

#### Input / Output

- inputs:
  - operator conversation
  - meeting notes
  - reference board
  - project brief
  - existing `project_state.yaml`
- outputs:
  - `01_intent/creative_brief.yaml`
  - `01_intent/unresolved_blockers.yaml`

#### Dialogue Flow

対話フローは固定する。

1. purpose capture
   - 何を作るか
   - 誰に向けるか
   - 何を感じてほしいか
2. constraint capture
   - must-have
   - must-avoid
   - forbidden interpretations
3. autonomy capture
   - 何を AI が決めてよいか
   - 何は必ず人に確認すべきか
4. blocker extraction
   - later editorial choice を不可逆に変える論点を blocker 化
5. structured readback
   - brief 要約を返し、operator が承認 / 修正

#### Autonomy Handling

M1 schema を壊さずに `full / collaborative` を扱うため、`creative_brief.yaml > autonomy` は
以下の shape を取る。M3 で新規に確定する brief では `mode` を必須 field とする。

- `mode: full | collaborative`
- `may_decide: []`
- `must_ask: []`

運用ルール:

- `full`
  - operator は brief-level で承認し、以後の pacing / structure / duration の詳細は AI に委譲する
- `collaborative`
  - operator は later planning の preference confirmation を要求する
  - `blueprint-planner` は pacing / structure / duration を確定前に必ず確認する

後方互換:

- `mode` が absent の旧 brief は `must_ask` が空なら `full`、そうでなければ `collaborative`
  とみなす

#### Finalization Rule

`creative_brief.yaml` と `unresolved_blockers.yaml` は、両方が schema-valid になって初めて確定する。
片方だけ valid でも promote しない。

成功時:

- `current_state` は `intent_locked`
- downstream hash を無効化する
- 既存 `04_plan/`, `05_timeline/`, `06_review/` が stale なら `/status` で再生成を要求する

### 2. `footage-triager`

`footage-triager` は M2 analysis artifacts と `media-mcp` を evidence layer として使い、
`selects_candidates.yaml` を生成する。

#### Input / Output

- inputs:
  - `creative_brief.yaml`
  - `03_analysis/assets.json`
  - `03_analysis/segments.json`
  - `03_analysis/transcripts/*.json`
  - `media-mcp`
- output:
  - `04_plan/selects_candidates.yaml`

#### Evidence Access Pattern

triager は以下の順序で evidence を集める。

1. `media.project_summary`
   - `qc_status`, `analysis_gaps`, `top_motifs` の確認
2. `media.list_assets`
   - asset landscape の俯瞰
3. `media.search_segments`
   - brief message, must-have, emotion curve を query に変換
4. `media.peek_segment`, `media.open_contact_sheet`
   - visual confirmation
5. `media.read_transcript_span`
   - dialogue candidate の line verification
6. `media.extract_window`
   - 曖昧な candidate の追加 inspection

media-mcp contract 自体は変更しない。triager は existing tool surface のみで reasoning する。

#### Source-Class Assignment

triager は canonical role を付ける前に、segment を内部的に以下の source class に分ける。

- `interview`
  - transcript density が高く、line が message に寄与する
- `b-roll`
  - motion / action / context coverage が中心で、dialogue 依存が低い
- `texture`
  - insert, atmosphere, motif close-up, environmental cutaway
- `hybrid`
  - spoken content と visual action の両方が強い

この source class は triager の reasoning 用であり、canonical artifact に保存する role は既存 schema の
`hero | support | transition | texture | dialogue | reject` のみとする。

#### Evidence-Based Candidate Scoring

候補 scoring は deterministic ではなく triager reasoning の一部だが、判断材料は固定する。

- brief/message match
- must-have / must-avoid fit
- transcript relevance
- visual motif relevance
- technical quality
- repetition risk
- asset diversity
- downstream role utility

score の説明責任は `why_it_matches`, `risks`, `confidence`, `evidence`, `quality_flags` に落とす。
raw guesswork は禁止し、reason は必ず analysis data に anchored させる。

#### Human Confirmation

triager 完了前に operator へ candidate board を提示する。

提示単位:

- role ごとの top candidates
- reject candidates と rejection reason
- transcript-backed dialogue lines
- technical risk summary

operator action:

- approve
- drop candidate
- request more in a role bucket
- narrow the brief emphasis

approval 後に schema validate し、成功時に `current_state` を `selects_ready` に進める。

### 3. `blueprint-planner`

`blueprint-planner` は brief と selects を beat sheet に変換し、
`edit_blueprint.yaml` と `uncertainty_register.yaml` を生成する。

#### Input / Output

- inputs:
  - `creative_brief.yaml`
  - `unresolved_blockers.yaml`
  - `selects_candidates.yaml`
  - optional `STYLE.md`
- outputs:
  - `04_plan/edit_blueprint.yaml`
  - `04_plan/uncertainty_register.yaml`

#### Planning Flow

1. brief / selects / STYLE synthesis
2. sequence goals と beat candidates の生成
3. preference interview
4. beat proposal readback
5. uncertainty extraction
6. schema validate and promote

#### Preference Interview

`autonomy.mode` に応じて flow を分岐する。

- `full`
  - planner が pacing / structure / duration を自律決定する
  - ただし readback は行う
- `collaborative`
  - planner は final beat sheet の前に以下 3 点を必ず確認する
    - pacing
    - structure
    - duration

`edit_blueprint.yaml > pacing.confirmed_preferences` は additive field として追加する。
M3 では推奨 shape ではなく固定 contract とし、required field は以下とする。

- `mode`
- `source`
- `duration_target_sec`
- `confirmed_at`
- optional `structure_choice`
- optional `pacing_notes`

`mode` は `creative_brief.yaml > autonomy.mode` を mirror する。`source` は
`human_confirmed` または `ai_autonomous` を取り、`collaborative` では前者、`full` では
後者を必須にする。旧 brief に `autonomy.mode` が存在しない場合は read-time で推定してよいが、
次回 `/intent` で canonical rewrite が走った時点で field を materialize する。

#### Beat Proposal And Confirmation

planner は beat をいきなり確定しない。まず operator に以下を readback する。

- sequence goal の要約
- beat 数と各 beat の目的
- runtime target と配分
- major alternatives
- open uncertainties

operator が承認した版のみ draft artifact 化し、schema validate 後 promote する。

#### Uncertainty Handling

`uncertainty_register.yaml` は ambiguity を放置せず構造化するための artifact である。

- tolerable ambiguity:
  - `status: open | monitoring | resolved | waived`
- planning-blocking ambiguity:
  - `status: blocker`
  - `escalation_required: true`

M3 では compiler contract を変えないため、hard compile gate は引き続き
`unresolved_blockers.yaml` が支配する。一方で slash command runtime は
`uncertainty_register.yaml` に `status: blocker` が残る間、`planning_gate` を `blocked` にし、
`/review` による compile 開始を拒否する。

この差分は `/status` に明示する。

#### Finalization Rule

成功時の state は以下のいずれか。

- `blueprint_ready`
  - preference interview 解決済み
  - planning blocker なし
- `blocked`
  - unresolved blocker または planning blocker が残る

### 4. `roughcut-critic`

`roughcut-critic` は `timeline.json` と preview を評価し、
`review_report.yaml` と `review_patch.json` を生成する。

#### Input / Output

- inputs:
  - `creative_brief.yaml`
  - `edit_blueprint.yaml`
  - `05_timeline/timeline.json`
  - `05_timeline/review.mp4`
  - optional `06_review/human_notes.yaml`
  - optional `STYLE.md`
- outputs:
  - `06_review/review_report.yaml`
  - `06_review/review_patch.json`

#### Critique Baseline

critic は既存 M1 compiler 出力を以下の順序で評価する。

1. factual mismatches to brief
   - must-have 欠落
   - must-avoid 違反
   - message / audience drift
2. factual mismatches to blueprint
   - beat purpose 不履行
   - required role coverage 不足
   - target duration / pacing の逸脱
3. technical deliverability
   - Gate 2 invalid
   - QC fatal / warning
   - source-range risk
   - repeated quality issue overexposure
4. craft / style
   - STYLE.md 不一致
   - taste-level improvement

この順序を固定することで、taste が factual mismatch を上書きしないようにする。

#### Review Preflight

`/review` は `timeline_drafted` が未成立でも、`blueprint_ready` から以下を自動で実行してよい。

1. `compile`
2. `render_preview`
3. `run_qc`
4. `roughcut-critic`

ただし preflight は deterministic step のみであり、agent 自身は compile / render / QC を実行しない。

#### Patch Generation Rule

`review_patch.json` は safe op のみを emit する。

- `trim_segment`
  - in/out exposure 問題
- `move_segment`
  - beat order / pacing correction
- `remove_segment`
  - redundant or harmful clip
- `change_audio_policy`
  - wind / dialogue / nat sound balance
- `add_marker`, `add_note`
  - manual follow-up
- `replace_segment`
  - `target_clip_id` が持つ `fallback_segment_ids` か、`human_notes.yaml` の
    `directive_type: replace_segment` note が machine-readable に示した
    `approved_segment_ids` に限定
- `insert_segment`
  - deterministic な insertion target と source id が揃い、human note 起点の場合は
    `directive_type: insert_segment` と machine-readable な timeline anchor がある場合のみ

safe replacement source が存在しない場合は、critic は issue を report に残すだけで patch を出さない。
これにより role prompt の「critique するが re-edit しない」を保つ。

#### Human Review Receptacle

`human_notes.yaml` は M3 で schema 化する。roughcut-critic は以下の優先順で読む。

1. human note
2. brief / blueprint mismatch
3. preview / QC observation
4. AI-only taste judgment

human note が AI 判断と矛盾する場合、critic は human note を report 本文に採用し、AI 側は
alternative direction として退避する。

`human-notes.schema.json` の最低 shape は template に揃えつつ、safe patch rule に必要な
machine-readable fields を追加する。

- root:
  - `version`
  - `project_id`
  - `notes`
- note item:
  - `id`
  - `timestamp`
  - `reviewer`
  - `observation`
  - `severity`
  - optional `directive_type`
  - optional `clip_ids`
  - optional `clip_refs`
  - optional `approved_segment_ids`
  - optional `timeline_in_frame`
  - optional `timeline_us`
  - optional `timeline_tc`

`clip_ids`, `approved_segment_ids`, `timeline_in_frame`, `timeline_us` を machine source of truth とし、
`clip_refs` と `timeline_tc` は human-readable / legacy compatibility 用に残す。M3 runtime は
`directive_type` と machine-readable anchor が揃った note だけを patch safety 判定に使い、
それ以外の human note は report-only evidence として扱う。
`directive_type` は少なくとも `observation | replace_segment | insert_segment | remove_segment |
move_segment | trim_segment` を取れるものとして schema を固定する。

#### Finalization Rule

`review_report.yaml` と `review_patch.json` が schema-valid なら `critique_ready` に進める。

その後:

- `fatal_issues` が空で、operator が accept した場合は `approved`
  - `project_state.yaml > approval_record.status = clean`
  - `approved_by`, `approved_at`, `artifact_versions` を確定する
- `fatal_issues` が残っていても、operator が explicit creative override を行う場合は `approved`
  - `project_state.yaml > approval_record.status = creative_override`
  - `approved_by`, `approved_at`, `override_reason`, `artifact_versions` を必須にする
- patch を apply する場合は `timeline_drafted` に戻り、再度 `/review` を回す

## Slash Command Design

`.claude/commands/` と `.codex/commands/` は同じ 6 command を持ち、内容は thin wrapper に揃える。
business rule は共通 runtime に寄せ、command ファイルは project path 解決と role 起動だけを担当する。

### Command Definition Pattern

各 command file は runtime 間で分岐した business logic を持たない。共通パターンは以下とする。

1. project root 解決
2. `project_state.yaml` reconcile
3. allowed start state の確認
4. 必要なら deterministic preflight 実行
5. 対応 role agent 起動
6. validate / promote / state update

Claude 側と Codex 側の差分は launcher 記法だけに閉じ、preflight / gate / promotion は同じ shared
runtime module を使う。

### Command Set

| Command | Primary action | Allowed start states | Success state |
| --- | --- | --- | --- |
| `/intent` | intent interview -> brief/blockers | any | `intent_locked` |
| `/triage` | analysis consume -> selects | `media_analyzed` 以降 | `selects_ready` |
| `/blueprint` | plan + preference interview | `selects_ready` 以降 | `blueprint_ready` or `blocked` |
| `/review` | compile/render/qc if needed -> critique | `blueprint_ready` 以降 | `critique_ready` or `approved` |
| `/status` | reconcile + next-step summary | any | state unchanged |
| `/export` | review bundle export | `critique_ready` 以降 | state unchanged |

### Start-State Rules

- `/intent`
  - rerun 可能
  - brief hash が変わったら downstream artifacts を stale 扱いにする
- `/triage`
  - `analysis_gate == ready` または `analysis_gate == partial_override` が前提
  - `partial` のときは default で拒否し、manual override 時のみ debug run として扱う
  - manual override は `project_state.yaml > analysis_override` に
    `approved_by`, `approved_at`, `reason`, `scope`, `artifact_version` を記録する
- `/blueprint`
  - valid selects が必要
- `/review`
  - `blueprint_ready` から開始可能
  - timeline / preview が stale なら deterministic preflight で補完する
- `/export`
  - M3 では `critique_ready` または `approved` からのみ実行できる
  - manifest には `approval_status` と `analysis_override_status` を入れて clean / override /
    degraded path を区別する

### Transition And Invalidation Rules

upstream artifact が更新されたら、downstream state は deterministic に invalidation する。

- brief changed:
  - invalidate selects / blueprint / timeline / review / approval
  - mark `approval_record` stale
  - state -> `intent_locked`
- analysis artifact version changed:
  - invalidate selects / blueprint / timeline / review / approval
  - clear or stale `analysis_override` when `artifact_version` no longer matches
  - mark `approval_record` stale
  - state -> `media_analyzed`
- selects changed:
  - invalidate blueprint / timeline / review / approval
  - mark `approval_record` stale
  - state -> `selects_ready`
- `STYLE.md` changed:
  - invalidate blueprint / timeline / review / approval
  - mark `approval_record` stale
  - state -> `selects_ready`
- blueprint changed:
  - invalidate timeline / review / approval
  - mark `approval_record` stale
  - state -> `blueprint_ready` or `blocked`
- timeline changed:
  - invalidate review / approval
  - mark `approval_record` stale
  - state -> `timeline_drafted`
- `human_notes.yaml` changed:
  - invalidate review / approval
  - mark `approval_record` stale
  - state -> `timeline_drafted`
- review artifacts changed:
  - invalidate approval only
  - mark `approval_record` stale
  - state -> `critique_ready`

### `/status`

`/status` は単なる read-only summary ではなく、startup reconcile の公開面とする。

表示内容:

- persisted `current_state`
- reconciled state
- gate matrix
  - analysis gate
  - compile gate
  - planning gate
  - timeline gate
  - review gate
- stale artifacts
- next recommended command
- pending human input
- approval / override summary
- active analysis override
- last runtime error

### `/export`

M3 の `/export` は NLE handoff ではなく review bundle を吐く command とする。

bundle 内容:

- canonical artifacts snapshot
- `project_state.yaml`
- optional `STYLE.md`
- optional `human_notes.yaml`
- `review_report.yaml`
- `review_patch.json`
- `review.mp4`
- QC summary
- export manifest

出力先は canonical contract 外の `exports/<timestamp>/` とし、M3.5 で
`handoff_manifest.yaml` / `handoff_timeline.otio` に接続する。

export manifest の最低項目:

- `project_id`
- `exported_at`
- `approval_status`
- `analysis_override_status`
- `current_state`
- `timeline_version`
- `review_report_version`
- `included_files`
- `artifact_hashes`

`approval_status` は `pending | clean | creative_override`、`analysis_override_status` は
`none | active | stale` を取る。

## Project State Persistence

`project_state.yaml` は state machine の cursor だが、唯一の source of truth ではない。
canonical artifacts が真実であり、`project_state.yaml` は resume を速くするための persisted ledger
とする。ただし human accept / creative override / analysis partial override は filesystem だけから
復元できないため、`approval_record` と `analysis_override` は `project_state.yaml` 内の canonical
record として扱う。

### Schema Shape

M3 で `project-state.schema.json` を追加し、少なくとも以下を持たせる。

- root metadata
  - `version`
  - `project_id`
  - `current_state`
  - `last_updated`
  - `last_agent`
  - `last_command`
  - `last_runtime`
- artifact snapshot
  - `brief_hash`
  - `analysis_artifact_version`
  - `selects_hash`
  - `blueprint_hash`
  - `timeline_version`
  - `review_report_version`
  - `review_patch_hash`
  - `human_notes_hash`
  - `style_hash`
- approval / override
  - `approval_record`
    - `status` (`pending | clean | creative_override | stale`)
    - `approved_by`
    - `approved_at`
    - `override_reason`
    - `artifact_versions`
  - `analysis_override`
    - `status` (`none | active | stale`)
    - `approved_by`
    - `approved_at`
    - `reason`
    - `scope`
    - `artifact_version`
- gates
  - `analysis_gate`
  - `compile_gate`
  - `planning_gate`
  - `timeline_gate`
  - `review_gate`
- resume
  - `pending_human_step`
  - `pending_questions`
  - `resume_command`
  - `last_error`
- history
  - `from_state`
  - `to_state`
  - `trigger`
  - `actor`
  - `timestamp`
  - `note`

`projects/_template/project_state.yaml` の現在 shape はこの schema の最小 subset とし、後方互換に保つ。
`approval_record.artifact_versions` は少なくとも `timeline_version`, `review_report_version`,
`review_patch_hash`, `human_notes_hash`, `style_hash` を保持し、approved 判定がどの artifact 集合に
対して行われたかを self-heal 可能にする。

### Reconcile On Startup

各 slash command 起動時に以下を実行する。

1. `project_state.yaml` を読む
2. canonical artifact の存在と hash を確認する
3. `validateProject(project)` を実行する
4. `STYLE.md`, `human_notes.yaml`, `review_patch.json` が存在する場合は hash も更新する
5. 必要なら `media.project_summary` で analysis gate を更新し、`analysis_override.artifact_version`
   が current snapshot と一致するか確認する
6. filesystem から到達可能な highest stable state を再計算する
7. `approved` は `approval_record.status in {clean, creative_override}` かつ
   `approval_record.artifact_versions` が current snapshot と一致する場合にのみ復元する
8. persisted state とズレていたら self-heal して history に記録する

これにより、operator が `scripts/analyze.ts` や `scripts/compile-timeline.ts` を
slash command 外で実行しても、次回 command 起動時に state が追従する。

### Gate Conditions

M3 runtime では 5 つの gate を持つ。

- `analysis_gate`
  - `media.project_summary.qc_status == ready` なら `ready`
  - `media.project_summary.qc_status == partial` かつ current
    `analysis_override.artifact_version == analysis_artifact_version` なら `partial_override`
  - それ以外は `blocked`
- `compile_gate`
  - `validateProject.compile_gate == open`
- `planning_gate`
  - `uncertainty_register.yaml` に planning-blocker がない
- `timeline_gate`
  - `validateProject.gate2_timeline_valid == true`
- `review_gate`
  - `validateProject.gate3_no_fatal_reviews == true`

### State Transition Conditions

`ARCHITECTURE.md` の state machine を M3 runtime に写像すると以下になる。

- `intent_pending -> intent_locked`
  - brief + unresolved blockers valid
- `intent_locked -> media_analyzed`
  - `analysis_gate in {ready, partial_override}`
- `media_analyzed -> selects_ready`
  - selects valid
- `selects_ready -> blueprint_ready`
  - blueprint valid and planning gate open
- `blueprint_ready -> blocked`
  - compile gate blocked or planning gate blocked
- `blocked -> blueprint_ready`
  - blocking condition resolved
- `blueprint_ready -> timeline_drafted`
  - timeline valid and preview fresh
- `timeline_drafted -> critique_ready`
  - review artifacts valid
- `critique_ready -> approved`
  - (`review_gate == open` and operator accept and `approval_record.status == clean`) or
    (operator explicit creative override and `approval_record.status == creative_override` and
    `override_reason` is non-empty)

`packaged` は M4 以降に予約し、M3 では遷移しない。

## Agent Runtime Design

### Interactive Mode Strategy

M3 は `ARCHITECTURE.md` の decision に従い、interactive local runtime を primary にする。

- Claude Code
  - main runtime が `.claude/agents/*.md` を使って role を呼ぶ
- Codex
  - main runtime が `.codex/agents/*.toml` または `codex exec` を使って role を呼ぶ

両 runtime は同じ role prompt と artifact contract を共有し、差分は launcher に閉じる。

### Call Flow

```text
human
  -> slash command
  -> project_state reconcile
  -> role launcher
  -> subagent
  -> media-mcp / canonical artifacts
  -> draft artifacts
  -> schema validator
  -> canonical promotion
  -> project_state update
```

`/review` は deterministic preflight が前段に入る。

```text
/review
  -> reconcile
  -> compile if needed
  -> render_preview if needed
  -> run_qc if needed
  -> roughcut-critic
  -> validate report/patch
  -> state update
```

### Artifact Handoff Between Agents

agent 間受け渡しは canonical artifact のみで行う。

- `intent-interviewer`
  - `creative_brief.yaml`
  - `unresolved_blockers.yaml`
- `footage-triager`
  - `selects_candidates.yaml`
- `blueprint-planner`
  - `edit_blueprint.yaml`
  - `uncertainty_register.yaml`
- deterministic compiler / preview
  - `timeline.json`
  - `review.mp4`
- `roughcut-critic`
  - `review_report.yaml`
  - `review_patch.json`

role-specific memory に依存せず、artifact を通して loop が再開できる構造にする。

### Error Handling

M3 runtime は以下の失敗を first-class に扱う。

- schema invalid draft
  - canonical artifact は保持
  - validator error を agent に返して repair
- media-mcp failure
  - state 不変
  - `last_error` に retryable / non-retryable を記録
- stale upstream artifact
  - command 開始時に invalidate してから進める
- interrupted collaborative step
  - `pending_human_step` を残し、同 command で resume
- concurrent artifact edit
  - preflight hash と post-run hash がズレたら promote を中止する

### Reliability / Auditability Requirements

- same inputs + same approved human answers なら state transition は再現可能であること
- command failure は canonical artifact corruption を起こさないこと
- project_state history から「誰がどの command でどの state に進めたか」を追えること
- test は mock LLM だけで完結し、online model 依存にしないこと

### Security / Permission Boundary

interactive agent は reasoning layer に留め、credential と external execution の境界は runtime 側に固定する。

- provider credential は connector / deterministic runtime のみが参照する
- agent は raw API key を読まない
- ffmpeg / render / QC invocation は shared runtime の固定 entrypoint 経由のみ
- agent が arbitrary shell command を提案しても canonical flow には入れない

## Operational Safety

### Run Logging And Monitoring

M3 は daemon を持たないため、monitoring は lightweight run ledger で代替する。

- command 実行ごとに `command_run_id` を採番する
- 以下を run log に残す
  - command
  - runtime
  - role
  - started_at / finished_at
  - consumed artifact hashes
  - produced artifact hashes
  - validation result
  - final state
  - last_error
- `/status` は直近 failure の要約と retry 推奨 action を表示する

run log は canonical artifact ではなく operational artifact とする。

### Rollback And Recovery

M3 では専用 `/rollback` command は作らないが、artifact promotion 前に直前の canonical file を
non-canonical backup に退避する。

- backup 対象
  - `creative_brief.yaml`
  - `unresolved_blockers.yaml`
  - `selects_candidates.yaml`
  - `edit_blueprint.yaml`
  - `uncertainty_register.yaml`
  - `review_report.yaml`
  - `review_patch.json`
- backup path
  - `.history/<artifact-name>/<timestamp>/`

復旧手順:

1. last known good artifact を restore
2. `/status` を実行
3. reconcile により state を再計算
4. 必要なら upstream command から rerun

preview / export は再生成可能 artifact とみなし、rollback 対象ではなく rerun 対象とする。

## Real-Material E2E Design

M3 の実素材 smoke は 2 ケースに限定する。

### 1. `sample-bicycle`

ローカル確認時点で `子ども自転車` は `28` 本の `MOV` と `1` 本の `mp3` を含む multi-asset set である。
映像は 1920x1080 / 約 29.97fps / audio 付き clip が中心で、family growth record らしい mixed footage
として扱う。

期待フロー:

1. `/intent`
   - growth record の message と audience を固定
   - `collaborative` を default とする
2. M2 analysis
   - `03_analysis/` を live 生成
   - `Pixel Heart Freeway.mp3` は M4 以前の canonical music contract 外なので analysis 対象から外す
3. `/triage`
   - dialogue, b-roll, texture, hybrid を横断して候補抽出
   - repeated motif と coverage bias を human が調整
4. `/blueprint`
   - montage bias が強いため preference interview を必須にする
5. `/review`
   - pacing, chronology drift, repeated family motif を重点確認

期待される challenge:

- 同種 shot の反復
- 成長記録としての時間感覚
- dialogue と observational b-roll の混在

### 2. `AX-1 D4887`

ローカル確認時点で `D4887.MP4` は単体 interview asset であり、約 `331.335` 秒、1920x1080、
約 29.97fps、stereo audio を持つ。

期待フロー:

1. `/intent`
   - testimonial の primary message を固定
2. M2 analysis
   - single-asset analysis
3. `/triage`
   - transcript span を主 evidence に dialogue 候補を抽出
   - pause, gesture, breathing, room-tone を texture / transition 候補として同 asset 内から拾う
4. `/blueprint`
   - single-asset 制約を前提に duration と line ordering を決める
5. `/review`
   - talking-head fatigue、冗長 line、同 asset 連続使用の単調さを重点確認

期待される challenge:

- coverage variety の不足
- `replace_segment` の safe source が同 asset 内 fallback に偏る
- b-roll 不足を blueprint 側で明示的に扱う必要

### Automated Vs Manual Checks

自動化可能:

- analysis 実行
- schema validation
- state reconcile
- compile / preview / QC
- mock-agent E2E
- export bundle generation

手動確認が必要:

- intent interview の回答
- candidate approval
- collaborative preference choice
- preview の creative judgment
- final acceptance / override

## Test Strategy

M3 の test は既存の schema validator / compiler / M2 suite の上に積み増す。
既存 suite を置き換えず、CI lane を次の 3 層に分ける。

- always-on CI
  - existing schema + compiler + M2 regression
  - M3 unit / integration
- fixture render lane
  - lightweight preview render を含む fixture E2E
- manual smoke
  - 実素材 2 ケース

### 1. Agent Prompt Tests

各 role に対して mock LLM response を用いた prompt test を持つ。

- `intent-interviewer`
  - happy path
  - blocker extraction
  - `autonomy.mode` 分岐
- `footage-triager`
  - evidence-backed candidate generation
  - reject candidate generation
  - partial analysis gate refusal
- `blueprint-planner`
  - `full` path
  - `collaborative` path
  - planning blocker emission
- `roughcut-critic`
  - report-only finding
  - safe patch emission
  - human note priority

assertion は artifact shape と state transition に限定し、online model の内容品質に依存しない。

### 2. Slash Command Tests

command test は mock runtime launcher を使って行う。

- allowed start state / denied start state
- reconcile 後の自動 state 修正
- downstream invalidation
- `/review` の compile/render/qc preflight
- `/status` の next command recommendation
- `/export` の `critique_ready` / `approved` manifest labeling
- `media-mcp` failure の retryable / non-retryable 記録
- post-run hash mismatch 時の promote 中止

### 3. Project State Tests

`project_state.yaml` には専用 test を持つ。

- empty project からの bootstrap
- manual artifact edit 後の reconcile
- interrupted command resume
- planning gate / compile gate / review gate derivation
- analysis partial override persistence
- approved / creative_override persistence
- state demotion
  - persisted state が artifact reality より先に進んでいた場合

### 4. E2E Integration Tests

fixture E2E:

- `projects/sample/` を基準に
  - `/intent`
  - `/triage`
  - `/blueprint`
  - deterministic compile
  - preview stub or lightweight render
  - `/review`

real-material smoke:

- `sample-bicycle`
  - human-approved candidate board まで
  - `critique_ready` 到達
- `AX-1 D4887`
  - single-asset plan / review
  - `critique_ready` 到達

manual acceptance checklist:

- state が正しく戻る
- downstream invalidation が正しい
- human note 反映が確認できる
- analysis override / creative override が `/status` と export manifest に残る
- preview judgment と report が大きく矛盾しない

## Implementation Order

### Phase 1: State And Schema Foundation

実装内容:

- `project-state.schema.json`
- `human-notes.schema.json`
- additive schema update
  - `creative_brief.autonomy.mode`
  - `edit_blueprint.pacing.confirmed_preferences`
- project state reconcile / invalidation / history runtime
  - `style_hash`
  - `approval_record`
  - `analysis_override`

達成条件:

- `/status` 相当の state reconstruction が sample project で通る
- schema validation が additive field を受け入れる

### Phase 2: `/intent` And `/triage`

実装内容:

- command wrapper
- draft/promote pipeline
- intent interview loop
- triage evidence access and approval loop

達成条件:

- mock LLM で `intent_locked` / `selects_ready` まで遷移
- analysis gate が `qc_status: ready` のときだけ triage が進む

### Phase 3: `/blueprint`

実装内容:

- autonomy branching
- preference interview
- planning gate
- STYLE.md incorporation

達成条件:

- `full` / `collaborative` の両 test が通る
- planning blocker 時に `blocked` へ遷移する

### Phase 4: `/review`

実装内容:

- compile / preview / QC preflight
- roughcut critique
- human notes integration
- patch safety guard

達成条件:

- sample fixture が `critique_ready` まで通る
- `fatal_issues` あり / なし / creative override の state 分岐が通る

### Phase 5: Real-Material Smoke And Export

実装内容:

- `sample-bicycle` smoke
- `AX-1 D4887` smoke
- `/export` review bundle
- operator checklist 整備

達成条件:

- 実素材 2 ケースで `critique_ready` 以上に到達
- export bundle が `critique_ready` 以降で M3.5 前段の handoff inventory として機能する

## Final Notes

M3 の本質は「agent を増やすこと」ではなく、「interactive loop を壊さずに product-plane reasoning を
artifact contract に接続すること」にある。したがって本 milestone の完成条件は model quality そのものではなく、
schema-gated artifact flow、state persistence、resume/retry safety、real-material smoke の成立で判断する。
