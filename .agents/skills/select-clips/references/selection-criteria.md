# Selection Criteria

`select-clips` が素材選定で使う判断基準。
ここでの score は reasoning 用の作業スコアであり、**現行 schema が許可しない key をそのまま YAML に書いてはいけない。**

## 1. 必須選定基準

### 1.1 `must_have` の扱い

- brief の `must_have[i]` ごとに、対応する `segment_id` / `candidate` を最低 1 つ特定する
- `why_it_matches` には「なぜその must-have を満たすか」を明記する
- 可能なら `evidence` に `brief.must_have[i]` を入れて trace を残す
- 1 つの candidate で複数の `must_have` を満たしてもよいが、coverage が薄くなるなら別 candidate も残す
- 該当素材が見つからない場合は捏造せず、`selection_notes` に欠落を書く

### 1.2 `must_avoid` の扱い

- brief の `must_avoid[i]` に該当する scene / line / framing は positive candidate に入れない
- operator に exclusion を見せる必要がある場合は `role: reject` にし、`rejection_reason` を必ず書く
- `evidence` には `brief.must_avoid[i]` と、該当根拠になった transcript / tag / visual cue を残す

## 2. 品質スコアリング

以下は ranking 用の作業スコア。数値が analysis artifact から取れない場合は、無理に invent せず定性的に判断する。

### 2.1 `peak_strength_score`

- 優先ソースは `segment.peak_analysis.support_signals.fused_peak_score`
- 別 branch / helper が `candidate.editorial_signals.peak_strength_score` を already surface している場合はそれを使ってよい
- `recommended_in_out` を採るか、peak-centered trim を採るかの主要判断材料にする
- hook や payoff 候補では高い peak を優先する

### 2.2 `speech_intensity_score`

- interview / testimonial 系では、強い line landing がある candidate を優先する
- 既に analysis helper や candidate proposal が `speech_intensity_score` を出しているなら使う
- 数値が無い場合は transcript の decisive line, emotional turn, informational value を見て定性的に比較する

### 2.3 `visual_energy_score`

- 現行 schema に `visual_energy_score` は無いので、**reasoning 用の内部スコアとしてだけ使う**
- 根拠は `segment.peak_analysis.visual_energy_curve`
- action / movement / reveal の candidate では、peak 周辺の energy が立っているものを優先する
- flat な素材は texture / transition 向けには有効だが、hook 候補としては優先度を下げる

### 2.4 `silence_ratio`

- 現行 schema が許可する `editorial_signals.silence_ratio` は、breath, hold, reset, closing の判断材料になる
- closing や余韻の beat では silence が高い candidate が効く場合がある
- hook や thesis line では silence が高すぎると momentum を落とす

### 2.5 優先度付けロジック

候補の優先順位は次の順で決める。

1. `must_have` を満たしているか
2. `must_avoid` / reject 条件に引っかからないか
3. message / audience / emotion curve への寄与があるか
4. peak / speech / visual energy などの salience があるか
5. 技術品質に致命傷がないか
6. coverage と diversity を壊していないか

`semantic_rank` はこの優先順位を YAML に写したものとして使う。

## 3. カバレッジ基準

### 3.1 時系列カバレッジ

- 素材の前半だけ、あるいは終盤だけに寄らない
- brief が chronology 重視でなくても、選択肢全体としては時期の偏りを避ける
- 同一 asset の連続採用しか無い状態は避ける

### 3.2 多様性

- 同じアングル、同じ行動、同じセリフ landing の候補を並べすぎない
- 同一 scene の別テイクは最良テイクを positive candidate にし、他は reject か omission に回す
- 近似候補を残す場合は、役割が違うことを `why_it_matches` で説明する

### 3.3 ビート配分

- opening / hook に置ける候補を最低 1 つは確保する
- middle / experience を支える movement, support, dialogue を持たせる
- closing / release に置ける余韻や resolve 候補を残す
- `eligible_beats` を使う場合は、hook / experience / closing のどこに置けるかを一貫した bucket で示す

## 4. `trim_hint` 設定ガイド

`trim_hint` は peak center ベースで組む。優先順位は次の通り。

1. `peak_analysis.recommended_in_out`
2. `peak_analysis.peak_moments[]` の highest-confidence peak
3. transcript / contact sheet 由来の明確な payoff
4. midpoint fallback

### 4.1 基本ルール

- `source_center_us` は選んだ peak の `timestamp_us`
- `interest_point_label` は `description` を優先し、無ければ `type`
- `interest_point_confidence` は選んだ peak の `confidence`
- `preferred_duration_us` は「実際に使いたい尺」
- `window_start_us` / `window_end_us` は authored `src_in_us` / `src_out_us` の hard clamp 内に置く

### 4.2 peak center の使い分け

- アクション系:
  peak 前の助走を見せるため、pre-roll を長めに取る
- 感情系 / リアクション系:
  peak 後の表情や余韻を残すため、post-roll を長めに取る
- dialogue / decisive line:
  line landing を center に置き、語尾と呼吸が切れないように post-roll を少し残す
- visual reveal / texture:
  reveal completion と hold を優先し、flat midpoint を避ける

### 4.3 `recommended_in_out` がある場合

- `support_signals.fused_peak_score >= 0.70` なら `best_in_us` / `best_out_us` を第一候補にする
- それより広い safety window が必要なときだけ広げる
- override した場合は `why_it_matches` か `selection_notes` で理由を残す
