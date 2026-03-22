# VLM Peak Detection + Interest Point 活用 設計

- Status: Draft
- Updated: 2026-03-22
- Target: M2 analysis -> M4.5 triage/compiler の additive 拡張
- Non-goal: 本書ではコード実装は行わない

## 1. 目的

VLM の役割を「summary / tags を付ける」から「映像のピークを秒単位で検出し、そのピークを selects の `src_in_us / src_out_us` と compiler の trim / score に反映する」に引き上げる。

狙いは次の 4 点である。

1. `segments.json.interest_points[]` を triage と compiler の両方で実際に使う。
2. `trim.ts` の center-based trim を midpoint fallback ではなく peak-centered にする。
3. `/triage` の candidate window を agent の手作業依存から、peak-aware な半自動生成へ寄せる。
4. VLM 単独の曖昧さを ffmpeg ベースの motion と optional audio support で補強し、誤検出時は fail-open する。

## 2. 成功条件

以下を満たした時点を本設計の成功とみなす。

- peak 情報を持つ candidate の大半で `trim_hint.source_center_us` が midpoint ではなく peak 由来になる。
- `/triage` が peak を持つ segment から candidate を作るとき、`src_in_us / src_out_us` は peak 周辺の safety window になり、`trim_hint` に preferred/min/max が入る。
- `score.ts` が peak を持つ candidate に候補依存の bonus を与え、全候補同一 bonus の no-op を解消する。
- `trim.ts` が resolved trim を peak 中心で出し、`timeline.json.clip.metadata.trim` に provenance を残す。
- peak signal が欠損しても、現行の fixed authored range + midpoint fallback で compile が継続する。

## 3. スコープ

### In Scope

- `runtime/connectors/gemini-vlm.ts` の prompt / response / normalization 設計
- `segments.json` への additive な peak 情報の保持
- `/triage` による peak-aware candidate window 生成
- `runtime/compiler/score.ts` と `runtime/compiler/trim.ts` の peak 連携
- ffmpeg 補助信号の設計
- unit / integration / E2E test 戦略
- rollout phase と rollback 方針

### Out Of Scope

- 新しい ranking model や学習ベース reranker の導入
- timeline reviewer / critic の prompt 改修
- UI での peak 可視化
- provider 固有 SDK 実装詳細

## 4. 現状整理

### 4.1 既存 contract で使えるもの

- `segments.json.interest_points[]` は既に存在し、required shape は `{ frame_us, label, confidence }`
- M2 は asset-level の `03_analysis/contact_sheets/*.png` と manifest `tile_map[]` を既に生成している
- M2 は segment-level の `03_analysis/filmstrips/*.png` を既に生成している
- `media.open_contact_sheet(mode: "overview")` と `media.peek_segment.filmstrip_path` で既存 artifact を開ける
- `selects_candidates.yaml` には `trim_hint` と `editorial_signals` の additive 拡張余地がある
- `trim.ts` には center-based trim の器がある
- `candidate_ref` / `fallback_candidate_refs` は timeline clip に残る
- compiler は `selects_candidates.yaml` のみを入力にし、remote API を呼ばない

### 4.2 現状のギャップ

1. `gemini-vlm.ts` の prompt が generic summary 中心で、peak detection を頼んでいない。
2. coarse discovery が M2 の `contact_sheets/*.png` を主入力にしておらず、asset 全体俯瞰を活かせていない。
3. refine pass が `filmstrips/*.png` を主入力にしておらず、segment 内の 6-tile 比較を contract 化できていない。
4. coarse pass に exact timestamp を要求しており、入力解像度と期待精度が噛み合っていない。
5. `trim.ts` のコメントには `interest point` fallback があるが、実装は `trim_hint.source_center_us` が無ければ midpoint fallback である。
6. `score.ts` は peak 有無を見ず、skill bonus も候補依存になっていない。
7. `/triage` は peak 情報を明示的に前提にしておらず、candidate window が手作業寄りである。
8. `normalize.ts` は `story_role` / `skill_hints` を `NormalizedBeat` に落としておらず、score / trim が beat 文脈を失っている。
9. trim 後の metadata 再付与が `segment_id + src_in/out` 依存のままだと、resolved trim 後に exact match を失いやすい。
10. peak-specific confidence / provenance の置き場が未整理で、closed schema を壊す危険がある。

## 5. 設計原則

### 5.1 Additive First

- 既存 field は維持する。
- 新 field 不在時は現行 path を使う。
- `segments.schema.json` の `interest_points` required shape は壊さない。

### 5.2 Progressive Resolution

- Pass 1 は asset-level contact sheet を見て coarse 候補区間を絞る。
- Pass 2 は segment-level filmstrip を見て peak center を特定する。
- Pass 3 は policy で有効な場合のみ高密度 sampling で in/out を詰める。
- coarse pass は ranking と narrowing の責務に徹し、exact timestamp を canonicalize しない。

### 5.3 Provider Response と Canonical Artifact を分離する

