# 「いい映像」をVLMで構造化する visual quality signals 設計調査

調査日: 2026-06-16

## 結論

summary は「何が写っているか」の圧縮には使えるが、「なぜ編集者がそのカットを採るか」の根拠としては弱い。戸隠/ふもと系のPV選定で必要なのは、少なくとも以下の3層に分けた signal である。

1. **segment-local visual quality**: 光、主被写体、表情、構図、モーションの見栄え。
2. **project-relative signal**: 同プロジェクト内での希少性、重複、視覚クラスタ。
3. **intent-relative editorial signal**: brief の beat/arc に対する必要度、終盤/導入/転換点としての役割。

最初に試すべき実装は **A. VLM多軸スコア方式**。既存の `gemini-2.5-flash-lite` segment enrichment に additive な JSON 出力を足すだけで、APIコストはほぼ増えず、triage agent が「summaryの語彙」ではなく「光/表情/構図/物語上の使い道」を読めるようになる。

ただし、7軸すべてを「VLMが単独で0-1採点した真実」として扱うべきではない。`narrative_necessity` と `uniqueness` は segment-local な事実ではないため、VLM出力に加えて brief / 全segment / 選定済み候補を使う deterministic post-process か triage-time scoring に寄せるのが安全。

## 1. 既存構造の把握

### 1.1 `selects_candidates.yaml` の `editorial_signals`

`schemas/selects-candidates.schema.json` の `$defs.candidate.properties.editorial_signals` は closed object で、`additionalProperties: false`。現在許可されているプロパティは以下。

| property | type | domain / enum | 用途 |
| --- | --- | --- | --- |
| `silence_ratio` | number | 0-1 | 無音比率 |
| `afterglow_score` | number | 0-1 | 余韻 |
| `speech_intensity_score` | number | 0-1 | 発話の強さ |
| `reaction_intensity_score` | number | 0-1 | 反応の強さ |
| `authenticity_score` | number | 0-1 | 素の感じ、作為の少なさ |
| `surprise_signal` | number | 0-1 | 驚き |
| `hope_signal` | number | 0-1 | 希望・前向きさ |
| `peak_strength_score` | number | 0-1 | peakの強さ |
| `motion_energy_score` | number | 0-1 | 動きの強さ |
| `audio_energy_score` | number | 0-1 | 音声/音量の強さ |
| `peak_ref` | string | - | peak参照ID |
| `peak_type` | string | `action_peak` / `emotional_peak` / `visual_peak` | peak種別 |
| `peak_source_pass` | string | - | peak検出元 |
| `face_detected` | boolean | - | 顔検出 |
| `visual_tags` | string[] | - | 視覚タグ |
| `semantic_cluster_id` | string | - | 意味/視覚クラスタ |

このため `light_quality` や `composition_score` を candidate に直接追加するには、将来の実装で schema と TypeScript 型を同時に拡張する必要がある。短期の実験では `segments.json` 側に `visual_quality` subtree を置き、candidate には既存の `visual_tags` / `face_detected` / `semantic_cluster_id` と peak系だけを materialize する方が artifact stability を保てる。

### 1.2 `runtime/pipeline/stages/vlm.ts` の戻り値と更新フィールド

主な exported shape:

| shape / function | fields |
| --- | --- |
| `VlmRetryPolicy` | `initialDelayMs`, `maxDelayMs`, `maxRetries` |
| `VlmShard` | `segment_id`, `result` |
| `VlmAssetFailure` | `assetId`, `filename`, `error` |
| `VlmProgressEvent` | `current`, `total`, `assetId`, `filename`, `status` (`analyzing` / `cached` / `skipped`) |
| `VlmProgressReporter` | `onAssetProgress?`, `onAssetFailure?` |
| `VlmAssetRunSummary` | `totalAssets`, `cachedAssets`, `analyzedAssets`, `skippedAssets`, `failedAssets`, `durationMs` |
| `RunParallelVlmAnalysisOptions` | `assets`, `segments`, `vlmPolicy`, `samplingPolicy`, `minSegmentDurationUs`, `vlmFn`, `contentHint?`, `concurrency?`, `retryPolicy?`, `reporter?`, `cachedSegmentIds?`, `sleepFn?` |
| `HydrateCachedVlmSegmentsOptions` | `currentSegments`, `cachedSegments?`, `vlmPolicy`, `policyHash` |
| `runParallelVlmAnalysis(...)` | returns `{ shards: VlmShard[], summary: VlmAssetRunSummary }` |
| `vlmReduce(...)` | returns `{ segments: SegmentsJson, assets: AssetsJson }` |

