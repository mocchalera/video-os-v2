# Creative regeneration — selects agreement

- golden (human): `togakushi-camp`
- candidate (regenerated): `togakushi-camp`
- evaluated_at: 2026-06-16T01:43:46.771Z

## Scores
- **composite: 55.4 / 100**
- selection F1: 50.0% (precision 46.7%, recall 53.8%)
- role agreement (matched): 78.6%
- rank correlation: -0.178
- beat-eligibility overlap: n/a
- counts: golden 26, candidate 30, matched 14

## Coverage
- **score: 93.8 / 100**
- runtime selected/target: 549.4s / 120.0s (457.8%)
- roles: hero 5, support 24, texture 1, transition 0, dialogue 0
- density: 30/60 (50.0%)
- dense clusters under-sampled: 1
- gaps:
  - selection sparse: 30/60 segments (50%)
  - dense cluster (30 similar shots) under-sampled: picked 14/30 -- montage candidate may be missing
  - must_have uncertain: 焚き火のシーン
  - must_have uncertain: 星空

## ❗ Missed critical moments (12)
Human treated these as essential (must-have or hero-role); the AI did not select them. Highest-priority gap.
- SEG_AST_AB1AD3B9_0001 [hero] (conf 0.95): A family is enjoying a picnic lunch at a campsite in a scenic mountain area. — why: positions 1, 26 use T015 as a hero shot for Opening — Togakushi Landscape and Closing — Bookend & Farewell. «must-have»
- SEG_AST_399510B7_0001 [support] (conf 0.95): A family is enjoying a picnic and playing in a grassy field during a sunny day. — why: position 5 uses T018 as a support shot for Day 1 — Arrival & Play. «must-have»
- SEG_AST_7A0CC62D_0001 [support] (conf 0.95): A family is enjoying a picnic lunch at a campsite in a scenic mountain area. — why: position 6 uses T023 as a support shot for Day 1 — Arrival & Play. «must-have»
- SEG_AST_F010BF35_0001 [support] (conf 0.95): A family is enjoying a picnic and playing in a grassy field during a sunny day. — why: position 9 uses T031 as a support shot for Day 1 — Arrival & Play. «must-have»
- SEG_AST_C7D644B1_0001 [support] (conf 0.95): A family is enjoying a picnic and playing in a grassy field during a daytime camping trip. — why: position 11 uses T036 as a support shot for Day 1 — BBQ & Campfire. «must-have»
- SEG_AST_99161EEB_0001 [support] (conf 0.95): A family is enjoying a picnic and playing in a grassy field during a sunny day. — why: position 18 uses T062 as a support shot for Day 2 — Morning. «must-have»
- SEG_AST_038AB86F_0001 [support] (conf 0.95): “学者の髪を切った 切ったよね エロい髪型あんだ おぼっちゃみたいな すごいねー” — why: position 19 uses T001 as a support shot for Day 2 — Activity & Exploration. «must-have»
- SEG_AST_287B7B3F_0001 [support] (conf 0.95): A family is enjoying a picnic and playing in a grassy field during a sunny day. — why: position 21 uses T003 as a support shot for Day 2 — Activity & Exploration. «must-have»
- SEG_AST_F45A9E48_0001 [support] (conf 0.95): A family is enjoying a picnic and playing in a grassy field during a daytime camping trip. — why: position 22 uses T008 as a support shot for Day 2 — Activity & Exploration. «must-have»
- SEG_AST_B254ED8B_0001 [support] (conf 0.95): A family is enjoying a picnic lunch at a campsite in a scenic mountain area. — why: position 23 uses T009 as a support shot for Day 2 — Activity & Exploration. «must-have»
- SEG_AST_D16E3D7A_0001 [texture] (conf 0.95): A family is enjoying a picnic and playing in a grassy field during a sunny day. — why: position 28 uses T019 as a texture shot for Closing — Bookend & Farewell. «must-have»
- SEG_AST_B39BAEE6_0001 [texture] (conf 0.95): A family is enjoying a picnic lunch at a campsite in a scenic mountain area. — why: position 29 uses T027 as a texture shot for Closing — Bookend & Farewell. «must-have»

## Missed moments (0)
Human selected, AI omitted (supporting/texture).
- none.