- VLM provider には richer response を要求してよい。
- canonical artifact には downstream が使う最小 machine-readable surface のみ残す。
- coarse pass の tile 候補は ephemeral であり、`segments.json` に直接昇格しない。
- exact `timestamp_us` と `recommended_in_out` は refine / precision 後にのみ canonicalize する。

### 5.4 Compiler は `selects_candidates.yaml` だけを見る

- compiler は `segments.json` を再読しない。
- peak の canonical handoff は `/triage` が `trim_hint` と `editorial_signals` に materialize する。

### 5.5 Fail Open

- peak data が無い、または confidence が低い時は authored range / midpoint に戻す。
- VLM と ffmpeg support signal が矛盾する場合は confidence を下げるが hard fail しない。

### 5.6 Strict Schema Safe + Deterministic

- peak fusion、window derivation、score bonus、trim bias は deterministic rule で行う。
- peak-specific prompt hash / fusion version / support signal version は `peak_analysis.provenance` または
  `clip.metadata` に残し、既存の root `confidence` / `provenance` / `timelineIR.provenance` には足さない。
- 新しい strict subtree は schema 上で明示し、`additionalProperties: false` を維持する。
- `timeline.json` への peak reflection は既存 extension point である `clip.metadata` を使う。

## 6. End-to-End Data Flow

```text
M2 ingest / analysis
  -> contact_sheets/*.png + manifest tile_map[] (asset-level)
  -> filmstrips/*.png (segment-level)
  -> Pass 1 coarse VLM
     - input: contact_sheet(mode="overview")
     - output: coarse_tile_candidates[] (ephemeral, tile indices only)
  -> deterministic tile -> segment mapping
  -> Pass 2 refine VLM
     - input: filmstrip + tile_map
     - output: exact peak center + recommended window
  -> Pass 3 precision VLM/local search (conditional)
     - input: dense frames or proxy clip around refine peak
     - output: tightened peak center + final in/out
  -> segments.json
     - interest_points[]
     - peak_analysis (new, optional, strict subtree)
  -> /triage helper
     - peak-aware candidate proposals
     - trim_hint + editorial_signals
  -> selects_candidates.yaml
  -> compiler score / assemble / trim
     - peak salience bonus
     - candidate_ref preserved
     - center = trim_hint.source_center_us
     - asymmetry = peak_type + beat story_role + active skill
  -> timeline.json
     - clip.metadata.trim
     - clip.metadata.editorial.peak
```

## 7. Canonical Artifact 設計

## 7.1 `segments.json` additive extension

`interest_points[]` はそのまま残し、machine-use 向けに optional `peak_analysis` を追加する。
ただし root `confidence` と root `provenance` には peak-specific key を追加しない。

提案 shape:

```json
{
  "interest_points": [
    {
      "frame_us": 4820000,
      "label": "action_peak: runner launches forward",
      "confidence": 0.88
    }
  ],
  "peak_analysis": {
    "coarse_locator": {
      "contact_sheet_id": "OV_AST_007_01",
      "tile_start_index": 12,
      "tile_end_index": 14,
      "coarse_window_start_us": 3600000,
      "coarse_window_end_us": 6200000
    },
    "peak_moments": [
      {
        "peak_ref": "SEG_0143@4820000",
        "timestamp_us": 4820000,
        "type": "action_peak",
        "confidence": 0.89,
        "description": "runner launches from the blocks",
        "source_pass": "refine_filmstrip"
      }
    ],
    "recommended_in_out": {
      "best_in_us": 3720000,
      "best_out_us": 5480000,
      "rationale": "preserve anticipation and first acceleration step",
      "source_pass": "refine_filmstrip"
    },
    "visual_energy_curve": [
      { "timestamp_us": 3600000, "energy": 0.34, "source": "motion" },
      { "timestamp_us": 4200000, "energy": 0.72, "source": "motion" },
      { "timestamp_us": 4800000, "energy": 0.94, "source": "fused" }
    ],
    "support_signals": {
      "motion_support_score": 0.91,
      "audio_support_score": 0.22,
      "fused_peak_score": 0.89
    },
    "provenance": {
      "coarse_prompt_template_id": "m2-asset-peak-coarse-v2",
      "refine_prompt_template_id": "m2-segment-peak-refine-v2",
      "precision_mode": "not_run",
      "fusion_version": "peak-fusion-v1",
      "support_signal_version": "motion-v1"
    }
  }
}
```

設計意図:

- 旧 consumer は `interest_points[]` だけ見ても意味を失わない。
- 新 consumer は `peak_analysis` を使って peak type、recommended window、energy を読める。
- `peak_moments[]` の各要素は `interest_points[]` にも mirror される。
- `coarse_locator` は contact sheet 上の tile 範囲だけを残し、coarse 推定を exact timestamp として扱わない。
- peak-specific confidence / provenance は `peak_analysis` 配下に隔離し、root の strict object を壊さない。
- `peak_analysis` とその nested object は schema 上で closed object として追加する。