`VlmEnrichmentResult` は `runtime/connectors/gemini-vlm.ts` 側で定義される。

| shape | fields |
| --- | --- |
| `VlmNormalizedOutput` | `summary`, `tags`, `interest_points[]`, `quality_flags`, `confidence` |
| `interest_points[]` item | `frame_us`, `label`, `confidence` |
| `confidence` | `summary`, `tags`, `quality_flags` |
| `VlmEnrichmentResult` | `success`, `output?`, `error?`, `prompt_hash`, `model_alias`, `model_snapshot` |

`vlmReduce` が `segments.json` に反映するのは、現在は `summary`, `tags`, `quality_flags`, `interest_points`, `confidence.summary/tags/quality_flags`, `provenance.summary/tags/quality_flags`。asset側は `role_guess` を更新する。

既存VLM policy は `runtime/analysis-defaults.yaml` で以下。

- `model_alias: gemini-2.5-flash-lite`
- `input_mode: frame_bundle_plus_text_context`
- `response_format: json_schema_v1`
- `prompt_template_id: m2-segment-v1`
- `max_frame_width_px: 1024`
- `segment_visual_token_budget_max: 8192`
- `segment_visual_output_tokens_max: 512`
- `segment_visual_frame_cap: 90`

### 1.3 `runtime/pipeline/stages/peak.ts` の戻り値と更新フィールド

主な exported shape:

| shape / function | fields |
| --- | --- |
| `DegradedPeakSignals` | `motion?`, `audio_rms?`, `speech_keyword?` |
| `PeakShard` | `segment_id`, `peak_analysis?`, `error?` |
| `peakMap(...)` | returns `Promise<PeakShard[]>` |
| `degradedPeakMap(...)` | returns `Promise<PeakShard[]>` |
| `derivePeakSignalsForSegment(...)` | returns `DegradedPeakSignals` |
| `peakReduce(...)` | returns `SegmentsJson` after writing `segment.peak_analysis` |

`PeakAnalysis` は `runtime/connectors/vlm-peak-detector.ts` 側で定義される。

| shape | fields |
| --- | --- |
| `CoarseCandidate` | `tile_start_index`, `tile_end_index`, `likely_peak_type`, `confidence`, `rationale` |
| `CoarseResult` | `success`, `candidates`, `error?`, `prompt_hash` |
| `PeakMoment` | `peak_ref`, `timestamp_us`, `type`, `confidence`, `description`, `source_pass` |
| `RecommendedInOut` | `best_in_us`, `best_out_us`, `rationale`, `source_pass` |
| `VisualEnergyCurvePoint` | `timestamp_us`, `energy`, `source?` |
| `RefineResult` | `success`, `summary`, `tags`, `interest_points`, `peak_moment?`, `recommended_in_out?`, `visual_energy_curve`, `quality_flags`, `confidence`, `peak_confidence_vlm`, `needs_precision`, `error?`, `prompt_hash` |
| `PrecisionResult` | `success`, `peak_moment?`, `recommended_in_out?`, `error?`, `prompt_hash` |
| `CoarseLocator` | `contact_sheet_id`, `tile_start_index`, `tile_end_index`, `coarse_window_start_us`, `coarse_window_end_us` |
| `SupportSignals` | `motion_support_score`, `audio_support_score`, `fused_peak_score` |
| `PeakAnalysisProvenance` | `coarse_prompt_template_id`, `refine_prompt_template_id`, `precision_mode`, `fusion_version`, `support_signal_version` |
| `PeakAnalysis` | `coarse_locator?`, `peak_moments`, `recommended_in_out?`, `visual_energy_curve`, `support_signals?`, `provenance` |

既存の peak 設計は `docs/vlm-peak-detection-design.md` にあり、方針は `contact_sheet -> filmstrip -> precision` の progressive resolution。`peak_analysis` は machine-use 向け、`interest_points[]` は旧consumer互換として残す設計になっている。

