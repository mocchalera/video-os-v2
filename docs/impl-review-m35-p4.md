# M3.5 Phase 4 実装レビュー

総合判定: `FAIL`

対象:
- [runtime/handoff/diff.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/diff.ts)
- [runtime/handoff/reentry.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/reentry.ts)
- [tests/m35-phase4.test.ts](/Users/mocchalera/Dev/video-os-v2-spec/tests/m35-phase4.test.ts)

実行確認:
- `npx vitest run`: pass
- `npx tsc --noEmit`: pass

## FATAL 1 (FAIL)
`human_revision_diff` が実際の import evidence ではなく capability profile の `lossy` surface 定義だけで `unmapped_edits[]` を捏造しています。  
根拠:
- [runtime/handoff/diff.ts:612](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/diff.ts#L612) で `categorizeSurfaces(profile).lossy` をそのまま `unmapped_edits` に追加している
- [runtime/handoff/diff.ts:638](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/diff.ts#L638) でその結果 `status` が `review_required` に倒れる
- [runtime/handoff/diff.ts:148](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/diff.ts#L148) の `importReport` は実質未使用
- 設計は「classification は capability profile と import normalization の両方で決める」「lossy なのは surface に変更があった時」としている: [docs/milestone-3.5-design.md:851](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L851), [docs/milestone-3.5-design.md:1127](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L1127)
- テストも誤挙動を固定している: [tests/m35-phase4.test.ts:672](/Users/mocchalera/Dev/video-os-v2-spec/tests/m35-phase4.test.ts#L672)

影響:
- lossy surface を持つ profile では、変更がなくても diff が `review_required` 化しうる
- `unmapped_edits[]` と `summary.unmapped` が実編集ではなく profile 能力表の写経になる
- `lossy` / `review_required` の意味論が崩れる

## FATAL 2 (FAIL)
`track_reorder` / transition fallback の設計が未実装で、実編集を誤分類または黙殺します。  
根拠:
- [runtime/handoff/diff.ts:447](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/diff.ts#L447) は `track_id` の差分だけで `track_move` を出しており、設計上必要な logical assignment (`track_id` + `track_kind`) 判定も global `track_reorder` fallback も無い
- [docs/milestone-3.5-design.md:747](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L747) - [docs/milestone-3.5-design.md:759](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L759) は global track reorder を `track_reorder` に落とすと明記
- required automated check でも同件が必須: [docs/milestone-3.5-design.md:1237](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L1237)
- ローカル再現では V1/V2 の入れ替えだけで 2 件の `track_move` が出た
- [runtime/handoff/diff.ts:511](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/diff.ts#L511) - [runtime/handoff/diff.ts:529](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/diff.ts#L529) は unsupported transition を `continue` で捨てており、設計の「complex/vendor transition は unmapped に落とす」に反する: [docs/milestone-3.5-design.md:761](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L761)
- transition diff が持つべき adjacent pair / side も表現されていない: [docs/milestone-3.5-design.md:768](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L768)

影響:
- global track reorder が blueprint revision ではなく clip 単位 `track_move` として誤誘導される
- unsupported transition 編集が diff から消える
- blueprint-planner へ渡る structural signal が欠落する

## FATAL 3 (FAIL)
`executeRecompileLoop()` が canonical artifact 未更新の段階で `approval_record` を stale にし、state まで戻しています。  
根拠:
- [runtime/handoff/reentry.ts:372](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/reentry.ts#L372) - [runtime/handoff/reentry.ts:430](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/reentry.ts#L430) で raw diff evidence だけを見て invalidation と state transition を実行
- 設計は `/handoff-import` 完了時は `approval_record unchanged`, state `approved` のまま、`review_patch.json` / `review_report.yaml` もしくは `edit_blueprint.yaml` を promote した時点で stale/state transition と定義している: [docs/milestone-3.5-design.md:1044](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L1044), [docs/milestone-3.5-design.md:1056](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L1056)
- 現行テストもこの誤契約を受け入れている: [tests/m35-phase4.test.ts:1176](/Users/mocchalera/Dev/video-os-v2-spec/tests/m35-phase4.test.ts#L1176), [tests/m35-phase4.test.ts:1207](/Users/mocchalera/Dev/video-os-v2-spec/tests/m35-phase4.test.ts#L1207)

影響:
- import report しか無い時点で `approved` snapshot を壊す
- M3 invalidation contract が「artifact promote」ではなく「diff があっただけ」で発火してしまう
- operator provenance と state machine がずれる

## FATAL 4 (FAIL)
recompile loop が「diff -> proposal -> deterministic compile -> preview update」を実現していません。  
根拠:
- [runtime/handoff/reentry.ts:341](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/reentry.ts#L341) - [runtime/handoff/reentry.ts:347](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/reentry.ts#L347) の agent interface は `Promise<void>` で、proposal artifact を返さない
- [runtime/handoff/reentry.ts:401](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/reentry.ts#L401) - [runtime/handoff/reentry.ts:412](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/reentry.ts#L412) は既存 blueprint/selects をそのまま `compile()` し直すだけ
- compiler 自体も review patch や human diff を入力に取らない: [runtime/compiler/index.ts:56](/Users/mocchalera/Dev/video-os-v2-spec/runtime/compiler/index.ts#L56)
- 設計フローは `/review` or `/blueprint` が proposal を作り、その canonical artifact 更新後に deterministic compile / preview update へ進む想定: [docs/milestone-3.5-design.md:1010](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L1010)

影響:
- diff を読んでも compile 結果は handoff 前と同じ artifact の再出力になりうる
- preview update の根拠が無い
- テストの「mock agent proposal から preview を再生成できる」要件を満たしていない

## WARNING 1 (CONDITIONAL PASS)
`handoff_resolution` の更新は不完全です。  
根拠:
- [runtime/handoff/reentry.ts:293](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/reentry.ts#L293) - [runtime/handoff/reentry.ts:310](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/reentry.ts#L310) は in-memory 更新のみ
- [runtime/handoff/reentry.ts:419](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/reentry.ts#L419) - [runtime/handoff/reentry.ts:430](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/reentry.ts#L419) まで write されないため、state が変わらない case では diff hash が永続化されない
- ローカル再現で report-only diff 実行後の `project_state.yaml` に `handoff_resolution` が残らないことを確認
- [runtime/handoff/reentry.ts:298](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/reentry.ts#L298) は既存 `handoff_id` 不一致も考慮していない
- テストは no-actionable case で `handoff_resolution` persistence を見ていない: [tests/m35-phase4.test.ts:1297](/Users/mocchalera/Dev/video-os-v2-spec/tests/m35-phase4.test.ts#L1297)

## WARNING 2 (CONDITIONAL PASS)
runtime 側の schema validate が未配線です。  
根拠:
- [runtime/handoff/diff.ts:12](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/diff.ts#L12) は `human_revision_diff.yaml generation (schema-validated)` と書いているが、実装内に validation がない
- [tests/m35-phase4.test.ts:764](/Users/mocchalera/Dev/video-os-v2-spec/tests/m35-phase4.test.ts#L764) では AJV をテスト側から直接呼んでいるだけ

影響:
- runtime 変更で schema drift が入っても production path では検知できない
- `reentry.ts` も invalid diff を受け入れて動いてしまう

## WARNING 3 (CONDITIONAL PASS)
テスト網羅は主要 happy path に寄っており、設計で必須とされた edge case が抜けています。  
不足:
- `global track reorder -> track_reorder`
- unsupported / complex transition -> `unmapped_edits[]`
- `deleted_clip_without_disable`, `note_text_add`, `ambiguous_mapping` の analyzer 側検出
- no-actionable diff でも `handoff_resolution` が persist されること
- runtime schema validation failure path

参考:
- 現行は ripple/reorder と単純 consumer classification に集中: [tests/m35-phase4.test.ts:479](/Users/mocchalera/Dev/video-os-v2-spec/tests/m35-phase4.test.ts#L479), [tests/m35-phase4.test.ts:930](/Users/mocchalera/Dev/video-os-v2-spec/tests/m35-phase4.test.ts#L930)

## NOTE 1 (PASS)
ripple shift vs reorder の peer-order 判定そのものは、coverage されている contiguous trim ケースでは妥当です。  
根拠:
- [runtime/handoff/diff.ts:226](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/diff.ts#L226) - [runtime/handoff/diff.ts:305](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/diff.ts#L305)
- [tests/m35-phase4.test.ts:479](/Users/mocchalera/Dev/video-os-v2-spec/tests/m35-phase4.test.ts#L479)

ただしこれは `track_reorder`, transition, gap insertion など未実装ケースを含まない限定 PASS です。

