# Creative regeneration — selects agreement

- golden (human): `fumoto-growth`
- candidate (regenerated): `fumoto-growth`
- evaluated_at: 2026-06-15T07:21:03.748Z

## Scores
- **composite: 57.6 / 100**
- selection F1: 72.2% (precision 100.0%, recall 56.5%)
- role agreement (matched): 46.2%
- rank correlation: 0.016
- beat-eligibility overlap: 0.0%
- counts: golden 23, candidate 13, matched 13

## Coverage
- **score: 36.9 / 100**
- runtime selected/target: 352.1s / 256.0s (137.6%)
- roles: hero 4, support 7, texture 2, transition 0, dialogue 0
- density: 13/32 (40.6%)
- dense clusters under-sampled: 1
- gaps:
  - selection sparse: 13/32 segments (41%)
  - dense cluster (10 similar shots) under-sampled: picked 0/10 -- montage candidate may be missing
  - must_have uncertain: 時系列順の成長過程
  - must_have uncertain: 歩行の初めての瞬間
  - must_have uncertain: 走る楽しさ
  - must_have uncertain: ストライダーに乗る姿
  - must_have uncertain: 自転車に乗れた達成シーン
  - must_have uncertain: 撮影日テロップ（YYYY.MM形式）
  - must_have uncertain: 心温まるコメントテロップ（控えめに）
  - must_have uncertain: 動画の声・環境音のミックス
  - must_have uncertain: フェードアウトで終わる

## ❗ Missed critical moments (2)
Human treated these as essential (must-have or hero-role); the AI did not select them. Highest-priority gap.
- SEG_AST_66F572EB_0001 [hero] (conf 0.9): “ご視聴ありがとうございました 余ってる。 おやすみなさい。 ん” — why: training wheels debut marks the beginning of the bicycle journey «hero»
- SEG_AST_FB322087_0001 [hero] (conf 0.92): “ご視聴ありがとうございました ご視聴ありがとうございました ん ん ん ん ん ん” — why: confident riding into the future provides a warm forward-looking ending «hero»

## Missed moments (8)
Human selected, AI omitted (supporting/texture).
- SEG_AST_3D474C76_0001 [texture] (conf 0.88): “ん ん ん ん ん ん ん” — why: infant early days footage adds intimate texture to the birth beat
- SEG_AST_8BED5B08_0001 [support] (conf 0.85): “ツキロは18. comput” — why: training wheels practice builds the learning montage with repetition
- SEG_AST_75D600FA_0001 [support] (conf 0.83): “ỗ兩木omp 海人もたぶん 海人もたぶん” — why: additional training wheels practice reinforces the persistence theme
- SEG_AST_D60A0C89_0001 [support] (conf 0.86): “ろくže 2 ウースト 反省の隔を追是数 וו精神” — why: outdoor training wheels riding shows growing confidence in a wider environment
- SEG_AST_7E5C9A8A_0001 [support] (conf 0.82): “かわります パッパン パッキーも言ってたかったですよ うん ご視聴ありがとうございました” — why: continued bicycle with training wheels shows the ongoing learning journey
- SEG_AST_DA4D2912_0001 [texture] (conf 0.8): “こっちだめ” — why: short bicycle practice clip adds rhythm variety to the montage
- SEG_AST_8BDBBA9F_0001 [support] (conf 0.86): “ご視聴ありがとうございました 時間が Lamabe 2rit 着ても 上降にをます おっとっと” — why: confident bicycle riding shows skill consolidation
- SEG_AST_DF524E7F_0001 [support] (conf 0.84): “2分間 2分間 2分間 3分間 3分間 4分間 4分間 指W ちょっとここのより搬送版が多い 활回したんば Comics おやすみなさい ご視聴ありがとうございました” — why: later training wheels footage shows the long arc of learning before mastery

## Added moments (0)
AI selected, human did not. Could be a defensible alternative or noise.
- none.