### 1.4 fumoto-growth 実データの観察

対象:

- `reports/eval/regen-scratch/fumoto-growth/03_analysis/segments.json`
- `reports/eval/regen-scratch/fumoto-growth/04_plan/selects_candidates.yaml`

`segments.json` の概況:

| metric | value |
| --- | ---: |
| segments | 32 |
| `interest_points` あり | 31 |
| `peak_analysis` あり | 31 |
| `peak_moments` あり | 31 |
| segment types | `general`: 27, `static`: 5 |
| quality flags | `minor_highlight_clip`: 32, `near_silent`: 5, `underexposed`: 1 |

top visual tags:

| tag | count |
| --- | ---: |
| `child` | 23 |
| `outdoor_scene` | 22 |
| `bicycle` | 21 |
| `daytime` | 20 |
| `learning` | 18 |
| `training_wheels` | 12 |
| `paved_surface` | 10 |
| `child_development` | 9 |
| `growth_record` | 9 |
| `text_overlay` | 9 |

peak signal の分布:

| field | observed |
| --- | --- |
| `peak_type` | `action_peak`: 26, `emotional_peak`: 5, missing: 1 |
| `source_pass` | `refine_filmstrip`, `marlin_find`, missing |
| `fused_peak_score` unique values | 0.565, 0.63, 0.65, 0.695, 0.75 |

代表サンプル:

| segment | existing summary / tags | existing peak |
| --- | --- | --- |
| `SEG_AST_567028AD_0001` | 「初めて自転車に乗れた、成人が応援」; tags include `child`, `bicycle`, `success`, `cheering` | `action_peak`, confidence 0.8, source `refine_filmstrip`, `fused_peak_score` 0.695, recommended range 13.03s-17.38s |
| `SEG_AST_9435E35C_0001` | 「赤ちゃんが寝ている、年齢テキスト」; tags include `baby`, `sleeping`, `close_up` | `emotional_peak`, confidence 0.7, source `refine_filmstrip`, `fused_peak_score` 0.65 |
| `SEG_AST_0C9FA88A_0001` | 「balance bike から pedaling へ」; tags include `child`, `bicycle`, `learning`, `pedaling` | `emotional_peak`, confidence 0.75, source `marlin_find`, `fused_peak_score` 0.75 |

`selects_candidates.yaml` の観察:

- `candidates` は `cand_01` から `cand_13` まで。
- candidate-level で使われている signal は `confidence`, `semantic_rank`, `quality_flags`, `evidence`, `eligible_beats`, `motif_tags`, `editorial_summary`。
- この fumoto-growth artifact には `editorial_signals`, `peak_signals`, `trim_hint` が出ていない。
- 例: `cand_05` は `SEG_AST_567028AD_0001`, role `hero`, confidence 0.90, `eligible_beats: [pride, warmth]`, `motif_tags: [bicycle, success, cheering]`。
- 例: `cand_13` は `SEG_AST_7EC7D225_0001`, role `texture`, confidence 0.65, `quality_flags: [underexposed]`, `eligible_beats: [nostalgia, warmth]`。

重要な示唆:

- `segments.json` には peak / interest point がかなり入っているが、選定artifactにはまだ materialize されていない。
- `summary` と tags は内容分類には効いているが、`light_quality`, `composition_score`, `subject_prominence` のような「見栄えの良さ」は明示的に残っていない。
- `peak_analysis` は「どこを切るか」には有効だが、「そのフレームが美しいか」「主被写体が立っているか」「他候補と被っていないか」はまだ別 signal が必要。

## 2. 映像品質の軸

### 2.1 軸別の定量化可能性

