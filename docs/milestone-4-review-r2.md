# M4 Design Review R2: Caption + Audio + Packaging

レビュー日: 2026-03-21

対象:
- [milestone-4-design.md](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md)
- [ARCHITECTURE.md](/Users/mocchalera/Dev/video-os-v2-spec/ARCHITECTURE.md)
- [roadmap.md](/Users/mocchalera/Dev/video-os-v2-spec/docs/roadmap.md)

参照:
- [milestone-4-review.md](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-review.md)
- [timeline-ir.schema.json](/Users/mocchalera/Dev/video-os-v2-spec/schemas/timeline-ir.schema.json)
- [edit-blueprint.schema.json](/Users/mocchalera/Dev/video-os-v2-spec/schemas/edit-blueprint.schema.json)
- [milestone-3.5-design.md](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md)

## Summary

- FATAL: 0
- WARNING: 2
- NOTE: 0
- 判定: CONDITIONAL PASS

## Findings

### WARNING 1: `packaging_projection_hash` の保持場所が本文内で揺れている

根拠:
- timeline identity 節では fingerprint を `artifact_hashes.packaging_projection_hash` と `package_manifest.json.provenance.packaging_projection_hash` に残すと書かれている。[milestone-4-design.md:203](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L203) [milestone-4-design.md:204](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L204)
- しかし `package_manifest.json` sample と後段の運用ルールでは、`packaging_projection_hash` は top-level field として扱われている。[milestone-4-design.md:330](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L330) [milestone-4-design.md:331](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L331) [milestone-4-design.md:361](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L361) [milestone-4-design.md:362](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L362) [milestone-4-design.md:477](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L477)

影響:
- `package-manifest.schema.json` の field placement が一意に定まらず、実装者が top-level / `provenance` のどちらを正とするかで割れる。
- `packaging_projection_hash` を freshness key として読む runtime 実装で参照先がぶれる。

推奨修正:
- `packaging_projection_hash` の canonical placement を 1 箇所に固定する。
- sample、timeline identity 説明、determinism 節を同じ placement に揃える。

### WARNING 2: `nle_finishing` QA フローと manifest 参照条件の順序が食い違っている

根拠:
- `nle_finishing` flow では `qa-report.json` を先に生成し、その後で `package_manifest.json` に final artifact を記録すると定義している。[milestone-4-design.md:990](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L990) [milestone-4-design.md:991](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L991) [milestone-4-design.md:992](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L992)
- 一方で `supplied_export_probe_valid` は checksum が manifest 記録値と一致することを pass 条件に置き、`package_completeness_valid` も manifest hash と実ファイル hash の一致を要求している。[milestone-4-design.md:1085](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1085) [milestone-4-design.md:1092](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1092) [milestone-4-design.md:1240](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1240) [milestone-4-design.md:1241](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1241)
- Implementation Order では `package_manifest.json` を Phase 4、`qa-report.json` を Phase 5 に置いており、上記 flow とも一致していない。[milestone-4-design.md:1537](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1537) [milestone-4-design.md:1539](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1539) [milestone-4-design.md:1551](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1551)

影響:
- `nle_finishing` 実装で `qa-report.json` が manifest の input なのか output なのかが不明確になる。
- checksum/hash 検証の責務を probe phase に置くのか manifest finalization phase に置くのかで実装が分岐する。

推奨修正:
- `nle_finishing` では `package_manifest.json` を QA 前に draft/finalize するか、逆に QA 定義から manifest 参照を外して「後続で manifest に mirror する」と書き換える。
- flow、QA hard check、Implementation Order の 3 箇所を同一順序に揃える。

## R1 Resolution Check

### 1. FATAL 1: timeline identity / approval binding split

判定: 解消済み

