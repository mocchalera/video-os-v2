# M4 Implementation Review: Caption + Audio + Packaging (R2)

レビュー日: 2026-03-21

## Validation

- `npx vitest run`
  - 24 files
  - 920 passed
  - 7 skipped
  - 0 failed
- `npx tsc --noEmit`
  - passed

## Summary

- FATAL: 2
- WARNING: 0
- NOTE: 1
- 判定: FAIL

## Findings

### FATAL 1: `/package` は `engine_render` の実 render pipeline をまだ実行しておらず、実動の packaging entrypoint になっていない

根拠:
- `packageCommand` は `assemblyPath` / `suppliedFinalPath` / `skipRender` を option として持つが、`engine_render` 側では `skipRender` 時に stub artifact を書くか、既存ファイルの存在確認をするだけで、render pipeline 自体を起動していない。[runtime/commands/package.ts:55](/path/to/project/runtime/commands/package.ts#L55) [runtime/commands/package.ts:207](/path/to/project/runtime/commands/package.ts#L207) [runtime/commands/package.ts:230](/path/to/project/runtime/commands/package.ts#L230)
- 一方で render pipeline 本体 `runRenderPipeline()` は別モジュールに存在し、`assembly.mp4` を受けて demux / sidecar / caption burn / audio mix / final mux を行う設計になっているが、`packageCommand` から呼ばれていない。[runtime/render/pipeline.ts:274](/path/to/project/runtime/render/pipeline.ts#L274)
- 設計書は `engine_render` path で `assembly.mp4 -> caption_burn -> audio_master -> package` の stepwise pipeline により `final.mp4`, `raw_dialogue.wav`, `final_mix.wav`, sidecar subtitle を生成できることを完了条件にしている。[docs/milestone-4-design.md:67](/path/to/project/docs/milestone-4-design.md#L67)
- 今回追加された E2E は `current_state=packaged` まで確認しているが、いずれも `skipRender: true` を前提にしており、実 render path の接続は検証していない。[tests/e2e-m4.test.ts:263](/path/to/project/tests/e2e-m4.test.ts#L263) [tests/e2e-m4.test.ts:324](/path/to/project/tests/e2e-m4.test.ts#L324) [tests/e2e-m4.test.ts:459](/path/to/project/tests/e2e-m4.test.ts#L459) [tests/e2e-m4.test.ts:536](/path/to/project/tests/e2e-m4.test.ts#L536)

影響:
- 前回 F2 のうち、`package_manifest` の自己参照 requirement と sidecar 名の齟齬は解消されたが、`engine_render` の本体配線は未解消。
- M4 の success criteria 5, 10 をまだ満たせず、`/package` を実運用の single entrypoint と見なせない。

### FATAL 2: `project_state` の M4 invalidation / hash semantics は未完成で、Gate 10 変更や packaging freshness を deterministic に扱えていない

根拠:
- `ApprovalRecord` 型は M4 で必須化された `base_timeline_version` / `editorial_timeline_hash` を保持しておらず、`approvalVersionsMatch()` も legacy field しか照合していない。[runtime/state/reconcile.ts:51](/path/to/project/runtime/state/reconcile.ts#L51) [runtime/state/reconcile.ts:359](/path/to/project/runtime/state/reconcile.ts#L359) [docs/milestone-4-design.md:146](/path/to/project/docs/milestone-4-design.md#L146)
- `snapshotArtifacts()` は `editorial_timeline_hash` を `timeline_version` の単純コピーにし、`packaging_projection_hash` も `caption_approval_hash + music_cues_hash` だけから作っている。設計が要求する editorial / packaging surface の分離、render defaults・toolchain を含む freshness key になっていない。[runtime/state/reconcile.ts:273](/path/to/project/runtime/state/reconcile.ts#L273) [runtime/state/reconcile.ts:278](/path/to/project/runtime/state/reconcile.ts#L278) [docs/milestone-4-design.md:137](/path/to/project/docs/milestone-4-design.md#L137) [docs/milestone-4-design.md:178](/path/to/project/docs/milestone-4-design.md#L178) [ARCHITECTURE.md:238](/path/to/project/ARCHITECTURE.md#L238)
- `detectInvalidation()` は file-hash 差分しか見ておらず、設計と architecture が明示する `handoff_resolution.source_of_truth_decision` 変更を stale trigger にしていない。[runtime/state/reconcile.ts:381](/path/to/project/runtime/state/reconcile.ts#L381) [runtime/state/reconcile.ts:408](/path/to/project/runtime/state/reconcile.ts#L408) [docs/milestone-4-design.md:175](/path/to/project/docs/milestone-4-design.md#L175) [docs/milestone-4-design.md:1035](/path/to/project/docs/milestone-4-design.md#L1035) [ARCHITECTURE.md:245](/path/to/project/ARCHITECTURE.md#L245)
- `packaging_gate` も `review_gate open + handoff decided + approval clean` しか見ておらず、caption/music/path-specific input の前提を gate に反映していない。[runtime/state/reconcile.ts:629](/path/to/project/runtime/state/reconcile.ts#L629) [docs/milestone-4-design.md:150](/path/to/project/docs/milestone-4-design.md#L150)

影響:
- 前回 F3 のうち「`packaged` が `reconcile()` で `approved` に戻る」問題自体は改善され、E2E でも保持できているが、M4 の freshness / fallback contract は未達。
- Gate 10 flip、render defaults 変更、toolchain fingerprint 変更時の deterministic fallback を保証できないため、success criteria 8-9 をまだ満たせない。

### NOTE 1: 前回 FATAL 1 (`SC_*` prefix mismatch) は解消されている

根拠:
- `segmenter` は caption id を `SC_0001` 形式で生成するようになった。[runtime/caption/segmenter.ts:359](/path/to/project/runtime/caption/segmenter.ts#L359)
- schema 側の `caption_id` も `^SC_` を要求しており、runtime と一致している。[schemas/caption-approval.schema.json:63](/path/to/project/schemas/caption-approval.schema.json#L63)
- M4 caption test も `SC_` 語彙に更新されている。[tests/m4-caption.test.ts:151](/path/to/project/tests/m4-caption.test.ts#L151)

影響:
- 前回 F1 は解消済み。
- transcript-backed caption approval の schema promotion blocker はこの観点では再現しない。

## Verdict

- 前回 FATAL 3件のうち、F1 は解消、F2/F3 は部分改善だが FATAL として残る。
- FATAL 2 件のため、判定は `FAIL`。
- コミットはまだ保留にすべき。