| axis | VLM単独 | ローカル/決定的補助 | 推奨保存先 | 注意点 |
| --- | --- | --- | --- | --- |
| `light_quality` | 中-高。ゴールデンアワー、逆光、曇天、焚き火の暖色などの意味づけはVLMが得意 | 輝度ヒストグラム、白飛び/黒つぶれ、コントラスト、色温度proxy | `segments.visual_quality.scores.light_quality` | VLMの絶対点は揺れる。`lighting_style` と evidence を併記する |
| `subject_prominence` | 高。主被写体が明確か、画面内で目立つかを判断可能 | 顔/人物/物体bbox面積、saliency、blur/sharpness | `subject_prominence`, `subject_sharpness`, `face_detected` | 被写体が小さくても「引きの良い画」な場合がある |
| `emotional_expression` | 中-高。笑顔、驚き、集中、緊張などは視認できれば可能 | 顔検出、landmarks、face capture quality。表情分類は別Core ML/VLMが必要 | `emotional_expression`, `expression_tags` | 顔が見えない時は body reaction / audio reaction を別扱い |
| `composition_score` | 中。三分割、シンメトリー、リーディングライン、バランスは評価可能 | saliency重心、水平線、エッジ/ライン、人物bbox位置 | `composition_score`, `composition_tags` | 主観性が強いので `rule_of_thirds`, `symmetry` など分解した方が使いやすい |
| `narrative_necessity` | segment単独では低。brief/arcを渡せば中 | creative_brief の beat coverage、must_have、時系列、既選定候補との差分 | candidate-level `eligible_beats`, future `editorial_signals.narrative_necessity` | raw `segments.json` に固定値として置くとproject/intentが変わった時に古くなる |
| `motion_quality` | 中。filmstripなら静→動、スロー向き、動きの美しさを判断可能 | Marlin peak、ffmpeg motion、optical flow、手ブレ検出 | `motion_quality`, existing `peak_analysis.visual_energy_curve` | 「激しい」と「美しい」は別。motion energy だけでは不足 |
| `uniqueness` | segment単独では低。コンタクトシートや全候補比較で中 | image embeddings, perceptual hash, histogram/CLIP/Marlin embeddings, cluster density | project-level `visual_cluster_id`, `rarity_score` | 同一クラスタ内の最良カット選びと、クラスタcoverageを分ける |

### 2.2 推奨rubric

VLM prompt では1つの総合点ではなく、以下のように軸別score + categorical evidence を返させる。

```json
{
  "visual_quality": {
    "scores": {
      "light_quality": 0.82,
      "subject_prominence": 0.76,
      "emotional_expression": 0.64,
      "composition_score": 0.72,
      "motion_quality": 0.58
    },
    "labels": {
      "lighting_style": ["warm_backlight", "soft_contrast"],
      "composition_tags": ["clear_subject", "balanced_background"],
      "expression_tags": ["small_smile", "focused"],
      "motion_tags": ["gentle_forward_motion"]
    },
    "evidence": {
      "light_quality": "warm directional light separates the subject from the background",
      "composition_score": "subject sits near a third line with uncluttered negative space"
    },
    "confidence": {
      "light_quality": 0.78,
      "subject_prominence": 0.84,
      "emotional_expression": 0.62,
      "composition_score": 0.70,
      "motion_quality": 0.66
    },
    "provenance": {
      "stage": "vlm",
      "prompt_template_id": "m2-segment-visual-quality-v1",
      "model_alias": "gemini-2.5-flash-lite"
    }
  }
}
```

`narrative_necessity` と `uniqueness` は同じ object に入れてもよいが、生成元は分ける。

```json
{
  "project_relative": {
    "visual_cluster_id": "bicycle_learning_daylight_03",
    "rarity_score": 0.31,
    "near_duplicate_segment_ids": ["SEG_..."]
  },
  "intent_relative": {
    "narrative_necessity": 0.88,
    "best_fit_beats": ["pride", "warmth"],
    "must_have_support": ["first_successful_bicycle_ride"]
  }
}
```

## 3. 実装アプローチ比較

API単価は 2026-06-16 時点の Google Gemini API pricing を参照。`gemini-2.5-flash-lite` standard は text/image/video input $0.10 / 1M tokens、output $0.40 / 1M tokens。既存policy上限の `8192 input tokens + 512 output tokens` を1segmentの荒い上限として使うと、60segmentでもおおよそ input $0.049 + output $0.012 = $0.061 程度。実際の画像token化やリトライで上下するが、今回の意思決定ではAPIコストよりも精度と実装安定性の方が支配的。

