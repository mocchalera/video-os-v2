# Milestone 4 Design

## Scope

Milestone 4 は、M3 で成立した editorial approval と M3.5 の OTIO round-trip / Gate 10 判断を前提に、
完成品質の deliverable を deterministic engine で生成する milestone である。

M4 の責務は 3 つに分かれる。

1. `approved` な editorial timeline に対して、SpeechCaption と TextOverlay を machine-readable に固定する。
2. A2 BGM、ducking、fade、loudnorm 2-pass mastering を final packaging path に組み込む。
3. `project_state.yaml.handoff_resolution` を読んで、`engine_render` と `nle_finishing` の source of truth を
   明示的に分岐し、`packaged` state を正しく確定する。

M4 で増やすのは「final output plane の contract と engine」であり、M1-M3.5 の editorial loop、
OTIO boundary、approval contract は壊さない。`timeline.json` は引き続き canonical timeline artifact であり、
agent は caption text や ffmpeg filter graph を直接 final media に書き込まない。

### In Scope

- `caption_policy` の M4 packaging path での必須化
- SpeechCaption と TextOverlay の 2 系統 caption workflow
- `caption_source.json` draft と `caption_approval.json` approved artifact
- `music_cues.json` による A2 cue contract
- `runtime/render-pipeline-defaults.yaml` による stepwise render pipeline
- Remotion assembly + ffmpeg post-processing + final mux
- `raw_dialogue.wav` / `final_mix.wav` の stem contract
- `qa-report.json` / `qa-report.md` と packaged transition
- Gate 10 による `engine_render` / `nle_finishing` path 分岐
- short fixture render と packaging QA test

### Out Of Scope

- BGM の検索、推薦、ライセンス管理
- multi-language parallel subtitle track
- karaoke / word-highlight / per-word animated captions
- TTS / voice cloning / ADR
- imported OTIO から canonical timeline を自動確定すること
- M3 の `/review` preview path を M4 の final package path に完全統合すること
- timeline IR の全面 redesign
  - `clip` を track-kind ごとの union schema に作り直すこと
- full NLE conform / color grade / advanced audio post を engine render path に持ち込むこと

### Contract Rule

- `timeline.json` は引き続き canonical timeline artifact とする。
- M4 は M1-M3.5 の既存 consumer を壊さない。
- 既存 field の rename / remove / semantic break は行わない。
- M4 で必要な schema 変更は additive extension または M4-specific gate による必須化で吸収する。
- final media (`final.mp4`, stems, sidecar subtitles) は engine-produced deliverable であり、canonical source of truth
  は `timeline.json`, `caption_approval.json`, `music_cues.json`, `package_manifest.json`, `qa-report.json`,
  `project_state.yaml` に置く。
- imported NLE export は untrusted input とみなし、schema / checksum / QA validation を通るまで `packaged` に進めない。

### Success Criteria

Milestone 4 は、以下がすべて満たされたとき完了とする。

1. `approved` state かつ current `approval_record` を持つ project で、M4 packaging preflight が
   `caption_policy`, `handoff_resolution`, `timeline.json`, `review_report.yaml` の fresh-ness を検証できる。
2. `caption_policy` が有効である場合、`03_analysis/transcripts/TR_*.json` から deterministic に
   `caption_source.json` を生成できる。
3. human-approved `caption_approval.json` から `tracks.caption` / `tracks.overlay` を含む
   schema-valid `timeline.json` を compiler が再投影できる。
4. `music_cues.json` により A2 track の entry 条件、cue timing、ducking 前提、fade、beat reference が
   machine-readable に固定される。
5. `engine_render` path では `assembly.mp4 -> caption_burn -> audio_master -> package` の stepwise pipeline で
   `final.mp4`, `raw_dialogue.wav`, `final_mix.wav`, sidecar subtitle を生成できる。
6. `nle_finishing` path では engine render を final truth に昇格させず、operator-provided NLE export を
   validate / package して `package_manifest.json` を確定できる。
7. post-render QA が path-specific profile で deterministic に閉じ、`engine_render` では
   `dialogue_occupancy`, `av_drift`, `caption_density`, `loudness_target`, `package_completeness` を、
   `nle_finishing` では `supplied_export_probe`, `supplied_av_sync`, `caption_delivery`,
   `loudness_target`, `package_completeness` を判定し、`qa-report.json` / `qa-report.md` を生成できる。
8. `project_state.yaml.current_state` は `approved -> packaged` に進み、upstream artifact 変更時は
   deterministic に stale / fallback できる。
9. same `base_timeline_version` + same `editorial_timeline_hash` + same caption approval + same music cues +
   same render defaults + same tool versions なら、`package_manifest.json` の正規化結果が deterministic に再現できる。
10. short fixture render で `final.mp4` が実際に生成され、manual smoke で Japanese speech caption,
    vertical TextOverlay, BGM ducking, source-of-truth branching が確認できる。

### Test Gates

上記 success criteria は以下の gate で受け入れる。

- unit
  - caption source generation / segmentation
  - caption approval validation
  - music cue normalization / beat reference validation
  - packaging state reconcile
  - QA metric calculators
- integration
  - `caption_approval.json -> timeline.json` projection
  - `music_cues.json -> A2 track + ffmpeg post manifest`
  - Remotion assembly -> demux -> audio master -> mux
  - Gate 10 branching
- e2e
  - approved fixture -> packaged
  - `engine_render` fixture path
  - `nle_finishing` validation-only fixture path
- manual smoke
  - Japanese speech captions
  - vertical credit / title overlay
  - BGM entry / ducking / fade
  - final mp4 + sidecar consistency

## M3.5 Connection And M5 Handoff

### Entry Point

M4 の final packaging path は M3.5 の `approved` を入口にする。`critique_ready` の project は caption source の
draft 生成や validation dry-run までは許可してよいが、`final.mp4` と `package_manifest.json` の確定には進めない。

理由:

- M3 の `approval_record` は editorial snapshot を固定する canonical operator record である。
- M3.5 の `handoff_resolution` は Gate 10 の source-of-truth decision であり、final package path の前提である。
- `critique_ready` は still-under-review なので packaged truth を固定できない。

M4 final packaging の前提:

- `project_state.yaml.current_state == approved`
- `approval_record.status in {clean, creative_override}`
- `approval_record.artifact_versions` が current editorial snapshot と一致
- `project_state.yaml.handoff_resolution.status == decided`
- `review_gate == open`
- `timeline.json` が fresh かつ schema-valid
- required packaging artifacts が current snapshot と整合

