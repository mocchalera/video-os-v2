# M3.5 Design Review R2: Human Handoff Round-Trip

対象:
- [milestone-3.5-design.md](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md)
- [ARCHITECTURE.md](/Users/mocchalera/Dev/video-os-v2-spec/ARCHITECTURE.md)

レビュー観点:
- R1 の是正確認 9 件
- Gate 8-11 の中心契約反映
- 新規問題の有無
- 実装準備完了度

## Findings

### MAJOR 1: lossy / unsupported surface の命名が capability profile と manifest/report taxonomy で一致していない

根拠:
- `handoff_manifest.yaml` sample と loss report taxonomy は `plugin_effect` / `advanced_audio_finish` を使っている。[docs/milestone-3.5-design.md:535](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L535) [docs/milestone-3.5-design.md:538](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L538) [docs/milestone-3.5-design.md:673](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L673) [docs/milestone-3.5-design.md:885](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L885)
- 一方 capability profile の surface 名は `fusion_effect` / `fairlight_advanced_audio` になっている。[docs/milestone-3.5-design.md:953](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L953) [docs/milestone-3.5-design.md:955](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L955)
- Required automated checks も `plugin effect / color finish / advanced audio` を前提に書かれており、profile enum と 1:1 に揃っていない。[docs/milestone-3.5-design.md:1244](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L1244) [docs/milestone-3.5-design.md:1245](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L1245)

影響:
- Gate 11 を profile 駆動で実装する際、同じ edit をどの enum で report / classify / fixture assert するかが揺れる。
- 実装者が alias を暗黙実装すると、fixture と capability profile の整合が壊れやすい。

推奨修正:
- `plugin_effect` / `advanced_audio_finish` と `fusion_effect` / `fairlight_advanced_audio` のどちらを canonical enum にするかを決め、manifest sample / classification list / automated checks / capability profile を一本化する。
- もし alias を許すなら、alias policy を本文で明示する。

### MINOR 1: track stable ID contract が「group-local uniqueness」と「kind を含まない exchange ID」を混在させている

