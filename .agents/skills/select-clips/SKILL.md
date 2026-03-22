---
name: select-clips
description: "MUST USE when 01_intent/creative_brief.yaml and 03_analysis artifacts exist and the user asks to choose clips, extract candidate segments, run triage, or build 04_plan/selects_candidates.yaml. Use before /blueprint whenever selects are missing, and re-run when the brief or analysis changes."
metadata:
  filePattern:
    - '**/04_plan/selects_candidates.yaml'
  bashPattern: []
---
# select-clips — 素材選定

## いつ使うか（必ず発火する条件）

- ユーザーが「クリップを選んで」「候補を抽出して」「triage して」「selects を作って」と言ったとき
- `01_intent/creative_brief.yaml` と `03_analysis/assets.json` / `segments.json` が揃っていて、`04_plan/selects_candidates.yaml` を作るとき
- `full-pipeline` の Step 4 として呼ばれたとき
- brief 更新後、analysis 更新後、あるいは must_have / must_avoid の解釈をやり直す必要があるとき

**このスキルを省略してはいけない。** brief と analysis があっても selects が無ければ、`/blueprint` は must-have tracing、reject 判断、coverage 判断を失う。

## 前提条件

- `schemas/selects-candidates.schema.json` を守ること
- `runtime/commands/triage.ts` の prerequisite に合わせ、analysis artifacts が揃い、analysis gate が `blocked` でないこと
- `01_intent/creative_brief.yaml` が存在すること
- 主 evidence は `03_analysis/assets.json`, `03_analysis/segments.json`, `transcripts`, `contact_sheets`, `filmstrips`, `quality_flags`, `peak_analysis`
- 先に `references/selection-criteria.md` と `references/reject-patterns.md` を読み、判断基準を固定してから候補を書き始めること

## やること（ステップ）

### Step 1: brief を selection obligations に変換する

- brief の `message`, `audience`, `emotion_curve`, `must_have`, `must_avoid` を読む
- 各 `must_have[i]` について、どの `segment_id` / `candidate` がそれを満たすかを先に特定する
- `must_have` を満たす候補には、可能な限り `evidence` に `brief.must_have[i]` を入れて trace できる状態にする
- `must_avoid[i]` に該当する素材は positive candidate に入れない。除外理由を残したい場合は `role: reject` にし、`rejection_reason` と `evidence: ["brief.must_avoid[i]"]` を付ける
- どの `must_have` にも対応できる素材が見つからない場合は、黙って埋めずに `selection_notes` へ欠落を書く。必要なら human clarification 前提で止める

### Step 2: analysis artifacts から候補を集める

- `assets.json` で asset landscape と asset-level `quality_flags` を確認する
- `segments.json` で各 segment の `summary`, `transcript_excerpt`, `quality_flags`, `tags`, `peak_analysis` を確認する
- transcript-backed dialogue は transcript で line を再確認する
- must-have 該当や曖昧な segment は `contact_sheets` / `filmstrips` で visual confirmation する
- `message` / `audience` / `emotion_curve` に寄与しない素材は無理に採らない

### Step 3: reject を先に確定する

- `references/reject-patterns.md` を使い、must_avoid, 技術的 NG, privacy, duplicate を先にふるい落とす
- `must_avoid` に該当する素材は `role: reject` を優先する。単なる不採用ではなく、「避けるべき理由がある」と operator に分かる形で残す
- 技術的に致命的な素材、対象外人物や秘匿情報が映る素材、同一シーンの劣後テイクは positive candidate から外す
- 軽微な欠点は即 reject にせず、`risks` や `quality_flags` に残して候補として残してよい

### Step 4: peak-aware で in/out と trim_hint を決める

- `peak_analysis` がある segment では、手書きで平坦な midpoint を置かず、peak evidence を優先する
- `peak_analysis.recommended_in_out` があり、`peak_analysis.support_signals.fused_peak_score >= 0.70` のときは、`best_in_us` / `best_out_us` を authored window の第一候補にする
- それ以外では、`peak_analysis.peak_moments[]` の中から最も強い payoff moment を 1 つ選び、その timestamp を基準に `src_in_us` / `src_out_us` を決める
- 近接した同型 peak が複数ある場合は別 candidate を乱造せず、1 つの editorial moment としてまとめる
- `trim_hint.source_center_us` は選んだ peak の timestamp に合わせる
- `trim_hint.interest_point_label` は `peak_moments[].description` を優先し、無ければ `type` を使う
- `trim_hint.interest_point_confidence` は選んだ peak の `confidence` を使う
- `trim_hint.window_start_us` / `window_end_us` は authored `src_in_us` / `src_out_us` の範囲内に置く。`runTriage()` は clamp するが、無効値を前提にしない
- `trim_hint.preferred_duration_us` は peak を含む「使いたい尺」を表す。アクション系は peak 前を長め、感情系やリアクション系は peak 後を長めに取る
- `peak_analysis` が無い場合だけ、transcript / contact sheet / visual tags を根拠に in/out を決める

### Step 5: 優先度付けと coverage を決める

- `references/selection-criteria.md` の順に、must-have充足 → reject除外 → 品質 → coverage → diversity で順位を付ける
- `semantic_rank` は「なんとなく」ではなく、その時点の優先順位を反映して単調に振る
- `eligible_beats` は schema 上 optional だが、`runtime/compiler/score.ts` と `runtime/script/read.ts` が参照するため、可能なら必ず付ける
- hook / experience / closing に置ける候補が偏らないようにする
- 同じ `asset_id` や同じ scene の近似候補ばかりに寄せない

### Step 6: selects_candidates.yaml を書く

- 各 candidate の必須項目は `segment_id`, `asset_id`, `src_in_us`, `src_out_us`, `role`, `why_it_matches`, `risks`, `confidence`
- `selection_notes` と `editorial_summary` に、must-have の充足状況、reject の方針、coverage 上の意図を短く残す
- reject 候補を入れる場合は `role: reject` にして `rejection_reason` を必ず入れる
- `candidate_id` は optional。自信がなければ省略してよく、`runtime/commands/triage.ts` が canonicalize 時に deterministic に補完する

## 出力 artifact
- `04_plan/selects_candidates.yaml`

## 注意事項

- `src_in_us < src_out_us` を守る。schema だけではなく validator でも落ちる
- `asset_id` は `03_analysis/assets.json` に存在するものだけを使う
- unsupported field を invent しない。特にこの repo の `schemas/selects-candidates.schema.json` は peak-aware extension の一部をまだ許可していないため、reasoning に使った score をそのまま未定義 key で書かない
- `trim_hint` は optional だが、あると compiler の adaptive trim が働きやすい