| approach | 推定コスト | 実装難易度 | 期待精度改善 | 強み | 弱み |
| --- | ---: | --- | --- | --- | --- |
| A. VLM多軸スコア方式 | 低。既存VLM passに相乗りなら60segmentで数セント級。出力token増分は小さい | 低-中。prompt/schema/parser/cache hash の追加が中心 | 中-高。summaryでは欠ける光/構図/表情/主被写体を直接triageへ渡せる | additive、既存artifactと相性が良い、すぐA/B evalできる | 絶対scoreのキャリブレーションが必要。narrative/uniquenessは別処理が必要 |
| B. コンタクトシート比較方式 | 低。複数segmentを1 requestにまとめやすい | 中。tile ID対応、batch bias、再現性、候補漏れ対策が必要 | 中-高。人間に近い相対選好を引き出しやすい | 「この中で良い3枚」の相対判断に強い。hero候補抽出に向く | canonical per-segment signalになりにくい。batch構成で結果が変わる。理由が粗くなりやすい |
| C. ローカルCV方式 | API 0。CPU/GPU計算のみ | 中-高。Apple Vision/OpenCV wrapper、platform差、threshold調整が必要 | 中。顔/ピント/露出/主被写体の物理signalは強い | 安い、再現性が高い、VLM hallucinationを抑えられる | 「良い表情」「物語上必要」は単独では弱い。表情分類には別モデルが必要 |
| D. Marlin temporal + VLM静止画ハイブリッド | 低。Marlinは既にlocal設定あり。VLMはpeak frameのみなら低い | 中。既存 `peak_analysis` との統合はしやすいが、品質軸への接続設計が必要 | 高。ただし主に peak / motion / expression timing | どの瞬間を見るべきかを改善できる。uniform samplingの外しを減らす | 光/構図/subject qualityの全体評価はAほど広くない。顔中心モデルなら顔がないB-rollに弱い |

### 3.1 A: VLM多軸スコア方式

最小実装:

- 既存 `m2-segment-v1` を置き換えず、別template `m2-segment-visual-quality-v1` として追加する。
- `summary`, `tags`, `interest_points`, `quality_flags` は既存互換のまま維持する。
- `segments.json` に optional `visual_quality` subtree を追加する。
- score は0-1に正規化し、必ず `confidence` と短い `evidence` を付ける。
- triage prompt では summary よりも `visual_quality.scores` と `labels` を使って候補理由を書かせる。

最初のeval:

- 人間採用26本との overlap を、現行summary-only、A追加後、A + deterministic coverage の3条件で比較する。
- 重要なのは全体一致率だけでなく、`light_quality` 上位、`emotional_expression` 上位、`narrative_necessity` 上位の各bucketで人間採用率を見ること。

### 3.2 B: コンタクトシート比較方式

使いどころ:

- canonical artifact 生成より、eval / calibration / hero候補のrerankに向く。
- 1枚のsheetに 12-30 tiles 程度を並べ、tile IDを大きく焼き込む。
- VLMには「PV intent」「選んだ理由」「落とした理由」「似ている候補」を返させる。

注意点:

- batch内の候補構成で順位が変わる。
- 60segment全体を一度に比較すると小さいtileの表情や光を見落とす。
- `top3` だけでは long-tail の narrative coverage を落とす可能性がある。

推奨用途は「Aのスコアが本当に人間選好を拾っているか」の診断。production ranking の唯一の根拠にしない。

### 3.3 C: ローカルCV方式

すぐ取れるsignal:

- OpenCV:
  - Laplacian / Sobel 系で blur / edge richness / sharpness proxy。
  - 輝度ヒストグラムで under/overexposure、contrast。
  - cascade / DNN face detection で face bbox と顔数。
- Apple Vision:
  - face rectangles / landmarks。
  - face capture quality。
  - saliency / optical flow 系request。

推奨signal:

| local signal | maps to |
| --- | --- |
| face bbox area ratio | `subject_prominence`, `face_detected` |
| face capture quality | `subject_sharpness`, `emotional_expression` confidence |
| Laplacian variance / edge density | `focus_quality`, `composition_support` |
| luma percentile / clipped pixels | `light_quality` support, quality flags |
| optical flow / ffmpeg motion | `motion_quality`, existing `motion_energy_score` |
| perceptual hash / embeddings | `uniqueness`, `semantic_cluster_id` |

