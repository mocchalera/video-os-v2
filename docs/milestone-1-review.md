## レビュー結果サマリー
- 🔴 FATAL: 3件
- ⚠️ WARNING: 5件
- 📝 NOTE: 2件

## 詳細

### [FATAL] `unresolved_blockers.yaml` が canonical artifact なのに契約未定義
- 対象ファイル: `ARCHITECTURE.md`, `agent-src/roles/intent-interviewer.yaml`, `docs/milestone-1-design.md`, `projects/sample/01_intent/unresolved_blockers.yaml`, `projects/_template/01_intent/`
- 問題:
  `unresolved_blockers.yaml` は canonical artifact かつ Gate 1 の判定材料ですが、対応する JSON Schema がありません。さらに `intent-interviewer` の role prompt は blocker ごとに `id / question / status / why_it_matters / allowed_temporary_assumption` を要求している一方、fixture は `blockers: []` しか示しておらず、template 側にも雛形がありません。現状では「何を unresolved blocker とみなすか」を機械的に検証できません。
- 根拠（ARCHITECTURE.md の該当箇所等）:
  `ARCHITECTURE.md` の canonical artifacts 定義（136-146行）、state machine（152-168行）、Non-negotiable gate 1（171-179行）。`agent-src/roles/intent-interviewer.yaml` の unresolved blockers 必須項目（92-102行）。`docs/milestone-1-design.md` の compile gate 入力説明（110-112行）。fixture は `projects/sample/01_intent/unresolved_blockers.yaml` で 3 行のみ。
- 推奨修正:
  `schemas/unresolved-blockers.schema.json` を追加し、`projects/_template/01_intent/unresolved_blockers.yaml` を新設してください。もし blocker 管理を `uncertainty_register.yaml` に統合する方針なら、`ARCHITECTURE.md`・role prompt・fixture をその形に一本化する必要があります。

### [FATAL] `_us` 時間範囲の順序不変条件がスキーマで保証されていない
- 対象ファイル: `schemas/selects-candidates.schema.json`, `schemas/timeline-ir.schema.json`, `ARCHITECTURE.md`
- 問題:
  `selects_candidates` も `timeline.json` も `src_in_us < src_out_us` を保証していません。特に `timeline-ir.schema.json` の `allOf` は sibling 比較になっておらず、実際には特定の定数組み合わせしか弾けません。これでは invalid source ranges が schema pass し得るため、Phase 4 の「invalid source ranges 解決」と Gate 2 の「timeline schema fail なら render 禁止」を十分に支えられません。
- 根拠（ARCHITECTURE.md の該当箇所等）:
  `ARCHITECTURE.md` の canonical machine fields（191-209行）と Phase 4 の invalid source ranges（244-250行）。`schemas/selects-candidates.schema.json` の `src_in_us` / `src_out_us` 定義（62-69行）。`schemas/timeline-ir.schema.json` の `src_in_us` / `src_out_us` 定義（193-200行）と `allOf`（275-300行）。
- 推奨修正:
  純粋な JSON Schema 2020-12 だけでは sibling 数値比較が弱いため、validator runner 側の追加検証ルールとして `src_in_us < src_out_us` を必須化してください。必要なら `duration_us` のような派生必須値を契約化して、schema と runner の二段で守る形に寄せるべきです。

### [FATAL] `review_report.yaml` の fatal / warning 区分が機械的に壊れている
- 対象ファイル: `schemas/review-report.schema.json`, `ARCHITECTURE.md`, `docs/milestone-1-design.md`
- 問題:
  `fatal_issues` と `warnings` が同じ `finding` 定義を共有しており、その `severity` enum は `warning | fatal` の両方を許しています。結果として `fatal_issues` 配列内に `severity: warning`、`warnings` 配列内に `severity: fatal` が入っても schema 上は合法です。Gate 3 の「fatal issue があれば final render 禁止」が曖昧になります。
- 根拠（ARCHITECTURE.md の該当箇所等）:
  `ARCHITECTURE.md` の Gate 3（173-179行）。`docs/milestone-1-design.md` は fatal/warning を stricter finding shape と説明（60-70行）。しかし `schemas/review-report.schema.json` では `fatal_issues` / `warnings` の両方が `#/$defs/finding` を参照（48-58行）し、`finding.severity` は `warning | fatal`（141-158行）です。
- 推奨修正:
  `fatal_issues` 用と `warnings` 用で別 `$defs` を切るか、各配列側で `severity` を `const` 固定してください。配列名と item severity の二重表現を残すなら、両者が矛盾しないことを schema で担保する必要があります。