### 7.2 `selects_candidates.yaml` additive extension

`trim_hint` と `editorial_signals` を peak-aware に拡張する。

推奨追加 field:

```yaml
trim_hint:
  source_center_us: 4820000
  preferred_duration_us: 1760000
  min_duration_us: 1200000
  max_duration_us: 2400000
  window_start_us: 3400000
  window_end_us: 5700000
  interest_point_label: "action_peak: runner launches forward"
  interest_point_confidence: 0.89
  peak_ref: SEG_0143@4820000
  peak_type: action_peak
  center_source: refine_filmstrip
  rationale: preserve anticipation and first acceleration step

editorial_signals:
  peak_ref: SEG_0143@4820000
  peak_strength_score: 0.89
  motion_energy_score: 0.91
  audio_energy_score: 0.22
  peak_type: action_peak
  peak_source_pass: refine_filmstrip
```

補足:

- `peak_type` / `peak_ref` / `center_source` は `trim_hint` に explicit field として追加する。
- `peak_strength_score` は score 用、`peak_type` は trim bias と type-match 用である。
- `recommended_in_out` を `trim_hint.window_*` と `preferred_duration_us` に materialize するのは
  `fused_peak_confidence >= 0.70` の場合に限る。
- `0.55 - 0.69` の peak は advisory として `source_center_us` / `peak_strength_score` まで使えるが、
  authored window override は行わない。

### 7.3 `timeline.json` additive reflection

`timeline.json.provenance` はこの phase では拡張しない。
peak reflection は既存 extension point である `clip.metadata.trim` と `clip.metadata.editorial.peak` に残す。

`timeline.json.clip.metadata.trim` には次を残す。

```json
{
  "mode": "adaptive_peak_center",
  "center_source": "refine_filmstrip",
  "source_center_us": 4820000,
  "preferred_duration_us": 1760000,
  "resolved_src_in_us": 3760000,
  "resolved_src_out_us": 5520000,
  "interest_point_label": "action_peak: runner launches forward",
  "peak_type": "action_peak",
  "peak_confidence": 0.89,
  "peak_ref": "SEG_0143@4820000"
}
```

`clip.metadata.editorial.peak` には次を残す。

```json
{
  "primary_peak_ref": "SEG_0143@4820000",
  "peak_type": "action_peak",
  "peak_confidence": 0.89,
  "peak_summary": "runner launches from the blocks",
  "source_pass": "refine_filmstrip"
}
```

merge ルール:

- `clip.metadata.trim` は trim phase の専有 namespace とし、trim phase だけが更新する。
- `clip.metadata.editorial` は object 全体を置き換えず、field 単位で deterministic deep merge する。
- peak feature は `clip.metadata.editorial.peak` のみを更新し、既存の `applied_skills` /
  `skill_tags` / `resolved_profile` / `resolved_policy` を上書きしない。
- `editorial.peak` を emit するのは selected candidate が peak を実際に採用し、
  `peak_strength_score >= 0.55` の場合に限る。
- `primary_peak_ref` と `peak_summary` を残すのは `peak_strength_score >= 0.70` かつ
  `trim_hint.center_source` が peak 由来のときに限る。
- lookup は trim 後の src range ではなく `candidate_ref` 基準に切り替える。

## 8. VLM Prompt 強化

## 8.1 Prompt Template ID

- coarse pass: `m2-asset-peak-coarse-v2`
- refine pass: `m2-segment-peak-refine-v2`
- precision pass: `m2-segment-peak-precision-v1`

既存 `m2-segment-v1` は legacy fallback として残す。

## 8.2 Progressive Resolution 設計

frame bundle のみでは高速動作の apex を外しやすいため、peak detection は
`contact_sheet -> filmstrip -> precision` の段階的解像度上昇を標準にする。

### Pass 1: Coarse Peak Discovery

- 入力:
  - asset-level `contact_sheet` (`mode: "overview"`)
  - `tile_map[]` (`tile_index`, `rep_frame_us`)
  - asset / transcript context
- 出力:
  - `coarse_candidates[]`
    - `tile_start_index`
    - `tile_end_index`
    - `likely_peak_type`
    - `confidence`
    - `rationale`
- 対象: 全 asset
- 制約:
  - exact timestamp は要求しない
  - coarse output は canonical artifact に直接昇格しない
  - provider が timestamp を返しても無視し、tile index だけ採用する

Pass 1 のあとで deterministic helper が `tile_index -> rep_frame_us -> overlapping segment_id`
へ写像し、refine 対象 segment を決める。

### Pass 2: Peak Refinement

- 入力:
  - segment-level `filmstrip`
  - `tile_map[]` (`tile_index`, `frame_us`)
  - `src_in_us`, `src_out_us`
  - coarse hint (`tile_start_index`, `tile_end_index`, `likely_peak_type`)
  - `transcript_excerpt`
