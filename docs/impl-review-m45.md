# M4.5 Implementation Review

対象:

- A. `candidate_ref`
- B-C. `triage signal` + `adaptive trim`
- D. `profile / policy`
- E. `editing skills`
- F. `script engine`
- G. `tests`

参照:

- `docs/milestone-4.5-design.md`
- `docs/milestone-4.5-review-r2.md`

判定:

- `CONDITIONAL PASS`
- `FATAL 0`
- `WARNING 4`
- `NOTE 1`

実行確認:

- `npx vitest run` -> `30 passed`, `996 passed`, `7 skipped`
- `npx tsc --noEmit` -> pass

既存テスト群は全通過しており、現時点で `determinism` を壊す回帰は見えていない。一方で、M4.5 設計書が追加した「editorial contract」を runtime の本線に載せ切れていない箇所が残っている。

## Findings

### WARNING 1. `candidate_ref` は export されたが、resolve / review patch の下流更新で整合が崩れる

根拠:

- `assemble` は `candidate_ref` / `fallback_candidate_refs` を clip に付与している。`runtime/compiler/assemble.ts:230-255`
- しかし duplicate 解決は依然として `segment_id` / `fallback_segment_ids` を正としており、差し替え時に `candidate_ref` を更新しない。`runtime/compiler/resolve.ts:21-25` `runtime/compiler/resolve.ts:118-133`
- review patch も同様で、候補 lookup は `segment_id` map のみ、`replace_segment` / `insert_segment` ともに `candidate_ref` を設定しない。`runtime/compiler/patch.ts:147-150` `runtime/compiler/patch.ts:208-244` `runtime/compiler/patch.ts:294-344`
- schema は `with_candidate_ref` を additive 追加済みだが、patch runtime はまだその field を受け取らない。`schemas/review-patch.schema.json:93-95` `runtime/compiler/patch.ts:31-46`

影響:

- duplicate fallback や review patch 後の `timeline.json` で、clip の実体は別 candidate に入れ替わっているのに `candidate_ref` が旧値のまま残る、または新規 insert clip に `candidate_ref` が無い状態が起こる。
- 設計書の review patch safety / fallback safety が `candidate_ref` 基準になる前提と一致していない。

評価:

- 既存 `segment_id` ベース契約は壊していないため `FATAL` ではない。
- ただしレビュー観点 1 の「all downstream consistency」は未達。

修正推奨:

- `resolve` と `patch` の candidate lookup を `candidate_ref` 優先に切り替える。
- replace / insert / fallback replacement では `candidate_ref` / `fallback_candidate_refs` を必ず再計算する。
- `with_candidate_ref` 単独指定の runtime test を追加する。

### WARNING 2. editing skill の score / trim 統合が実質的に効いていない

根拠:

- `scoreCandidates` は `getSkillScoreAdjustment()` の戻り値をそのまま全 candidate に加算する。`runtime/compiler/score.ts:168-180`
- しかし `getSkillScoreAdjustment()` は candidate signal や beat 条件を見ず、active skill ごとの固定 bonus / penalty を総和して返すだけである。`runtime/editorial/skill-registry.ts:147-173`
- このため同一 beat 内の全 candidate に同じ定数が乗り、ranking は変わらない。`score` 統合としては実質 no-op。
- さらに trim 系 skill 用の `getSkillTrimEffects()` は実装されているが、compiler から一度も呼ばれていない。`runtime/editorial/skill-registry.ts:178-207` `runtime/compiler/index.ts:111-116` `runtime/compiler/trim.ts:220-224`
- その結果、`silence_beat` / `cooldown_resolve` の resolve-phase effect は actual trim に反映されない。

影響:

- レビュー観点 4 の「IR 表現可能な skill の score 統合」は仕様名だけ存在し、選定結果や trim 結果をほぼ変えていない。
- M4.5 で差が出るはずの interview / highlight / closing hold 系の compiler behavior が runtime で説明できない。

評価:

- deterministic ではあるが、supported skill compiler としては不十分。

修正推奨:

- score bonus / penalty は candidate role, signal, beat story role, policy suppression を条件に candidate ごとに計算する。
- trim subphase に `activeSkills` と beat `story_role` を渡し、`getSkillTrimEffects()` を実際に適用する。
- skill ごとの差分が ranking / trim に反映される統合テストを追加する。

