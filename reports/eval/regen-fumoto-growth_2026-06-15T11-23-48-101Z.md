# Creative regeneration — selects agreement

- golden (human): `fumoto-growth`
- candidate (regenerated): `fumoto-autonomous`
- evaluated_at: 2026-06-15T11:23:48.101Z

## Scores
- **composite: 81.7 / 100**
- selection F1: 90.9% (precision 95.2%, recall 87.0%)
- role agreement (matched): 60.0%
- rank correlation: 0.392
- beat-eligibility overlap: n/a
- counts: golden 23, candidate 21, matched 20

## Coverage
- **score: 100.0 / 100**
- runtime selected/target: 531.1s / 256.0s (207.4%)
- roles: hero 9, support 11, texture 0, transition 1, dialogue 0
- density: 21/32 (65.6%)
- dense clusters under-sampled: 0
- gaps: none

## ❗ Missed critical moments (1)
Human treated these as essential (must-have or hero-role); the AI did not select them. Highest-priority gap.
- SEG_AST_66F572EB_0001 [hero] (conf 0.9): “ご視聴ありがとうございました 余ってる。 おやすみなさい。 ん” — why: training wheels debut marks the beginning of the bicycle journey «hero»

## Missed moments (2)
Human selected, AI omitted (supporting/texture).
- SEG_AST_8BDBBA9F_0001 [support] (conf 0.86): “ご視聴ありがとうございました 時間が Lamabe 2rit 着ても 上降にをます おっとっと” — why: confident bicycle riding shows skill consolidation
- SEG_AST_DF524E7F_0001 [support] (conf 0.84): “2分間 2分間 2分間 3分間 3分間 4分間 4分間 指W ちょっとここのより搬送版が多い 활回したんば Comics おやすみなさい ご視聴ありがとうございました” — why: later training wheels footage shows the long arc of learning before mastery

## Added moments (1)
AI selected, human did not. Could be a defensible alternative or noise.
- SEG_AST_34EA5E88_0001 [transition] (conf 0.9): “ご視聴ありがとうございました” — why: 日本語のテキストと感謝のメッセージが表示されるタイトルカード/クロージングスクリーン。動画のフェードアウトで終わる要件を満たすための明確なエンディングとして選定しました。