## Added moments (16)
AI selected, human did not. Could be a defensible alternative or noise.
- SEG_AST_00725A11_0001 [support] (conf 0.8): “ここは遠いです こういう顔をしています あ、難しいのがあった おー、わかりますね そっちは遠いですか? うん” — why: 戸隠の環境の素晴らしさを表現する景観ショット。emotion curveの'wonder'に貢献します。朝の静かな空気感を間接的に表現できる可能性があります。
- SEG_AST_08BC00DF_0001 [texture] (conf 0.8): “あ!” — why: 子供たちが自然と触れ合い成長する姿、自然の美しさ、そして朝の静かな空気感を表現するのに適しています。emotion curveの'serenity'に貢献します。
- SEG_AST_1AA38FF9_0001 [support] (conf 0.9): A family is enjoying a picnic lunch at a campsite in a scenic mountain area. — why: Must-have: BBQ・食事の家族時間。家族の絆と楽しさを表現。dense cluster (26 similar shots) からのサンプリングを増やしました。
- SEG_AST_1FD2260C_0001 [support] (conf 0.9): A family is enjoying a picnic lunch at a campsite in a scenic mountain area. — why: Must-have: BBQ・食事の家族時間。家族の絆と楽しさを表現。dense cluster (26 similar shots) からのサンプリングを増やしました。
- SEG_AST_29C1662F_0001 [support] (conf 0.9): A family is enjoying a picnic lunch at a campsite in a scenic mountain area. — why: Must-have: BBQ・食事の家族時間。家族の絆と楽しさを表現。dense cluster (26 similar shots) からのサンプリングを増やしました。
- SEG_AST_330996D5_0001 [support] (conf 0.9): A family is enjoying a picnic lunch at a campsite in a scenic mountain area. — why: Must-have: BBQ・食事の家族時間。家族の絆と楽しさを表現。dense cluster (26 similar shots) からのサンプリングを増やしました。
- SEG_AST_34FEC43F_0001 [support] (conf 0.9): A family is enjoying a picnic lunch outdoors in a scenic mountain setting. — why: Must-have: BBQ・食事の家族時間。家族の絆と楽しさを表現。dense cluster (26 similar shots) からのサンプリングを増やしました。
- SEG_AST_50CC5A4E_0001 [support] (conf 0.9): A family is enjoying a picnic lunch at a campsite in a scenic mountain area. — why: Must-have: BBQ・食事の家族時間。家族の絆と楽しさを表現。dense cluster (26 similar shots) からのサンプリングを増やしました。
- SEG_AST_83763628_0001 [hero] (conf 1): A family is enjoying a picnic lunch at a campsite in a scenic mountain area. — why: Must-have: BBQ・食事の家族時間。家族の絆と楽しさを表現。長尺で、キャンプの雰囲気を伝える中心的なショット。dense cluster (26 similar shots) からのサンプリングを増やしました。
- SEG_AST_B8612888_0001 [hero] (conf 1): A family is enjoying a picnic lunch at a campsite in a scenic mountain area. — why: Must-have: BBQ・食事の家族時間。家族の絆と楽しさを表現。長尺で、キャンプの雰囲気を伝える中心的なショット。dense cluster (26 similar shots) からのサンプリングを増やしました。
- SEG_AST_2373D82B_0001 [support] (conf 0.9): A family is enjoying a picnic and playing in a grassy field during a daytime camping trip. — why: Must-have: 子供の表情（楽しさ・発見）、BBQ・食事の家族時間。子供たちが自然と触れ合い成長する姿を表現。dense cluster (30 similar shots) からのサンプリングを増やしました。
- SEG_AST_34237612_0001 [support] (conf 0.9): A family is enjoying a picnic and playing in a grassy field during a daytime camping trip. — why: Must-have: 子供の表情（楽しさ・発見）、BBQ・食事の家族時間。子供たちが自然と触れ合い成長する姿を表現。dense cluster (30 similar shots) からのサンプリングを増やしました。
- SEG_AST_343F59BE_0001 [support] (conf 0.9): A family is enjoying a picnic and playing in a grassy field during a sunny day. — why: Must-have: 子供の表情（楽しさ・発見）、BBQ・食事の家族時間。子供たちが自然と触れ合い成長する姿を表現。dense cluster (30 similar shots) からのサンプリングを増やしました。
- SEG_AST_38AC5E78_0001 [support] (conf 0.9): A family is enjoying a picnic and playing in a grassy field during a daytime camping trip. — why: Must-have: 子供の表情（楽しさ・発見）、BBQ・食事の家族時間。子供たちが自然と触れ合い成長する姿を表現。dense cluster (30 similar shots) からのサンプリングを増やしました。
- SEG_AST_ECA4E6B4_0001 [hero] (conf 1): A family is enjoying a picnic and playing in a grassy field during a daytime camping trip. — why: Must-have: 子供の表情（楽しさ・発見）、BBQ・食事の家族時間。子供たちが自然と触れ合い成長する姿を表現する長尺ショット。dense cluster (30 similar shots) からのサンプリングを増やしました。
- SEG_AST_F465D53F_0001 [hero] (conf 1): A family is enjoying a picnic and playing in a grassy field during a sunny day. — why: Must-have: 子供の表情（楽しさ・発見）、BBQ・食事の家族時間。子供たちが自然と触れ合い成長する姿を表現する長尺ショット。dense cluster (30 similar shots) からのサンプリングを増やしました。
