# VLM ピーク検出 設計レビュー

## 判定

- FATAL: 2
- WARNING: 4
- NOTE: 2

## Findings

### FATAL 1: M2 の contact sheet / filmstrip を VLM 入力に使う設計が欠落している

- 対象: `docs/vlm-peak-detection-design.md:95-116`, `docs/vlm-peak-detection-design.md:233-250`, `docs/vlm-peak-detection-design.md:255-316`
- 問題: 設計書の end-to-end flow と two-pass 入力は一貫して「segment 全体の sampled frames」または「dense frame bundle」だけを前提にしており、M2 で既に生成済みの `03_analysis/contact_sheets/*.png` と `03_analysis/filmstrips/*.png` を coarse/refine pass の主入力として使う記述がありません。
- 既存事実: contact sheet は M2 の正式成果物であり、asset 全体を俯瞰する manifest 付き derivative です `docs/milestone-2-design.md:357-376`。filmstrip も segment ごとの deterministic derivative です `docs/milestone-2-design.md:396-409`。実装でも ingest が contact sheet / filmstrip を生成して segments/assets に反映しています `runtime/pipeline/ingest.ts:305-360`。architecture でも `media_analyzed` への遷移条件に contact sheets ready が入っています `ARCHITECTURE.md:187-188`。MCP contract も `media.open_contact_sheet` と `filmstrip_path` を既に持っています `contracts/media-mcp.md:114-145`, `contracts/media-mcp.md:224-240`。
- 影響: 個別フレームだけでは asset 全体の流れと peak の位置関係を VLM が把握しづらく、coarse discovery の効率と精度が落ちます。特に coarse pass は本来 `media.open_contact_sheet(mode: "overview")` で全体俯瞰し、refine pass は `filmstrip_path` で segment 内の運動変化を見るべきです。現状設計は M2 artifact の最大の利点を捨てています。
- 修正: Pass A を asset-level coarse discovery に変更し、第一入力を contact sheet にしてください。Pass B は segment-level refine とし、第一入力を filmstrip、必要時のみ dense frames / proxy clip にフォールバックしてください。connector interface にも `contact_sheet`, `filmstrip`, `sampled_frames`, `proxy_clip` を区別した入力設計を追加する必要があります。

### FATAL 2: strict schema を壊す追加フィールドが未整理のまま入っている

- 対象: `docs/vlm-peak-detection-design.md:92-93`, `docs/vlm-peak-detection-design.md:286-315`, `docs/vlm-peak-detection-design.md:576`, `docs/vlm-peak-detection-design.md:714-719`
- 問題: 設計書は `confidence.peak_detection` を prompt の repository-compatible shape に含めていますが、現行 `segments.schema.json` の `confidence` は `summary / tags / quality_flags` しか許可していません `schemas/segments.schema.json:63-79`。また prompt hash / fusion version / ffmpeg version を provenance に残す設計ですが、`segments.schema.json` の `provenance` キーも固定です `schemas/segments.schema.json:81-100`。さらに `timelineIR.provenance` に `peak_fusion_version` を足す提案がありますが、現行 schema/type は strict でそのキーを許可していません `schemas/timeline-ir.schema.json:113-143`, `runtime/compiler/types.ts:348-355`。
- 影響: 設計どおりに実装すると `segments.json` と `timeline.json` の schema validation を壊します。判定基準の「既存契約破壊」に該当します。
- 修正: Phase 1 で更新対象を `segments.schema.json` と `selects-candidates.schema.json` だけに限定せず、少なくとも `schemas/timeline-ir.schema.json` と `runtime/compiler/types.ts` まで含めて明示してください。`confidence.peak_detection` を本当に canonical に残すなら schema を追加するか、`peak_analysis.confidence` のような新しい strict subtree に隔離するべきです。provenance も既存 object に直接足すのではなく `peak_analysis.provenance` か schema で許可された新 field に整理してください。

### WARNING 1: coarse pass に exact microsecond を要求しており、入力解像度と要求精度が噛み合っていない

- 対象: `docs/vlm-peak-detection-design.md:237-248`, `docs/vlm-peak-detection-design.md:267-270`
- 根拠: 現行 connector の sampled frame 取得は evenly spaced timestamp です `runtime/connectors/gemini-vlm.ts:221-241`。その状態で coarse pass に「exact source timestamps in microseconds」を返させても、VLM は未観測フレームの apex を知りません。
- 影響: coarse pass の timestamp が疑似的な精度を持つだけになり、downstream で `trim_hint.source_center_us` として過信される危険があります。
- 修正: Pass A の出力は `coarse_peak_window` または `nearest_sample_timestamp_us + uncertainty_us` に落とし、exact center は Pass B の責務に分離してください。contact sheet を使うならなおさら coarse は ranking と narrowing に徹するべきです。

### WARNING 2: refine pass の multimodal 入力契約が connector 設計に落ちていない