確認内容:
- `base_timeline_version` を approved `timeline.json.version` に固定し、`editorial_timeline_hash` と `packaging_projection_hash` を別責務に分離した。[milestone-4-design.md:201](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L201) [milestone-4-design.md:217](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L217) [milestone-4-design.md:221](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L221)
- `project_state.artifact_hashes.timeline_version` を legacy file-hash slot と明記し、cross-artifact identity から外した。[milestone-4-design.md:135](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L135) [milestone-4-design.md:225](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L225) [ARCHITECTURE.md:241](/Users/mocchalera/Dev/video-os-v2-spec/ARCHITECTURE.md#L241)
- M3.5 `human_revision_diff.base_timeline_version` と語彙を合わせる方針が明示された。[milestone-4-design.md:213](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L213) [milestone-3.5-design.md:1079](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L1079) [schemas/human-revision-diff.schema.json:29](/Users/mocchalera/Dev/video-os-v2-spec/schemas/human-revision-diff.schema.json#L29)

### 2. FATAL 2: `nle_finishing` path が QA / Gate 10 contract を満たせない

判定: 解消済み

確認内容:
- success criteria と QA contract が path-specific profile に分離され、`nle_finishing` では `supplied_export_probe`, `caption_delivery`, `supplied_av_sync`, `loudness_target`, `package_completeness` を判定対象にした。[milestone-4-design.md:71](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L71) [milestone-4-design.md:73](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L73) [milestone-4-design.md:1059](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1059) [milestone-4-design.md:1068](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1068)
- `nle_finishing` required artifact matrix から `raw_video`, `raw_dialogue`, `final_mix` を外し、supplied final 前提に閉じた。[milestone-4-design.md:1233](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1233) [milestone-4-design.md:1236](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1236)
- Gate 10 change による stale / fallback を M4 と architecture の両方で明文化した。[milestone-4-design.md:175](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L175) [milestone-4-design.md:1034](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1034) [ARCHITECTURE.md:245](/Users/mocchalera/Dev/video-os-v2-spec/ARCHITECTURE.md#L245)

### 3. WARNING 1: `caption_policy` contract と schema / overlay-only rule の不整合

判定: 解消済み

確認内容:
- persisted `caption_policy.source` は `transcript | authored | none` を維持すると明記し、現行 schema と整合した。[milestone-4-design.md:400](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L400) [milestone-4-design.md:403](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L403) [schemas/edit-blueprint.schema.json:213](/Users/mocchalera/Dev/video-os-v2-spec/schemas/edit-blueprint.schema.json#L213)
- `TextOverlay` only project を `caption_policy.source == none` で有効とし、SpeechCaption enablement と分離した。[milestone-4-design.md:528](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L528) [milestone-4-design.md:531](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L531)

### 4. WARNING 2: `audio_master` skip 条件と mastering / stem contract の衝突

判定: 解消済み

確認内容:
- `engine_render` path で `audio_master` は `skip: never` に固定された。[milestone-4-design.md:972](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L972) [milestone-4-design.md:974](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L974)
- no-BGM path でも pass-through mastering を実行し、`final_mix.wav` を常時生成すると明記された。[milestone-4-design.md:952](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L952) [milestone-4-design.md:975](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L975) [milestone-4-design.md:1373](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1373)

### 5. WARNING 3: QA contract の hard check 群が deterministic に閉じていない

判定: 解消済み

確認内容:
- `caption_density_valid`, `caption_alignment_valid`, `loudness_target_valid`, `package_completeness_valid` に入力 artifact、threshold、failure detail format が追加された。[milestone-4-design.md:1104](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1104) [milestone-4-design.md:1121](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1121) [milestone-4-design.md:1204](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1204) [milestone-4-design.md:1226](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1226)
- `qa-report.json` sample も hard check 群の詳細 format に追随した。[milestone-4-design.md:1264](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1264) [milestone-4-design.md:1274](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1274)

### 6. WARNING 4: Remotion render test の CI 前提が repo baseline と接続していない

判定: 解消済み

確認内容:
- default CI を `validate`, `test`, `build` の non-render suite に限定し、render は dedicated lane に分離すると明記した。[milestone-4-design.md:1317](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1317) [package.json:6](/Users/mocchalera/Dev/video-os-v2-spec/package.json#L6)
- Node / Remotion / ffmpeg / fonts / fixture cap の baseline を Phase 0 で固定する前提が追加された。[milestone-4-design.md:1319](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1319) [milestone-4-design.md:1324](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L1324)

### 7. NOTE 1: roadmap の Gate 10 wording ずれ

判定: 解消済み

確認内容:
- roadmap の M4 セクションが `project_state.yaml.handoff_resolution` を canonical record として参照する形に揃った。[roadmap.md:257](/Users/mocchalera/Dev/video-os-v2-spec/docs/roadmap.md#L257) [roadmap.md:260](/Users/mocchalera/Dev/video-os-v2-spec/docs/roadmap.md#L260)
- M3.5 と architecture の Gate 10 記述とも一致する。[docs/milestone-3.5-design.md:1075](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L1075) [ARCHITECTURE.md:264](/Users/mocchalera/Dev/video-os-v2-spec/ARCHITECTURE.md#L264)

### 8. NOTE 2: `package_manifest.json` sample の determinism field 不足

判定: 解消済み

確認内容:
- `engine_render` sample に `render_defaults_hash` が入り、`nle_finishing` sample も追加された。[milestone-4-design.md:347](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L347) [milestone-4-design.md:349](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L349) [milestone-4-design.md:354](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L354) [milestone-4-design.md:376](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L376)

## Verdict

- R1 の 8 件はすべて解消済みと判断する。
- 特に timeline identity は `base_timeline_version` / `editorial_timeline_hash` / `packaging_projection_hash` の三層に整理され、`nle_finishing` QA profile も path-specific に閉じた。
- FATAL 0 を確認したため、判定は `CONDITIONAL PASS` とする。
- 実装準備完了度は高い。着手は可能だが、上記 2 warning を先に wording 正規化しておくと schema / runtime 実装の解釈差分を減らせる。
