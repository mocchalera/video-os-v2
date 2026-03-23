# M3.5 Final Review

判定: `CONDITIONAL PASS`

- FATAL: `0`
- コミット判定: `WARNING を許容するなら可`

実行確認:
- `npx vitest run`: `20` files passed, `815` tests passed, `7` skipped
- `npx tsc --noEmit`: passed

## FATAL Recheck

`docs/impl-review-m35-p2p3.md` は現在 `FATAL 4件` を列挙していますが、その 4 件は解消されています。

- base timeline hash 検証は [`runtime/handoff/import.ts`](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/import.ts#L269) と [`runtime/handoff/import.ts`](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/import.ts#L1142) で実装され、real path でも import 前に reject されます。
- metadata を失った imported clip は bridge で落とされず保持され、`metadata_lost` として import 側へ渡されます。[`runtime/handoff/otio-bridge.py`](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/otio-bridge.py#L307) [`runtime/handoff/import.ts`](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/import.ts#L646)
- lossy / unsupported 判定は profile 定義の写経ではなく imported evidence から作られます。[`runtime/handoff/import.ts`](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/import.ts#L612)
- Gate 9 は dropped stable metadata / lossy / unsupported まで見るようになっています。[`runtime/handoff/import.ts`](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/import.ts#L778)

`docs/impl-review-m35-p4.md` の `FATAL 4件` も解消されています。

- diff は profile の `lossy` surface だけで `unmapped_edits[]` を捏造せず、`importReport.loss_summary` を evidence として読みます。[`runtime/handoff/diff.ts`](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/diff.ts#L869)
- global track swap は `track_move` ではなく `track_reorder` に落ち、unsupported transition も黙殺されません。[`runtime/handoff/diff.ts`](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/diff.ts#L468) [`runtime/handoff/diff.ts`](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/diff.ts#L731)
- `/handoff-import` 相当の no-proposal path では approval/state を壊さず、proposal artifact ができた時だけ invalidation します。[`runtime/handoff/reentry.ts`](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/reentry.ts#L423)
- recompile loop は proposal artifact を compiler override に通すようになっています。[`runtime/handoff/reentry.ts`](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/reentry.ts#L395) [`runtime/compiler/index.ts`](/Users/mocchalera/Dev/video-os-v2-spec/runtime/compiler/index.ts#L57)

## Gates / Round-Trip

- Gate 8: stable ID preflight は有効です。[`runtime/handoff/export.ts`](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/export.ts#L127)
- Gate 9: unmapped / provisional / one-to-many / dropped metadata / lossy / unsupported で `review_required` になります。[`runtime/handoff/import.ts`](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/import.ts#L778)
- Gate 10: handoff diff hash は `project_state.yaml.handoff_resolution` に persist され、proposal が無い時は state を動かしません。[`runtime/handoff/reentry.ts`](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/reentry.ts#L300) [`runtime/handoff/reentry.ts`](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/reentry.ts#L458)
- Gate 11: verified/provisional/report-only/lossy の境界は import/diff の両方で機能しています。[`runtime/handoff/import.ts`](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/import.ts#L658) [`runtime/handoff/diff.ts`](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/diff.ts#L733)
- stable ID round-trip は main path で維持されています。export readback、imported clip の retention、metadata-lost 検出の骨格は成立しています。[`runtime/handoff/export.ts`](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/export.ts#L575) [`runtime/handoff/otio-bridge.py`](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/otio-bridge.py#L307)

## WARNING

1. real import path が exported base OTIO の再読込を必須にしていません。`exportedOtioPath` は optional のままで、未指定時は `exportedClips=[]` のまま mapping に進みます。設計の import flow step 3-6 は base OTIO の再読込を前提にしているので、ここは default 解決か hard fail が必要です。[`runtime/handoff/import.ts`](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/import.ts#L1208) [`runtime/handoff/import.ts`](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/import.ts#L1249)

2. fallback / one-to-many の edge 判定はまだ緩いです。`clip.name.includes(exported.clip_id)` は prefix collision を誤マップし得ますし、split 判定も parent range cover を見ていません。[`runtime/handoff/import.ts`](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/import.ts#L384) [`runtime/handoff/import.ts`](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/import.ts#L515)

3. export/import boundary の runtime guard はまだ不完全です。manifest / roundtrip report は runtime で schema validate されず、export readback 失敗も hard fail になりません。[`runtime/handoff/export.ts`](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/export.ts#L486) [`runtime/handoff/import.ts`](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/import.ts#L829) [`runtime/handoff/export.ts`](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/export.ts#L807)

4. `simple_transition` は unsupported transition を report できるようになりましたが、diff operation 自体は設計で要求されている adjacent clip pair / side をまだ持ちません。[`runtime/handoff/diff.ts`](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/diff.ts#L742)

5. export path の bridge error はなお structured payload を十分に返していません。non-zero exit 時に `stderr` 文字列だけで潰しており、import path ほど診断可能ではありません。[`runtime/handoff/export.ts`](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/export.ts#L774)

## Conclusion

前回レビューの FATAL は解消済みで、M3.5 の mainline contract は通っています。いま残っているのは edge-case と boundary hardening の warning で、判定は `CONDITIONAL PASS` です。
