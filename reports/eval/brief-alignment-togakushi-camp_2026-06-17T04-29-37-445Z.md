# Brief Alignment Report

- Project: togakushi-camp
- Evaluated at: 2026-06-17T04:29:37.445Z
- Brief hash: sha256:ac03754ffbce4668e750cd0129155b5e7d9e5ec0028c552be458c6ff7a95f579

## Composite: 46.5%

## Selects — 27.8%

| axis | score | confidence | source | evidence | gaps |
| --- | ---: | ---: | --- | --- | --- |
| intent_message_alignment | 25.0% | 55.0% | deterministic | 0/26 active candidates mention primary/secondary message terms | candidate evidence does not explicitly echo the brief message |
| must_have_coverage | 16.7% | 90.0% | deterministic | 1/6 selectable must_have items matched<br>selection coverage analyzer score 79.8%<br>1 production directive must_have items deferred | missing explicit candidate evidence for must_have: 焚き火のシーン<br>missing explicit candidate evidence for must_have: 星空<br>missing explicit candidate evidence for must_have: 子供の表情（楽しさ・発見）<br>missing explicit candidate evidence for must_have: 到着〜設営の導入<br>missing explicit candidate evidence for must_have: 朝の静かな空気感 |
| emotion_curve_alignment | 16.7% | 45.0% | deterministic | 0/26 active candidates carry emotion/peak signals | selects expose little deterministic emotion-curve evidence |
| narrative_structure | 45.8% | 75.0% | deterministic | 3 role types represented in selects<br>eligible_beats present on 26/26 candidates<br>hook/opening function detected | selects do not expose experience/development candidates<br>selects do not expose a clear closing/payoff candidate |
| pacing_coherence | 0.0% | 45.0% | deterministic | selected source duration 272.1s for 120s target | selected duration ratio 2.27 may be weak for target runtime |
| visual_variety_and_focus | 92.2% | 65.0% | deterministic | 26/26 unique assets<br>3 active roles represented<br>semantic clusters unavailable; used segment diversity fallback | — |

## Blueprint — 69.0%

| axis | score | confidence | source | evidence | gaps |
| --- | ---: | ---: | --- | --- | --- |
| intent_message_alignment | 55.0% | 55.0% | deterministic | blueprint has structural plan text | blueprint does not explicitly echo the brief primary/secondary message |
| must_have_coverage | 70.0% | 45.0% | deterministic | 6 blueprint beats available for must_have placement | — |
| emotion_curve_alignment | 37.5% | 55.0% | deterministic | 1/6 emotion_curve terms appear in blueprint<br>hook and closing beats are present | not all emotion_curve terms are explicit in blueprint |
| narrative_structure | 100.0% | 85.0% | deterministic | story roles: hook -> setup -> experience -> experience -> experience -> closing<br>6 beats with 4 sequence goals | — |
| pacing_coherence | 100.0% | 82.0% | deterministic | brief target 120s; blueprint target 117.72s<br>6 beats planned<br>duration_policy mode=guide | — |
| visual_variety_and_focus | 65.0% | 45.0% | deterministic | 6 beats define role requirements | — |