CはVLMの代替ではなく、VLM score の confidence補強と obvious failure の検出に使うのがよい。

### 3.4 D: Marlin temporal + VLM静止画ハイブリッド

既存repoでは `runtime/analysis-defaults.yaml` に Marlin が primary / temporal_semantics として定義され、fumoto-growth の `segments.json` にも `marlin_find` 由来の peak が出ている。

有効な接続:

- Marlin / peak_analysis が peak timestamp を出す。
- その timestamp 周辺の representative frame / mini filmstrip を VLM visual_quality に渡す。
- uniform sampling で平均化された summary ではなく、「編集上いちばん使う瞬間」の光/表情/構図を採点する。

注意点:

- MARLINの論文・公式実装は facial video representation が中心。顔が主役の素材には強いが、キャンプ場の風景、焚き火、テント、手元作業などは別signalが必要。
- 既存 `peak_analysis` は「ピークの時刻」には強いが、「画として美しいか」は未分離。

## 4. 推奨実装順序

| order | step | 目的 | 成功条件 |
| ---: | --- | --- | --- |
| 1 | A: `visual_quality` を segment-local に追加 | summaryの限界を最小変更で補う | 人間採用カットが `light_quality`, `subject_prominence`, `emotional_expression`, `composition_score`, `motion_quality` のいずれか上位に寄る |
| 2 | D-lite: existing `peak_analysis` の peak frame を visual_quality 入力に混ぜる | uniform samplingで外す「表情/成功/一瞬の見栄え」を拾う | peak frame採点時の overlap が通常rep frame採点より改善する |
| 3 | `uniqueness` / `visual_cluster_id` を deterministic post-process 化 | 同じ自転車/同じ構図の重複を抑える | cluster coverage と density が改善し、title/end screenを除外して評価できる |
| 4 | C: local CV support signals を追加 | VLM scoreを物理signalで補強 | face/focus/exposure の明らかな失敗を安定して検出できる |
| 5 | B: contact sheet comparison を eval/rerank として追加 | 絶対scoreのキャリブレーション | VLMが選ぶtop tilesと人間採用の差分理由が説明できる |

最初に試すべき1つは **A. VLM多軸スコア方式**。

理由:

- 既存 pipeline のVLM passに一番近く、実装差分が小さい。
- APIコストは、現在の `gemini-2.5-flash-lite` 前提ではほぼ問題にならない。
- triage agent が今すぐ読める structured signal になる。
- `segments.json` に閉じれば、`selects_candidates.yaml` の closed schema をすぐ壊さない。
- B/C/DはAの補正・校正として後から重ねやすい。

## 5. 具体的な設計提案

### 5.1 artifact placement

短期:

- `03_analysis/segments.json`:
  - optional `visual_quality` subtree を追加。
  - `summary` は残す。
  - `peak_analysis` とは別にする。peak は「時刻」、visual_quality は「画の質」。
- `04_plan/selects_candidates.yaml`:
  - 既存schemaの範囲では `editorial_signals.visual_tags`, `face_detected`, `semantic_cluster_id`, peak系のみmaterialize。
  - `light_quality` 等をcandidateに持つのは schema拡張後。

中期:

- `selects-candidates.schema.json` / TS型に以下を追加する案。

```ts
editorial_signals?: {
  light_quality_score?: number;
  subject_prominence_score?: number;
  emotional_expression_score?: number;
  composition_score?: number;
  motion_quality_score?: number;
  narrative_necessity_score?: number;
  uniqueness_score?: number;
  visual_tags?: string[];
  semantic_cluster_id?: string;
}
```

ただし `additionalProperties: false` のため、schema・types・validator・fixturesを同時に更新する必要がある。

### 5.2 scoring semantics

scoreは「美的真実」ではなく、編集判断の補助として扱う。

推奨:

- `0.80-1.00`: strong. 候補選定/hero採用の理由に使える。
- `0.60-0.79`: usable. beat適合や重複状況次第で採用。
- `0.40-0.59`: weak/advisory. 他signalが強い時のみ採用。
- `<0.40`: negative or absent signal.