- 出力:
  - `summary`, `tags`, `interest_points[]`, `quality_flags`
  - single strongest `peak_moment`
  - `recommended_in_out`
  - `visual_energy_curve`
  - raw `peak_confidence.vlm`
- 役割:
  - filmstrip 6 tile の中で最も強い peak を選ぶ
  - 静的シーンと対話シーンは原則ここで止める
  - exact center はこの pass か、必要なら Pass 3 で確定する

### Pass 3: Precision (条件付き)

- 条件:
  - `policy.peak_precision_mode = action_only | always`
  - かつ `segment_type = action | music_driven` または refine uncertainty が高い
- 入力:
  - refine peak 周辺の `frames` または `proxy_clip`
  - `window_start_us`, `window_end_us`
  - refine pass の `peak_moment`
- 出力:
  - final `peak_moment.timestamp_us`
  - tightened `recommended_in_out`
- 方針:
  - default policy は `action_only`
  - static / dialogue / reveal は Pass 2 で十分なら Pass 3 を実行しない

provider が native video input を持つ場合は Pass 3 を `proxy_clip` に置換してよい。
持たない場合は dense frame bundle でよい。

## 8.3 Connector Input Contract

`VlmInput` は union とし、少なくとも次を持つ。

```ts
type VlmInput =
  | {
      type: "contact_sheet";
      contact_sheet_id: string;
      image_path: string;
      mode: "overview";
      tile_map: Array<{ tile_index: number; rep_frame_us: number }>;
    }
  | {
      type: "filmstrip";
      segment_id: string;
      filmstrip_path: string;
      src_in_us: number;
      src_out_us: number;
      tile_map: Array<{ tile_index: number; frame_us: number }>;
    }
  | {
      type: "frames";
      frame_paths: string[];
      frame_timestamps_us: number[];
      window_start_us: number;
      window_end_us: number;
    }
  | {
      type: "proxy_clip";
      clip_path: string;
      window_start_us: number;
      window_end_us: number;
    };
```

補足:

- `filmstrip` には manifest が無いので、`tile_map[]` は M2 の deterministic 6-tile sampling rule から
  connector 側で計算して添付する。
- provider capability には最低でも `supports_video_input` を持たせ、Pass 3 で
  `frames` と `proxy_clip` を分岐できるようにする。

## 8.4 Coarse Prompt

```text
You are analyzing an asset overview contact sheet for editorial peak discovery.

Inputs:
- asset_id: {asset_id}
- contact_sheet_id: {contact_sheet_id}
- tile_map: [{ tile_index, rep_frame_us }]
- transcript_context: {transcript_context_or_none}

Tasks:
1. Identify up to 3 tile spans that likely contain the strongest editorial payoff.
2. Return tile indices only. Do not return exact timestamps.
3. Label each span with the most likely peak type and confidence.
4. If evidence is weak, return an empty array instead of guessing.

Peak type vocabulary:
- action_peak: motion apex, impact, takeoff, landing, balance recovery, reveal-through-action
- emotional_peak: strongest facial or bodily reaction, laugh, tears, surprise, relief, awe
- visual_peak: strongest reveal, composition payoff, lighting change, entrance, parallax payoff

Rules:
- Tile indices must exist in the provided tile_map.
- Do not invent speech that is not supported by the transcript context.
- Prefer narrowing over false precision.
- Respond with valid JSON only.

Return this JSON shape:
{
  "coarse_candidates": [
    {
      "tile_start_index": 0,
      "tile_end_index": 0,
      "likely_peak_type": "action_peak | emotional_peak | visual_peak",
      "confidence": 0.0,
      "rationale": "string"
    }
  ]
}
```

## 8.5 Refine Prompt

```text
You are analyzing a single segment filmstrip for editorial peak refinement.

Segment metadata:
- segment_id: {segment_id}
- segment_type: {segment_type}
- source_range_us: {src_in_us}..{src_out_us}
- filmstrip_tile_map: [{ tile_index, frame_us }]
- coarse_hint: {coarse_hint_or_none}
- transcript_excerpt: {transcript_excerpt_or_none}

Tasks:
1. Identify the single strongest editorial peak inside this segment.
2. Return the exact best timestamp_us if the filmstrip provides enough evidence.
3. Recommend best_in_us and best_out_us around that peak.
4. Keep summary / tags / interest_points / quality_flags repository-compatible.
5. If the best tile is clear but exact center is still uncertain, set needs_precision=true.

Respond with valid JSON only:
{
  "summary": "string",
  "tags": ["string"],
  "interest_points": [
    { "frame_us": 0, "label": "string", "confidence": 0.0 }
  ],
  "peak_moment": {
    "timestamp_us": 0,
    "type": "action_peak | emotional_peak | visual_peak",
    "confidence": 0.0,
    "description": "string"
  },
  "recommended_in_out": {
    "best_in_us": 0,
    "best_out_us": 0,
    "rationale": "string",
    "needs_precision": false
  },
  "visual_energy_curve": [
    { "timestamp_us": 0, "energy": 0.0 }
  ],
  "quality_flags": ["string"],
  "confidence": {
    "summary": 0.0,
    "tags": 0.0,
    "quality_flags": 0.0
  },
  "peak_confidence": {
    "vlm": 0.0
  }
}
```

