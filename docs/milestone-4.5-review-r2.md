# M4.5 Design Review R2

対象: `docs/milestone-4.5-design.md`

参照:

- `docs/milestone-4.5-review.md`
- `ARCHITECTURE.md`
- `schemas/edit-blueprint.schema.json`
- `runtime/compiler/score.ts`
- `runtime/compiler/assemble.ts`

判定:

- `CONDITIONAL PASS`
- `FATAL 0`
- `WARNING 1`
- `NOTE 2`

R1 で致命傷だった 2 点は解消されており、今回確認した範囲では新たな FATAL はありません。`candidate_ref` 導入は既存契約との整合も取れており、実装順序も R1 の推奨リプランに沿う形へ修正されています。

## Findings

### WARNING 1. 先行導入 skill の一部で signal / effect vocabulary がまだ未固定

根拠:

- 先行導入 skill には `axis_hold_dialogue`、`deliberate_axis_break`、`match_cut_bridge`、`shot_reverse_reaction` が含まれている。`docs/milestone-4.5-design.md:606-621`
- しかし required signal として固定されているのは `speaker_role`、`reaction_intensity_score`、`visual_tags`、`semantic_cluster_id` などまでで、axis side、facing direction、shot pair、visual similarity の語彙と決定規則は定義されていない。`docs/milestone-4.5-design.md:636-679`
- 現行 compiler は明示 field 前提で score / assemble を決める実装であり、deterministic に載せるには signal 側の語彙固定が必要になる。`runtime/compiler/score.ts:14-109` `runtime/compiler/assemble.ts:16-158`

評価:

- IR 表現可能/不可能の大分け自体は妥当で、deferred 6 skill を別 milestone に逃がした判断は正しい。`docs/milestone-4.5-design.md:623-633`
- ただし上記 4 skill は「IR は足りるが signal / effect contract はまだ粗い」状態で、設計書どおりに compiler へ入れるにはもう半歩仕様固定が必要。

修正推奨:

- `runtime/editorial/skills/*.yaml.required_signals` に axis / reaction / match-cut 系の tag vocabulary を明記する。
- `effects.transition_override` や visual-similarity bonus が最終的にどの compiler field / metadata に落ちるかを 1 段明記する。
- それが難しければ、上記 4 skill は M4.5 初期実装では `deferred_signal_contract` 扱いへ下げる。

## R1 解消確認

| R1 項目 | 判定 | 確認内容 |
| --- | --- | --- |
| FATAL 1. stable candidate ref 不在 | 解消 | `candidate_id` / `candidate_ref` を正式化し、legacy shim、timeline / review patch まで含めた downstream 参照方針が明記された。`docs/milestone-4.5-design.md:191-224` `docs/milestone-4.5-design.md:248-283` `docs/milestone-4.5-design.md:1000-1022` |
| FATAL 2. 18 skill を現行 IR に無理に載せる | 解消 | M4.5 対象を beat-linear IR で表現可能な subset に限定し、scene / interleave / overlap 系 6 skill は deferred に分離した。`docs/milestone-4.5-design.md:22-33` `docs/milestone-4.5-design.md:79-97` `docs/milestone-4.5-design.md:551-633` |
| WARNING 1. profile / policy 推論条件が不足 | 解消 | `creative_brief.editorial` に structured field を追加し、deterministic inference table と signal 不足時の blocker 化が定義された。`docs/milestone-4.5-design.md:721-760` `docs/milestone-4.5-design.md:742-745` |
| WARNING 2. 実装順序に signal producer phase がない | 解消 | `/triage` ownership を先に固定し、Implementation Order でも Phase 2 として独立した。`docs/milestone-4.5-design.md:251-263` `docs/milestone-4.5-design.md:1015-1027` |
| WARNING 3. `confirmed_preferences` に default を混ぜる | 解消 | `confirmed_preferences` を確定判断専用に維持し、policy default は `pacing.default_duration_target_sec` へ分離した。`docs/milestone-4.5-design.md:124-125` `docs/milestone-4.5-design.md:467-469` `docs/milestone-4.5-design.md:811-825` |
| WARNING 4. Phase D metric が粗い | 解消 | gate / advisory を分けた deterministic metric table、input、fallback、enforcement が追加された。`docs/milestone-4.5-design.md:411-424` |
| WARNING 5. provenance に registry 依存が出ない | 解消 | `compiler_defaults_hash` と `editorial_registry_hash` を `timeline.json.provenance` に残す方針が明記された。`docs/milestone-4.5-design.md:144-145` `docs/milestone-4.5-design.md:903-906` `docs/milestone-4.5-design.md:936-937` |
| NOTE 1. 4 フェーズを operational artifact に閉じ込める | 維持 | canonical / operational split は維持され、`edit_blueprint.yaml` を唯一の canonical plan に据えたまま。`docs/milestone-4.5-design.md:150-169` |
| NOTE 2. interest point -> adaptive trim は契約境界がきれい | 維持 | additive contract と trim subphase が明記され、`candidate_ref` と結びついた resolved trim 記録まで整理された。`docs/milestone-4.5-design.md:840-914` |

## 契約整合の確認

### `candidate_ref` 導入

- `segment_id` を media locator として残しつつ、editorial identity / fallback / patch safety を `candidate_ref` に寄せる方針は妥当。`docs/milestone-4.5-design.md:118-125` `docs/milestone-4.5-design.md:191-224`
- `timeline.json` と `review_patch.json` は現状 closed schema だが、additive extension 対象として明示されているため、既存 consumer を壊さずに拡張できる。`docs/milestone-4.5-design.md:171-189` `docs/milestone-4.5-design.md:884-914`
- 既存 compiler が `segment_id` / `fallback_segment_ids` 中心で動いている現状とも矛盾しない。M4.5 では互換 field を残して段階移行する設計になっている。`runtime/compiler/assemble.ts:174-249` `runtime/compiler/resolve.ts:16-167`

### skill の IR 表現可能 / 不可能の分離

- 「within-beat multi-clip」「thread / section」「audio lead / lag」「overlap-aware transition」が必要な skill を deferred に回した判断は、現行 beat-linear compiler と整合している。`ARCHITECTURE.md:104-123` `runtime/compiler/assemble.ts:16-158` `docs/milestone-4.5-design.md:623-633`
- 先行導入 skill は score / eligibility / beat order bias / trim bias / metadata tag に落とすという原則も妥当。`docs/milestone-4.5-design.md:595-603`

### 実装順序

- 実装順序は R1 の推奨リプランどおり、`candidate_ref` -> `/triage` signal -> adaptive trim -> profile / policy -> `/blueprint` internal phases -> supported skill compiler -> review gate の順へ修正された。`docs/milestone-4.5-design.md:998-1096`
- migration plan も同順序で additive rollout を想定しており、旧 fixture fail-open と両立している。`docs/milestone-4.5-design.md:1143-1158`

## 結論

R1 の 9 件は、NOTE 2 件を含めて全件確認した。FATAL は解消済みで、R2 判定は `CONDITIONAL PASS` とする。残課題は先行導入 skill の signal / effect vocabulary 固定だけであり、これは設計の方向性を壊す問題ではない。
