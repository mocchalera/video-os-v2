# Speech-led Highlight Product Contract

Status: **Normative P0 contract**

Contract version: **1.0**

Effective date: **2026-07-10**

Default editorial profile: **`interview-highlight`**

Default editorial policy: **`interview`**

## 1. Normative language

`MUST` / `MUST NOT` は必須、`SHOULD` / `SHOULD NOT` は正当な理由がある場合のみ例外可、`MAY` は任意を意味する。本書と説明資料が矛盾する場合、P0 の製品範囲については本書を優先する。schema、compiler、state reconcile、artifact validator の機械的制約は本書によって緩和されない。

## 2. Product promise

> 日本語の発話中心のインタビュー、セミナー、イベント収録と短い brief を渡すと、Video OS は素材根拠付きの 60〜180 秒の rough cut を作り、人間が Studio で確認・修正でき、MP4 と編集可能な NLE handoff を返す。

P0 が約束するのは「自動完成動画」ではなく、理由を追跡でき、人間が短時間で仕上げられる編集可能な rough cut である。

## 3. Fixed product route

- 最初の製品ルートは `interview-highlight` **だけ**である。
- resolved policy は `interview` でなければならない。
- first-run では `creative_brief.yaml > editorial.profile_hint` を `interview-highlight`、`policy_hint` を `interview`、`allow_inference` を `false` に固定しなければならない。
- 構成順は `order_policy: editorial` とする。素材の時系列は evidence として保持するが、完成順を拘束しない。
- `project.runtime_target_sec` は 60 以上 180 以下でなければならない。省略時の profile default は 60 秒である。
- `project.duration_mode` は `guide` を既定とする。compiler 内の guide window は編集探索の許容幅であり、P0 の出力合格条件を緩和しない。合格する `timeline.json` の実尺は 60〜180 秒でなければならない。
- 他の profile は削除しないが、first-run や既定の golden path からは除外し、明示的な advanced / experimental 選択でのみ利用できる。
- profile ごとの別 pipeline、別 state machine、別 canonical artifact を作ってはならない。

## 4. Input contract

### 4.1 Source media

入力は次を満たさなければならない。

- 日本語の発話が物語の意味の背骨になる interview、seminar、event recording のいずれか
- 初期サポートは primary camera 1 台。追加 camera と B-roll は任意
- runtime が読めるローカル source media と安定した asset identity
- transcript evidence。取得不能な場合は 7 節の human-approved degraded path に従う
- 利用権限が確認できる素材。権利不明の素材を golden、package、handoff に含めてはならない

複雑な multicam 同期、映像だけで意味を作る素材、音声が理解不能な素材は通常ルートの入力とはみなさない。

### 4.2 Creative brief

意図の唯一の canonical source は `01_intent/creative_brief.yaml` である。最低限、既存 schema の次の項目を埋めなければならない。

| Product question | Existing field |
|---|---|
| タイトルと制作目的・期待結果 | `project.title`, `project.strategy` |
| 目標尺 | `project.runtime_target_sec` |
| 中心メッセージ | `message.primary` |
| 対象視聴者 | `audience.primary` |
| 感情の流れ・トーン | `emotion_curve` |
| 必須内容 | `must_have` |
| 禁止内容 | `must_avoid` |
| agent が決めてよいこと / 人間に聞くこと | `autonomy.may_decide`, `autonomy.must_ask` |
| 解決済みの仮定 | `resolved_assumptions` |
| 配信面・画角・hook 方針 | `editorial.distribution_channel`, `aspect_ratio`, `hook_priority`, `credibility_bias` |
| 固定 profile / policy | `editorial.profile_hint`, `policy_hint`, `allow_inference` |

目的やトーンのためだけに `IntentBrief` や `EditorialProgram` という別の canonical document を追加してはならない。不足する制約は、既存 artifact の最も近い schema を additive に拡張する場合に限り認める。

## 5. Output contract

通常ルートの完了には、次がすべて必要である。