根拠:
- `exchange_track_id` は `<project_id>:<timeline_version>:<track_id>` で導出され、`kind` を含まない。[docs/milestone-3.5-design.md:377](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L377)
- しかし Gate 8 validator は `track_id` の一意性を `track group` 内にしか要求していない。[docs/milestone-3.5-design.md:467](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L467) [docs/milestone-3.5-design.md:468](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L468)
- `timeline-ir.schema.json` も `track_id` を単なる string としており、global uniqueness や命名規約を固定していない。[schemas/timeline-ir.schema.json:149](/Users/mocchalera/Dev/video-os-v2-spec/schemas/timeline-ir.schema.json#L149)

影響:
- 現在のサンプルが `V1` / `A1` 命名なので直ちには破綻しないが、将来 `track_id` が group-local naming になった場合に `exchange_track_id` が衝突しうる。
- Gate 8 が「stable ID の重複禁止」を fully enforce していると言い切れなくなる。

推奨修正:
- `track_id` を timeline 全体で一意と明文化する。
または
- `exchange_track_id = <project_id>:<timeline_version>:<track_kind>:<track_id>` に変更する。

## R1 Resolution Check

R1 の是正確認対象 9 件はすべて解消された。対象は `FATAL 1 + WARNING 6 + NOTE 1-2` であり、R1 の `NOTE 3` は肯定メモなので是正項目には含めない。

| R1 item | Status | Evidence |
| --- | --- | --- |
| FATAL 1: stable ID one-to-many 未定義 | Resolved | import 直後の duplicate 検査、`split_clip` / `duplicated_clip` / `ambiguous_one_to_many` 分類、`operations[]` からの隔離、report counters が入った。[docs/milestone-3.5-design.md:379](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L379) [docs/milestone-3.5-design.md:393](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L393) [docs/milestone-3.5-design.md:571](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L571) [docs/milestone-3.5-design.md:640](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L640) [docs/milestone-3.5-design.md:699](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L699) |
| WARNING 1: reorder / track_move 誤検出 | Resolved | ripple normalization, peer set construction, `track_reorder` 分離, logical track assignment 判定が追加された。[docs/milestone-3.5-design.md:702](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L702) [docs/milestone-3.5-design.md:732](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L732) [docs/milestone-3.5-design.md:758](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L758) |
| WARNING 2: Gate 10 の artifact/timing ずれ | Resolved | export manifest を immutable ledger に留め、final decision を `project_state.yaml.handoff_resolution` に分離した。[docs/milestone-3.5-design.md:188](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L188) [docs/milestone-3.5-design.md:1075](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L1075) [ARCHITECTURE.md:218](/Users/mocchalera/Dev/video-os-v2-spec/ARCHITECTURE.md#L218) |
| WARNING 3: capability profile が広すぎる | Resolved | `verified_roundtrip` / `provisional_roundtrip` / `report_only` / `lossy` に分離され、manual acceptance も verified surface 中心へ狭めた。[docs/milestone-3.5-design.md:965](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L965) [docs/milestone-3.5-design.md:986](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L986) [docs/milestone-3.5-design.md:1269](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L1269) |
| WARNING 4: Python bridge versioning / error contract 不足 | Resolved | fingerprint fields, mismatch policy, JSON request/response, timeout / stderr / invalid JSON contract が入った。[docs/milestone-3.5-design.md:271](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L271) [docs/milestone-3.5-design.md:293](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L293) [docs/milestone-3.5-design.md:324](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L324) |
| WARNING 5: marker/note の M3 patch contract 不一致 | Resolved | first-class を timeline marker のみに狭め、clip marker / note body は `unmapped_edits[]` に落とす方針へ変わった。[docs/milestone-3.5-design.md:771](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L771) [docs/milestone-3.5-design.md:778](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L778) [docs/milestone-3.5-design.md:1040](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L1040) |
| WARNING 6: recompile state / approval invalidation 未明記 | Resolved | `/review` / `/blueprint` 再入線と `approval_record` stale, expected state table が明記された。[docs/milestone-3.5-design.md:1044](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L1044) [docs/milestone-3.5-design.md:1056](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L1056) |
| NOTE 1: `ARCHITECTURE.md` に gates 8-11 未反映 | Resolved | central contract 側に 8-11 が追加され、Gate 10 の記録先も明文化された。[ARCHITECTURE.md:239](/Users/mocchalera/Dev/video-os-v2-spec/ARCHITECTURE.md#L239) [ARCHITECTURE.md:244](/Users/mocchalera/Dev/video-os-v2-spec/ARCHITECTURE.md#L244) |
| NOTE 2: report sample shape と本文 NFR 不一致 | Resolved | `roundtrip_import_report.yaml` sample に `base_timeline` と `bridge` block が追加された。[docs/milestone-3.5-design.md:617](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L617) [docs/milestone-3.5-design.md:620](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L620) |

補足:
- R1 の `NOTE 3` だった「M3 `/export` と M3.5 handoff export の責務分離」は今回も維持されている。[docs/milestone-3.5-design.md:345](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L345) [docs/milestone-3.5-design.md:1046](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L1046)

## Gate 8-11 Check

`ARCHITECTURE.md` には gates 8-11 が正しく追記されている。

- Gate 8: stable ID 欠落/重複時は OTIO export 禁止。[ARCHITECTURE.md:239](/Users/mocchalera/Dev/video-os-v2-spec/ARCHITECTURE.md#L239)
- Gate 9: unmapped edits があれば自動 import accept 禁止。[ARCHITECTURE.md:240](/Users/mocchalera/Dev/video-os-v2-spec/ARCHITECTURE.md#L240)
- Gate 10: final render 前に `project_state.yaml` で source of truth 宣言。[ARCHITECTURE.md:241](/Users/mocchalera/Dev/video-os-v2-spec/ARCHITECTURE.md#L241)
- Gate 11: NLE handoff は capability profile 制約下に限定。[ARCHITECTURE.md:242](/Users/mocchalera/Dev/video-os-v2-spec/ARCHITECTURE.md#L242)
- 補足説明も roadmap と整合している。[ARCHITECTURE.md:244](/Users/mocchalera/Dev/video-os-v2-spec/ARCHITECTURE.md#L244) [docs/roadmap.md:61](/Users/mocchalera/Dev/video-os-v2-spec/docs/roadmap.md#L61)

## Verdict

- FATAL: 0
- MAJOR: 1
- MINOR: 1
- 判定: CONDITIONAL PASS

実装準備完了度は高い。R1 で問題だった stable ID one-to-many、Gate 8-11、bridge contract、M3 re-entry contract は設計として閉じた。残る論点は enum 命名の一本化と track stable ID contract の固定で、いずれも実装前に短時間で潰せるが、放置すると schema / fixture / importer 実装がずれやすい。