- 対象: `docs/vlm-peak-detection-design.md:247-250`, `docs/vlm-peak-detection-design.md:723-725`
- 根拠: 現行 `VlmFn` は `framePaths: string[]` を受けるだけで `contact_sheet` / `filmstrip` / `proxy_clip` の区別を持ちません `runtime/connectors/gemini-vlm.ts:130-145`。実装も inline image data のみを POST しています `runtime/connectors/gemini-vlm.ts:557-587`。
- 影響: 設計の two-pass は概念としては妥当でも、connector contract を先に versioning しないと Pass B の provider capability 分岐を実装できません。
- 修正: `VlmInput` を union にしてください。最低でも `type: "contact_sheet" | "filmstrip" | "frames" | "proxy_clip"` と provenance を持つ入力オブジェクトにし、provider 側 capability も `supports_video_input` などで明示するべきです。

### WARNING 3: ffmpeg motion は現実的だが、audio support は「既存 artifact 再利用」の前提が強すぎる

- 対象: `docs/vlm-peak-detection-design.md:598-609`, `docs/vlm-peak-detection-design.md:740-744`
- 根拠: `audio-events.json` の schema 自体はあります `schemas/audio-events.schema.json:1-80`。ただし repository 内の runtime 参照は見当たらず、少なくとも今回の参照実装群の中には producer / consumer がありません。
- 影響: motion energy curve は ffmpeg base layer 再利用で現実的ですが、audio events まで Phase 5 の同じ粒度で積むと実装量を過小評価します。
- 修正: Phase 5 は `RMS/peak envelope + optional speech_end proximity` を first cut にし、`audio-events.json` 連携は Phase 5b へ分離した方が安全です。設計書の「existing `audio-events.json`」は「schema はあるが runtime 実装は別途必要」と書き換えるべきです。

### WARNING 4: compiler metadata handoff の merge 条件を明示しないと peak provenance を上書きしやすい

- 対象: `docs/vlm-peak-detection-design.md:220`, `docs/vlm-peak-detection-design.md:529-576`
- 根拠: 現行 compiler は trim 後に `clip.metadata.trim` を付け、別フェーズで `clip.metadata.editorial` を付与します `runtime/compiler/trim.ts:232-241`, `runtime/compiler/index.ts:141-166`。`index.ts` は `editorial` object を丸ごと代入しており、同じ key space に peak metadata を後から載せると merge order 次第で欠落します。
- 影響: `primary_peak_ref` や `peak_summary` を追加しても、active skills あり/なしで metadata shape が揺れる可能性があります。
- 修正: 設計書に `clip.metadata.editorial` は shallow merge ではなく deterministic merge rule を持つと明記してください。lookup key を `candidate_ref` に寄せる方針自体は正しいですが、metadata write order も契約化した方が安全です。

## Notes

### NOTE 1: `peak_moments -> selects -> compiler` の handoff 方針自体は実現可能

- 根拠: architecture は canonical artifact 境界と strict schema 方針を明確にしています `ARCHITECTURE.md:157-180`。設計書も raw peak 情報を compiler に直接渡さず、`/triage` が `trim_hint` と `editorial_signals` に materialize して handoff する方針で揃っています `docs/vlm-peak-detection-design.md:80-84`, `docs/vlm-peak-detection-design.md:169-200`。
- 補足: `candidate_ref` 系の基盤は既にあり、assemble/export も保持しています `runtime/compiler/candidate-ref.ts:45-67`, `runtime/compiler/assemble.ts:253-269`, `runtime/compiler/export.ts:169-177`。そのため raw `segments.json` を compiler に持ち込まずに handoff する設計は妥当です。

### NOTE 2: peak-centered asymmetry の方向性は妥当

- 対象: `docs/vlm-peak-detection-design.md:537-567`
- 評価: `action_peak` を pre-roll 長め、`emotional_peak` を post-roll 長め、`visual_peak` をやや post-roll 長めにする初期 prior は自然です。現行 `trim.ts` も center-based trim と clamp の枠組みを既に持っているため、局所的な拡張で入れられます `runtime/compiler/trim.ts:75-160`。
- 条件: ただし coarse pass の疑似精密 timestamp をそのまま center にしないことが前提です。exact center を refine pass か deterministic local search で詰める設計にして初めて、この asymmetry は効きます。

## 実装順序の修正提案

1. Phase 1 を再定義し、schema/type contract を先に固定する。
2. 同じ Phase 1 に connector input contract の拡張を入れる。
3. Phase 2 で contact sheet coarse pass と filmstrip refine pass を導入する。
4. Phase 3 で `/triage` が `peak_analysis` を `trim_hint` / `editorial_signals` に materialize する。
5. Phase 4 で `score.ts` / `trim.ts` / metadata merge / candidate_ref lookup をまとめて入れる。
6. Phase 5 で motion support、Phase 5b で audio semantic support を入れる。

## 結論

設計の狙い自体は良く、`peak_moments -> selects -> compiler` の責務分離も正しいです。ただし今の版は、最重要の M2 artifact 活用が抜けている点と、strict schema を壊す追加フィールドが未整理な点で、そのままでは通せません。まず `contact_sheet / filmstrip` を主入力に据え直し、contract 更新範囲を `segments/selects` だけでなく `timeline-ir` と compiler types まで明示してください。