1. `04_plan/edit_blueprint.yaml` に、目的と素材根拠を確認できる beat / story structure がある。
2. `04_plan/selects_candidates.yaml` に、source range、evidence、採用理由を持つ候補がある。
3. `05_timeline/timeline.json` が schema と semantic validation を通り、実尺が 60〜180 秒である。
4. `09_output/rough-cut.mp4` が再生可能で、`09_output/render-report.json` に render 結果が記録される。
5. dialogue が理解可能で、caption policy に従う字幕と基本的な loudness / ducking 処理が確認できる。
6. `06_review/review_report.yaml` に fatal issue がなく、visual QA と package QA を skip や mock で代替していない。
7. Studio が同じ `timeline.json` を開き、preview、edit、save、undo の結果を artifact に反映できる。
8. stable ID を保持した Premiere/FCP7 XML または対応 NLE handoff と `exports/handoffs/HND_*/handoff_manifest.yaml` を出力できる。
9. NLE から戻した場合、同じ handoff session に `roundtrip_import_report.yaml` と `human_revision_diff.yaml` を残せる。
10. operator approval が `project_state.yaml > approval_record` に、最終 source-of-truth 判断が `handoff_resolution` に記録される。

MP4、NLE handoff、Studio のいずれか一つだけを生成しても、P0 製品ルートの完了とはみなさない。

## 6. Canonical artifact mapping

新しい概念名は説明用の view に留め、source of truth を増やしてはならない。

| Product concept | Existing source of truth |
|---|---|
| IntentBrief | `01_intent/creative_brief.yaml` |
| Blocker / unresolved decision | `01_intent/unresolved_blockers.yaml` |
| EditorialProgram | resolved profile/policy と brief、blueprint、compiler input の制約 |
| MaterialMap / EvidenceGraph | `03_analysis/assets.json`, `03_analysis/segments.json`, transcript / observation / analysis graph, `03_analysis/search/footage.db` |
| CandidateSet | `04_plan/selects_candidates.yaml` |
| StoryBeat / story structure | `04_plan/edit_blueprint.yaml` の beats |
| Coverage / uncertainty | analysis coverage、must-have coverage、beat candidate coverage、`04_plan/uncertainty_register.yaml` |
| TimelinePatch | `06_review/review_patch.json` と Studio の review / feedback session operations |
| TimelineVersion | `05_timeline/timeline.json` の version と hash |
| ReviewReport | `06_review/review_report.yaml`, `06_review/review_metrics.json`, visual QA, `07_package/qa-report.json` |
| DecisionLog | `project_state.yaml` history / approval、`06_review/human_notes.yaml`、`07_handoff/editor_annotations.json` |
| Review render | `09_output/rough-cut.mp4`, `09_output/render-report.json` |
| NLE exchange | `exports/handoffs/HND_*/handoff_manifest.yaml`、同 session の FCP7 XML / OTIO adapter output、`roundtrip_import_report.yaml`、`human_revision_diff.yaml` |

Authority は次の順で解決する。

1. `project_state.yaml` が現在状態、gate、approval、resume、handoff decision を決める。
2. canonical artifacts が意図、evidence、story、timeline、review の内容を決める。
3. deterministic compiler / validator / renderer が timeline 整合性と media output を決める。
4. Studio と agents は proposal / edit / decision surface であり、保存・compile・approval 前の UI state や会話は canonical ではない。
5. chat、job log、通知は evidence にはできるが source of truth にはできない。

## 7. Degraded behavior

degraded path は失敗を隠す fallback ではない。理由、欠損 evidence、operator 判断、再開方法を canonical artifact と `project_state.yaml` に残さなければならない。

| Condition | Required behavior | P0 success |
|---|---|---|
| STT provider が失敗 | 別 provider / cache を試し、復旧不能なら `analysis_override` に human approval、scope、reason を記録する | transcript evidence がない出力は review-only。golden 合格不可 |
| diarization が失敗 | 話者 identity が必須でなければ発話区間で継続し、speaker ambiguity を uncertainty / review に残す | human review で意味と帰属を確認した場合のみ可 |
| Qwen3-VL、CLAP、Marlin 等の optional local model がない | fail-open し、利用できた STT、derivative、visual observation を使う。欠けた modality と provenance を記録する | 必須 visual QA を skip / mock した run は golden 合格不可 |
| B-roll / coverage が不足 | talking head と既存素材で組み、coverage を weak / missing として明示する | 必須 beat が覆えなければ blocked。生成映像で自動補完しない |
| dialogue が理解不能、A/V sync や clipping が致命的 | issue と再取得・修復手順を残し、compile / package gate を閉じる | 不可 |
| render が失敗 | `timeline.json` を保持し、失敗 stage と resume command を記録する | playable MP4 まで未完了 |
| Studio が timeline を開けない、または edit/save/undo が成立しない | artifact を変更せず blocker として記録する | 不可 |
| NLE export / round-trip が失敗 | internal timeline を canonical のまま保持し、loss / unmapped edit を report する | editable handoff まで未完了 |
| rights が不明 | 該当 source を禁止し、代替、追加撮影、または brief 変更を human decision に戻す | golden / package 不可 |

