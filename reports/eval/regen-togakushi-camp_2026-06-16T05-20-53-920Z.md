# Creative regeneration — selects agreement

- golden (human): `togakushi-camp`
- candidate (regenerated): `togakushi-camp`
- evaluated_at: 2026-06-16T05:20:53.920Z

## Scores
- **composite: 34.4 / 100**
- selection F1: 39.2% (precision 40.0%, recall 38.5%)
- role agreement (matched): 20.0%
- rank correlation: n/a
- beat-eligibility overlap: n/a
- counts: golden 26, candidate 25, matched 10

## Coverage
- **score: 69.4 / 100**
- runtime selected/target: 363.2s / 120.0s (302.6%)
- roles: hero 21, support 4, texture 0, transition 0, dialogue 0
- density: 25/60 (41.7%)
- dense clusters under-sampled: 2
- gaps:
  - selection sparse: 25/60 segments (42%)
  - dense cluster (9 similar shots) under-sampled: picked 4/9 -- montage candidate may be missing
  - dense cluster (6 similar shots) under-sampled: picked 0/6 -- montage candidate may be missing
  - must_have uncertain: 焚き火のシーン
  - must_have uncertain: 星空
  - must_have uncertain: 子供の表情（楽しさ・発見）
  - must_have uncertain: 到着〜設営の導入
  - must_have uncertain: 朝の静かな空気感

## ❗ Missed critical moments (16)
Human treated these as essential (must-have or hero-role); the AI did not select them. Highest-priority gap.
- SEG_AST_6E4BB9B4_0001 [hero] (conf 0.95): “イース” — why: positions 3, 27 use T016 as a hero shot for Opening — Togakushi Landscape and Closing — Bookend & Farewell. «must-have»
- SEG_AST_5DFD06CE_0001 [support] (conf 0.95): “プロカメラマンやっぱりあれかな 音ミニを隠してたのかな 西条さんこのスリーハル機はちょっと” — why: position 4 uses T020 as a support shot for Day 1 — Arrival & Play. «must-have»
- SEG_AST_399510B7_0001 [support] (conf 0.95): “4万円払う 4万円払わない そんなお金ない 4万円も払えない 払う” — why: position 5 uses T018 as a support shot for Day 1 — Arrival & Play. «must-have»
- SEG_AST_7647C815_0001 [support] (conf 0.95): “音楽” — why: position 7 uses T026 as a support shot for Day 1 — Arrival & Play. «must-have»
- SEG_AST_0AD9FD1C_0001 [support] (conf 0.95): “ユニコが来てくる レイナー クリア クリア クリア ユニコにユニコが回している ユニコが映っていた ユニコが映っていた” — why: position 10 uses T035 as a support shot for Day 1 — BBQ & Campfire. «must-have»
- SEG_AST_C7D644B1_0001 [support] (conf 0.95): “あれ? 大城さんの車にあれか 飲み物とか詰んであるのか うーん! うち、おしまいは!” — why: position 11 uses T036 as a support shot for Day 1 — BBQ & Campfire. «must-have»
- SEG_AST_6793F326_0001 [support] (conf 0.95): “お邪魔します。先生、これを冷蔵庫に入れてもらっていいですか? これを冷蔵庫に入れてもらっていいですか? では、ちょっと入ってみたいと思います。 おー、すごい!” — why: position 14 uses T037 as a support shot for Day 1 — BBQ & Campfire. «must-have»
- SEG_AST_06D3223E_0001 [support] (conf 0.95): “そうそうそう なに? 役者前閉めなよ やだー! それ中のやつダサいって” — why: position 16 uses T056 as a support shot for Day 2 — Morning. «must-have»
- SEG_AST_54FA9ED0_0001 [support] (conf 0.95): “あなたはあなたを見つけたことを知っています。” — why: position 17 uses T058 as a support shot for Day 2 — Morning. «must-have»
- SEG_AST_99161EEB_0001 [support] (conf 0.95): “ああああああああ クリスワイクリス” — why: position 18 uses T062 as a support shot for Day 2 — Morning. «must-have»
- SEG_AST_038AB86F_0001 [support] (conf 0.95): “学者の髪を切った 切ったよね エロい髪型あんだ おぼっちゃみたいな すごいねー” — why: position 19 uses T001 as a support shot for Day 2 — Activity & Exploration. «must-have»
- SEG_AST_8A0FFB9A_0001 [support] (conf 0.95): “ダンの先生、日本のお店でカタログを渡してくれた 高そうですねって言われて、呼びつけたわけじゃない ダンのカッコよさを見せてあげてた” — why: position 20 uses T005 as a support shot for Day 2 — Activity & Exploration. «must-have»
- SEG_AST_F45A9E48_0001 [support] (conf 0.95): “いらないと え? ここ? ここ? ここにたんじ? ここにたんじ? ないで ついてんつい これに” — why: position 22 uses T008 as a support shot for Day 2 — Activity & Exploration. «must-have»
- SEG_AST_B254ED8B_0001 [support] (conf 0.95): “こんにちは” — why: position 23 uses T009 as a support shot for Day 2 — Activity & Exploration. «must-have»
- SEG_AST_2759B31C_0001 [support] (conf 0.95): “こういう感じこういう感じ どうやって出ていいのか分からなくなってる 何をやってるんだろう” — why: position 24 uses T010 as a support shot for Day 2 — Activity & Exploration. «must-have»
- SEG_AST_D16E3D7A_0001 [texture] (conf 0.95): “あ、いくらい みて” — why: position 28 uses T019 as a texture shot for Closing — Bookend & Farewell. «must-have»