VLM prompt では、各scoreに rubric anchor を入れる。

例:

- `light_quality=0.9`: directional, warm/expressive, subject separation, controlled highlights.
- `subject_prominence=0.9`: intended subject is immediately clear, sharp, and visually dominant.
- `composition_score=0.9`: strong balance, clean background, clear geometry, intentional framing.
- `emotional_expression=0.9`: visible face/body reaction with clear emotional valence.
- `motion_quality=0.9`: readable action arc, graceful/decisive movement, good anticipation/follow-through.

### 5.3 triageへの渡し方

triage agent には raw summary の羅列ではなく、候補ごとに次の compact view を渡す。

```yaml
segment_id: SEG_AST_567028AD_0001
summary: "A child successfully rides a bicycle for the first time, cheered on by an adult."
visual_quality:
  light_quality: 0.62
  subject_prominence: 0.81
  emotional_expression: 0.76
  composition_score: 0.58
  motion_quality: 0.84
  evidence:
    - "child and bicycle are clearly visible"
    - "success reaction is visible near the peak"
peak:
  type: action_peak
  fused_peak_score: 0.695
  recommended_in_out: [13033749, 17378333]
project_relative:
  semantic_cluster_id: bicycle_success_daylight
  rarity_score: 0.42
intent_relative:
  candidate_beats: [pride, warmth]
  must_have_support: [first_successful_bicycle_ride]
```

これにより agent は「自転車に乗っている」という summary だけでなく、「成功の瞬間が見える」「主被写体が明確」「同クラスタが多いので最良候補だけ採る」と判断できる。

## 6. 検証計画

最小eval:

1. fumoto-growth / togakushi-camp の既存 `segments.json` に対し、手作業または一時スクリプトで `visual_quality` を生成する。
2. 人間採用26本との overlap を比較する。
3. 以下の指標を見る。
   - top-N visual_quality recall
   - selected vs rejected の score distribution
   - cluster coverage
   - title/end screen除外後の density
   - `light_quality` / `emotional_expression` / `composition_score` の human-picked lift
4. 失敗例を分類する。
   - VLMが表情を読めなかった
   - summaryは似ているが画として差がある
   - uniquenessが未計算で重複した
   - narrative_necessityがbriefとずれた

合格ライン:

- 現行summary-onlyより human overlap が改善する。
- overlapが大きく改善しなくても、human pick の理由を説明する signal が増える。
- `selects_candidates.yaml` の schema安定性を壊さない。

## 7. 参照

Repo内:

- `schemas/selects-candidates.schema.json`
- `runtime/pipeline/stages/vlm.ts`
- `runtime/pipeline/stages/peak.ts`
- `runtime/connectors/gemini-vlm.ts`
- `runtime/connectors/vlm-peak-detector.ts`
- `runtime/artifacts/peak-materialization.ts`
- `runtime/analysis-defaults.yaml`
- `docs/vlm-peak-detection-design.md`
- `reports/eval/regen-scratch/fumoto-growth/03_analysis/segments.json`
- `reports/eval/regen-scratch/fumoto-growth/04_plan/selects_candidates.yaml`

External:

- Google Gemini API pricing: <https://ai.google.dev/gemini-api/docs/pricing>
- Apple Vision `DetectFaceCaptureQualityRequest`: <https://developer.apple.com/documentation/vision/detectfacecapturequalityrequest>
- Apple Vision `DetectFaceLandmarksRequest`: <https://developer.apple.com/documentation/vision/detectfacelandmarksrequest>
- Apple Vision `TrackOpticalFlowRequest`: <https://developer.apple.com/documentation/vision/trackopticalflowrequest>
- OpenCV Laplace Operator: <https://docs.opencv.org/4.x/d5/db5/tutorial_laplace_operator.html>
- OpenCV Cascade Classifier: <https://docs.opencv.org/4.x/db/d28/tutorial_cascade_classifier.html>
- MARLIN official implementation: <https://github.com/ControlNet/MARLIN>
- MARLIN CVPR 2023 paper: <https://openaccess.thecvf.com/content/CVPR2023/html/Cai_MARLIN_Masked_Autoencoder_for_Facial_Video_Representation_LearnINg_CVPR_2023_paper.html>