### [WARNING] Phase 2 deterministic scoring に必要な入力が契約化し切れていない
- 対象ファイル: `ARCHITECTURE.md`, `docs/milestone-1-design.md`, `schemas/selects-candidates.schema.json`, `schemas/edit-blueprint.schema.json`
- 問題:
  `semantic_rank` と `quality_flags` は入っていますが、`motif reuse limits`、`adjacency penalties`、`beat alignment penalties` をどう決めるかが artifact 側にありません。`motif_tags` は任意で、`rejection_rules` は prose です。さらにゼロベース再設計案にあった `analysis_policy` もどこにも入っておらず、analysis artifact がどのルールで生成されたか追跡できません。現状だと deterministic scoring が canonical artifact ではなく compiler の隠れデフォルトに依存します。
- 根拠（ARCHITECTURE.md の該当箇所等）:
  `ARCHITECTURE.md` の Phase 2 入力（223-231行）。`docs/milestone-1-design.md` は `semantic_rank`, `quality_flags`, `motif_tags` を optional convenience field と説明（32-36行）、compiler inputs には policy の明示がありません（89-115行）。`schemas/selects-candidates.schema.json` の optional fields（97-134行）と `schemas/edit-blueprint.schema.json` の policy/rejection 定義（27-64行、149-234行）。
- 推奨修正:
  `analysis_policy` ないし `scoring_policy` を新設し、motif reuse・adjacency・duration fit・beat alignment の判定ルールを machine-readable にしてください。もし compiler 固定値にするなら、その固定値を `ARCHITECTURE.md` に明文化して artifact 契約から外すべきです。

### [WARNING] `edit_blueprint.yaml` が `music` / `title` を required role にできてしまう
- 対象ファイル: `schemas/edit-blueprint.schema.json`, `schemas/selects-candidates.schema.json`, `ARCHITECTURE.md`, `docs/milestone-1-design.md`
- 問題:
  `beats[].required_roles` は `music` と `title` を許しますが、Phase 1 の role quotas は `hero / support / transition / texture / dialogue` のみで、`selects_candidates` の role enum にも `music` と `title` はありません。つまり schema-valid だが compiler 入力として満たせない blueprint を作れてしまいます。
- 根拠（ARCHITECTURE.md の該当箇所等）:
  `ARCHITECTURE.md` の Phase 1 output（219-221行）。`schemas/edit-blueprint.schema.json` の `beatRole` enum（110-121行）。`schemas/selects-candidates.schema.json` の role enum（70-79行）。`docs/milestone-1-design.md` は timeline-ir role に合わせて追加したと説明（44-48行）。
- 推奨修正:
  `required_roles` は compiler が select candidate から満たせる role に限定してください。`music` と `title` は別の cue / overlay 契約に分けるか、beat の optional directive として表現した方が整合します。

### [WARNING] caption / subtitle の契約が不足している
- 対象ファイル: `ARCHITECTURE.md`, `schemas/timeline-ir.schema.json`, `docs/milestone-1-design.md`
- 問題:
  architecture は packaged 出力に `captions` を含め、timeline schema も `caption` track を許しますが、caption / subtitle の生成元、言語、スタイル、burn-in か sidecar か、speaker ラベル方針などを表す schema がありません。現状の milestone 1 契約では packaged state まで deterministic に到達できません。
- 根拠（ARCHITECTURE.md の該当箇所等）:
  packaged state に `captions + package manifest`（167行）。`schemas/timeline-ir.schema.json` の `tracks.caption`（98-103行）と track kind enum（153-159行）。`docs/milestone-1-design.md` の scope / compiler inputs には caption policy の説明がありません（5-8行、89-115行）。
- 推奨修正:
  `caption_policy` / `subtitle_policy` を blueprint 側に追加するか、別 artifact として `captions_plan.yaml` のような契約を設けてください。最低限、language、delivery mode、source of truth、styling class は必要です。

### [WARNING] BGM / music の情報量が A2 assembly と conflict resolution に対して不足している
- 対象ファイル: `schemas/edit-blueprint.schema.json`, `ARCHITECTURE.md`, `docs/milestone-1-design.md`
- 問題:
  `music_policy` は boolean 数個と `permitted_energy_curve` だけで、A2 track に何を置くのか、どの beat から入れてよいのか、ducking や nat sound 優先の原則をどこまで compiler が守るべきかが不足しています。Phase 3/4 にある `A2: music` と `music timing conflicts` を支えるには弱い契約です。
- 根拠（ARCHITECTURE.md の該当箇所等）:
  `ARCHITECTURE.md` の Assembly（236-242行）と Constraint resolution（244-250行）。`schemas/edit-blueprint.schema.json` の `musicPolicy`（149-169行）。`docs/milestone-1-design.md` でも music policy は blueprint 要素として挙げるのみで、cue レベルの入力までは定義していません（40-48行、103-108行）。