## Missed moments (0)
Human selected, AI omitted (supporting/texture).
- none.

## Added moments (15)
AI selected, human did not. Could be a defensible alternative or noise.
- SEG_AST_F4D174A3_0001 [hero] (conf 0.95): “これは食感の難しいぞ” — why: Score 11: campfire, fire, tent, night, CAMPFIRE, TENT, NIGHT. A person is sitting on a wooden stool in front of a campfire, holding a marshmallow on a stick, with trees and a tent visible in the background.
- SEG_AST_1FD2260C_0001 [hero] (conf 0.9): “ここに入れよう いや、まだだ ソーセージでやり取れよう その部分 それさ、やりすぎて 工房さんに” — why: Score 8: campfire, fire, sausage, CAMPFIRE, BBQ. A person is holding a sausage over a campfire, with a blurred background suggesting an outdoor camping scene.
- SEG_AST_29C1662F_0001 [hero] (conf 0.9): “ん 結構来てるのにもうなんかおやすみなさいぐらいのものだっ” — why: Score 8: campfire, fire, tent, CAMPFIRE, TENT. A person is sitting on a wooden bench in front of a campfire, holding a mug, with trees and a tent visible in the background.
- SEG_AST_343F59BE_0001 [hero] (conf 0.9): A person is sitting on a wooden chair in front of a campfire, holding a mug, with a tent and trees visible in the background. — why: Score 8: campfire, fire, tent, CAMPFIRE, TENT. A person is sitting on a wooden chair in front of a campfire, holding a mug, with a tent and trees visible in the background.
- SEG_AST_B8612888_0001 [hero] (conf 0.9): A person is sitting on a wooden chair in front of a campfire, holding a mug, with trees and a tent visible in the background. — why: Score 8: campfire, fire, tent, CAMPFIRE, TENT. A person is sitting on a wooden chair in front of a campfire, holding a mug, with trees and a tent visible in the background.
- SEG_AST_34FEC43F_0001 [hero] (conf 0.8): “ん いただきますジャッカー やって食べる うんなんだこれ” — why: Score 6: campfire, fire, food, CAMPFIRE. A person is sitting on the ground in front of a campfire, holding a skewer with food and bringing it towards their mouth, with trees visible in the background.
- SEG_AST_2373D82B_0001 [support] (conf 0.75): “はい 何かちゃんと言ってきたの?” — why: Score 5: child, CHILD, NIGHT. A young child with short dark hair, wearing a blue shirt and grey shorts, is walking on a paved path in a grassy area with trees in the background.
- SEG_AST_330996D5_0001 [hero] (conf 0.75): “ご視聴ありがとうございました。” — why: Score 5: campfire, fire, CAMPFIRE. A person is sitting on a wooden bench in front of a campfire, holding a mug, with trees in the background.
- SEG_AST_34237612_0001 [hero] (conf 0.75): “この動画は、私の動画でお会いしましょう。” — why: Score 5: campfire, fire, CAMPFIRE. A person is sitting on a wooden chair in front of a campfire, holding a mug, with trees in the background.
- SEG_AST_38AC5E78_0001 [hero] (conf 0.75): “マキマキマキマキ うわ見てたん?あそこジクジクジクジクになってるよ ほらほらほら” — why: Score 5: campfire, fire, CAMPFIRE. A person is holding a piece of wood over a campfire, with smoke rising from the fire and trees in the background.
- SEG_AST_8855E384_0001 [hero] (conf 0.75): “ご視聴ありがとうございました” — why: Score 5: campfire, fire, CAMPFIRE. A person is sitting on a wooden chair in front of a campfire, holding a mug, with trees in the background.
- SEG_AST_B32B0A34_0001 [support] (conf 0.75): “着いた途端に泣いてるしね 眠かったのあれやな 眠かったのと眠かったのに合わさって” — why: Score 5: child, CHILD, NIGHT. A young child with dark hair, wearing a blue shirt and grey pants, sits on the ground in a grassy area with trees in the background, looking down with their hands in their lap.
- SEG_AST_D0AC82AF_0001 [hero] (conf 0.75): “固いのやらないんだからな うーん うーんやば こういうぐらいにした? 自分でやってできる?” — why: Score 5: campfire, fire, CAMPFIRE. A person is sitting on the ground next to a campfire, holding a stick with marshmallows over the flames, with trees visible in the background.
- SEG_AST_ECA4E6B4_0001 [support] (conf 0.75): A young child with short dark hair, wearing a blue t-shirt and grey shorts, is walking on a gravel path in a forest clearing, holding a white plastic bucket. — why: Score 5: child, CHILD, NIGHT. A young child with short dark hair, wearing a blue t-shirt and grey shorts, is walking on a gravel path in a forest clearing, holding a white plastic bucket.
- SEG_AST_F11D204E_0001 [support] (conf 0.75): “おやすみなさい。 なんかそれも和がいらしいや。 ね。 あえて西の… どこに? あ、いい?あんなにちんまいの。” — why: Score 5: tent, TENT, NIGHT. A person is sitting on the ground next to a tent, holding a small, dark object in their right hand, with a blurred green background suggesting an outdoor, possibly wooded, environment.
