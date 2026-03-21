## レビュー結果サマリー（Round 2）
- 🔴 FATAL: 0件
- ⚠️ WARNING: 2件
- 📝 NOTE: 1件
- 機械検証: sample/template artifact 9件は schema validation を通過。`src_in_us < src_out_us` の追加不変条件チェックも sample/template ともに通過。`review_report` の severity 負例は schema で reject されることを確認。sample fixture の segment/asset/range/beat coverage 参照整合も問題なし。

## 前回指摘の解決状況
- ✅ 解決: 🔴 FATAL 1 `unresolved_blockers.yaml` 契約未定義。`schemas/unresolved-blockers.schema.json` と `projects/_template/01_intent/unresolved_blockers.yaml` が追加され、`ARCHITECTURE.md`、`docs/milestone-1-design.md`、`agent-src/roles/intent-interviewer.yaml` も新契約に追従している。
- ✅ 解決: 🔴 FATAL 2 `src_in_us < src_out_us` 不変条件未定義。`ARCHITECTURE.md:205-216` と `docs/milestone-1-design.md:43-48,120-133` に validator-runner を含む二段検証方針が明記され、`schemas/selects-candidates.schema.json:43` と `schemas/timeline-ir.schema.json:172` にも runner invariant が注記された。
- ✅ 解決: 🔴 FATAL 3 `review_report` severity 区分崩壊。`schemas/review-report.schema.json:48-57,186-209` が `fatalFinding` / `warningFinding` に分離され、`docs/milestone-1-design.md:85-86` と `agent-src/roles/roughcut-critic.yaml:57-58` も一致している。
- ✅ 解決: ⚠️ WARNING 1 scoring policy 未契約。`runtime/compiler-defaults.yaml` が新設され、`ARCHITECTURE.md:251-255` と `docs/milestone-1-design.md:135-138` が compiler-owned defaults として固定している。
- ✅ 解決: ⚠️ WARNING 2 `beatRole` enum に `music` / `title` が残っていた問題。`schemas/edit-blueprint.schema.json:95-104` は selectable roles のみに制限され、`docs/milestone-1-design.md:59-65` と `agent-src/roles/blueprint-planner.yaml:46-60` も overlay / music policy 側へ整理された。
- ✅ 解決: ⚠️ WARNING 3 `caption_policy` 不足。`schemas/edit-blueprint.schema.json:48-49,177-210` に追加され、`docs/milestone-1-design.md:62-65` と `agent-src/roles/blueprint-planner.yaml:56` にも反映されている。
- ✅ 解決: ⚠️ WARNING 4 BGM / music 契約不足。`schemas/edit-blueprint.schema.json:150-175` に `music_policy.entry_beat` が追加され、`ARCHITECTURE.md:258-266` と `docs/milestone-1-design.md:62-63` で Milestone 1 の `A2` 空許容が明記された。
- ✅ 解決: ⚠️ WARNING 5 role prompt と schema の root metadata 不一致。`agent-src/roles/intent-interviewer.yaml:48-49`、`agent-src/roles/footage-triager.yaml:35-39`、`agent-src/roles/blueprint-planner.yaml:43-44`、`agent-src/roles/roughcut-critic.yaml:40-43` が更新され、`.claude/agents/*` と `.codex/agents/*` の生成物にも同内容が反映されている。
- ✅ 解決: 📝 NOTE `additionalProperties` 方針未明文化。`ARCHITECTURE.md:155-158` と `docs/milestone-1-design.md:177-178` で open metadata と closed artifact の方針が明示された。

## 新規指摘
- ⚠️ [WARNING] `uncertainty_register.yaml` の `status: blocker` を compile/render の hard stop にするかが文書間で揃っていない。`docs/milestone-1-design.md:130-133` は `uncertainty_register.yaml` の blocker でも stop を要求する一方、`ARCHITECTURE.md:168-181` の state machine と gate は `unresolved_blockers` 側しか明示していない。`schemas/uncertainty-register.schema.json:67-75` と `agent-src/roles/blueprint-planner.yaml:72-77` は blocker を許容しているため、compiler/validator 実装時に gate 判定が分岐する余地がある。
- ⚠️ [WARNING] template timeline fixture が更新後 contract を反映し切れていない。`projects/_template/05_timeline/v001.timeline.json:52-58` は `A1` しか持たず、`ARCHITECTURE.md:258-266` が説明する `A1/A2/A3` レイアウトの見本になっていない。加えて `projects/_template/05_timeline/v001.timeline.json:68-73` の `selects_path` は存在しない `projects/_template/04_plan/selects_candidates.yaml` を指しており、schema は通るが fixture としては stale。
- 📝 [NOTE] `music_policy.entry_beat` は必須化されたが、`schemas/edit-blueprint.schema.json:164-166` では任意の非空文字列しか要求していない。`b99_missing` のような存在しない beat id に差し替えても schema pass することを確認したため、validator runner で `entry_beat ∈ beats[].id` を追加すると契約が閉じる。