degraded run は通常 run と同じ artifact 名と state machine を使う。別 pipeline や hidden success state を作ってはならない。

## 8. State and human control loop

P0 は `projects/*/project_state.yaml` の既存状態だけを使う。

```text
intent_pending
  -> intent_locked
  -> media_analyzed
  -> selects_ready
  -> blueprint_ready
  -> timeline_drafted
  -> critique_ready
  -> approved
  -> packaged
```

`blocked` は unresolved blocker または closed gate を表す。review patch の採用は `critique_ready -> timeline_drafted`、upstream artifact の変更は reconcile の invalidation matrix に従って既存の前段状態へ戻す。`Briefed`、`Story Ready`、`Assembled` などの表示ラベルを UI に使う場合も、新しい persisted state を追加してはならない。

Agent は現在状態と gate が許す proposal だけを出す。canonical timeline の整合性は deterministic compiler が保証する。approval、analysis override、rights decision、source-of-truth decision は human action でなければならない。

## 9. Success and regression metrics

### 9.1 Run acceptance

P0 conformant run は次をすべて満たさなければならない。

- required artifacts が schema / semantic validation を通る
- unresolved blocker がない
- actual timeline duration が 60〜180 秒
- brief の `must_have` を満たし、`must_avoid` に違反しない
- missing media、invalid source range、black frame、fatal A/V sync、audio clipping、subtitle overflow がない
- review と package QA に fatal issue がない
- rough cut が再生可能で Studio edit/save/undo が成立する
- stable IDs を持つ editable NLE handoff が生成できる
- operator が usable rough cut として承認する

### 9.2 Product outcome metrics

各 golden / regression run は、既存 run、patch、review、handoff diff から次を測定しなければならない。

| Metric | Definition |
|---|---|
| `time_to_first_usable_cut` | run start から operator が初めて usable と判断した timeline version まで |
| `human_intervention_minutes` | brief lock 後から approval までの人間の編集・判断時間 |
| `kept_cut_ratio` | AI rough cut の clip のうち approval / NLE handoff まで保持された割合 |
| `accepted_proposal_ratio` | 提案された review / Studio patch のうち採用された割合 |
| `post_export_edit_distance` | NLE 往復での trim、move、delete、insert、transition 等の変更量 |
| `review_issue_density` | timeline 1 分あたりの review issue 数と severity |
| `rerun_duration` / `rerun_cost` | cache 利用を含む再実行の時間と推定費用 |
| `degraded_run_flags` | 欠損 modality、override、skipped stage、rights / media blocker |

モデルの自己評価だけで合格にしてはならない。maker、deterministic validator、checker、human preference の evidence を分離する。

## 10. Explicit exclusions

次は P0 では実施しない。

- AI 生成映像による不足 shot の自動補完
- MV / PV を既定とする visual-first、music-first 編集
- advanced VFX、完成 color grading、複雑な multicam synchronization
- 全 SNS / delivery format への同時自動最適化
- profile、model、editing skill のカタログ拡大
- profile ごとの専用 pipeline / state / artifact
- Studio の full NLE 化または golden path と無関係な新規 editing feature
- 人間の approval を省略した automatic final publish

## 11. P0 exit criterion

この契約の固定は、P0 実装者が次を選び直す必要がない状態を意味する。

- genre: speech-led `interview-highlight`
- output: 60〜180 秒の Studio-editable rough cut、MP4、editable NLE handoff
- workflow authority: existing `project_state.yaml` と gates
- content authority: existing canonical artifacts
- mutation boundary: agent proposal、人間判断、deterministic compiler / renderer
- quality authority: deterministic validation、review / visual / package QA、human approval、NLE revision evidence

次の gate は、この契約を満たす rights-cleared speech-led fixture を一つ選び、operator-approved golden として固定することである。