## 8.6 Precision Prompt

```text
Refine the single strongest editorial peak inside this narrowed high-density window.

Window metadata:
- candidate_window_us: {window_start_us}..{window_end_us}
- refine_peak_timestamp_us: {refine_peak_timestamp_us}
- segment_type: {segment_type}

Tasks:
1. Return the exact best peak timestamp_us inside this window.
2. Tighten best_in_us and best_out_us around that peak.
3. If the refine peak was slightly off, move it and explain why in rationale.

Respond with valid JSON only:
{
  "peak_moment": {
    "timestamp_us": 0,
    "type": "action_peak | emotional_peak | visual_peak",
    "confidence": 0.0,
    "description": "string"
  },
  "recommended_in_out": {
    "best_in_us": 0,
    "best_out_us": 0,
    "rationale": "string"
  }
}
```

## 8.7 Variant Guidance: Interview / Dialogue

```text
Additional guidance for dialogue/interview segments:
- Prioritize the decisive answer landing, emotional face change, laugh, pause after a strong line, or listener reaction.
- Avoid choosing a neutral talking-head midpoint unless it is the real payoff.
- Recommended in/out should avoid cutting mid-phoneme when possible.
- Preserve a short pre-roll before the line lands and a slightly longer post-roll for the reaction.
```

## 8.8 Variant Guidance: Action / Sports / High Motion

```text
Additional guidance for action segments:
- Prioritize the exact apex: takeoff, impact, catch, balance recovery, collision, jump peak, sudden directional change.
- The peak is usually not the first frame of motion and not the final freeze frame.
- Recommended in/out should preserve anticipation before the peak and a short follow-through after it.
- If multiple micro-peaks exist, choose the strongest editorial payoff and keep others as secondary peaks.
```

## 8.9 Variant Guidance: Scenery / Reveal / Product Visual

```text
Additional guidance for scenic or visual-payoff segments:
- Prioritize the reveal moment, composition lock-in, subject entrance, lighting transition, or camera move payoff.
- Do not choose a flat establishing frame unless the reveal itself has completed there.
- Recommended in/out should give enough lead-in to perceive the reveal and enough hold to register it.
```

## 9. Provider Response -> Canonical Artifact 写像

## 9.1 Normalization Rules

1. Pass 1 の `tile_start_index / tile_end_index` が tile_map 範囲外なら drop
2. Pass 1 が timestamp を返しても採用せず、tile span だけを coarse locator に保存する
3. coarse tile span は `rep_frame_us` の min/max から `coarse_window_start_us / coarse_window_end_us` に写像し、
   overlapping segment だけを Pass 2 対象にする
4. Pass 2 / Pass 3 の `peak_moment.timestamp_us` は segment 範囲外なら drop
5. `recommended_in_out.best_in_us / best_out_us` は segment 範囲に clamp し、
   `best_out_us <= best_in_us` なら無効扱い
6. `visual_energy_curve[]` は最大 8-12 点に downsample
7. `peak_ref` は `"{segment_id}@{timestamp_us}"` で決定する
8. `peak_moments[]` の各要素を `interest_points[]` に mirror し、
   `interest_points[].label` は `"type: description"` に正規化する
9. exact center は Pass 2 で十分ならそのまま採用し、Pass 2 が tile-level ambiguity を残す場合だけ
   Pass 3 か deterministic local search で確定する
10. `segments.json` に canonicalize するのは Pass 2 / Pass 3 後の結果だけであり、Pass 1 単独結果は残さない

## 9.2 Confidence Fusion

VLM confidence をそのまま canonical truth にせず、ffmpeg support signal で補強する。

audio support がある場合:

```text
fused_peak_confidence =
  clamp(
    0.70 * vlm_peak_confidence +
    0.20 * motion_support_score +
    0.10 * audio_support_score
  )
```

audio support が無い場合:

```text
fused_peak_confidence =
  clamp(
    0.75 * vlm_peak_confidence +
    0.25 * motion_support_score
  )
```

type 別の補正:

- `action_peak`: motion support の重みを上げる
- `emotional_peak`: audio support をやや上げる
- `visual_peak`: VLM を主、motion を補助にする

閾値:

- `>= 0.70`: strong peak。`recommended_in_out` を候補 window に採用してよい
- `0.55 - 0.69`: usable peak。`source_center_us` と score bonus には使えるが、authored window override はしない
- `< 0.55`: advisory only。`interest_points[]` のみ残し、`recommended_in_out` は採用しない

## 10. Interest Point -> /triage 連携

## 10.1 基本方針

compiler は `segments.json` を見ないため、`/triage` が segment peak data を candidate-level signal に変換する責務を持つ。

