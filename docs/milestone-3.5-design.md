# Milestone 3.5 Design

## Scope

Milestone 3.5 は、M3 で `approved` になった `timeline.json` を OTIO に変換して NLE へ handoff し、
人間の editorial edit を OTIO で受け戻し、差分を machine-readable に抽出して次案へ反映できるようにする
milestone である。

この milestone の主眼は「NLE を canonical source of truth にすること」ではない。`timeline.json` を
引き続き canonical とし、OTIO は loss-aware な exchange boundary として扱う。人間の編集結果は
直接 `timeline.json` を上書きせず、`human_revision_diff.yaml` と `roundtrip_import_report.yaml` に
正規化した上で、既存の M3 loop に evidence として戻す。

### In Scope

- `approved` state からの OTIO handoff export (`/handoff-export`)
- `handoff_manifest.yaml` / `handoff_timeline.otio` の生成
- stable-id-based な OTIO import / clip tracking / diff 生成
- `roundtrip_import_report.yaml` と `human_revision_diff.yaml` の生成
- NLE capability profile の schema と DaVinci Resolve v1 profile
- loss-aware import/export と Gate 8-11
- diff を roughcut-critic / blueprint-planner に戻す recompile loop
- fixture-based round-trip test と Resolve manual smoke の設計

### Out Of Scope

- `timeline.json` を OTIO で直接置き換えること
- 人間編集済み OTIO から canonical artifact を自動確定すること
- Premiere Pro profile の実装本体
- AAF / FCPXML / Premiere XML など `.otio` 以外の interchange format
- full finishing round-trip
  - complex titles / MOGRT
  - plugin effects
  - full color finish
  - advanced audio finish
- M1/M2/M3 の既存 schema / patch contract の semantic change

### Contract Rule

- `timeline.json` は引き続き唯一の canonical timeline artifact とする
- OTIO は exchange artifact であり、canonical artifact ではない
- M3.5 は M1/M2/M3 の既存 consumer を壊さない
- M3.5 で追加するものは新規 schema / 新規 non-canonical artifact / additive runtime のみとする
- imported OTIO は untrusted input とみなし、schema validate と capability profile 判定を通るまで
  canonical path へ反映しない

### Success Criteria

Milestone 3.5 は、以下がすべて満たされたとき完了とする。

1. `approved` state かつ current `approval_record` を持つ project から、schema-valid な
   `handoff_manifest.yaml` と `handoff_timeline.otio` を出力できる。
2. export 前 Gate 8 により、全 track / clip / segment に必要な stable ID があり、重複や欠落が
   ある場合は handoff を拒否できる。
3. fixture human edit を模擬した imported OTIO から、schema-valid な
   `roundtrip_import_report.yaml` と `human_revision_diff.yaml` を生成できる。
4. verified round-trip surface として `trim`, `reorder`, `enable / disable` を stable ID ベースで
   検出できる。
5. `exchange_clip_id` の one-to-many が発生した場合、split / duplicate / ambiguous one-to-many を
   決定的に分類し、child ID / copy ID / provenance 付きで report に隔離できる。
6. provisional surface (`track_move`, `simple_transition`, `timeline_marker_add`) は explicit mode 付きで
   report できるが、verified surface に昇格するまで auto-accept contract に含めない。
7. unmapped edit や profile 外編集が含まれる場合、loss report に記録され、Gate 9 により
   `review_required` なしで自動確定されない。
8. `human_revision_diff.yaml` を roughcut-critic または blueprint-planner が読める machine-readable
   contract にでき、次の patch / blueprint 提案へ使える。
9. same base timeline + same capability profile + same OTIO bridge fingerprint
   (`bridge_version` + exact-pinned OTIO version) なら、exported OTIO と import report の正規化結果が
   deterministic に再現できる。
10. 実 NLE smoke で、DaVinci Resolve 上の verified surface (`trim / reorder / disable`) が round-trip
    で検出でき、lossy / report-only edit は report に記録される。

### Test Gates

上記 success criteria は以下の gate で受け入れる。

- unit
  - export preflight / stable ID validation
  - OTIO metadata embedding / recovery
  - capability profile matching
  - diff classification
  - lossy item detection
- integration
  - `timeline.json -> handoff_timeline.otio`
  - `imported_handoff.otio -> normalized import -> report + diff`
  - Gate 8 / Gate 9 / Gate 11 enforcement
- e2e
  - fixture-based round-trip
  - diff -> agent proposal -> deterministic recompile -> preview refresh
- manual smoke
  - DaVinci Resolve import / edit / export
  - stable ID retention verification
  - one-to-many split / duplicate classification
  - source-of-truth declaration before final path selection

## M3 Connection And M4 Handoff

### M3 To M3.5 Entry Point

M3.5 は M3 の `approved` を入口にする。`critique_ready` では handoff しない。

理由:

- M3 の `approval_record` は「どの artifact 集合に対して人間が accept / override したか」の canonical
  operator record であり、handoff 先に渡す base snapshot を固定する役割を持つ
- `critique_ready` は still-under-review であり、NLE 編集に回すには snapshot が不安定

M3.5 export の前提:

- `project_state.yaml.current_state == approved`
- `approval_record.status in {clean, creative_override}`
- `approval_record.artifact_versions` が current snapshot と一致
- `timeline.json` が fresh で schema-valid
- `review_report.yaml` / `review_patch.json` / optional `human_notes.yaml` が current snapshot と整合

M3.5 は project state に新しい canonical state を追加しない。handoff session の進行は
non-canonical artifact で追跡し、`current_state` は `approved` のまま維持する。Gate 10 の判断だけは
`project_state.yaml.handoff_resolution` として canonical operator record に追加する。

### Command Boundary

M3 の `/export` は review bundle export のままとし、M3.5 で NLE handoff の意味に上書きしない。