- 推奨修正:
  milestone 1 で A2 を空許容にするのか、簡易 music cue まで契約化するのかを決めてください。前者なら architecture 文言を弱め、後者なら `music_cues` か `music_policy.entry_windows` などの machine-readable 入力が必要です。

### [WARNING] role prompt と schema 必須フィールドのズレが残っている
- 対象ファイル: `agent-src/roles/intent-interviewer.yaml`, `agent-src/roles/footage-triager.yaml`, `agent-src/roles/blueprint-planner.yaml`, `agent-src/roles/roughcut-critic.yaml`, `schemas/creative-brief.schema.json`, `schemas/selects-candidates.schema.json`, `schemas/uncertainty-register.schema.json`, `schemas/review-report.schema.json`, `docs/milestone-1-design.md`
- 問題:
  `selects_candidates`, `uncertainty_register`, `review_report` は root metadata (`version`, `project_id`, `timeline_version`) を schema required にしていますが、各 role prompt はそれを明示していません。また `creative_brief` の `strategy` は prompt 上は section 名、schema 上は `project.strategy` に置かれています。role が prompt どおりに書いても schema-invalid になる余地があります。
- 根拠（ARCHITECTURE.md の該当箇所等）:
  `agent-src/roles/footage-triager.yaml` の candidate 必須項目（51-67行）に root metadata の説明がありません。`schemas/selects-candidates.schema.json` は `version`, `project_id`, `candidates` を required（6-10行）。同様に `blueprint-planner` prompt（67-81行）と `schemas/uncertainty-register.schema.json`（6-21行）、`roughcut-critic` prompt（44-63行）と `schemas/review-report.schema.json`（6-32行）もズレています。`intent-interviewer` の `strategy` section 指示（73-89行）に対し、schema は `project.strategy` を要求しています（27-56行、docs 17-23行）。
- 推奨修正:
  role prompt を schema envelope に合わせて更新するか、逆に metadata を schema optional に下げて validator runner 側で補完する方針に揃えてください。少なくとも prompt と template と schema の 3 点は同じ形を話すべきです。

### [NOTE] sample fixture の参照整合性は現状問題なし
- 対象ファイル: `projects/sample/03_analysis/assets.json`, `projects/sample/03_analysis/segments.json`, `projects/sample/03_analysis/transcripts/*.json`, `projects/sample/04_plan/selects_candidates.yaml`, `projects/sample/04_plan/edit_blueprint.yaml`
- 問題:
  明確な不整合は見つかっていません。`selects_candidates` の `segment_id` / `asset_id` は analysis artifact と一致し、`src_in_us < src_out_us` も満たしています。beat ごとの required role も current fixture では coverage があります。transcript の時間帯と `segments.json` の spoken segment も整合しています。
- 根拠（ARCHITECTURE.md の該当箇所等）:
  ローカル機械チェックで `missing_segments=[]`, `missing_assets=[]`, `wrong_asset_links=[]`, `invalid_ranges=[]`, `out_of_segment_ranges=[]` を確認。coverage は `b01 hero=1 texture=1`, `b02 support=1 dialogue=2 texture=2`, `b03 hero=1 support=2 transition=2`, `b04 hero=2 dialogue=2 transition=2`。transcript mismatch も 0 件でした。
- 推奨修正:
  この整合性チェックは reviewer の目視に頼らず、後続の schema validator / fixture test に回してください。

### [NOTE] `additionalProperties` 方針は新規 schema では概ね統一されている
- 対象ファイル: `schemas/creative-brief.schema.json`, `schemas/selects-candidates.schema.json`, `schemas/edit-blueprint.schema.json`, `schemas/uncertainty-register.schema.json`, `schemas/review-report.schema.json`, `schemas/timeline-ir.schema.json`
- 問題:
  新規 5 schema は root と主要 object で `additionalProperties: false` に揃っており、strictness の方向性は明確です。一方で既存 `timeline-ir.schema.json` は `clip.metadata` と `marker.metadata` を open object にしており、完全統一ではありません。これは extension point と見るなら妥当ですが、方針として明文化されていません。
- 根拠（ARCHITECTURE.md の該当箇所等）:
  新規 schema は各 object で `additionalProperties: false`。`schemas/timeline-ir.schema.json` では `metadata` が単なる `type: object`（271-273行、329-331行）です。
- 推奨修正:
  `timeline-ir` の open metadata を意図的な escape hatch とするなら、その方針を `docs/milestone-1-design.md` か `ARCHITECTURE.md` に追記してください。そうでなければ、許可する metadata key を絞る設計に寄せるべきです。