`/triage` では agent の自由記述だけに任せず、deterministic helper を先に走らせる。

### helper の責務

1. `segments.json` の `peak_analysis` と `interest_points` を読む
2. role / segment_type ごとに peak-aware candidate window を提案する
3. `trim_hint` と `editorial_signals` を事前計算する
4. agent には「この候補を採る / 捨てる」「どの beat に当てる」を決めさせる

## 10.2 Candidate Proposal Rules

優先順位:

1. `peak_analysis.recommended_in_out` (`fused_peak_confidence >= 0.70` のとき)
2. highest-confidence `peak_moments[]` (`fused_peak_confidence >= 0.55` のとき)
3. highest-confidence `interest_points[]`
4. midpoint fallback

window 生成ルール:

- `dialogue`:
  - 可能なら utterance / sentence boundary に align
  - `source_center_us` は emotional peak か decisive line landing
  - pre-roll を短め、post-roll をやや長めに取る
- `action`:
  - `source_center_us` は action apex
  - safety window は anticipation + follow-through を含む
  - near-identical nearby windows は 1 本に寄せる
- `static` / `general` / `visual`:
  - reveal completion と hold を優先
  - flat midpoint は避ける

candidate 生成時の rules:

- `src_in_us / src_out_us` は authored safety window
- `trim_hint.preferred_duration_us` は target editorial clip 長
- `trim_hint.window_start_us / window_end_us` は hard clamp
- `trim_hint.center_source` は `refine_filmstrip` / `precision_dense_frames` /
  `precision_proxy_clip` / `interest_point_fallback` / `midpoint_fallback` のいずれかにする
- `semantic_dedupe_key` は `segment_id + peak_type + quantized_peak_timestamp` を含める
  - 近接 peak を同一扱いできるように 500-800ms bucket を使う
- same `segment_id` + same `peak_type` + center 差 `<= 800ms` の候補は helper が merge し、
  より高 confidence の peak を正とする

## 10.3 Agent Prompt 変更

`/triage` agent には次を追加する。

```text
When a segment has peak_analysis or interest_points, do not hand-author in/out from scratch unless you have a clear editorial reason.
Default to the proposed peak-centered window and explain overrides explicitly.
Prefer candidates whose trim_hint.source_center_us lands on the strongest payoff moment.
```

MCP で `peek_segment` / `search_segments` を返す場合も、`top_peak`, `peak_type`, `recommended_in_out`, `fused_peak_confidence` を surface する。

## 11. Interest Point -> Compiler 連携

## 11.1 `normalize.ts`

`NormalizedBeat` に次を追加する。

- `story_role`
- `skill_hints`

理由:

- `score.ts` は hook / setup / closing で peak bonus の重みを変える必要がある
- `trim.ts` は `build_to_peak`, `silence_beat`, `cooldown_resolve` などの hint を見て asymmetry を変える必要がある

## 11.2 `score.ts`

現状の問題は「全候補同一 bonus」で順位が変わらないことにある。peak bonus は候補依存でなければならない。

追加する candidate-specific score:

```text
peak_salience_bonus =
  peak_strength_score
  * beat_story_role_weight
  * peak_type_match_weight
```

初期 weight 例:

- `beat_story_role_weight`
  - `hook`: 1.00
  - `experience`: 0.85
  - `closing`: 0.70
  - `setup`: 0.45
- `peak_type_match_weight`
  - `action_peak` on `hero/support`: 1.00
  - `emotional_peak` on `dialogue/hero`: 1.00
  - `visual_peak` on `support/transition/texture`: 1.00
  - mismatch: 0.55

加点元:

- `candidate.editorial_signals.peak_strength_score`
- `candidate.editorial_signals.motion_energy_score`
- `candidate.editorial_signals.audio_energy_score`
- `candidate.trim_hint.interest_point_confidence`

fail-open:

- 上記が無ければ bonus は 0

この peak bonus は generic skill adjustment とは別の項で計算する。skill adjustment は依然として使うが、constant bonus だけでは peak ranking にならない。

## 11.3 `assemble.ts`

assembly 自体のロジック変更は最小でよいが、次を守る。

- `candidate_ref` を primary key として維持する
- trim 後の metadata 再付与は `segment_id + src range` ではなく `candidate_ref` で引く
- `clip.metadata` は namespace ごとに merge し、object 全体を置き換えない
  - `trim`: trim phase 専有
  - `editorial`: deep merge
  - `editorial.peak`: peak feature 専有
- same-source repetition を抑える場合は `semantic_dedupe_key` に quantized peak bucket を反映する

## 11.4 `trim.ts`

target behavior:

1. center を決める
   - `trim_hint.source_center_us`
   - これは Pass 2 / Pass 3 か deterministic local search で確定した値を使う
   - coarse pass 単独の tile index は直接 center にしない
   - なければ `trim_hint.center_source = interest_point_fallback` として midpoint fallback
