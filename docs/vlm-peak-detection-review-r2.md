# VLM ピーク検出 設計レビュー R2

## 判定

- Result: CONDITIONAL PASS
- FATAL: 0
- WARNING: 2
- NOTE: 3

## Findings

### WARNING 1: Refine pass の `coarse_hint` に tile index の名前空間衝突が残っている

- 対象: `docs/vlm-peak-detection-design.md:343-348`, `docs/vlm-peak-detection-design.md:473-475`
- 問題: Pass 2 は segment-level `filmstrip_tile_map` を見ながら、別系統である Pass 1 の coarse hint を `tile_start_index / tile_end_index` の生名で受け取ります。ここでは contact sheet の tile index と filmstrip の 6-tile index が別空間ですが、その区別が prompt/input contract 上で明示されていません。
- 影響: connector 実装や provider prompt が coarse hint を filmstrip 側 index と誤読すると、refine pass の文脈がぶれます。設計全体は成立していますが、ここは実装者依存の解釈差が出やすい箇所です。
- 修正: Pass 2 に渡す coarse hint は `coarse_window_start_us / coarse_window_end_us` へ正規化するか、どうしても index を残すなら `coarse_contact_sheet_tile_start_index` / `coarse_contact_sheet_tile_end_index` のように名前空間を分けてください。

### WARNING 2: provider response の単数 `peak_moment` と canonical `peak_moments[]` の写像が明文化し切れていない

- 対象: `docs/vlm-peak-detection-design.md:173-181`, `docs/vlm-peak-detection-design.md:351-354`, `docs/vlm-peak-detection-design.md:491-515`, `docs/vlm-peak-detection-design.md:535-545`, `docs/vlm-peak-detection-design.md:591-595`
- 問題: canonical artifact 側は `peak_moments[]` を前提にしていますが、refine / precision prompt の provider response は単数 `peak_moment` です。`Provider Response -> Canonical Artifact` 章には正規化の方向性がありますが、`peak_moment -> peak_moments[0]` をどう包むか、precision pass が既存要素を置換するのか append するのかが一文で固定されていません。
- 影響: normalize 実装とテストがレイヤーごとに微妙にずれやすく、fixture/golden の期待 shape がぶれる可能性があります。
- 修正: `9.1 Normalization Rules` に「Pass 2/3 の単数 `peak_moment` は canonical `peak_moments[]` の先頭要素へ正規化する。precision pass 実行時は同一 `peak_ref` を置換し、array を増やさない」のような明示を追加してください。

## Notes

### NOTE 1: Progressive Resolution は R1 の主要 FATAL を解消している

- 根拠: `docs/vlm-peak-detection-design.md:82-95`, `docs/vlm-peak-detection-design.md:116-145`, `docs/vlm-peak-detection-design.md:314-377`
- 評価: `contact_sheet -> filmstrip -> precision` の責務分離が明確です。coarse pass は tile span に限定し exact timestamp を canonicalize しないため、R1 で問題だった「粗い入力に精密 timestamp を要求する」ねじれも解消されています。

### NOTE 2: strict schema 拡張は additive に整理され、既存 contract を壊さない方針になった

- 根拠: `docs/vlm-peak-detection-design.md:106-113`, `docs/vlm-peak-detection-design.md:149-218`, `docs/vlm-peak-detection-design.md:258-302`, `docs/vlm-peak-detection-design.md:955-962`
- 既存事実: 現行 `segments.schema.json` の `confidence` / `provenance` は closed object です `schemas/segments.schema.json:63-100`。現行 `timeline-ir.schema.json` の `provenance` も closed object です `schemas/timeline-ir.schema.json:113-144`。
- 評価: 今回の版は peak-specific 情報を root `confidence` / root `provenance` / `timelineIR.provenance` に足さず、`segments.json.peak_analysis` と `clip.metadata.*` に隔離しています。この整理なら additive extension として通せます。

### NOTE 3: audio support の optional 化と metadata merge rules の明文化は十分

- 根拠: `docs/vlm-peak-detection-design.md:292-302`, `docs/vlm-peak-detection-design.md:601-620`, `docs/vlm-peak-detection-design.md:825-853`, `docs/vlm-peak-detection-design.md:991-995`
- 既存事実: 現行 `timeline-ir.schema.json` は `clip.metadata` を object として許可しています `schemas/timeline-ir.schema.json:285-287`。一方、現行 compiler は `editorial` object を丸ごと代入する実装なので `runtime/compiler/index.ts:145-166`、設計側で merge 契約を明文化したのは妥当です。
- 評価: `audio support が無い場合` の融合式を別立てにし、Phase 5b に分離したことで optional 扱いが明確になりました。`clip.metadata.trim` 専有、`clip.metadata.editorial` deep merge、`editorial.peak` 限定更新という書き分けも十分に具体的です。

## 結論

R2 では R1 の 2 件の FATAL は解消されています。特に、M2 artifact を使う Progressive Resolution と、strict schema を壊さない peak-specific subtree への隔離は設計として通ります。

残る 2 件はいずれも contract の表現粒度に関する WARNING であり、現時点では FAIL 要因ではありません。したがって本レビューの判定は `CONDITIONAL PASS` です。