### State And Invalidation

M4 では `project_state.schema.json` を additive に拡張し、少なくとも以下を追加する。

- `artifact_hashes`
  - `timeline_version`
    - legacy file-hash slot。M1-M3 互換のため残すが、M4 では cross-artifact timeline identity として使わない
  - `editorial_timeline_hash`
  - `caption_approval_hash`
  - `music_cues_hash`
  - `qa_report_hash`
  - `package_manifest_hash`
  - `packaging_projection_hash`
- `gates`
  - `packaging_gate`
    - `open | blocked`
- `approval_record.artifact_versions`
  - `base_timeline_version`
  - `editorial_timeline_hash`

`packaging_gate` は少なくとも以下で `open` になる。

- `review_gate == open`
- `handoff_resolution.status == decided`
- captions enabled の場合は `caption_approval.json` が valid
- BGM enabled の場合は `music_cues.json` が valid
- chosen render path に必要な input deliverable が揃っている

`packaged` への遷移条件:

- `qa-report.json.passed == true`
- `package_manifest.json` が valid
- chosen source-of-truth path に応じた final deliverable が存在する

invalidation は M3 の downstream invalidation を引き継ぎ、追加で以下を持つ。

- editorial surface changed
  - stale: `caption_approval`, `music_cues`, `qa_report`, `package_manifest`
  - state fallback: `timeline_drafted`
- `caption_approval.json` changed
  - stale: `qa_report`, `package_manifest`
  - state fallback: `approved`
- `music_cues.json` changed
  - stale: `qa_report`, `package_manifest`
  - state fallback: `approved`
- `handoff_resolution` changed
  - stale: `qa_report`, `package_manifest`
  - state fallback: `approved`
- render defaults / toolchain fingerprint changed
  - stale: `qa_report`, `package_manifest`
  - state fallback: `approved`

### Editorial Surface Freeze

M3 approval と M4 packaging projection が衝突しないよう、M4 では `timeline.json` を 2 面に分けて扱う。

- editorial surface
  - `sequence`
  - `tracks.video`
  - `tracks.audio.A1`
  - beat / review marker のうち M3 critic が読む範囲
- packaging surface
  - `tracks.audio.A2`
  - `tracks.audio.A3`
  - `tracks.caption`
  - `tracks.overlay`
  - packaging-only metadata

ルール:

- M4 compiler は editorial surface を mutate してはならない。
- `base_timeline_version` は M4 の canonical timeline identity であり、approved `timeline.json.version` と同値に固定する。
- `approval_record` は `base_timeline_version` + `editorial_timeline_hash` に bind し、packaging projection 自体では stale にならない。
- packaging projection の fingerprint は `artifact_hashes.packaging_projection_hash` と
  `package_manifest.json.provenance.packaging_projection_hash` に残す。

### Timeline Identity

M4 では timeline identity と hash fingerprint を分離する。

- canonical identity
  - `base_timeline_version`
  - 値は approved `timeline.json.version` をそのままコピーする
  - `caption_source.json`, `caption_approval.json`, `music_cues.json`, `package_manifest.json`,
    `approval_record.artifact_versions.base_timeline_version`, M3.5 `human_revision_diff.base_timeline_version`
    が同じ語彙を共有する
- editorial binding hash
  - `editorial_timeline_hash`
  - approved editorial surface (`sequence`, `tracks.video`, `tracks.audio.A1`, critic-facing markers) の hash
  - approval self-heal / stale 判定はこの hash で行う
- packaging freshness hash
  - `packaging_projection_hash`
  - caption / music / render defaults を含む packaging plane の fingerprint
  - package freshness と rerun 判定はこの hash で行う
- backward-compatibility note
  - `project_state.artifact_hashes.timeline_version` は既存 reconcile 互換の legacy file-hash slot として残す
  - M4 artifact の cross-artifact binding にこの field を再利用しない

### M5 Handoff

M5 Automation + Batch へ渡す surface は以下で固定する。

- `runtime/render-pipeline-defaults.yaml`
- `/package` 相当の single entrypoint runtime
- `caption_approval.json`
- `music_cues.json`
- `package_manifest.json`
- `qa-report.json`

M5 はこれらの artifact contract を headless 実行単位として使い、interactive reasoning 自体は増やさない。
M4 の exit criteria は「human-in-the-loop で 1 本通せること」であり、M5 はその batch 化だけを担う。

## Artifact Model

### Canonical vs Derived

M4 では packaging plane の artifact を 2 層に分ける。

canonical:

- `05_timeline/timeline.json`
- `07_package/caption_approval.json`
- `07_package/music_cues.json`
- `07_package/package_manifest.json`
- `07_package/qa-report.json`
- `project_state.yaml`

derived / operational:

- `07_package/caption_source.json`
- `07_package/render_manifest.json`
- `07_package/captions/speech.auto.srt`
- `07_package/captions/speech.approved.srt`
- `07_package/captions/speech.vtt`
- `07_package/audio/bgm-analysis.json`
- `07_package/video/assembly.mp4`
- `07_package/video/raw_video.mp4`
- `07_package/audio/raw_dialogue.wav`
- `07_package/audio/final_mix.wav`
- `07_package/video/final.mp4`
- `07_package/qa-report.md`
- `07_package/logs/*`

基本方針:

- human approval が必要で再構築できないものは canonical に置く。
- deterministic engine が再生成できる中間物は derived に置く。
- media binary 自体は final deliverable だが、truth の anchor は `package_manifest.json` とする。

### Proposed Layout

```text
07_package/
  caption_source.json
  caption_approval.json
  music_cues.json
  render_manifest.json
  package_manifest.json
  qa-report.json
  qa-report.md
  captions/
    speech.auto.srt
    speech.approved.srt
    speech.vtt
  audio/
    bgm-analysis.json
    raw_dialogue.wav
    final_mix.wav
  video/
    assembly.mp4
    raw_video.mp4
    final.mp4
  logs/
    remotion.log
    ffmpeg-caption.log
    ffmpeg-audio.log
    ffmpeg-package.log
```

### New Schemas

M4 で追加する schema は以下を想定する。

- `schemas/caption-approval.schema.json`
- `schemas/music-cues.schema.json`
- `schemas/package-manifest.schema.json`
- `schemas/package-qa-report.schema.json`

既存 `timeline-ir.schema.json` は additive に使う。caption / overlay 固有 payload は `clip.metadata` に格納し、
M1-M3.5 の reader が unknown metadata を無視しても壊れない形に保つ。