2. desired duration を決める
   - beat target duration
   - trim policy default
   - `trim_hint.preferred / min / max`
   - skill duration bias
3. asymmetry を決める
   - `action_peak`: pre-roll 長め
   - `emotional_peak`: post-roll 長め
   - `visual_peak`: やや post-roll 長め
   - さらに `story_role` と active skill で補正
4. authored safety window に clamp
5. resolved trim を metadata に残す

type 別の初期 asymmetry:

- `action_peak`: pre 0.60 / post 0.40
- `emotional_peak`: pre 0.40 / post 0.60
- `visual_peak`: pre 0.45 / post 0.55

必要な wiring:

- `applyAdaptiveTrim()` に `activeSkills` と beat `story_role` を渡す
- `getSkillTrimEffects()` を実際に使う
- `ResolvedTrim.mode` に `adaptive_peak_center` を追加する

## 11.5 `compiler/index.ts`

compile orchestration では次を行う。

1. active skill を trim phase にも渡す
2. `candidate_ref -> candidate` map を作る
3. trim 後 metadata 再付与は `candidate_ref` で解決する
4. `clip.metadata.editorial` は deep merge し、peak 情報は `editorial.peak` にだけ書く
5. `timelineIR.provenance` はこの phase では拡張せず、peak provenance は `clip.metadata.*` に閉じ込める

## 12. ffmpeg ベース補助分析

## 12.1 目的

VLM の「それっぽい peak」を、映像・音声の物理 signal で補強する。これは ranking と confidence の補助であり、VLM の代替ではない。

## 12.2 Motion Detection

候補:

- frame difference ベースの motion energy curve
- scene / cut density
- sudden acceleration を示す局所変化量

要件:

- segment 内を fixed bin に分け、各 bin に `motion_energy_score` を出す
- VLM peak の前後 300-500ms で local max があるかを support とする
- existing ffmpeg base layer を再利用し、remote API は呼ばない

## 12.3 Audio Support (optional)

候補:

- RMS / peak level の windowed curve
- optional な speech-end proximity
- Phase 5b 以降で `audio-events.json` の `laughter`, `applause`, `impact`, `ambient_shift`

要件:

- `audio_energy_score` を 0-1 に正規化する
- `emotional_peak` と `action_peak` の confidence 補強に使う
- audio が存在しない素材、または runtime producer が無い素材では neutral でよい
- `audio-events.json` schema が存在しても、この phase では runtime 実装を前提にしない

## 12.4 Fusion Rule

各 VLM peak に対して:

1. timestamp 近傍の motion support を引く
2. optional で timestamp 近傍の audio support を引く
3. `fused_peak_confidence` を計算
4. `support_signals` として `peak_analysis` に残す

誤検出時の扱い:

- VLM 高 confidence でも motion / optional audio が flat なら one-rank 下げる
- VLM 低 confidence だが motion / optional audio が強い場合でも、VLM なしで peak を新規生成しない
  - 本 phase は補強であり、deterministic detector 単独採用ではない

## 12.5 Non-Functional Requirements

- analysis token budget
  - coarse pass の output は asset あたり peak 3 件まで
  - refine pass は coarse 候補あたり最大 2 segment まで
  - precision pass は segment あたり最大 1 window
- latency budget
  - peak 検出導入後も canonical analysis の wall-clock が極端に増えないよう、
    refine / precision は eligible segment のみに限定する
- compiler complexity
  - score / assemble / trim は引き続き `O(beats * candidates)` を大きく超えない
  - compiler は remote API を呼ばない
- determinism
  - peak fusion rule、window derivation、type asymmetry は pure function 化する
  - prompt hash、fusion version、support signal version を artifact に残す
- compatibility
  - new field 不在時は legacy path を使う
  - canonical artifact promotion の入口は既存 `/triage` と `/blueprint` を維持する

## 12.6 Observability

導入後に最低限観測する指標:

- `peak_detection_rate`
  - peak を 1 件以上持つ segment の比率
- `contact_sheet_coarse_rate`
  - coarse pass が contact sheet を使って走った asset の比率
- `peak_refine_rate`
  - refine pass が走った segment の比率
- `peak_precision_rate`
  - precision pass が走った segment の比率
- `midpoint_fallback_rate`
  - peak-aware trim ではなく midpoint fallback になった clip の比率
- `peak_bonus_applied_rate`
  - score で peak salience bonus が 0 以外だった candidate の比率
- `peak_center_hit_rate`
  - expected peak 近傍に resolved center が入った fixture / golden case の比率
- `low_confidence_drop_rate`
  - `recommended_in_out` が confidence 閾値未満で advisory 扱いに落ちた率

real project では数値を hard gate にせず advisory で開始し、fixture で安定後に gate 候補へ引き上げる。

## 13. テスト戦略

## 13.1 Unit

- `buildCoarsePrompt()` が tile-index only contract を含む
- `buildRefinePrompt()` が filmstrip tile_map contract を含む
- VLM raw response の parse / normalize
  - `coarse_candidates[]`
  - `peak_moments[]`
  - `recommended_in_out`
  - `visual_energy_curve`
