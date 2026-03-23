# M4 Design Review: Caption + Audio + Packaging

レビュー日: 2026-03-21

対象:
- [milestone-4-design.md](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md)

参照:
- [ARCHITECTURE.md](/Users/mocchalera/Dev/video-os-v2-spec/ARCHITECTURE.md)
- [roadmap.md](/Users/mocchalera/Dev/video-os-v2-spec/docs/roadmap.md)
- [timeline-ir.schema.json](/Users/mocchalera/Dev/video-os-v2-spec/schemas/timeline-ir.schema.json)
- [edit-blueprint.schema.json](/Users/mocchalera/Dev/video-os-v2-spec/schemas/edit-blueprint.schema.json)
- [runtime/compiler/index.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/compiler/index.ts)
- [runtime/compiler/export.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/compiler/export.ts)
- [runtime/state/reconcile.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/state/reconcile.ts)
- [milestone-3-design.md](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3-design.md)
- [milestone-3.5-design.md](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md)
- [project-state.schema.json](/Users/mocchalera/Dev/video-os-v2-spec/schemas/project-state.schema.json)
- [human-revision-diff.schema.json](/Users/mocchalera/Dev/video-os-v2-spec/schemas/human-revision-diff.schema.json)
- [package.json](/Users/mocchalera/Dev/video-os-v2-spec/package.json)

## Summary

- FATAL: 2
- WARNING: 4
- NOTE: 2
- 判定: HOLD

## Findings

### FATAL 1: approval binding と `base_timeline_version` の識別子が 3 系統に割れている

