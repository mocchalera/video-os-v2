# Creative regeneration — selects agreement

- golden (human): `fumoto-growth`
- candidate (regenerated): `fumoto-coverage-guided`
- evaluated_at: 2026-06-15T07:28:33.577Z

## Scores
- **composite: 70.7 / 100**
- selection F1: 88.4% (precision 95.0%, recall 82.6%)
- role agreement (matched): 47.4%
- rank correlation: 0.632
- beat-eligibility overlap: 0.0%
- counts: golden 23, candidate 20, matched 19

## Coverage
- **score: 100.0 / 100**
- runtime selected/target: 82.7s / 256.0s (32.3%)
- roles: hero 7, support 4, texture 8, transition 1, dialogue 0
- density: 20/32 (62.5%)
- dense clusters under-sampled: 0
- gaps:
  - must_have uncertain: 時系列順の成長過程
  - must_have uncertain: 歩行の初めての瞬間
  - must_have uncertain: 走る楽しさ
  - must_have uncertain: ストライダーに乗る姿
  - must_have uncertain: 自転車に乗れた達成シーン
  - must_have uncertain: 撮影日テロップ（YYYY.MM形式）
  - must_have uncertain: 心温まるコメントテロップ（控えめに）
  - must_have uncertain: 動画の声・環境音のミックス
  - must_have uncertain: フェードアウトで終わる

## ❗ Missed critical moments (1)
Human treated these as essential (must-have or hero-role); the AI did not select them. Highest-priority gap.
- SEG_AST_66F572EB_0001 [hero] (conf 0.9): “ご視聴ありがとうございました 余ってる。 おやすみなさい。 ん” — why: training wheels debut marks the beginning of the bicycle journey «hero»

## Missed moments (3)
Human selected, AI omitted (supporting/texture).
- SEG_AST_7EC7D225_0001 [texture] (conf 0.85): “帯へ 大昇 あー いっ いっ です 今 おやすみなさい。 あ” — why: indoor bedtime scene provides warmth and domestic texture for the early growth period
- SEG_AST_0C9FA88A_0001 [texture] (conf 0.8): “おやすみなさい。” — why: short transitional clip bridging training wheels to next phase
- SEG_AST_DF524E7F_0001 [support] (conf 0.84): “2分間 2分間 2分間 3分間 3分間 4分間 4分間 指W ちょっとここのより搬送版が多い 활回したんば Comics おやすみなさい ご視聴ありがとうございました” — why: later training wheels footage shows the long arc of learning before mastery

## Added moments (1)
AI selected, human did not. Could be a defensible alternative or noise.
- SEG_AST_2F5B86AF_0001 [transition] (conf 0.84): “音楽 作詞・作曲・編曲 初音ミク 君の靴音 一つ分 朝靄の向こう 白い叩き 呼ばれたような風が吹く 言えないことを抱えて 描いたまま 土の匂いに紛れてく 小さな影をつれながら 坂はゆっくり続いてる 怖さはきっと消えないまま それでも空は 解けてく 泣いた後の空の色 身のもに滲む光 遠い世界に触れる度 ご視聴ありがとうございました 登って行け 麓から衝動のまま深く深くなれ 峠の向こうで待つ者はまだ誰の思うでもない空 ご視聴ありがとうございました この先へ行きたくなる 転んだ膝の痛みより 峠の向こうが気になってる こぼした声もそのままで 君は斜面を越えていく 大きな山を越えなくていいさ 最初はただのサーカーで 雪どけみたいに一歩ずつ 知りたい方へ続いてく 昇ってゆけ風の中 まだ柔らかな朝の方へ 高くなる夜をドゥ 広くなれ君の光を滲ませ ご視聴ありがとうございました 雪解け水が鳴っている 白い叩き黙っている 始まりはいつも 麓から” — why: Bicycle learning footage with the project music