### `package_manifest.json`

`package_manifest.json` は packaged deliverable の ledger であり、少なくとも以下を持つ。

```json
{
  "version": "1",
  "project_id": "sample",
  "source_of_truth": "engine_render",
  "base_timeline_version": "5",
  "packaging_projection_hash": "sha256:...",
  "created_at": "2026-03-21T12:30:00Z",
  "artifacts": {
    "final_video": {"path": "07_package/video/final.mp4", "sha256": "sha256:..."},
    "raw_video": {"path": "07_package/video/raw_video.mp4", "sha256": "sha256:..."},
    "raw_dialogue": {"path": "07_package/audio/raw_dialogue.wav", "sha256": "sha256:..."},
    "final_mix": {"path": "07_package/audio/final_mix.wav", "sha256": "sha256:..."},
    "captions": [
      {"kind": "speech", "delivery": "sidecar", "path": "07_package/captions/speech.vtt", "sha256": "sha256:..."}
    ],
    "qa_report": {"path": "07_package/qa-report.json", "sha256": "sha256:..."}
  },
  "provenance": {
    "editorial_timeline_hash": "sha256:...",
    "caption_approval_hash": "sha256:...",
    "music_cues_hash": "sha256:...",
    "ffmpeg_version": "7.x",
    "remotion_bundle_hash": "sha256:...",
    "render_defaults_hash": "sha256:..."
  }
}
```

`nle_finishing` path では artifact set が異なる。canonical sample は以下とする。

```json
{
  "version": "1",
  "project_id": "sample",
  "source_of_truth": "nle_finishing",
  "base_timeline_version": "5",
  "packaging_projection_hash": "sha256:...",
  "created_at": "2026-03-21T12:45:00Z",
  "artifacts": {
    "final_video": {"path": "07_package/video/final.mp4", "sha256": "sha256:..."},
    "captions": [
      {"kind": "speech", "delivery": "sidecar", "path": "07_package/captions/speech.vtt", "sha256": "sha256:..."}
    ],
    "qa_report": {"path": "07_package/qa-report.json", "sha256": "sha256:..."}
  },
  "provenance": {
    "editorial_timeline_hash": "sha256:...",
    "caption_approval_hash": "sha256:...",
    "handoff_id": "HND_0005_20260321T103000Z",
    "ffmpeg_version": "7.x",
    "render_defaults_hash": "sha256:..."
  }
}
```

## Key Decisions And Trade-offs

### 1. `caption_policy` の必須化は schema breaking ではなく M4 gate で行う

選択肢:

- A. `edit-blueprint.schema.json` で root required に昇格する
- B. schema は backward-compatible に維持し、M4 packaging gate で必須化する

採用: B

理由:

- M1-M3.5 の既存 project / fixture を壊さない。
- roadmap の「必須化」は packaging path の contract として達成できる。
- M4 writer / template / role prompt は `caption_policy` を必ず出すよう更新する。

補足:

- canonical artifact に保存する `caption_policy.source` は
  `transcript | authored | none` を維持する。
- packaging runtime 内部での別名 (`stt`, `manual`) は許容してよいが、writer と persisted artifact は
  legacy enum を出力する。

### 2. caption truth は timeline-only ではなく `caption_approval.json` を経由する

選択肢:

- A. approved captions を直接 `timeline.json` に埋め込む
- B. `caption_approval.json` を canonical source とし、compiler が `timeline.json` へ投影する

採用: B

理由:

- 「source generation -> editorial approval」の 2 段階を artifact として分離できる。
- human-approved text と generated draft を明確に区別できる。
- `timeline.json` は引き続き compiler-only mutation を守れる。

### 3. SpeechCaption の burn-in owner は ffmpeg、TextOverlay owner は Remotion

選択肢:

- A. SpeechCaption も TextOverlay も Remotion が final draw する
- B. SpeechCaption は ffmpeg post、TextOverlay は Remotion

採用: B

理由:

- roadmap の stepwise pipeline (`assembly -> caption_burn -> audio_master -> package`) と一致する。
- speech sidecar (`.srt` / `.vtt`) と burn-in が同じ approved source を共有できる。
- vertical writing や expressive layout は ffmpeg より Remotion の方が自然に持てる。

補足:

- `VideoTimeline.tsx` には preview-only speech caption layer を置いてよいが、canonical delivery burn-in は
  `caption_burn` phase が持つ。

### 4. `timeline.json` の overlay clip には synthetic source ID を使う

選択肢:

- A. timeline IR を clip-kind union に redesign する
- B. 既存 `clip` shape を維持し、overlay clip は synthetic source ID + metadata で表現する

採用: B

理由:

- M1-M3.5 reader を壊さない。
- M4 の主眼は packaging path であり、IR 全面 redesign は scope 外である。

運用ルール:

- SpeechCaption は元 dialogue source の `asset_id` / `segment_id` / `src_*` を引き継ぐ。
- TextOverlay は `asset_id="__overlay__"` と `segment_id="TXT_<overlay_id>"` を使い、
  実 payload は `metadata.overlay` に置く。

### 5. `timeline.json` の version は editorial version を維持し、packaging projection は別 hash で追う

選択肢:

- A. caption / music projection のたびに `timeline.version` を上げる
- B. `timeline.version` は M3-approved editorial version を維持し、M4 augmentation は別 fingerprint で追う

採用: B

理由:

- M3 approval は editorial timeline に対する人間判断であり、caption / music plane の追加で自動失効させるべきではない。
- M4 で必要なのは full timeline re-approval ではなく packaging-specific validation である。

運用ルール:

- M4 projection は `timeline.version` を変えない。
- `package_manifest.json` に `base_timeline_version` と `packaging_projection_hash` を残す。
- editorial surface が変わった場合のみ `approval_record` を stale にする。

## Caption Design

### Goals

M4 の caption plane は 2 系統を持つ。

- `SpeechCaption`
  - approved dialogue / speech trace を viewer-readable な字幕へ変換する
  - sidecar と burn-in の双方に使える
- `TextOverlay`
  - タイトル、章見出し、クレジット、日付、縦書き演出など speech ではない text treatment
  - Remotion がレイアウトと motion を持つ

両者は同じ text plane だが contract は分ける。

- SpeechCaption は readability / CPS / transcript provenance が主
- TextOverlay は layout / writing mode / styling が主

### `caption_policy` Contract

M4 packaging path での normalized contract:

```yaml
caption_policy:
  language: ja
  delivery_mode: burn_in | sidecar | both
  source: transcript | authored | none
  styling_class: clean-lower-third
```

意味:

- `language`
  - primary subtitle language
  - CPS calibration と line breaking の基準になる
- `delivery_mode`
  - `burn_in`: video に焼き込む
  - `sidecar`: `.srt` / `.vtt` のみ出す
  - `both`: 両方出す
- `source`
  - `transcript`: `03_analysis/transcripts/TR_*.json` から draft を作る
  - `authored`: operator-authored text だけを使う
  - `none`: SpeechCaption を出さない
- `styling_class`
  - renderer / sidecar generator が共有する named style preset

M4 gate:

- `caption_policy` は SpeechCaption の contract であり、TextOverlay の有無とは独立に必須
- `caption_policy.source in {transcript, authored}` のときだけ SpeechCaption を有効化する
- `caption_policy.source == none` のときは `speech_captions[]` を空にし、`caption_burn` / sidecar emission を skip する
- `TextOverlay` only project は `caption_policy.source == none` で有効とし、overlay render は継続する
- `delivery_mode` は SpeechCaption にのみ作用し、TextOverlay render の enablement を表さない

### Language Calibration

Caption segmentation は「意味単位優先、CPS 言語別 calibration」を採る。

初期 default:

- Japanese
  - unit: character-based
  - target max: `6.0 cps`
  - warn: `7.0 cps`
  - fail: `10.0 cps`
- English
  - unit: word-based
  - target max: `3.0 wps`
  - warn: `3.5 wps`
  - fail: `4.5 wps`

補足:

- exact threshold は `runtime/render-pipeline-defaults.yaml` の packaging policy で上書き可能にする。
- opening / closing など stage-aware な微調整は metadata に残してよいが、M4 の hard gate は language baseline を優先する。

### SpeechCaption Source Generation

SpeechCaption draft は transcript connector ではなく、separate deterministic packaging engine で生成する。

理由:

- M2 の STT migration path (OpenAI -> Groq + pyannote) に追従しやすい。
- transcript artifact shape を固定したまま caption generation rule を差し替えられる。
- STT connector を caption-specific policy で汚さない。

入力:

- `05_timeline/timeline.json`
- `03_analysis/transcripts/TR_<asset_id>.json`
- `caption_policy`
- optional `human_notes.yaml`

生成アルゴリズム:

1. A1 dialogue clip を source order で走査する。
2. 各 clip の `asset_id`, `src_in_us`, `src_out_us` と overlap する transcript item を拾う。
3. transcript item を timeline time に写像する。
4. 以下の優先順で caption unit に切る。
   - consecutive item gap >= `500 ms`
   - sentence-ending punctuation (`。！？.!?`)
   - max CPS を超える
   - language-specific orphan rule
     - Japanese: 行頭助詞回避
     - English: orphaned short function word 回避
5. 各 unit に minimum dwell time を適用する。
   - next unit と重ならない範囲で end を延長してよい
6. `caption_source.json` に provenance, CPS, dwell, source item ids を保存する。

保持する知見:

- particle split 回避
- punctuation-aware split
- gap-driven hard split
- readability first, raw utterance fidelity second

`caption_source.json` 例:

```json
{
  "version": "1",
  "project_id": "sample",
  "base_timeline_version": "5",
  "caption_policy": {
    "language": "ja",
    "delivery_mode": "both",
    "source": "transcript",
    "styling_class": "clean-lower-third"
  },
  "speech_captions": [
    {
      "caption_id": "SC_0001",
      "asset_id": "A_001",
      "segment_id": "SG_0042",
      "timeline_in_frame": 144,
      "timeline_duration_frames": 38,
      "text": "本当にびっくりしました。",
      "transcript_ref": "TR_A_001",
      "transcript_item_ids": ["TRI_A_001_0007", "TRI_A_001_0008"],
      "source": "transcript",
      "styling_class": "clean-lower-third",
      "metrics": {
        "cps": 5.2,
        "dwell_ms": 1580
      }
    }
  ],
  "text_overlays": []
}
```

### TextOverlay Design

TextOverlay は transcript 由来ではなく、authored source を前提にする。

想定用途:

- タイトル
- chapter card
- date / location
- credits
- vertical poetic insert

`text_overlays[]` item:

- `overlay_id`
- `timeline_in_frame`
- `timeline_duration_frames`
- `text`
- `styling_class`
- `writing_mode`
  - `horizontal_tb`
  - `vertical_rl`
- `anchor`
  - `top_left | top_center | top_right | center | bottom_left | bottom_center | bottom_right`
- optional `safe_area`
- `source`
  - `authored`

vertical writing support は `TextOverlay` に限定して始める。SpeechCaption には M4 では縦書きを適用しない。

### Editorial Approval Workflow

M4 の caption workflow は 2 段階で固定する。

1. source generation
   - engine が `caption_source.json` と auto sidecar (`speech.auto.srt`) を生成する
2. editorial approval
   - operator が内容 / line break / omission / overlay placement を確認し、
     `caption_approval.json` を確定する

`caption_approval.json` は `caption_source.json` の approved projection とし、少なくとも以下を持つ。

- `version`
- `project_id`
- `base_timeline_version`
- `caption_policy`
- `speech_captions`
- `text_overlays`
- `approval`
  - `status: approved | stale`
  - `approved_by`
  - `approved_at`

stale 条件:

- approved timeline snapshot changed
- `caption_policy` changed
- source transcript hash changed

用語:

- `base_timeline_version` は approved `timeline.json.version` をそのまま写した canonical timeline identity である。
- `editorial_timeline_hash` は同じ version 上の editorial surface hash であり、stale/self-heal は hash を見る。
- `project_state.artifact_hashes.timeline_version` は legacy file-hash slot であり、M4 では base identity に使わない。

### `timeline.json` Integration

compiler は `caption_approval.json` を読み、`timeline.json` へ以下を additive に投影する。

- `tracks.caption`
  - `track_id: C1`
  - SpeechCaption clips
- `tracks.overlay`
  - `track_id: O1`
  - TextOverlay clips

SpeechCaption clip mapping:

- `kind: caption`
- `role: dialogue`
- `asset_id`, `segment_id`, `src_in_us`, `src_out_us`
  - source dialogue regionを継承
- `metadata.caption`
  - `caption_id`
  - `text`
  - `language`
  - `delivery_mode`
  - `source`
  - `styling_class`
  - `transcript_ref`
  - `transcript_item_ids`
  - `metrics`