### WARNING 3. profile / policy resolution が設計書の inference / override / source-of-truth に追従していない

根拠:

- `matrix.yaml` は「single source of truth」と宣言されているが、resolver はこの file を読まず、profile->policy map をコードに重複定義している。`runtime/editorial/matrix.yaml:1-11` `runtime/editorial/policy-resolver.ts:149-157`
- 設計書にある policy override
  - chronology 必須時の `chronological-recap`
  - `credibility_bias=high` + `hook_priority=credibility_first` 時の `documentary`
  が resolver に実装されていない。`runtime/editorial/policies/chronological-recap.yaml:1-16` `runtime/editorial/policies/documentary.yaml:1-16` `runtime/editorial/policy-resolver.ts:161-264`
- signal 不足時も resolver は default `interview-highlight` を返すだけで、design の blocker 化には接続されていない。`runtime/editorial/policy-resolver.ts:193-231`

影響:

- structured field からの deterministic resolution は一部しか実装されておらず、設計書どおりの profile/policy 決定を再現できない。
- `matrix.yaml`・profile YAML・policy YAML のいずれを更新しても runtime が追従しない drift が起こり得る。

評価:

- レビュー観点 3 に対して、基礎実装はあるが contract の一貫性が不足している。

修正推奨:

- `matrix.yaml` を実際に読み、profile->policy map と supported/deferred skill の source of truth を一本化する。
- design doc の override table を resolver に実装する。
- insufficient signal は `/blueprint` の `uncertainty_register` blocker へ接続する。

### WARNING 4. script engine 4フェーズは helper として存在するが、`/blueprint` の runtime path に統合されていない

根拠:

- script engine module 自体は追加されている。`runtime/script/frame.ts` `runtime/script/read.ts` `runtime/script/draft.ts` `runtime/script/evaluate.ts`
- しかし `/blueprint` command は依然として agent の返した `edit_blueprint.yaml` / `uncertainty_register.yaml` だけを validate/promote しており、`message_frame.yaml` / `material_reading.yaml` / `script_draft.yaml` / `script_evaluation.yaml` を生成しない。`runtime/commands/blueprint.ts:1-17` `runtime/commands/blueprint.ts:305-318`
- 参照も無く、現状この 4 module を使っているのは test のみである。
- さらに Phase D の fail-closed 仕様も不足している。`evaluateScript()` は `duplicate_primary` や `interviewer_contamination` を warning にするだけで gate を落とさない。`runtime/script/evaluate.ts:133-197`

影響:

- レビュー観点 5 の「4フェーズが設計書リプランどおりに `/blueprint` 内部 workflow へ入っているか」は未達。
- operational artifact が runtime に残らず、closing unsupported / interviewer contamination / hard dedupe を blueprint gate で止められない。

評価:

- 既存 `/blueprint` 契約は保たれているが、M4.5 の中核機能はまだ library/test 段階。

修正推奨:

- `/blueprint` で 4 operational artifact を生成し、その projection として `edit_blueprint.yaml` を確定する。
- `evaluateScript()` の gate に design doc の fail-closed 条件を反映する。
- command-level integration test を追加する。

## Note

### NOTE 1. additive schema rollout と既存回帰の抑制は概ね良好

確認内容:

- `selects-candidates`, `edit-blueprint`, `timeline-ir`, `review-patch` の additive field は schema compatibility test で旧 artifact と併存できている。`tests/m45-schema-compat.test.ts`
- `candidate_ref` legacy shim、adaptive trim pure function、profile/policy resolver、skill registry helper、script engine helper は個別 unit test がある。`tests/m45-*.test.ts`
- `npx vitest run` と `npx tsc --noEmit` は両方 pass しており、少なくとも現時点の baseline 互換性は維持されている。

## Conclusion

`FATAL` は見当たらず、既存 996 テストも全通過しているため、M4.5 は「既存契約を壊した実装」ではない。ただし、`candidate_ref` の下流整合、policy-aware skill activation、`/blueprint` への 4 フェーズ統合は未完で、設計書の editorial contract までは到達していない。判定は `CONDITIONAL PASS` とする。
