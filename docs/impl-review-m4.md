# M4 Implementation Review: Caption + Audio + Packaging

レビュー日: 2026-03-21

## Validation

- `npx vitest run`
  - 24 files
  - 918 passed
  - 7 skipped
  - 0 failed
- `npx tsc --noEmit`
  - passed

## Summary

- FATAL: 3
- WARNING: 3
- NOTE: 1
- 判定: FAIL

## Findings

### FATAL 1: transcript-backed caption approval が schema promotion に到達できない

根拠:
- segmenter は caption id を `CAP_0001` 形式で生成している。[runtime/caption/segmenter.ts:359](/Users/mocchalera/Dev/video-os-v2-spec/runtime/caption/segmenter.ts#L359)
- しかし schema は `caption_id` に `^SC_` を要求している。[schemas/caption-approval.schema.json:63](/Users/mocchalera/Dev/video-os-v2-spec/schemas/caption-approval.schema.json#L63)
- M4 caption test も `CAP_` 系を正として固定しており、runtime と schema の不整合を温存している。[tests/m4-caption.test.ts:151](/Users/mocchalera/Dev/video-os-v2-spec/tests/m4-caption.test.ts#L151) [tests/m4-caption.test.ts:552](/Users/mocchalera/Dev/video-os-v2-spec/tests/m4-caption.test.ts#L552) [tests/m4-caption.test.ts:596](/Users/mocchalera/Dev/video-os-v2-spec/tests/m4-caption.test.ts#L596)
- 実際に `generateCaptionSource()` → `createDraftApproval()` → schema validate を再現すると、`/speech_captions/0/caption_id: must match pattern "^SC_"` で失敗した。

影響:
- `captionCommand` は `source=none` か transcript 未検出のケースでは通るが、実 caption を含む 2 段階 workflow を完走できない。
- 設計書の success criteria 2-3 を満たせない。

### FATAL 2: `/package` は両 path とも packaged に到達できず、engine_render も実際には配線されていない

根拠:
- `packageCommand` は render pipeline を import / invoke しておらず、`assemblyPath` option も使っていない。コード上は Gate 10 後に QA 組み立てへ直行している。[runtime/commands/package.ts:55](/Users/mocchalera/Dev/video-os-v2-spec/runtime/commands/package.ts#L55) [runtime/commands/package.ts:77](/Users/mocchalera/Dev/video-os-v2-spec/runtime/commands/package.ts#L77) [runtime/commands/package.ts:305](/Users/mocchalera/Dev/video-os-v2-spec/runtime/commands/package.ts#L305)
- `checkPackageCompleteness()` は QA 前 artifact として `package_manifest` を必須化している。[runtime/packaging/qa.ts:261](/Users/mocchalera/Dev/video-os-v2-spec/runtime/packaging/qa.ts#L261) [runtime/packaging/qa.ts:263](/Users/mocchalera/Dev/video-os-v2-spec/runtime/packaging/qa.ts#L263)
- 一方、設計書の required artifact matrix は `package_manifest` を required に含めていない。[docs/milestone-4-design.md:1230](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1230) [docs/milestone-4-design.md:1236](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1236)
- `packageCommand` 側は `existingArtifacts` に `package_manifest` を一度も追加していない。さらに sidecar 必須時は `sidecar_captions` を積むが、QA 側は `srt_sidecar` / `vtt_sidecar` を要求している。[runtime/commands/package.ts:205](/Users/mocchalera/Dev/video-os-v2-spec/runtime/commands/package.ts#L205) [runtime/commands/package.ts:216](/Users/mocchalera/Dev/video-os-v2-spec/runtime/commands/package.ts#L216) [runtime/commands/package.ts:232](/Users/mocchalera/Dev/video-os-v2-spec/runtime/commands/package.ts#L232) [runtime/packaging/qa.ts:277](/Users/mocchalera/Dev/video-os-v2-spec/runtime/packaging/qa.ts#L277) [runtime/packaging/qa.ts:278](/Users/mocchalera/Dev/video-os-v2-spec/runtime/packaging/qa.ts#L278)
- M4 E2E 自体がこの自己参照ギャップを前提に「metric checks pass」しか見ていない。[tests/e2e-m4.test.ts:10](/Users/mocchalera/Dev/video-os-v2-spec/tests/e2e-m4.test.ts#L10) [tests/e2e-m4.test.ts:281](/Users/mocchalera/Dev/video-os-v2-spec/tests/e2e-m4.test.ts#L281) [tests/e2e-m4.test.ts:287](/Users/mocchalera/Dev/video-os-v2-spec/tests/e2e-m4.test.ts#L287)
- さらに engine_render 側の assembly は stub のままで、pipeline は prebuilt `assembly.mp4` を必須化している。[runtime/render/composition.ts:73](/Users/mocchalera/Dev/video-os-v2-spec/runtime/render/composition.ts#L73) [runtime/render/pipeline.ts:293](/Users/mocchalera/Dev/video-os-v2-spec/runtime/render/pipeline.ts#L293)
- `music_cues` があっても pipeline は `mixAudio()` に `bgmPath` を渡さず、`speechIntervals` も空配列で固定しているため、BGM mix / ducking が発火しない。[runtime/render/pipeline.ts:400](/Users/mocchalera/Dev/video-os-v2-spec/runtime/render/pipeline.ts#L400) [runtime/render/pipeline.ts:410](/Users/mocchalera/Dev/video-os-v2-spec/runtime/render/pipeline.ts#L410) [runtime/audio/mixer.ts:95](/Users/mocchalera/Dev/video-os-v2-spec/runtime/audio/mixer.ts#L95) [runtime/audio/mixer.ts:105](/Users/mocchalera/Dev/video-os-v2-spec/runtime/audio/mixer.ts#L105)

影響:
- `engine_render` / `nle_finishing` のどちらでも `approved -> packaged` を正常完了できない。
- Remotion vs ffmpeg の責務分離も package path 上では未実装のまま。

### FATAL 3: `project_state` は packaged truth を保持できず、M4 invalidation も未実装

根拠:
- `STATE_ORDER` は `approved` で終わっており、`reconstructState()` は `packaged` を返さない。[runtime/state/reconcile.ts:278](/Users/mocchalera/Dev/video-os-v2-spec/runtime/state/reconcile.ts#L278) [runtime/state/reconcile.ts:290](/Users/mocchalera/Dev/video-os-v2-spec/runtime/state/reconcile.ts#L290)
- `snapshotArtifacts()` は `qa_report_hash` / `package_manifest_hash` は取るが、schema に追加された `editorial_timeline_hash` / `packaging_projection_hash` を一切計算していない。[runtime/state/reconcile.ts:238](/Users/mocchalera/Dev/video-os-v2-spec/runtime/state/reconcile.ts#L238) [runtime/state/reconcile.ts:242](/Users/mocchalera/Dev/video-os-v2-spec/runtime/state/reconcile.ts#L242) [schemas/project-state.schema.json:86](/Users/mocchalera/Dev/video-os-v2-spec/schemas/project-state.schema.json#L86) [schemas/project-state.schema.json:91](/Users/mocchalera/Dev/video-os-v2-spec/schemas/project-state.schema.json#L91)
- `detectInvalidation()` は file hash 変化しか見ず、設計で必須の `handoff_resolution.source_of_truth_decision` 変更や toolchain/render defaults change を検出できない。[runtime/state/reconcile.ts:366](/Users/mocchalera/Dev/video-os-v2-spec/runtime/state/reconcile.ts#L366) [runtime/state/reconcile.ts:382](/Users/mocchalera/Dev/video-os-v2-spec/runtime/state/reconcile.ts#L382) [docs/milestone-4-design.md:175](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L175) [docs/milestone-4-design.md:179](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L179) [ARCHITECTURE.md:245](/Users/mocchalera/Dev/video-os-v2-spec/ARCHITECTURE.md#L245)
- `computeGates()` の `packaging_gate` 判定も caption approval / music cues / path-specific inputs の存在を見ていない。[runtime/state/reconcile.ts:601](/Users/mocchalera/Dev/video-os-v2-spec/runtime/state/reconcile.ts#L601)
- 実再現でも、`qa-report.json` と `package_manifest.json` を揃えた `current_state=packaged` project が `reconcile()` で `approved` に巻き戻った。

影響:
- packaged project は次回起動時の reconcile で後退しうる。
- Gate 10 flip 時の deterministic fallback と freshness 管理を実装できていない。

### WARNING 1: QA hard checks が設計書の判定粒度まで届いていない

根拠:
- `checkCaptionAlignment()` は `transcript_item_ids` の有無しか見ず、設計書が要求する overlap ratio や `source=authored` 時の A1 overlap を検証していない。[runtime/packaging/qa.ts:125](/Users/mocchalera/Dev/video-os-v2-spec/runtime/packaging/qa.ts#L125) [docs/milestone-4-design.md:1130](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1130) [docs/milestone-4-design.md:1147](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1147)
- `supplied_export_probe_valid` は existence check のみで、container / stream count / duration / checksum を見ない。[runtime/commands/package.ts:244](/Users/mocchalera/Dev/video-os-v2-spec/runtime/commands/package.ts#L244) [docs/milestone-4-design.md:1085](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1085)
- `caption_delivery_valid` は `speech.vtt` の存在しか見ず、parseable sidecar や SRT-only supplied captions を判定しない。[runtime/commands/package.ts:256](/Users/mocchalera/Dev/video-os-v2-spec/runtime/commands/package.ts#L256) [docs/milestone-4-design.md:1094](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1094)
- `checkAvDrift()` は duration delta のみで、engine path の anchor offset を扱っていない。[runtime/packaging/qa.ts:192](/Users/mocchalera/Dev/video-os-v2-spec/runtime/packaging/qa.ts#L192) [docs/milestone-4-design.md:1181](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1181)

影響:
- `qa-report.json.passed=true` になっても、設計上の hard checks を実際に全部通したとは言えない。

### WARNING 2: caption projection contract が設計書より薄い

根拠:
- SpeechCaption projection は `src_in_us: 0`, `src_out_us: duration` を固定しており、設計書の「source dialogue region を継承する」と一致しない。[runtime/caption/approval.ts:121](/Users/mocchalera/Dev/video-os-v2-spec/runtime/caption/approval.ts#L121) [docs/milestone-4-design.md:707](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L707)
- `metadata.caption` に `language` と `delivery_mode` を入れていない。[runtime/caption/approval.ts:139](/Users/mocchalera/Dev/video-os-v2-spec/runtime/caption/approval.ts#L139) [docs/milestone-4-design.md:714](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L714)
- source generation phase で必要な auto sidecar `speech.auto.srt` を生成していない。[runtime/commands/caption.ts:143](/Users/mocchalera/Dev/video-os-v2-spec/runtime/commands/caption.ts#L143) [docs/milestone-4-design.md:261](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L261) [docs/milestone-4-design.md:666](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L666)

影響:
- 2 段階 caption workflow の機械可読 contract が設計より弱く、downstream で参照可能な情報が欠ける。

### WARNING 3: manifest/provenance の determinism 実装が設計書より弱い

根拠:
- `computePackagingProjectionHash()` は `captionApprovalHash`, `musicCuesHash`, `renderDefaultsHash` しか見ず、`editorial_timeline_hash`, Gate 10 path, tool fingerprints を含めていない。[runtime/packaging/manifest.ts:62](/Users/mocchalera/Dev/video-os-v2-spec/runtime/packaging/manifest.ts#L62) [docs/milestone-4-design.md:1309](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1309)
- `packageCommand` は `editorial_timeline_hash` に `timeline.json` の whole-file hash を流し込んでおり、設計書の editorial surface hash と一致しない。[runtime/commands/package.ts:362](/Users/mocchalera/Dev/video-os-v2-spec/runtime/commands/package.ts#L362) [docs/milestone-4-design.md:201](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L201)
- engine manifest で minimum provenance とされている `remotion_bundle_hash` などが実装上も schema 上も optional 扱いのままになっている。[runtime/packaging/manifest.ts:186](/Users/mocchalera/Dev/video-os-v2-spec/runtime/packaging/manifest.ts#L186) [schemas/package-manifest.schema.json:71](/Users/mocchalera/Dev/video-os-v2-spec/schemas/package-manifest.schema.json#L71) [docs/milestone-4-design.md:1310](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1310)

影響:
- manifest を freshness key / reproducibility proof として使う前提が崩れる。

### NOTE 1: 既存テストとの共存は通っているが、重要な broken path は未検知

根拠:
- 現在の suite は `vitest` で 918 pass / 7 skip、`tsc` も clean だった。
- ただし M4 E2E は package success ではなく「metric checks が通る」ことを見ており、実 packaged transition を assertion していない。[tests/e2e-m4.test.ts:281](/Users/mocchalera/Dev/video-os-v2-spec/tests/e2e-m4.test.ts#L281) [tests/e2e-m4.test.ts:469](/Users/mocchalera/Dev/video-os-v2-spec/tests/e2e-m4.test.ts#L469)

影響:
- 「既存 815 テストとの共存」は現時点の suite では機械的に成立しているが、M4 の本質的な回帰はまだ防げていない。

## Verdict

- FATAL 3 件のため、判定は `FAIL`。
- 優先度順の修正ポイントは以下。
  1. caption id 語彙を `SC_` に揃え、transcript-backed approval promotion を通す。
  2. `/package` に render pipeline を実配線し、self-referential な completeness check を解消する。
  3. `reconcile` に `packaged` 保持、Gate 10 invalidation、editorial / packaging hash 分離を実装する。