TextOverlay clip mapping:

- `kind: overlay`
- `role: title`
- `asset_id: "__overlay__"`
- `segment_id: "TXT_<overlay_id>"`
- `src_in_us: 0`
- `src_out_us: duration_us`
- `metadata.overlay`
  - `overlay_id`
  - `text`
  - `styling_class`
  - `writing_mode`
  - `anchor`
  - `safe_area`
  - `source`

この投影により `timeline.json` は render manifest の sole timeline input でいられる。

補足:

- compiler は `timeline.version` を維持したまま packaging plane を再投影する。
- `base_timeline_version` は常にその `timeline.version` と一致させる。
- packaging-specific freshness は `packaging_projection_hash` で追跡する。

## Audio Design

### Goals

M4 audio plane の責務は以下である。

- A1 dialogue / nat sound を editorial timing どおりに維持する
- A2 BGM cue を machine-readable に固定する
- ffmpeg post で ducking / fade / mastering / loudnorm 2-pass を行う
- `raw_dialogue.wav` と `final_mix.wav` を stable stem として残す

### `music_cues.json` Contract

`edit_blueprint.yaml.music_policy` は coarse intent に留め、M4 では packaging plane 用に
`music_cues.json` を追加する。

理由:

- `music_policy` は「どこから入れてよいか」の方針であり、最終 cue timing や ducking envelope までは持たない。
- A2 track の render / QA / batch automation には exact timing contract が必要である。

shape:

```json
{
  "version": "1",
  "project_id": "sample",
  "base_timeline_version": "5",
  "music_asset": {
    "asset_id": "MUSIC_001",
    "path": "inputs/music/theme.wav",
    "source_hash": "sha256:...",
    "analysis_ref": "07_package/audio/bgm-analysis.json"
  },
  "cues": [
    {
      "cue_id": "MC_0001",
      "track_id": "A2",
      "entry_window": {
        "earliest_frame": 96,
        "latest_frame": 144,
        "basis": "beat:b02"
      },
      "entry_frame": 120,
      "exit_frame": 864,
      "fade_in_ms": 400,
      "fade_out_ms": 900,
      "ducking": {
        "base_gain_db": -16.0,
        "duck_gain_db": -24.0,
        "attack_ms": 80,
        "release_ms": 180
      },
      "beat_sync": {
        "enabled": true,
        "analysis_ref": "07_package/audio/bgm-analysis.json#/downbeats",
        "align": "entry"
      }
    }
  ]
}
```

最低 contract:

- `music_asset`
- `cue_id`
- `entry_window`
- `entry_frame`
- `exit_frame`
- `fade_in_ms`
- `fade_out_ms`
- `ducking`
- optional `beat_sync`

用語:

- `base_timeline_version` は approved `timeline.json.version` を指す canonical timeline identity である。

### A2 Track Population

compiler は `music_cues.json` を読んで `tracks.audio` の `A2` を materialize する。

A2 clip:

- `track_id: A2`
- `kind: audio`
- `role: music`
- `asset_id: music_asset.asset_id`
- `segment_id: cue_id`
- `timeline_in_frame: entry_frame`
- `timeline_duration_frames: exit_frame - entry_frame`
- `metadata.music_cue`
  - `cue_id`
  - `entry_window`
  - `fade_in_ms`
  - `fade_out_ms`
  - `ducking`
  - `beat_sync`

`audio_policy` の使い分け:

- A1 dialogue clip
  - `duck_music_db`
  - short fade in/out
- A2 music clip
  - exact cue / fade / beat refs は `metadata.music_cue`

### Responsibility Split

M4 では音声責務を以下に固定する。

- Remotion
  - A1 dialogue / nat sound の timeline placement
  - short fade in/out
  - no mastering
  - no BGM ducking judgment
- ffmpeg
  - demux
  - BGM mix
  - ducking
  - fade in/out on music layer
  - loudnorm 2-pass
  - final mux

この split は `Only engines render` と `Only compiler mutates timeline.json` を守りつつ、
signal processing を ffmpeg 側へ隔離するためである。

### Ducking And Beat Sync

基本ルール:

- 発話中は BGM ducking
- pause / afterglow window は BGM を少し戻す
- `audio_mode=voice-first` 相当の挙動を default とする
- beat sync は cue entry / ending / major motion reference に限定する

M4 phase-in:

- Phase 1
  - speech / pause の 2 段階 ducking
  - entry / exit fade
- Phase 2
  - beat-aware cue entry
  - ending sync
  - optional chapter break cue

### Loudnorm And Stem Contract

mastering default:

- loudness target: `-16 LUFS`
- LRA target: `7`
- true peak target: `-1.5 dBTP`
- ffmpeg `loudnorm` 2-pass を使う

stem contract:

- `raw_dialogue.wav`
  - assembly demux で得る unmixed dialogue stem
- `final_mix.wav`
  - ducking + mastering 後の final audio stem

M4 では `raw_bgm.wav` は必須にしない。必要になれば M5 以降で additive に追加する。

## Remotion Rendering Design

### Composition Ownership

`VideoTimeline.tsx` は M4 の assembly composition であり、少なくとも以下を持つ。

- V1 / V2 video clip placement
- transition / fade_to_black 等の visual timing
- TextOverlay rendering
- A1 dialogue / nat sound placement
- optional preview-only SpeechCaption layer

Remotion が持たないもの:

- BGM mix
- ducking
- mastering
- loudnorm
- final mux decision

### Engine Render Path

`engine_render` path は以下で固定する。

1. compiler projects packaged timeline
   - base `timeline.json`
   - `caption_approval.json`
   - `music_cues.json`
2. Remotion assembly
   - output: `07_package/video/assembly.mp4`
3. demux
   - `assembly.mp4 -> raw_video.mp4 + raw_dialogue.wav`
4. caption burn
   - if `caption_policy.delivery_mode in {burn_in, both}`
   - `raw_video.mp4 + speech.approved.srt -> captioned_video.mp4`
   - else skip and use `raw_video.mp4`
5. audio master
   - `raw_dialogue.wav + optional music_cues.json + bgm-analysis.json -> final_mix.wav`
   - no-BGM path でも pass-through mastering を実行し、`final_mix.wav` を常に出す
6. package
   - `captioned_video.mp4(or raw_video.mp4) + final_mix.wav -> final.mp4`
   - emit sidecar subtitle when `delivery_mode in {sidecar, both}`
   - emit `package_manifest.json`