- `contact_sheet tile_map -> segment` mapping
- `filmstrip tile_map` 生成
- `peak_moments -> interest_points` mirror
- `trim_hint` canonicalization
- `clip.metadata.editorial` merge rule
- `resolveTrim()` が peak center / type asymmetry / clamp を正しく処理する
- `scoreCandidate()` が peak candidate を実際に rerank する
- `candidate_ref` lookup が trim 後も安定する

## 13.2 Integration

- contact sheet coarse output から refine 対象 segment を導ける
- mock refine / precision response から `segments.json.peak_analysis` を生成できる
- `/triage` helper が `peak_analysis` から candidate window を作り、`trim_hint` を埋める
- compiler が `trim_hint` と `editorial_signals` を消費して score + trim に反映する
- `clip.metadata.trim` と `clip.metadata.editorial.peak` が deterministic merge される

## 13.3 E2E Fixture

最低 3 系統の fixture を持つ。

1. Interview
   - decisive line + reaction face
2. Action
   - run/jump/balance/catch の apex
3. Scenic / Reveal
   - visual reveal / subject entrance / composition payoff

E2E assertions:

- top-ranked candidate が想定 peak を含む
- resolved trim center が expected peak から許容差内にある
- coarse pass が tile index を返し、refine pass が exact center を返す
- timeline clip metadata に peak provenance が残る
- peak data が欠損した fixture では legacy compile path が通る

## 13.4 Acceptance Threshold

初期 threshold:

- trim center 誤差: `<= 750ms`
- `recommended_in_out` の clamp miss: `0`
- peak-aware candidate の score uplift: non-peak 対比で有意な差分がある
- no-peak fallback fixture の regression: `0`

## 14. 実装順序

## Phase 1: Contract 固定

- VLM prompt template と response shape を固定
- `VlmInput` union と provider capability を固定
- `segments.schema.json` に `peak_analysis` を追加
- `selects-candidates.schema.json` に peak-related field を追加
- root `segments.confidence` / `segments.provenance` / `timelineIR.provenance` を拡張しないことを明記
- golden test を先に作る

## Phase 2: VLM Connector

- contact sheet coarse pass と filmstrip refine pass を導入
- raw response normalization と mirror rules を実装
- precision pass の policy gating を導入
- `peak_analysis.provenance` に prompt hash / fusion version を保存

## Phase 3: /triage Integration

- deterministic peak window helper を実装
- agent prompt を更新
- `trim_hint` / `editorial_signals` を candidate に materialize

## Phase 4: Compiler Integration

- `normalize.ts` に `story_role` / `skill_hints` を通す
- `score.ts` に candidate-specific peak salience bonus を追加
- `trim.ts` に peak type asymmetry と skill trim effects を配線
- `candidate_ref` based metadata lookup に切り替える
- `clip.metadata.editorial` deep merge rule を入れる

## Phase 5: Motion Support Signal

- motion support curve を導入
- peak confidence fusion を有効化
- fixture tuning

## Phase 5b: Optional Audio Support

- RMS / peak envelope と optional speech-end proximity を導入
- `audio-events.json` 連携は runtime 実装が整った時点で opt-in

## Phase 6: Rollout

- feature flag で opt-in
- fixture + real sample で評価
- quality regression が無ければ default on

## 15. リスクと回避策

### 15.1 Coarse だけでは apex を外す

回避:

- asset-level contact sheet で coarse narrowing を行う
- segment-level filmstrip で refine する
- action 系だけ precision pass を追加する
- provider が video input を持つ場合は precision pass に proxy clip を使う

### 15.2 Same-source 近接 peak の量産

回避:

- `semantic_dedupe_key` に quantized peak bucket を使う
- near-duplicate window を triage helper で merge する

### 15.3 Dialogue で peak center が口パク途中に刺さる

回避:

- interview variant prompt で mid-phoneme cut 回避を指示
- transcript / utterance boundary がある場合はそこへ snap する

### 15.4 補助信号が VLM と矛盾する

回避:

- ffmpeg support は confidence 補強のみ
- support signal 単独で new peak を生やさない

## 16. Rollback / Compatibility

- `peak_analysis` 不在時: 現行 `interest_points` advisory のみ
- `trim_hint` 不在時: 現行 authored range / midpoint fallback
- peak score field 不在時: bonus 0
- feature flag off: `m2-segment-v1` + 現行 compile path を使う

## 17. 受け入れ条件

- `gemini-vlm.ts` の prompt が「何を見せ場とみなすか」を具体的に指示している
- `segments.json` から `/triage`、`selects_candidates.yaml` から compiler まで、peak signal の handoff が切れていない
- `score.ts` と `trim.ts` の両方で peak が候補依存の形で効く
- ffmpeg support signal が additive で、fallback path を壊さない
- unit / integration / E2E の各層に検証手段がある
