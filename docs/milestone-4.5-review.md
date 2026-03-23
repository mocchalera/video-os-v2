# M4.5 Design Review

対象: `docs/milestone-4.5-design.md`

総評:

- FATAL 2件
- WARNING 5件
- NOTE 2件

結論:

この設計は「旧知見を v2 に artifact-first で持ち込む」方向性自体は妥当ですが、現状のまま着手すると 2 箇所で実装契約が破綻します。特に `candidate` の安定参照子がないまま adaptive trim / backup / dedupe を導入する点と、scene/audio 系 skill を現行の線形 beat compiler に additive に載せる点は、先に契約を修正しないと成立しません。

## FATAL

### 1. `candidate_id` 不在のまま M4.5 の backup / dedupe / adaptive trim を導入しようとしている

判定理由:

- 現行 `selects_candidates` contract には stable な `candidate_id` がなく、candidate は実質 `segment_id + src_in_us + src_out_us` でしか区別できません。`schemas/selects-candidates.schema.json:41-156`
- compiler 実装も fallback 解決を `segment_id` 単位でしか行っていません。`runtime/compiler/types.ts:137-151` `runtime/compiler/resolve.ts:21-25` `runtime/compiler/resolve.ts:118-133`
- 一方 M4.5 設計は `script_draft.yaml` に `beat-to-candidate assignment` と `backup map` を持たせ、Phase D で backup 差し替えと `missing_beats` 記録を行い、さらに adaptive trim で同一 long segment から別 window を切り出す前提です。`docs/milestone-4.5-design.md:247-277` `docs/milestone-4.5-design.md:648-669`
- 旧 Script Engine 側はこの問題を `candidate_id` / `material_unit_id` で解いていました。`/Users/mocchalera/Dev/video-edit-agent/docs/inventory-ja/rules/narrative-design.md:131-179`

なぜ致命的か:

- 同一 `segment_id` から複数 candidate window を許した瞬間に、`script_draft.yaml` / `script_evaluation.yaml` / `timeline.json` / `review_patch.json` の参照先が曖昧になります。
- hard dedupe の `utterance_ids` 消費制御、backup 差し替え、same-source repetition 削減のどれも、「どの candidate を使ったか」を stable に指せないと deterministic に実装できません。
- 現状の `fallback_segment_ids: string[]` では、同一 segment 内の別 subclip を正しく復元できません。既存 `resolve()` の置換ロジックも壊れます。

修正推奨:

- `selects_candidates.yaml` に `candidate_id` か `candidate_ref` を追加する。
- `script_draft.yaml` / `script_evaluation.yaml` / `timeline.json.clip.metadata.editorial` / `fallback_*` はすべて `segment_id` ではなく stable candidate ref を使う。
- review patch safety も `segment_id` 前提ではなく candidate ref 前提へ寄せる。

### 2. 18 skill を additive に compiler へ統合する設計が、現行 IR の表現力を超えている

判定理由:

- 設計は 18 skill を `normalize -> score -> assemble -> resolve -> export` に additive 統合すると宣言しています。`docs/milestone-4.5-design.md:11-23` `docs/milestone-4.5-design.md:397-463`
- しかし現行 compiler は beat ごとに最大 1 本の hero / support / dialogue / transition を選ぶ線形 assembly で、thread / subbeat / overlap / transition spec / within-beat sequence を持ちません。`runtime/compiler/types.ts:93-165` `runtime/compiler/assemble.ts:16-158`
- 旧 skill の中には、明示的に audio overlap や multi-clip compression や interleave を要求するものがあります。`/Users/mocchalera/Dev/video-edit-agent/docs/inventory-ja/editing-skills/j-cut-lead-in.md:41-51` `/Users/mocchalera/Dev/video-edit-agent/docs/inventory-ja/editing-skills/l-cut-reaction-hold.md:42-54` `/Users/mocchalera/Dev/video-edit-agent/docs/inventory-ja/editing-skills/montage-compress.md:24-52` `/Users/mocchalera/Dev/video-edit-agent/docs/inventory-ja/editing-skills/crosscut-suspense.md:24-51`
- しかも roadmap では `audio_overlap_sec` は「引き継がない」と明記されています。`docs/roadmap.md:301-305`

なぜ致命的か:

- `crosscut_suspense`, `montage_compress`, `j_cut_lead_in`, `l_cut_reaction_hold`, `cutaway_repair`, `talking_head_pacing` は、現行の beat-linear IR では「metadata を付ける」以上の compile behavior を持てません。
- その状態で success criteria 4 と Phase 4 done condition の「profile ごとに active skill が変わり compile behavior 差が説明可能」を満たすのは無理です。`docs/milestone-4.5-design.md:102-104` `docs/milestone-4.5-design.md:805-815`
- 既存 golden snapshot / deterministic compile テストがある以上、隠れた IR redesign を後から入れるのも危険です。`tests/compiler.test.ts:80-88` `tests/e2e.test.ts:217-234`

修正推奨:

- M4.5 では skill を 2 群に分ける。
- 先行導入:
  - score / trim / metadata で表現できる skill のみ
- 後続導入:
  - thread, montage, overlap, reaction-hold のように新 IR を要する skill
- もし 18 skill を本当に入れるなら、先に editorial IR を追加する。
  - stable candidate refs
  - within-beat clip list
  - thread / section id
  - audio lead / lag primitive
  - transition spec

## WARNING

### 1. profile / policy 推論テーブルが、提案されている brief/selects 契約だけでは deterministic に解けない

根拠:

- 推論条件は `16:9`, `LP embed`, `short persuasive loop`, `strong hook need`, `credibility-first` などの structured signal を前提にしています。`docs/milestone-4.5-design.md:544-576`
- しかし現行 `creative_brief` で machine-readable なのは `project.format` と `runtime_target_sec` 程度で、提案されている additive field も `profile_hint` / `policy_hint` / `allow_inference` のみです。`schemas/creative-brief.schema.json:27-56` `docs/milestone-4.5-design.md:533-538`
- 旧 profile の差分は `platform`, `aspect_ratio`, `caption`, `qa_policy`, `narrative_lock` など複数面にまたがっています。`/Users/mocchalera/Dev/video-edit-agent/docs/inventory-ja/profiles/interview-highlight.md:19-122` `/Users/mocchalera/Dev/video-edit-agent/docs/inventory-ja/profiles/lp-testimonial.md:20-61`

懸念:

- no-hint case の deterministic inference は、実装者依存の文字列 heuristics になりやすいです。
- `/blueprint` と compiler のテスト oracle が安定しません。

修正推奨:

- `creative_brief.editorial` に `distribution_channel`, `aspect_ratio`, `credibility_bias`, `embed_context`, `hook_priority` などの structured field を足す。
- それが難しいなら初期版は `profile_hint` 必須寄りに寄せ、推論対象を狭める。

### 2. 実装順序に `selects_candidates` signal 生成フェーズが入っておらず、依存関係が逆転している

根拠:

- skill 統合は `utterance_ids`, `speaker_role`, `semantic_dedupe_key`, `editorial_signals`, `trim_hint` を required signal としています。`docs/milestone-4.5-design.md:465-496`
- ただし implementation order には `/triage` / `footage-triager` 側の signal 生成を独立フェーズとして置いていません。`docs/milestone-4.5-design.md:762-840`
- runtime changes の列挙には `runtime/commands/triage.ts` と `footage-triager.yaml` が入っていますが、deliverable phase が曖昧です。`docs/milestone-4.5-design.md:712-740`

懸念:

- Phase 4/5 が、まだ producer のいない field に依存する形になります。
- 不具合が出たときに triage 由来か compiler 由来か切り分けにくいです。

修正推奨:

- Phase 1.5 相当で `selects_candidates` extension を生成する `/triage` 改修を明示する。
- `message_frame` など 4 operational artifact も、role output なのか command-owned artifact なのかを先に固定する。

### 3. `confirmed_preferences` に policy default を投影する案は、既存契約の意味を濁す

根拠:

- 設計は `output.duration_sec` を `confirmed_preferences.duration_target_sec default` へ写像しています。`docs/milestone-4.5-design.md:599-613`
- しかし現行 `/blueprint` では `pacing.confirmed_preferences` は autonomy interview の結果として扱われ、`source` も strict に検証されています。`runtime/commands/blueprint.ts:175-198`
- テストもこの前提で組まれています。`tests/commands.test.ts:1243-1302`

懸念:

- human-confirmed な意思決定と、profile/policy 既定値が同じ field に混ざります。
- collaborative mode で「まだ確認していない default 値」を confirmed と見なす誤実装を誘発します。

修正推奨:

- `confirmed_preferences` は operator/agent の確定判断専用に維持する。
- profile/policy 由来の duration は別 field に置く。
  - 例: `pacing.default_duration_target_sec`
  - 例: `resolved_profile.defaults.duration_target_sec_snapshot`

### 4. Phase D の deterministic quality metric がまだ仕様として粗い

根拠:

- Phase D は `story continuity`, `emotion_gradient`, `causal_connectivity`, `source_fidelity` を deterministic に計算するとしています。`docs/milestone-4.5-design.md:264-285` `docs/milestone-4.5-design.md:373-395`
- 旧 `quality-judgment` は LLM ベース審査で、ここを deterministic に落とす具体 proxy はまだ書かれていません。`/Users/mocchalera/Dev/video-edit-agent/docs/inventory-ja/skills/quality-judgment.md:5-44`

懸念:

- 実装者によって tokenization, threshold, evidence source がぶれます。
- 単体テストに落としにくく、923 テストの non-regression を維持しにくいです。

修正推奨:

- metric ごとに input field, threshold, fallback を固定する。
- もし deterministic proxy が弱いものは M4.5 では review-side advisory に留める。

### 5. compiler provenance が新しい registry 依存を表現できていない

根拠:

- compile は今でも `runtime/compiler-defaults.yaml` を外部依存として読みます。`runtime/compiler/index.ts:65-73`
- M4.5 ではさらに `runtime/editorial/{profiles,policies,skills}/*.yaml` を読む前提です。`docs/milestone-4.5-design.md:404-409` `docs/milestone-4.5-design.md:733-735`
- しかし timeline provenance は `brief_path`, `blueprint_path`, `selects_path`, `compiler_version` しか持ちません。`runtime/compiler/types.ts:194-199` `runtime/compiler/export.ts:66-71`

懸念:

- 同じ canonical artifact でも registry 更新だけで compile 結果が変わります。
- 回帰原因の追跡と golden 更新判断が難しくなります。

修正推奨:

- `editorial_registry_hash` と `compiler_defaults_hash` を provenance に追加する。
- あるいは `resolved_profile` / `resolved_policy` の compile-relevant snapshot を blueprint 側へ持つ。

## NOTE

### 1. 4 フェーズを `/blueprint` の operational artifact に閉じ込める方針は正しい

根拠:

- architecture は canonical artifact を限定し、`selects_ready -> blueprint_ready` の state machine を維持しています。`ARCHITECTURE.md:157-195`
- 設計も 4 フェーズ artifact を non-canonical に分離し、`edit_blueprint.yaml` を唯一の canonical plan に保っています。`docs/milestone-4.5-design.md:111-147` `docs/milestone-4.5-design.md:172-179`

評価:

- これは v2 の artifact-first 方針と整合しています。
- script engine の導入位置としては妥当です。

### 2. Interest Point -> adaptive trim は、この設計の中で最も契約境界がきれい

根拠:

- roadmap でも `Interest Point アーキテクチャ（中心点 → adaptive in/out）` は明示的に継承対象です。`docs/roadmap.md:294-299`
- 現行 `timeline.json` は `clip.metadata` / `marker.metadata` を intentional extension point としています。`ARCHITECTURE.md:176-179` `schemas/timeline-ir.schema.json:272-304`
- 設計はその extension point をそのまま使っています。`docs/milestone-4.5-design.md:648-688`

評価:

- この部分は schema break を起こしにくく、独立したマイルストーンとして先行実装しやすいです。
- skill 全面導入より先に切り出す価値があります。

## 推奨リプラン

実装順序は以下へ組み替えるのが現実的です。

1. `candidate_id` / `candidate_ref` 導入
2. `/triage` で `trim_hint` と minimal editorial signal を生成
3. adaptive trim を単独で導入
4. profile / policy resolution を structured brief field 前提で導入
5. score/trim/metadata で表現できる skill だけ先行導入
6. scene/interleave/overlap 系 skill は別 milestone で IR 拡張後に導入

この順なら、M1-M4 の既存 golden / schema / determinism テストを守りながら前進できます。