### Render Pipeline Defaults

`runtime/render-pipeline-defaults.yaml` では phase ごとに provider, input, output, skip condition を持つ。

想定 phase:

- `assembly`
  - provider: `remotion`
  - skip: never on `engine_render`
- `caption_burn`
  - provider: `ffmpeg`
  - skip:
    - `caption_policy.source == none`
    - `delivery_mode == sidecar`
- `audio_master`
  - provider: `ffmpeg`
  - skip: never on `engine_render`
  - no `music_cues` path では `raw_dialogue.wav -> final_mix.wav` の pass-through mastering を行う
- `package`
  - provider: `ffmpeg`
  - skip: never on `engine_render`

各 phase は log, output hash, tool version を manifest に残す。

### `nle_finishing` Path

`nle_finishing` path では engine render を final truth にしない。

flow:

1. operator が NLE export (`final.mp4`, optional captions) を指定する
2. runtime が `ffprobe` ベースで container, streams, duration delta, checksum, caption sidecar completeness を検証する
3. primary audio stream を一時抽出し、`nle_finishing` QA profile で loudness / supplied A/V sync を測定する
4. `qa-report.json` を生成する
5. `package_manifest.json` に NLE export を final artifact として記録する

この path では Remotion assembly, ffmpeg audio master, caption burn を実行しない。engine timeline と
caption / music artifacts は provenance と validation reference に留める。

## Source Of Truth Declaration (Gate 10)

### Rule

Gate 10 は `project_state.yaml.handoff_resolution` でのみ管理する。export-time manifest や runtime flag を
truth source にしない。

required shape は M3.5 を引き継ぐ。

```yaml
handoff_resolution:
  handoff_id: HND_0005_20260321T103000Z
  status: decided
  source_of_truth_decision: engine_render | nle_finishing
  decided_by: operator
  decided_at: 2026-03-21T12:20:00Z
  basis_report_hashes:
    roundtrip_import_report: sha256:...
    human_revision_diff: sha256:...
```

### `engine_render`

- final truth は engine-produced `final.mp4`
- imported NLE diff は advisory
- NLE edit を採用したい場合は canonical artifact に再表現し、compile / package を再実行する

### `nle_finishing`

- final truth は operator-provided NLE export
- engine `timeline.json` は editorial provenance と QA reference に残る
- packaged state では NLE export が `package_manifest.json.artifacts.final_video` になる

### Project State Implication

`status == decided` でない限り `packaging_gate` は `blocked` とする。

- Gate 10 decision は `qa-report.json` と `package_manifest.json` の前に固定する。
- `handoff_resolution.source_of_truth_decision` が変わった場合、既存 `qa_report` / `package_manifest` は stale とみなし
  `current_state` を `approved` に戻す。

`packaged` は source-of-truth agnostic な terminal state だが、`package_manifest.json.source_of_truth` に
必ず mirror する。

## QA Contract

### Goals

M4 QA は「レンダーできたか」ではなく「delivery truth として accept できるか」を判定する。
`qa-report.json.passed` は、Gate 10 で選ばれた QA profile の hard check がすべて成功したときのみ `true` になる。

hard check profile は source of truth ごとに固定する。

- `engine_render`
  - `timeline_schema_valid`
  - `caption_policy_valid`
  - `caption_density_valid`
  - `caption_alignment_valid`
  - `dialogue_occupancy_valid`
  - `av_drift_valid`
  - `loudness_target_valid`
  - `package_completeness_valid`
- `nle_finishing`
  - `timeline_schema_valid`
  - `caption_policy_valid`
  - `supplied_export_probe_valid`
  - `caption_delivery_valid`
  - `supplied_av_sync_valid`
  - `loudness_target_valid`
  - `package_completeness_valid`

`nle_finishing` profile は `dialogue_occupancy` や transcript-level caption alignment を hard check にしない。
それらは engine-produced stems を前提にした metric であり、NLE export path では operator sign-off と
Gate 10 declaration が quality owner になる。

### Structural Checks

- `timeline_schema_valid`
  - input artifact: `timeline.json`
  - pass 条件: current `timeline.json` が active schema + validator rule を通る
  - failure details format: `schema_error=<pointer>`
- `caption_policy_valid`
  - input artifact: `caption_policy`, `caption_approval.json`
  - pass 条件:
    - `source in {transcript, authored, none}`
    - `source == none` の場合は `speech_captions[]` が空
    - `source != none` の場合は `delivery_mode in {burn_in, sidecar, both}`
  - failure details format: `field=<name> reason=<reason>`
- `supplied_export_probe_valid`
  - input artifact: supplied final export
  - pass 条件:
    - allowed container は `mp4 | mov`
    - video stream がちょうど 1 本
    - primary audio stream が 1 本以上
    - `duration_ms > 0`
    - checksum が manifest 記録値と一致
  - failure details format: `probe_field=<name> value=<value>`
- `caption_delivery_valid`
  - input artifact: supplied captions or generated sidecar
  - pass 条件:
    - `caption_policy.source == none` なら captions 不要
    - `delivery_mode in {sidecar, both}` かつ `source != none` なら parseable sidecar が必須
    - `delivery_mode == burn_in` の場合は sidecar 不要
  - failure details format: `delivery_mode=<mode> missing=<artifact>`

### Post-render Metrics

#### 1. `caption_density_valid`

input artifact:

- `caption_approval.json.speech_captions[]`

定義:

- Japanese: `density = visible_characters / duration_seconds`
- English: `density = visible_words / duration_seconds`
- no overlap
- no negative duration

hard fail:

- Japanese で `density > 10.0 cps`
- English で `density > 4.5 wps`
- overlap あり
- `duration_ms <= 0`

failure details format:

- `caption_id=<id> density=<value> threshold=<threshold> unit=<cps|wps>`

#### 2. `caption_alignment_valid`

input artifact:

- `caption_approval.json.speech_captions[]`
- `timeline.json.tracks.audio.A1`
- `TR_*.json` when `caption_policy.source == transcript`

定義:

- `source == transcript`
  - `transcript_item_ids` が 1 件以上
  - `alignment_overlap_ratio = overlap_ms(caption_interval, transcript_union_interval) / caption_duration_ms`
  - pass 条件は `alignment_overlap_ratio >= 0.50`
- `source == authored`
  - speech caption interval が A1 dialogue clip と `>= 1 frame` overlap する

hard fail:

- required reference が空
- overlap ratio が threshold 未満
- caption が dialogue clip 群から完全に外れる

failure details format:

- `caption_id=<id> overlap_ratio=<value> threshold=0.50 source=<source>`

#### 3. Dialogue Occupancy

目的:

- dialogue stem が落ちていないか
- ducking / mix で speech が実質消えていないか

定義:

- expected windows: A1 dialogue clip の timeline interval
- observed signal: `raw_dialogue.wav` の non-silent interval
- `dialogue_occupancy_ratio = observed_non_silent_ms_within_expected / expected_dialogue_window_ms`

hard fail:

- expected dialogue があるのに `raw_dialogue.wav` が空
- ratio が floor 未満

初期 floor:

- `0.65`

failure details format:

- `ratio=<value> floor=0.65`

#### 4. `av_drift_valid` / `supplied_av_sync_valid`

目的:

- demux / mux / sample-rate conversion 由来のズレ検出

定義:

- `engine_render`
  - `raw_video.mp4.duration_ms` と `final_mix.wav.duration_ms` の差分
  - optional anchor-based cross-correlation で `raw_dialogue.wav` と muxed final audio の offset を測る
- `nle_finishing`
  - supplied final の video stream duration と primary audio stream duration の差分を `ffprobe` で測る

hard fail:

- duration delta > `1 frame`
- `engine_render` で anchor offset > `40 ms`

failure details format:

- `delta_ms=<value> threshold_ms=<value>`

#### 5. `loudness_target_valid`

input artifact:

- `engine_render`: `final_mix.wav`
- `nle_finishing`: supplied final から抽出した primary audio stream

定義:

- integrated loudness target: `-16 LUFS`
- pass band: `-17.0 <= integrated_lufs <= -15.0`
- true peak target: `<= -1.5 dBTP`

hard fail:

- LUFS が pass band 外
- true peak が上限超過

failure details format:

- `integrated_lufs=<value> lower=-17.0 upper=-15.0 true_peak_dbtp=<value>`

#### 6. `package_completeness_valid`

required artifact matrix:

- `engine_render`
  - always: `final_video`, `raw_video`, `raw_dialogue`, `final_mix`, `qa_report`
  - `caption_policy.delivery_mode in {sidecar, both}` かつ `caption_policy.source != none` の場合は sidecar captions
- `nle_finishing`
  - always: `final_video`, `qa_report`
  - `caption_policy.delivery_mode in {sidecar, both}` かつ `caption_policy.source != none` の場合は supplied sidecar captions
  - `raw_video`, `raw_dialogue`, `final_mix` は required にしない

hard fail:

- selected profile の required artifact が 1 件でも欠ける
- manifest hash と実ファイル hash が不一致

failure details format:

- `missing=<artifact_name>` または `hash_mismatch=<artifact_name>`

### Caption QA

SpeechCaption:

- no overlap
- no negative duration
- CPS below fail threshold
- transcript-backed item overlap present when `source == transcript`

TextOverlay:

- valid `writing_mode`
- valid `anchor`
- no screen-outside safe area placement

### `qa-report.json` Shape

`qa-report.json` は canonical machine report とし、少なくとも以下を持つ。

```json
{
  "version": "1",
  "project_id": "sample",
  "source_of_truth": "engine_render",
  "qa_profile": "engine_render",
  "passed": true,
  "checks": [
    {"name": "caption_density_valid", "passed": true, "details": "caption_id=SC_0001 density=5.2 threshold=10.0 unit=cps"},
    {"name": "caption_alignment_valid", "passed": true, "details": "caption_id=SC_0001 overlap_ratio=0.88 threshold=0.50 source=transcript"},
    {"name": "dialogue_occupancy_valid", "passed": true, "details": "ratio=0.82 floor=0.65"},
    {"name": "av_drift_valid", "passed": true, "details": "delta_ms=8 threshold_ms=41"},
    {"name": "loudness_target_valid", "passed": true, "details": "integrated_lufs=-15.9 lower=-17.0 upper=-15.0 true_peak_dbtp=-1.8"},
    {"name": "package_completeness_valid", "passed": true, "details": "missing=none"}
  ],
  "metrics": {
    "caption_max_density": 5.2,
    "dialogue_occupancy_ratio": 0.82,
    "av_drift_ms": 8,
    "integrated_lufs": -15.9,
    "true_peak_dbtp": -1.8
  },
  "artifacts": {
    "final_video": "07_package/video/final.mp4",
    "final_mix": "07_package/audio/final_mix.wav"
  }
}
```

`qa-report.md` は human-readable projection とする。

## Operational Requirements

### Reliability

- Remotion / ffmpeg / fonts / style preset のいずれかが欠けた場合は fail-closed とし、placeholder render で
  `packaged` に進めない。
- `cleanup_intermediates` は default `false` で始める。
  - packaged acceptance 後にのみ cleanup を許可する。
- phase log は step ごとに分離して保存する。

### Determinism

- `package_manifest.json.provenance` の minimum required field は path ごとに固定する。
  - `engine_render`: `editorial_timeline_hash`, `ffmpeg_version`, `remotion_bundle_hash`, `render_defaults_hash`
  - `nle_finishing`: `editorial_timeline_hash`, `handoff_id`, `ffmpeg_version`, `render_defaults_hash`
- sidecar subtitle の serialization order は stable にする。
- `caption_source.json`, `caption_approval.json`, `music_cues.json` は source order / id order を deterministic に保つ。

### Render Lane Baseline

- default CI は既存 baseline に合わせて `validate`, `test`, `build` の non-render suite のみを回す。
- render を含む integration / e2e は dedicated render lane に分離する。
- dedicated render lane は以下を phase 0 で固定する。
  - single pinned Node major (`22.x`)
  - exact Remotion version pin
  - single ffmpeg install source (`ffmpeg 7.x` baked runner image)
  - project font bundle provisioning
  - fixture media cap (`<= 30s`, `<= 1080p`, audio tracks <= 2)
- `package_manifest.json.provenance` に残る version fingerprint は dedicated render lane の前提と一致していなければならない。

### Performance

- M4 は production wall-clock 最適化を主眼にしないが、short fixture render は pinned CI runner 上で完走できる
  設定に保つ。
- phase split により `caption_burn`, `audio_master`, `package` は individual rerun を可能にし、full rerender を
  常に要求しない。

### Security / Trust Boundary

- imported NLE export の metadata や container tags を code execution に使わない。
- agent は raw ffmpeg command string を canonical artifact に保存しない。
- `styling_class` は whitelist された preset 名のみ許可し、任意 CSS / filter graph を直接受け入れない。