根拠:
- M4 は `approval_record.artifact_versions.editorial_timeline_hash` を追加すると書く一方で、`caption_approval.json.base_timeline_version` は `project_state.artifact_hashes.timeline_version` を指すと定義し、compiler は `timeline.version` を変えずに packaging plane を再投影するとしている。[milestone-4-design.md:130](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L130) [milestone-4-design.md:141](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L141) [milestone-4-design.md:188](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L188) [milestone-4-design.md:624](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L624) [milestone-4-design.md:676](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L676) [milestone-4-design.md:706](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L706)
- 現行 state contract / reconcile は `artifact_hashes.timeline_version` を `timeline.json` の file hash として扱い、approval 復元と invalidation もその hash で判定している。[project-state.schema.json:72](/Users/mocchalera/Dev/video-os-v2-spec/schemas/project-state.schema.json#L72) [project-state.schema.json:100](/Users/mocchalera/Dev/video-os-v2-spec/schemas/project-state.schema.json#L100) [runtime/state/reconcile.ts:225](/Users/mocchalera/Dev/video-os-v2-spec/runtime/state/reconcile.ts#L225) [runtime/state/reconcile.ts:232](/Users/mocchalera/Dev/video-os-v2-spec/runtime/state/reconcile.ts#L232) [runtime/state/reconcile.ts:294](/Users/mocchalera/Dev/video-os-v2-spec/runtime/state/reconcile.ts#L294) [runtime/state/reconcile.ts:351](/Users/mocchalera/Dev/video-os-v2-spec/runtime/state/reconcile.ts#L351)
- M3.5 handoff contract の `human_revision_diff.yaml.base_timeline_version` は `timeline.version` 系列で記述されている。M4 の `approved timeline snapshot token` 定義とは語彙が一致していない。[human-revision-diff.schema.json:7](/Users/mocchalera/Dev/video-os-v2-spec/schemas/human-revision-diff.schema.json#L7) [human-revision-diff.schema.json:29](/Users/mocchalera/Dev/video-os-v2-spec/schemas/human-revision-diff.schema.json#L29) [milestone-3.5-design.md:795](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L795) [milestone-3.5-design.md:805](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L805)

影響:
- `caption_approval.json` / `music_cues.json` の stale 判定、M3 approval の self-heal、M3.5 diff artifact の再接続が同じ identifier で結び付かない。
- `timeline.json` の packaging-only mutation を approval 非 stale にしたい設計と、現行 reconcile の timeline file-hash invalidation が両立しない。

推奨修正:
- `base_timeline_version` は cross-artifact で一貫して `timeline.json.version` に固定する。
- その上で `artifact_hashes.editorial_timeline_hash` と `artifact_hashes.packaging_projection_hash` を別 field として追加し、approval/staleness は editorial hash、packaging freshness は projection hash で判定する。
- `caption-approval`, `music-cues`, `package-manifest`, `project-state` schema と reconcile rule を同じ語彙で更新する。

### FATAL 2: `nle_finishing` path が現行 QA / Gate 10 contract を満たせない

根拠:
- `nle_finishing` path は supplied final の validate/package のみを行い、assembly / `audio_master` / `caption_burn` を実行しない。[milestone-4-design.md:914](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L914) [milestone-4-design.md:918](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L918) [milestone-4-design.md:923](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L923)
- しかし hard check は `dialogue_occupancy_valid`, `av_drift_valid`, `loudness_target_valid`, `package_completeness_valid` を必須にし、本文の metric 定義は `raw_dialogue.wav`, `raw_video.mp4`, `final_mix.wav` に依存している。`qa-report.json` sample も `final_mix` を前提にしている。[milestone-4-design.md:71](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L71) [milestone-4-design.md:972](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L972) [milestone-4-design.md:994](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L994) [milestone-4-design.md:1015](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1015) [milestone-4-design.md:1046](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1046) [milestone-4-design.md:1057](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1057)
- Gate 10 は `project_state.yaml.handoff_resolution` で管理すると明記しているが、M4 invalidation には `handoff_resolution` / `source_of_truth_decision` change が入っていない。[ARCHITECTURE.md:241](/Users/mocchalera/Dev/video-os-v2-spec/ARCHITECTURE.md#L241) [ARCHITECTURE.md:246](/Users/mocchalera/Dev/video-os-v2-spec/ARCHITECTURE.md#L246) [milestone-3.5-design.md:1064](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L1064) [milestone-3.5-design.md:1090](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L1090) [milestone-4-design.md:158](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L158) [milestone-4-design.md:930](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L930)

影響:
- `nle_finishing` では `qa-report.json.passed` を現行 contract のまま決められず、`approved -> packaged` の条件が閉じない。
- Gate 10 decision を後から変えても `qa_report` / `package_manifest` が stale にならず、誤った packaged truth が残りうる。

推奨修正:
- `engine_render` と `nle_finishing` で QA profile を分ける。`nle_finishing` は supplied final の probe / demux / sidecar completeness / loudness を別定義にし、必須 artifact も path 別に固定する。
- invalidation matrix に `handoff_resolution changed -> stale qa_report/package_manifest, state -> approved` を追加する。
- Phase order も見直し、Gate 10 branch contract は Phase 5 state transition より前に固定する。

### WARNING 1: `caption_policy` contract が schema と overlay-only rule の両方で不整合

根拠:
- M4 は schema を backward-compatible に保つと言いながら、新 writer は `stt | manual` を出すと定義している。[milestone-4-design.md:323](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L323) [milestone-4-design.md:336](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L336) [milestone-4-design.md:338](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L338)
- 現行 `edit-blueprint.schema.json` は `transcript | authored | none` しか許可しない。[edit-blueprint.schema.json:213](/Users/mocchalera/Dev/video-os-v2-spec/schemas/edit-blueprint.schema.json#L213) [edit-blueprint.schema.json:234](/Users/mocchalera/Dev/video-os-v2-spec/schemas/edit-blueprint.schema.json#L234)
- 同じ節で `delivery_mode != sidecar` かつ `source == none` を禁止しつつ、`TextOverlay` only project では SpeechCaption を無効化してよいとしている。[milestone-4-design.md:437](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L437) [milestone-4-design.md:454](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L454) [milestone-4-design.md:461](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L461) [milestone-4-design.md:464](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L464)

影響:
- 新規 blueprint が schema-invalid になるか、overlay-only project の valid 設定が曖昧になる。

推奨修正:
- `captionPolicy.source` を additive に拡張して `transcript/authored` と `stt/manual` の両方を受けるか、writer 出力を legacy enum に据え置く。
- SpeechCaption enablement と TextOverlay presence を分離する。最低でも `overlay_only` 例外を gate に明記する。

### WARNING 2: `audio_master` の skip 条件が mastering / stem contract と衝突している

根拠:
- success criteria と engine render path は `final.mp4`, `raw_dialogue.wav`, `final_mix.wav` を必須 deliverable としている。[milestone-4-design.md:67](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L67) [milestone-4-design.md:68](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L68) [milestone-4-design.md:880](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L880) [milestone-4-design.md:883](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L883)
- roadmap も `assembly -> caption_burn -> audio_master -> package` を固定 pipeline としている。[roadmap.md:247](/Users/mocchalera/Dev/video-os-v2-spec/docs/roadmap.md#L247) [roadmap.md:252](/Users/mocchalera/Dev/video-os-v2-spec/docs/roadmap.md#L252) [roadmap.md:253](/Users/mocchalera/Dev/video-os-v2-spec/docs/roadmap.md#L253)
- それなのに M4 は `audio_master` を `no music_cues` / `no mastering requested` で skip 可能にし、test strategy でも `mastering disabled path` を残している。[milestone-4-design.md:901](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L901) [milestone-4-design.md:903](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L903) [milestone-4-design.md:1127](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1127) [milestone-4-design.md:1129](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1129)

影響:
- no-BGM / voice-only project で `final_mix.wav` と loudness QA の contract が揺れる。

推奨修正:
- `engine_render` では `audio_master` を常時実行し、no-BGM path は `raw_dialogue.wav -> final_mix.wav` の pass-through mastering にする。
- もし mastering truly optional なら、別 artifact set と QA gate を path ごとに定義する。

### WARNING 3: QA contract の hard check 群が deterministic に閉じていない

根拠:
- success criteria と hard check 一覧には `caption_density`, `caption_alignment`, `loudness_target`, `package_completeness` が含まれる。[milestone-4-design.md:71](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L71) [milestone-4-design.md:72](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L72) [milestone-4-design.md:974](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L974) [milestone-4-design.md:981](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L981)
- しかし本文で数式 / threshold があるのは `dialogue_occupancy` と `av_drift` だけで、`qa-report.json` sample もその 2 件しか持たない。[milestone-4-design.md:985](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L985) [milestone-4-design.md:1007](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1007) [milestone-4-design.md:1048](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1048) [milestone-4-design.md:1055](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1055)
- test strategy も `caption density and overlap` / `package completeness` の語だけで oracle が未固定である。[milestone-4-design.md:1146](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1146) [milestone-4-design.md:1152](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1152) [milestone-4-design.md:1153](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1153)

影響:
- `qa-report.json.passed` の判定が実装者依存になり、fixture assertion が割れる。

推奨修正:
- 各 hard check に formula, threshold, input artifact, failure message format を追加する。
- `source_of_truth` ごとの package completeness matrix と loudness pass band を schema / sample に落とす。

### WARNING 4: Remotion render test の CI 前提が repo baseline と接続していない

根拠:
- M4 は pinned CI runner で assembly / demux / e2e render を回す前提になっている。[milestone-4-design.md:1084](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1084) [milestone-4-design.md:1131](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1131) [milestone-4-design.md:1135](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1135) [milestone-4-design.md:1142](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1142)
- ただし現行 repo の toolchain は `validate`, `vitest`, `tsc` のみで、Remotion / ffmpeg render lane 用の dependency や script contract がまだない。[package.json:6](/Users/mocchalera/Dev/video-os-v2-spec/package.json#L6) [package.json:11](/Users/mocchalera/Dev/video-os-v2-spec/package.json#L11) [package.json:17](/Users/mocchalera/Dev/video-os-v2-spec/package.json#L17)

影響:
- Phase 4/5 の blockers が contract 実装ではなく environment bootstrap に流れやすい。

推奨修正:
- Phase 0 に render-lane infra contract を追加する。例: supported Node version, Remotion version pin, ffmpeg install source, font provisioning, fixture media size cap, default CI と dedicated render runner の分離。

### NOTE 1: roadmap の Gate 10 wording が M3.5 / M4 本文とずれている

根拠:
- roadmap は source of truth を brief で宣言すると書いている。[roadmap.md:257](/Users/mocchalera/Dev/video-os-v2-spec/docs/roadmap.md#L257) [roadmap.md:260](/Users/mocchalera/Dev/video-os-v2-spec/docs/roadmap.md#L260)
- `ARCHITECTURE.md` と M3.5 / M4 は `project_state.yaml.handoff_resolution` を canonical record にしている。[ARCHITECTURE.md:241](/Users/mocchalera/Dev/video-os-v2-spec/ARCHITECTURE.md#L241) [ARCHITECTURE.md:246](/Users/mocchalera/Dev/video-os-v2-spec/ARCHITECTURE.md#L246) [milestone-3.5-design.md:1075](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L1075) [milestone-4-design.md:930](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L930)

推奨修正:
- roadmap M4 セクションの Gate 10 wording を `project_state.yaml.handoff_resolution` に更新する。

### NOTE 2: `package_manifest.json` sample が determinism rule を全て反映していない

根拠:
- sample provenance には `render_defaults_hash` がない。[milestone-4-design.md:286](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L286) [milestone-4-design.md:308](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L308)
- determinism section では `ffmpeg_version`, `remotion_bundle_hash`, `render_defaults_hash` を最低限 required としている。[milestone-4-design.md:1076](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1076) [milestone-4-design.md:1078](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1078)

推奨修正:
- sample と upcoming schema を同じ必須 field セットに揃える。`nle_finishing` sample も別途追加すると解釈差分が減る。

## Verdict

- FATAL: 2
- WARNING: 4
- NOTE: 2
- 判定: HOLD

FATAL はどちらも Gate 10 / approval binding の中心 contract に当たるため、解消前に実装へ進めない。