- M3 `/export`
  - review bundle
  - help: `Export review bundle for critique/approval artifacts`
  - state unchanged
  - `critique_ready` 以上で実行可能
- M3.5 `/handoff-export`
  - OTIO handoff package
  - help: `Export OTIO handoff package for external NLE round-trip`
  - `approved` のみ
  - state unchanged
- M3.5 `/handoff-import`
  - edited OTIO import + normalization + report generation
  - help: `Import edited OTIO and generate round-trip reports`
  - `approved` のみ
  - state unchanged

実装上は、review bundle runtime と handoff runtime を分ける。

- `runtime/commands/export.ts`
  - M3 review bundle の責務を維持
- `runtime/handoff/export.ts`
  - M3.5 handoff export orchestration
- `runtime/handoff/import.ts`
  - OTIO import + normalization
- `runtime/handoff/diff.ts`
  - diff generation

### Handoff Session Root

handoff artifacts は canonical tree の外で保持する。M3 `/export` review bundle と同じく、handoff も
non-canonical session root に出す。

推奨レイアウト:

```text
exports/handoffs/<handoff_id>/
  handoff_manifest.yaml
  handoff_timeline.otio
  imported_handoff.otio
  roundtrip_import_report.yaml
  human_revision_diff.yaml
  normalized/
    exported_otio.json
    imported_otio.json
  logs/
    handoff_run_log.yaml
```

`handoff_id` は `HND_<timeline_version>_<UTC timestamp>` を基本形とし、同一 `timeline_version` に対する
複数 handoff を区別できるようにする。

### M3.5 To M4 Handoff

M4 へ渡す責務は 2 つある。

1. `project_state.yaml.handoff_resolution`
   - `engine_render`
   - `nle_finishing`
2. latest handoff session result
   - `roundtrip_import_report.yaml`
   - `human_revision_diff.yaml`
   - chosen `nle_capability_profile.yaml`

M4 はこれを読んで final render path を選ぶ。M3.5 時点では final package を作らず、
handoff export の immutable ledger と post-import の final decision を分離したまま M4 に渡す。

## Gate Additions

`ARCHITECTURE.md` の Gate 1-7 を維持した上で、M3.5 では以下を追加する。

8. **No OTIO export if stable IDs are missing or duplicated**
   - export 前に `track_id`, `clip_id`, `segment_id`, `asset_id` を検証する
9. **No automatic import acceptance when unmapped edits exist**
   - unmapped / lossy / ambiguous edit が 1 件でもあれば `review_required: true`
10. **Declare source of truth before final render**
   - `engine_render` か `nle_finishing` を `project_state.yaml.handoff_resolution` に記録する
11. **NLE handoff is limited by capability profile**
   - profile が `verified_roundtrip` または `provisional_roundtrip` と宣言した編集面だけを
     diffable とみなし、`verified_roundtrip` のみ automated acceptance の対象にする

Gate 8-11 は `timeline.json` の canonical 性を守るための boundary gate であり、M3 の state machine を
置き換えず補完する。

## Artifact Model

### Canonical / Exchange / Operational Split

M3.5 では artifact を 3 種類に分ける。

- canonical
  - `timeline.json`
  - `review_report.yaml`
  - `review_patch.json`
  - `project_state.yaml`
- exchange
  - `handoff_timeline.otio`
  - `imported_handoff.otio`
- operational / analysis-of-exchange
  - `handoff_manifest.yaml`
  - `roundtrip_import_report.yaml`
  - `human_revision_diff.yaml`
  - `nle_capability_profile.yaml`

exchange / operational artifact は evidence だが、canonical source of truth ではない。

### New Schemas

M3.5 で新規追加する schema:

- `schemas/handoff-manifest.schema.json`
- `schemas/roundtrip-import-report.schema.json`
- `schemas/human-revision-diff.schema.json`
- `schemas/nle-capability-profile.schema.json`

いずれも closed root (`additionalProperties: false`) とし、`timeline.json` / `marker.metadata` の extension
point policyは変更しない。

## OTIO Export Design

### Engine Choice

OTIO export / import の engine は TypeScript native binding ではなく、Python subprocess bridge を採用する。

判断理由:

- 2026-03-21 時点で、maintained な official distribution は Python package
  [`opentimelineio` on PyPI](https://pypi.org/project/opentimelineio/) である
- OpenTimelineIO の GitHub topic 上で official binding として確認できるのは
  Swift / C / Java 系で、JavaScript binding は community-maintained repository として見える
- 本 repository の deterministic engine 層は Node/TypeScript orchestration でよいが、OTIO core I/O は
  official runtime に寄せた方が long-term maintenance risk が低い

したがって M3.5 は以下の分離を取る。

- TypeScript
  - command orchestration
  - schema validation
  - report generation
  - capability profile evaluation
- Python bridge
  - OTIO read / write
  - OTIO object normalization
  - adapter/plugin loading

`.otio` native read/write が対象なので、M3.5 の base scope では core `opentimelineio` package を使い、
plugin package は required にしない。

### Python Bridge Versioning And Error Contract

OTIO bridge は determinism boundary の一部なので、export 時と import 時の両方で同じ fingerprint を
artifact に残す。

- `python_version`
- `opentimelineio_version`
- `bridge_version`
- `bridge_script_hash`
- `loaded_adapter_modules[]`

versioning rule:

- `opentimelineio` は bridge lockfile 上で exact pin する。floating major/minor は許可しない。
- `bridge_version` は request/response schema または normalization semantics が変わるたびに上げる。
- export は manifest に expected fingerprint を書き、import は report に actual fingerprint を書いて比較する。
- mismatch policy は以下で固定する。
  - same `bridge_version` + same exact `opentimelineio_version`: 正常
  - same `bridge_version` + patch-only `opentimelineio_version` 差分: `status: partial` +
    `review_required: true`
  - `bridge_version` 差分 or OTIO major/minor 差分: `status: failed`

bridge command contract:

```json
{
  "request_id": "uuid",
  "command": "export_otio | import_otio | normalize_otio",
  "input_path": "path-or-null",
  "output_path": "path-or-null",
  "options": {},
  "expected_bridge_version": "1.0.0"
}
```

```json
{
  "request_id": "uuid",
  "ok": true,
  "bridge": {
    "bridge_version": "1.0.0",
    "python_version": "3.11.x",
    "opentimelineio_version": "exact-pin",
    "bridge_script_hash": "sha256:...",
    "loaded_adapter_modules": []
  },
  "payload_path": "normalized/exported_otio.json",
  "warnings": []
}
```

error contract:

- non-zero exit は failure。TS 側は `stderr` を capture して run log と report に残す。
- timeout は retry せず failure。request context と timeout 値を run log に残す。
- invalid JSON response は bridge protocol error として failure。
- `stderr` があっても `ok: true` なら warning 扱いで capture する。

### Compiler Integration

`runtime/compiler/export.ts` の `exportOtio()` stub は、M3.5 で low-level OTIO serializer に昇格する。

責務分離:

- `runtime/compiler/export.ts::exportOtio()`
  - pure function
  - `timeline.json` 相当の in-memory structure から OTIO object / file を生成
- `runtime/handoff/export.ts`
  - `approved` gate
  - capability profile 解決
  - handoff manifest 生成
  - source map 解決
  - export readback validation

これにより compiler phase と handoff runtime の責務を混ぜない。M1/M3 由来の compile path は引き続き
deterministic engine であり、NLE 向け package 化は M3.5 runtime 側の責務とする。

### Export Preconditions

`/handoff-export` の preflight は以下を満たさない限り失敗させる。

1. `approved` state である
2. `approval_record` が current snapshot と一致している
3. `timeline.json` が schema-valid である
4. `nle_capability_profile` が存在し、target NLE が指定されている
5. Gate 8 stable ID validation を通る

### Stable ID Semantics

M3 で既に保持している ID の意味は以下のまま維持する。

- `track_id`
  - timeline 内 track identity
- `clip_id`
  - exported base timeline version の clip identity
- `segment_id`
  - M2 analysis 由来の stable segment identity
- `asset_id`
  - M2 analysis 由来の stable asset identity

`clip_id` は cross-version で不変であることまでは要求しない。M3.5 では
「ある approved `timeline_version` の中で stable」であればよい。

cross-handoff で一意にするため、export 時に以下の derived ID を作る。

- `exchange_clip_id = <project_id>:<timeline_version>:<clip_id>`
- `exchange_track_id = <project_id>:<timeline_version>:<track_id>`

import 時の primary key は 1:1 mapping でのみ `exchange_clip_id` とする。正規化直後に
duplicate stable ID 検査を行い、one-to-many は別経路に送る。

- `split_clip`
  - 同じ parent `exchange_clip_id` を持つ imported clip が 2 件以上あり、source range が parent clip 内で
    分割され、子同士が material overlap しない場合
  - report 用 child ID を `parent_exchange_clip_id#S01`, `#S02` ... の形で採番する
- `duplicated_clip`
  - 同じ parent `exchange_clip_id` を持つ imported clip が重複利用される場合
  - copy provenance を持つ `copy_id = parent_exchange_clip_id#D01`, `#D02` ... を採番する
- `ambiguous_one_to_many`
  - split と duplicate を決定的に区別できない場合

child ID / copy ID は report-only instance ID であり、canonical `clip_id` を書き換えない。one-to-many
item は常に Gate 9 で `review_required: true` にし、`operations[]` ではなく report / `unmapped_edits[]` に
隔離する。

### OTIO Mapping

`timeline.json -> handoff_timeline.otio` の mapping は以下で固定する。

| Timeline IR | OTIO | Notes |
| --- | --- | --- |
| `sequence.*` | `Timeline` / `Stack` metadata | fps / raster / start frame を root metadata に保持 |
| `tracks.video[]`, `tracks.audio[]` | `Track` | `track_id` / `kind` を track metadata に保持 |
| `clip` | `Clip` + `ExternalReference` | source path は source map から解決 |
| `src_in_us`, `src_out_us` | `source_range` + metadata mirror | exact microseconds は metadata に mirror する |
| `timeline_in_frame`, `timeline_duration_frames` | placement metadata | import diff の before/after 基準 |
| `markers[]` | OTIO markers | existing marker は derived `exchange_marker_id` を付与 |

source time は OTIO `source_range` に変換して書くが、exact comparison は microseconds mirror を優先する。

理由:

- OTIO adapter は frame quantization を行いうる
- internal truth は引き続き `src_in_us` / `src_out_us`
- round-trip loss の有無を exact に判断したい

### OTIO Metadata Namespace

全 OTIO metadata は `video_os` namespace に格納する。

timeline root metadata:

```yaml
video_os:
  schema_version: "1"
  project_id: "mountain-brand-film"
  handoff_id: "HND_0005_20260321T103000Z"
  timeline_version: "5"
  capability_profile_id: "davinci_resolve_otio_v1"
  approval_status: "clean"
```

track metadata:

```yaml
video_os:
  exchange_track_id: "mountain-brand-film:5:V1"
  track_id: "V1"
  kind: "video"
```

clip metadata:

```yaml
video_os:
  exchange_clip_id: "mountain-brand-film:5:CLP_0003"
  clip_id: "CLP_0003"
  track_id: "V1"
  asset_id: "AST_73A1F6D0"
  segment_id: "SEG_AST_73A1F6D0_0004"
  beat_id: "beat_middle_turn"
  role: "support"
  src_in_us: 11200000
  src_out_us: 15850000
  timeline_in_frame: 48
  timeline_duration_frames: 36
  capability_profile_id: "davinci_resolve_otio_v1"
```

`Clip.name` は human-readable fallback として `CLP_0003 SEG_AST_73A1F6D0_0004` のように書いてよいが、
import の primary mapping には使わない。

### Gate 8: Stable ID Validation

export 前 validator は少なくとも以下を確認する。

- 全 track に `track_id` がある
- `track_id` が track group 内で一意
- 全 clip に `clip_id`, `segment_id`, `asset_id` がある
- `clip_id` が timeline 全体で一意
- `segment_id` / `asset_id` が非空
- `exchange_clip_id` を一意に導出できる
- optional marker に対して `exchange_marker_id` を一意に導出できる

failure 時は OTIO export を実行しない。

### `handoff_manifest.yaml`

`handoff_manifest.yaml` は handoff session の contract ledger であり、import 側が必ず読む。

最低 shape:

```yaml
version: 1
project_id: mountain-brand-film
handoff_id: HND_0005_20260321T103000Z
exported_at: 2026-03-21T10:30:00Z
base_timeline:
  path: 05_timeline/timeline.json
  version: "5"
  hash: sha256:...
  sequence:
    fps_num: 24
    fps_den: 1
    width: 1920
    height: 1080
approval_snapshot:
  status: clean
  approved_by: operator
  approved_at: 2026-03-21T10:20:00Z
  artifact_versions:
    timeline_version: "5"
    review_report_version: "3"
review_bundle_ref:
  export_manifest_path: exports/review/2026-03-21T10:21:00Z/export_manifest.yaml
capability_profile:
  profile_id: davinci_resolve_otio_v1
  path: adapters/nle/davinci_resolve_otio_v1.yaml
bridge:
  bridge_version: 1.0.0
  python_version: 3.11.x
  opentimelineio_version: exact-pin
  bridge_script_hash: sha256:...
  loaded_adapter_modules: []
nle_session:
  vendor: Blackmagic Design
  product: DaVinci Resolve
  expected_version: "19.x"
  expected_import_options:
    otio_import_mode: custom
  expected_export_options:
    preserve_metadata: true
verified_roundtrip_surfaces:
  - trim
  - reorder
  - enable_disable
provisional_roundtrip_surfaces:
  - track_move
  - simple_transition
  - timeline_marker_add
report_only_surfaces:
  - track_reorder
  - clip_marker_add
  - note_text_add
lossy_surfaces:
  - color_finish
  - plugin_effect
  - advanced_audio_finish
source_map:
  - asset_id: AST_73A1F6D0
    source_locator: media/source/interview_a.mov
    local_source_path: /abs/path/to/interview_a.mov
    relink_required: false
notes:
  - Imported OTIO must retain video_os.exchange_clip_id metadata.
  - Unmapped edits require manual review before reuse in engine path.
```

`source_map.local_source_path` は non-canonical field なので、M2 `run_manifest.json` にある machine-local
absolute path を使ってよい。canonical artifact には昇格させない。

## OTIO Import Design

### Import Inputs

importer は以下を入力にする。

- `handoff_manifest.yaml`
- exported `handoff_timeline.otio`
- edited `imported_handoff.otio`
- `nle_capability_profile.yaml`

import は `timeline.json` を直接更新しない。まず normalized import と report を生成する。

### Import Flow

1. Python OTIO bridge で `imported_handoff.otio` を parse
2. OTIO object を deterministic JSON へ normalize し、bridge fingerprint を取得する
3. exported base OTIO を同じ normalization で再読込する
4. manifest の `base_timeline.hash` と bridge fingerprint policy を検証する
5. `exchange_clip_id` 衝突を検査し、split / duplicate / ambiguous one-to-many を正規化する
6. capability profile に従って stable ID mapping と ripple normalization を実行する
7. mapped change / lossy item / unmapped item を分類する
8. `roundtrip_import_report.yaml` を生成する
9. `human_revision_diff.yaml` を生成する

### Stable ID Mapping

mapping の優先順位:

1. exact metadata match
   - `clip.metadata.video_os.exchange_clip_id`
2. exact metadata fallback
   - `clip.metadata.video_os.clip_id` + `timeline_version`
3. human-readable fallback
   - `clip.name` 内の encoded `clip_id`
4. diagnostic-only source signature fallback
   - `asset_id + src range + duration` の近似一致

4 は自動確定に使わない。見つかっても `mapping_confidence: provisional` とし、Gate 9 の review requirement を
外してはならない。

mapping は 2 段で行う。

1. parent identity resolution
   - base clip と imported clip の parent `exchange_clip_id` を決める
2. instance normalization
   - parent `exchange_clip_id` ごとに imported instance を束ね、`split_clip` / `duplicated_clip` /
     `ambiguous_one_to_many` を判定する

instance normalization の suffix 順は `src_in_us -> timeline_in_frame -> imported ordinal` の stable sort で決める。
1:1 で確定した item のみ `operations[]` 候補に進める。

### `roundtrip_import_report.yaml`

`roundtrip_import_report.yaml` は import 自体の成功可否と lossiness を表す operational report である。

最低 shape:

```yaml
version: 1
project_id: mountain-brand-film
handoff_id: HND_0005_20260321T103000Z
imported_at: 2026-03-21T12:05:00Z
capability_profile_id: davinci_resolve_otio_v1
status: partial
base_timeline:
  version: "5"
  hash: sha256:...
bridge:
  bridge_version: 1.0.0
  python_version: 3.11.x
  opentimelineio_version: exact-pin
  bridge_script_hash: sha256:...
  loaded_adapter_modules: []
nle_session:
  vendor: Blackmagic Design
  product: DaVinci Resolve
  observed_version: "19.0.x"
  import_options_snapshot:
    otio_import_mode: custom
  export_options_snapshot:
    preserve_metadata: true
mapping_summary:
  exported_clip_count: 24
  imported_clip_count: 26
  exact_matches: 22
  fallback_matches: 1
  provisional_matches: 1
  split_items: 1
  duplicate_id_items: 1
  ambiguous_one_to_many_items: 0
  unmapped_items: 3
one_to_many_items:
  split_entries:
    - parent_exchange_clip_id: mountain-brand-film:5:CLP_0003
      child_ids:
        - mountain-brand-film:5:CLP_0003#S01
        - mountain-brand-film:5:CLP_0003#S02
      review_required: true
  duplicate_entries:
    - parent_exchange_clip_id: mountain-brand-film:5:CLP_0008
      retained_exchange_clip_id: mountain-brand-film:5:CLP_0008
      copy_ids:
        - mountain-brand-film:5:CLP_0008#D01
      provenance:
        basis: duplicate_metadata_collision
      review_required: true
loss_summary:
  review_required: true
  lossy_items:
    - classification: color_finish
      item_ref: clip:mountain-brand-film:5:CLP_0007
      reason: capability profile marks color_finish as lossy
  unmapped_items:
    - classification: split_clip
      item_ref: clip:mountain-brand-film:5:CLP_0003
      reason: one-to-many stable ID cannot be auto-reduced to a single canonical diff operation
    - classification: missing_stable_id
      item_ref: clip@track=V1,index=4
      reason: imported clip dropped exchange_clip_id
  unsupported_items:
    - classification: plugin_effect
      item_ref: effect@clip=mountain-brand-film:5:CLP_0003
      reason: outside editable surface allowlist
notes:
  - No canonical artifact was mutated.
```

`status` は `success | partial | failed` を取る。

### Gate 9: Unmapped Edit Handling

以下のいずれかがある場合、import result は `review_required: true` になる。

- unmapped clip
- ambiguous/provisional mapping
- split / duplicate / ambiguous one-to-many
- dropped stable metadata
- unsupported surface edit
- vendor-specific metadata onlyで意味が確定できない変更

Gate 9 により、import 結果から canonical patch を自動生成して apply してはならない。

## Diff Analysis Design

### Supported Edit Types

M3.5 で `operations[]` に入るのは 1:1 mapping が確定した item だけとする。split / duplicate /
ambiguous one-to-many は child ID / copy ID を持っても `unmapped_edits[]` に残す。

reorder 判定の前に以下を正規化する。

- ripple normalization
  - same logical track 上の upstream trim delta を差し引いた `normalized_timeline_in_frame` を計算する
- peer set construction
  - same logical track 上の 1:1 exact/fallback mapped clip だけで relative order を比較する

#### 1. `trim`

検出条件:

- same `exchange_clip_id`
- `src_in_us` または `src_out_us` が変化
- capability profile の `trim.mode == verified_roundtrip`

出力:

- `before.src_in_us`
- `before.src_out_us`
- `after.src_in_us`
- `after.src_out_us`
- `delta.in_us`
- `delta.out_us`

#### 2. `reorder`

検出条件:

- same `exchange_clip_id`
- same logical track assignment
- same peer set 内の relative order が ripple normalization 後に変化

`timeline_in_frame` 単独の変化は reorder 条件にしない。track が変わった場合は `track_move` を優先し、
global track reorder は `track_reorder` classification に落とす。

#### 3. `enable_disable`

検出条件:

- same `exchange_clip_id`
- capability profile が enable flag を `verified_roundtrip` と宣言
- `enabled` 状態が変化

engine canonical timeline には enable state がないため、この diff は import evidence として保持し、
後段 AI が `remove_segment` 相当の意図へ再表現する。

#### 4. `track_move`

検出条件:

- same `exchange_clip_id`
- clip の logical track assignment (`track_id` + `track_kind`) が変化

current M3 `review_patch.json` には direct `change_track` op がないため、M3.5 では
blueprint-planner か future compiler extension への signal として扱う。

track ordinal のみが一括で変わり、各 clip の logical assignment が不変な場合は `track_move` ではなく
`track_reorder` として report-only classification にする。

#### 5. `simple_transition`

検出対象:

- dissolve
- wipe

transition diff は adjacent clip pair を target にし、type / duration / side を持たせる。
complex transition や vendor-specific effect chain は unmapped edit に落とす。

#### 6. `timeline_marker_add`

検出対象:

- timeline marker の追加
- absolute timeline frame と label を持つ marker

`add_marker` patch op と接続できる timeline-level marker だけを first-class にする。clip-attached marker と
freeform note body は `clip_marker_add` / `note_text_add` として `unmapped_edits[]` に落とす。

#### 7. One-To-Many Stable ID Events

split / duplicate / ambiguous one-to-many は human diff の対象ではあるが、canonical patch へは直接還元しない。

- `split_clip`
  - `parent_exchange_clip_id`
  - `derived_child_ids[]`
- `duplicated_clip`
  - `parent_exchange_clip_id`
  - `copy_ids[]`
  - `provenance`
- `ambiguous_one_to_many`
  - parent / candidates / reason

### `human_revision_diff.yaml`

`human_revision_diff.yaml` は agent-consumable な構造化 diff とする。

最低 shape:

```yaml
version: 1
project_id: mountain-brand-film
handoff_id: HND_0005_20260321T103000Z
base_timeline_version: "5"
capability_profile_id: davinci_resolve_otio_v1
status: review_required
summary:
  trim: 3
  reorder: 1
  enable_disable: 2
  track_move: 1
  simple_transition: 1
  timeline_marker_add: 1
  unmapped: 3
operations:
  - operation_id: HRD_0001
    type: trim
    target:
      exchange_clip_id: mountain-brand-film:5:CLP_0003
      clip_id: CLP_0003
      segment_id: SEG_AST_73A1F6D0_0004
      asset_id: AST_73A1F6D0
      track_id: V1
    before:
      src_in_us: 11200000
      src_out_us: 15850000
      timeline_in_frame: 48
      timeline_duration_frames: 36
    after:
      src_in_us: 11400000
      src_out_us: 15400000
      timeline_in_frame: 48
      timeline_duration_frames: 32
    delta:
      in_us: 200000
      out_us: -450000
      duration_frames: -4
    mapped_via: metadata.exchange_clip_id
    confidence: exact
    surface: verified_roundtrip
unmapped_edits:
  - classification: split_clip
    item_ref: clip:mountain-brand-film:5:CLP_0008
    derived_child_ids:
      - mountain-brand-film:5:CLP_0008#S01
      - mountain-brand-film:5:CLP_0008#S02
    review_required: true
    reason: one-to-many stable ID requires human restructuring
  - classification: duplicated_clip
    item_ref: clip:mountain-brand-film:5:CLP_0010
    copy_ids:
      - mountain-brand-film:5:CLP_0010#D01
    review_required: true
    reason: duplicate stable ID copy is preserved as provenance only
  - classification: plugin_effect
    item_ref: effect@clip=mountain-brand-film:5:CLP_0009
    review_required: true
    reason: outside capability profile allowlist
```

### Structural Summary Rules

summary は human-readable prose ではなく machine-readable count + status を持つ。

- `status`
  - `clean`
  - `lossy`
  - `review_required`
- `summary`
  - type 別 count
- `operations[]`
  - exact / fallback / provisional の mapping provenance を持つ
  - 1:1 exact/fallback/provisional match のみを許可し、one-to-many item は入れない
- `unmapped_edits[]`
  - 自動解決してよいものは 0 件でなければならない

### Unmapped Edit Classification

M3.5 では最低でも以下に分類する。

- `complex_title`
- `plugin_effect`
- `color_finish`
- `advanced_audio_finish`
- `speed_change`
- `nested_sequence`
- `deleted_clip_without_disable`
- `missing_stable_id`
- `split_clip`
- `duplicated_clip`
- `ambiguous_one_to_many`
- `track_reorder`
- `clip_marker_add`
- `note_text_add`
- `ambiguous_mapping`
- `unknown_vendor_extension`

classification は capability profile と import normalization の両方で決める。

## NLE Capability Profile

### Design Goal

NLE profile は「ある編集面が verified / provisional / report-only / lossy のどこに属するか」を
data-driven に判定する contract である。import / export core は NLE 固有条件を if 文で持たず、profile を読む。

### Schema Shape

`nle_capability_profile.yaml` は以下を持つ。

```yaml
version: 1
profile_id: davinci_resolve_otio_v1
nle:
  vendor: Blackmagic Design
  product: DaVinci Resolve
  version_range: ">=19"
otio:
  interchange_format: otio
  metadata_namespace: video_os
stable_id:
  primary_paths:
    clip: metadata.video_os.exchange_clip_id
    track: metadata.video_os.exchange_track_id
  fallback_paths:
    - clip.name
  require_exact_metadata: true
surfaces:
  trim:
    mode: verified_roundtrip
    tolerance_frames: 1
  reorder:
    mode: verified_roundtrip
    detect_after: ripple_normalized_peer_order
  enable_disable:
    mode: verified_roundtrip
  track_move:
    mode: provisional_roundtrip
  track_reorder:
    mode: report_only
  simple_transition:
    mode: provisional_roundtrip
    allowed_types: [dissolve, wipe]
  timeline_marker_add:
    mode: provisional_roundtrip
  clip_marker_add:
    mode: report_only
  note_text_add:
    mode: report_only
  color_finish:
    mode: lossy
  fusion_effect:
    mode: lossy
  fairlight_advanced_audio:
    mode: lossy
import_policy:
  provisional_mapping_requires_review: true
  unmapped_edit_requires_review: true
  one_to_many_requires_review: true
```

### DaVinci Resolve v1 Profile

DaVinci Resolve v1 profile は実機 evidence ベースで保守的に固定する。

- verified_roundtrip
  - clip ID metadata retention
  - trim
  - reorder
  - enable / disable
- provisional_roundtrip
  - track_move
  - simple_transition
  - timeline_marker_add
- report_only
  - track_reorder
  - clip_marker_add
  - note_text_add
- lossy
  - color grades
  - Fusion effects
  - Fairlight advanced audio

重要なのは、これは「M3.5 が依存する product contract」であって、あらゆる Resolve version の一般論ではない点である。
実機 smoke の acceptance は verified surface のみで行い、provisional surface は report できても product
contract に昇格させない。各 handoff session は Resolve version と import / export option snapshot を
manifest / report に必ず記録する。

### Future Premiere Pro Extension

Premiere profile 追加時の拡張点:

- `profile_id` を増やすだけで importer core は不変
- metadata retention rule が違っても `stable_id.primary_paths` / `fallback_paths` で吸収
- transition naming や marker field が違っても `surfaces.*` の detect rule で吸収

M3.5 base scope は Resolve v1 のみ実装し、Premiere は schema-ready / code-deferred とする。

## Recompile Loop

### Principle

imported OTIO から canonical artifact を直接 mutate しない。diff を evidence 化し、既存 M3 loop に戻す。

```text
approved timeline
  -> /handoff-export
  -> human NLE edit
  -> /handoff-import
  -> roundtrip_import_report.yaml + human_revision_diff.yaml
  -> roughcut-critic or blueprint-planner
  -> new review_patch / new blueprint proposal
  -> deterministic compile
  -> preview update
```

### Downstream Consumption Rule

`human_revision_diff.yaml` は 2 つの consumer を持つ。

1. roughcut-critic
   - trim / reorder / timeline marker のように current patch contract へ落とし込みやすい変更を読む
2. blueprint-planner
   - track move / track reorder / transition / repeated disable / split / duplicate など構造や policy の
     見直しが必要な変更を読む

### Mapping To Existing M3 Contracts

M3 patch contract を変えないため、diff からの反映は以下のように制限する。

| Human diff | M3 への戻し方 |
| --- | --- |
| trim | `trim_segment` proposal に落とせる |
| reorder (same track) | `move_segment` proposal に落とせる |
| timeline marker add | `add_marker` proposal に落とせる |
| enable/disable | `remove_segment` or blueprint revision の意図に再表現する |
| track move | blueprint revision or future compiler extension |
| simple transition | blueprint transition policy or NLE finishing path |
| clip marker / note body / split / duplicate | `unmapped_edits[]` のまま human review へ送る |

M3.5 は diff を canonical patch に自動変換しない。agent proposal を一段挟む。

### Re-entry Command And State Contract

`/handoff-import` は canonical artifact を書き換えず、handoff session root に report だけを書く。canonical
M3 loop へ戻すのは既存 command の責務とする。

- `/review`
  - `human_revision_diff.yaml` を読んで新しい `review_patch.json` / `review_report.yaml` を提案する
- `/blueprint`
  - 構造変更が必要な diff を `edit_blueprint.yaml` 更新案へ戻す

canonical artifact が更新された時点で、M3 の invalidation contract をそのまま適用する。

| Event | Canonical mutation | `approval_record` | Expected state |
| --- | --- | --- | --- |
| `/handoff-import` 完了 | なし | unchanged | `approved` |
| diff から新しい `review_patch.json` / `review_report.yaml` を promote | review artifact changed | stale | `critique_ready` |
| accepted patch を compile して `timeline.json` / preview を更新 | timeline changed | stale | `timeline_drafted` |
| diff から `edit_blueprint.yaml` を更新 | blueprint changed | stale | `blueprint_ready` or `blocked` |
| 再 `/review` で新しい critique を生成 | review artifact changed | stale until re-approved | `critique_ready` |

### Gate 10: Source Of Truth Declaration

final path に入る前に、handoff session ごとに以下のいずれかを宣言する。

- `engine_render`
  - imported diff は advisory
  - 反映したい変更は canonical artifact に再表現し、compiler で再構成する
- `nle_finishing`
  - NLE の finishing result を最終 truth とする
  - engine timeline は editorial provenance として残るが、final master は NLE 側を採用する

この宣言は export 時 manifest には置かない。handoff export artifact は immutable ledger とし、post-import /
post-review の判断だけを `project_state.yaml` に書く。

```yaml
handoff_resolution:
  handoff_id: HND_0005_20260321T103000Z
  status: decided
  source_of_truth_decision: engine_render
  decided_by: operator
  decided_at: 2026-03-21T12:20:00Z
  basis_report_hashes:
    roundtrip_import_report: sha256:...
    human_revision_diff: sha256:...
```

M4 は `project_state.yaml.handoff_resolution` を読んで final render path を分岐する。

### Gate 11: Capability-Bounded Handoff

profile mode ごとの扱いを固定する。

- `verified_roundtrip`
  - diffable
  - agent evidence に使える
  - automated acceptance の対象
- `provisional_roundtrip`
  - diffable
  - agent evidence に使える
  - `review_required: true`
- `report_only`
  - report には残すが M3 patch contract へ自動還元しない
- `lossy`
  - report only
  - `engine_render` path では manual review required
- `one_way`
  - `nle_finishing` path を選んだ場合のみ許容

## Loss-Aware Round-Trip Design

### Export-Time Loss Metadata

export 時に timeline root metadata と `handoff_manifest.yaml` の両方へ以下を残す。

- `capability_profile_id`
- `verified_roundtrip_surfaces`
- `provisional_roundtrip_surfaces`
- `lossy_surfaces`
- bridge fingerprint
- expected NLE import / export option snapshot
- exact source mirror
  - `src_in_us`
  - `src_out_us`
  - `timeline_in_frame`
  - `timeline_duration_frames`

これにより import 側は「NLE が変えた」のか「adapter が落とした」のかを分類できる。

### Import-Time Loss Detection

loss とみなす条件:

- stable metadata が欠落
- profile で `lossy` な surface に変更がある
- source range が frame-rounding を超えてずれた
- transition/effect が vendor metadata にしか残っていない

loss report には少なくとも以下を記録する。

- classification
- target ref
- base value
- imported value
- capability rule
- review requirement

### Stable ID Retention Verification

stable ID 維持の acceptance は 3 段で確認する。

1. export readback
   - `handoff_timeline.otio` を直後に再読込し、全 clip に `exchange_clip_id` があることを確認
2. imported readback
   - `imported_handoff.otio` に同じ `exchange_clip_id` が残っている clip 数を計測する
   - split / duplicate は `one_to_many_items` として別カウントし、1:1 retention rate の分母から外す
3. round-trip assertion
   - supported surface edit を行った clip で `exchange_clip_id` retention rate が 100% であること

retention が 100% でない場合、profile は `require_exact_metadata: true` なら smoke fail とする。

## Non-Functional Requirements

### Determinism

- same `timeline.json` + same `handoff_manifest` input + same capability profile + same OTIO bridge fingerprint
  なら exported OTIO の normalized JSON は一致すること
- import report / diff report は stable sort で書く
- child ID / copy ID suffix は `src_in_us -> timeline_in_frame -> imported ordinal` の stable sort で固定する
- operation ordering は
  `track kind -> logical track_id -> peer ordinal -> operation type -> normalized_instance_id`
  で固定する

### Reliability / Auditability

- imported OTIO failure は canonical artifact corruption を起こさない
- handoff session ごとに run log を残し、どの OTIO file / profile / base timeline から report を
  作ったか追跡できる
- `roundtrip_import_report.yaml` は `base_timeline.hash` を保持し、誤った base への import を拒否できる

### Security Boundary

- imported OTIO は untrusted であり、vendor metadata や path を code execution に使わない
- absolute source path は `handoff_manifest.yaml` の non-canonical field にのみ保持する
- agent は imported OTIO raw blob を直接 canonical directory に promote しない
- Python bridge は fixed command surface のみを公開し、arbitrary Python execution を許さない

### Rollback

handoff 失敗時の rollback は単純に handoff session directory を破棄する。canonical artifact は無傷で、
project state は `approved` のまま再 handoff できる。

## Test Strategy

### OTIO Library Strategy

M3.5 は OTIO bridge に official Python package を使う。

- primary
  - `opentimelineio` Python package
- not chosen as canonical runtime
  - unofficial/community JavaScript bindings

理由は export/import engine を long-term に保守可能な official runtime へ寄せるためである。

### Fixture-Based Round-Trip Tests

最低 fixture flow:

```text
timeline.json
  -> /handoff-export
  -> fixture human edit
  -> /handoff-import
  -> roundtrip_import_report.yaml
  -> human_revision_diff.yaml
```

fixture human edit には以下を含める。

- trim
- reorder
- disable
- ripple shift without reorder
- split
- duplicate
- global track reorder
- track move
- simple transition
- timeline marker add
- unmapped plugin effect

### Required Automated Checks

- stable ID retention
  - exported OTIO readback で全 clip が `exchange_clip_id` を持つ
  - imported OTIO で supported edit clip が同じ `exchange_clip_id` を保持する
- diff detection
  - 各 edit type が expected operation に分類される
  - ripple shift が false-positive reorder を起こさない
  - global track reorder が `track_move` ではなく `track_reorder` に分類される
- lossy detection
  - plugin effect / color finish / advanced audio が loss report に落ちる
- Gate enforcement
  - Gate 8 missing id fail
  - Gate 9 unmapped edit review_required
  - Gate 11 out-of-profile edit review_required
  - bridge version mismatch policy
- recompile loop
  - diff を読んだ mock agent proposal から preview を再生成できる

### Manual NLE Smoke

M3.5 manual smoke は DaVinci Resolve を対象に document 化する。

手順:

1. `approved` state の sample or real-material project で `/handoff-export` を実行
2. Resolve version と import option / export option を記録
3. Resolve に import
4. trim / reorder / disable を実施
5. optional exploratory edit として track move / timeline marker add を実施
6. `imported_handoff.otio` を export
7. importer 実行
8. import report と diff report を確認

acceptance:

- `trim / reorder / disable` が diff に出る
- `exchange_clip_id` retention が 100%
- recorded Resolve version / option snapshot が manifest / report と一致する
- unsupported edit は unmapped / lossy に出る

### Real-Material Smoke

real-material smoke は roadmap の 2 ケースを継続利用する。

- `sample-bicycle`
  - multi-asset coverage で reorder を確認し、track move / timeline marker は exploratory coverage とする
- `AX-1 D4887`
  - single-asset interview で trim / disable を確認し、timeline marker は exploratory coverage とする

## Implementation Order

### Phase 1. Contracts And Bridge Boundary

実装内容:

- `docs/milestone-3.5-design.md`
- 4 つの新規 schema
- OTIO bridge command contract
- `nle_capability_profile.yaml` schema + Resolve v1 profile

達成条件:

- artifact shape と gate 8-11 が文書 / schema で固定される
- TypeScript orchestration と Python bridge の責務境界が明確
- bridge fingerprint / mismatch policy / `project_state.yaml.handoff_resolution` shape が固定される

### Phase 2. Export Path

実装内容:

- export preflight
- stable ID validation
- `handoff_manifest.yaml`
- `handoff_timeline.otio`

達成条件:

- `approved` project から handoff session を生成できる
- export readback で stable metadata retention を確認できる

### Phase 3. Import Path

実装内容:

- OTIO normalization
- stable ID mapping
- split / duplicate normalization
- `roundtrip_import_report.yaml`

達成条件:

- imported OTIO を normalize して success/partial/failed を返せる
- unmapped / lossy / unsupported / split / duplicate を分類できる

### Phase 4. Diff Analyzer And M3 Re-entry

実装内容:

- `human_revision_diff.yaml`
- diff classification
- roughcut-critic / blueprint-planner input wiring

達成条件:

- supported edit が diff に落ちる
- diff を読んだ next proposal から compiler を再実行できる

### Phase 5. Fixture And Resolve Smoke

実装内容:

- fixture-based golden tests
- Resolve manual smoke checklist
- real-material smoke

達成条件:

- fixture round-trip suite が通る
- Resolve smoke で trim / reorder / disable の検出が確認できる
- one-to-many classification と option snapshot 記録が確認できる
- lossy edit が report に記録される

## Risks And Deferred Work

### Primary Risks

- NLE version 差で metadata retention が揺れる
- unsupported edit が見た目上は trivial でも vendor metadata にしか残らない
- same-track reorder と track move の複合編集で diff 解釈が難しくなる

### Mitigations

- capability profile に version range を持たせる
- provisional mapping は自動確定せず review に送る
- diff operation は exact/provisional を明示する
- `engine_render` path では canonical patch への再表現を必須にする

### Deferred Beyond M3.5

- Premiere Pro profile の実装
- one-way `nle_finishing` path の final master packaging
- transition / enable-state を canonical compiler contract に昇格するかの判断
- AAF / FCPXML adapters

## Final Notes

M3.5 の本質は「OTIO を canonical にすること」ではなく、「人間の NLE 判断を stable-id-based に読み戻し、
loss-aware な evidence として M3 の loop に戻すこと」である。

したがって完了判定は、NLE 側で何でも再現できるかではなく、

- export 前に boundary gate が閉じていること
- imported OTIO から安全に diff を抽出できること
- unsupported change を silent に canonical 化しないこと
- next proposal が deterministic compile loop に戻せること

で行う。