## Test Strategy

### Caption Generation Tests

unit:

- mock transcript -> SpeechCaption segmentation
- punctuation split
- gap split
- Japanese particle guard
- English orphan word guard
- CPS calibration by language
- minimum dwell extension without overlap

integration:

- `caption_source.json -> caption_approval.json -> timeline.json`
- `delivery_mode = burn_in | sidecar | both`
- `source = transcript | authored`

### Audio Pipeline Tests

unit:

- `music_cues.json` normalization
- entry window validation
- beat reference validation
- ducking envelope builder
- loudnorm 2-pass command assembly

integration:

- short fixture WAV + cue -> `final_mix.wav`
- no-BGM path still emits `final_mix.wav` via pass-through mastering
- BGM path / voice-only path の両方で loudness oracle が一致する

### Remotion Render Tests

integration:

- short fixture `timeline.json` -> `assembly.mp4`
- TextOverlay horizontal / vertical
- dialogue audio placement
- demux creates `raw_video.mp4` + `raw_dialogue.wav`

e2e:

- approved sample project -> packaged final mp4
- `caption_burn` skipped on sidecar-only project
- `nle_finishing` path validates supplied final without running assembly
- Gate 10 decision flip invalidates old `qa-report.json` / `package_manifest.json`

### QA Contract Tests

unit:

- `dialogue_occupancy` metric
- `av_drift` metric
- caption density and alignment oracle
- package completeness
- profile selection by `handoff_resolution.source_of_truth_decision`

integration:

- packaging run emits `qa-report.json` + `qa-report.md`
- `passed=false` prevents `packaged` transition
- `nle_finishing` profile accepts supplied final without requiring `raw_dialogue.wav` / `final_mix.wav`

### Manual Smoke

- Japanese interview fixture with SpeechCaption burn-in
- vertical credit / title overlay fixture
- BGM entry aligned to beat-aware cue
- one `nle_finishing` sample with supplied export

## Risks And Mitigations

### 1. Speech burn-in ownership mismatch

risk:

- preview と final burn-in の見た目がズレる

mitigation:

- preview-only SpeechCaption layer は optional にし、canonical burn source は approved SRT/VTT だけにする
- burn-in golden fixture を持つ

### 2. Overlay clip の synthetic source fields が awkward

risk:

- future consumer が overlay の `asset_id="__overlay__"` を誤って media source と扱う

mitigation:

- `metadata.overlay` presence で kind-specific branch を明示する
- synthetic namespace を予約文字列で固定する
- schema v2 redesign は M4 scope 外として明記する

### 3. audio drift / mastering regressions

risk:

- demux / mux で最終納品にズレが入る

mitigation:

- `raw_dialogue.wav`, `final_mix.wav`, `raw_video.mp4` を常に保存する
- QA に duration delta と anchor drift を入れる
- tool version を manifest に残す

### 4. caption approval 運用が重い

risk:

- operator が draft / approval artifact を二重管理して混乱する

mitigation:

- `caption_source.json` は draft-only、`caption_approval.json` は approved-only で意味を分ける
- approval artifact に `base_timeline_version` を必須化する

### Rollback / Fail-closed

- Remotion assembly failure 時は package を確定しない
- `qa-report.json.passed=false` の場合は `current_state` を `approved` のまま維持する
- `nle_finishing` path へ勝手に fallback しない

## Implementation Order

### Phase 0. Contract Freeze

やること:

- new schema 草案
- `07_package/` layout 固定
- `project_state` additive field 設計
- `render-pipeline-defaults.yaml` 草案
- render lane baseline の固定

達成条件:

- schema list と directory layout が固定される
- `packaging_gate` 条件が文章で矛盾なく定義される
- `base_timeline_version` / `editorial_timeline_hash` / `packaging_projection_hash` の役割分担が固定される

### Phase 1. Caption Source + Approval

やること:

- `caption_source.json` generator
- `caption_approval.json` schema / validator
- `caption_policy` normalization
- language calibration defaults

達成条件:

- mock transcript から stable caption draft が出る
- approval artifact が stale 判定込みで validate できる

### Phase 2. Timeline Projection

やること:

- compiler が `caption_approval.json` を読んで `tracks.caption` / `tracks.overlay` を出す
- overlay synthetic ID rule 実装
- A2 cue projection の準備

達成条件:

- schema-valid `timeline.json` に caption / overlay track が materialize される
- existing M3 reader が unknown metadata を無視して動く

### Phase 3. Music Cue + Audio Master

やること:

- `music_cues.json`
- A2 track population
- ffmpeg demux / mix / duck / loudnorm 2-pass
- stem output

達成条件:

- short fixture で `final_mix.wav` が生成できる
- no-BGM path / BGM path の両方が deterministic に通る

### Phase 4. Remotion Assembly + Source-Of-Truth Branching

やること:

- `VideoTimeline.tsx`
- `render_manifest.json`
- `assembly.mp4`
- `caption_burn`
- final mux
- `nle_finishing` validation branch
- Gate 10 に応じた required artifact matrix の切り替え
- `package_manifest.json`

達成条件:

- `engine_render` path で `final.mp4` が生成できる
- sidecar-only path で caption_burn が skip される
- `nle_finishing` path の required artifact set が確定する

### Phase 5. QA + State Transition

やること:

- `qa-report.json` / `.md`
- path-specific QA profile
- `dialogue_occupancy` / `av_drift` / `loudness_target` / `package_completeness`
- `packaging_gate`
- `approved -> packaged`

達成条件:

- failing QA で `packaged` に進まない
- passing QA で `packaged` に進む
- `handoff_resolution` change で `qa_report` / `package_manifest` が stale になる

### Phase 6. M5 Prep

やること:

- batch-ready package entrypoint 整理

達成条件:

- M5 が headless に再利用できる packaging entrypoint が固まる

## Final Notes

M4 の本質は「Remotion を入れること」そのものではない。`approved` な editorial truth に対して、
caption / music / mastering / package QA を artifact contract 化し、Gate 10 の source-of-truth decision を
壊さずに `packaged` state まで持っていくことが本体である。

したがって M4 実装では、次の順序を崩さない。

1. artifact contract を先に固定する
2. caption / music の approval or exact timing artifact を作る
3. compiler で `timeline.json` へ投影する
4. render engine はその投影結果だけを実行する
5. QA と `project_state` で packaged truth を確定する
