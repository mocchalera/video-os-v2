# Brief Alignment Report

- Project: ena-promo
- Evaluated at: 2026-06-17T01:51:59.388Z
- Brief hash: sha256:4fffa7c3115604e0f3a439f2f122bfea5010b82737d7e10e7b8ab945a87d5805

## Composite: 50.0%

## Selects — 62.3%

| axis | score | confidence | source | evidence | gaps |
| --- | ---: | ---: | --- | --- | --- |
| intent_message_alignment | 0.0% | 90.0% | deterministic | — | must_avoid evidence found in SEG_AST_2458305F_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_E4C3E126_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_B28FF61E_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_BA264D3E_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_02352E6C_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_0CBD2398_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_8E177594_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_B5DD7EC5_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_FA6BF8D4_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_374B8454_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_7FFADD3B_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_0ABE9883_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_720960EC_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_842E9AB2_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_0C0DA029_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_5A089060_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_FCB9B51E_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_998D5C89_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_DB9645BB_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_0CBD2398_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_C96907DD_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_42069045_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_9C822C55_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_C2CE75D8_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_0B1ACF7D_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_ABC69F0E_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_54328ECB_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_47926EA2_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_ADFDD653_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_E1A9B641_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_6FEA8B0A_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_E98C7A35_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_5F18A179_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_45CAE530_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_36832BA5_0001: text-heavy information overlays<br>must_avoid evidence found in SEG_AST_09AA1D70_0001: text-heavy information overlays |
| must_have_coverage | 100.0% | 90.0% | deterministic | 5/5 selectable must_have items matched<br>selection coverage analyzer score 100.0% | — |
| emotion_curve_alignment | 42.6% | 45.0% | deterministic | 0/100 active candidates carry emotion/peak signals | selects expose little deterministic emotion-curve evidence |
| narrative_structure | 67.5% | 45.0% | deterministic | 3 role types represented in selects | selects do not expose a clear closing/payoff candidate |
| pacing_coherence | 100.0% | 45.0% | deterministic | selected source duration 173.3s for 230s target | — |
| visual_variety_and_focus | 86.5% | 65.0% | deterministic | 93/100 unique assets<br>3 active roles represented<br>semantic clusters unavailable; used segment diversity fallback | — |

## Blueprint — 72.5%

| axis | score | confidence | source | evidence | gaps |
| --- | ---: | ---: | --- | --- | --- |
| intent_message_alignment | 85.0% | 55.0% | deterministic | blueprint text explicitly overlaps with brief message | — |
| must_have_coverage | 70.0% | 45.0% | deterministic | 6 blueprint beats available for must_have placement | — |
| emotion_curve_alignment | 25.0% | 55.0% | deterministic | 0/5 emotion_curve terms appear in blueprint<br>hook and closing beats are present | not all emotion_curve terms are explicit in blueprint |
| narrative_structure | 100.0% | 85.0% | deterministic | story roles: hook -> setup -> experience -> experience -> experience -> closing<br>6 beats with 4 sequence goals | — |
| pacing_coherence | 100.0% | 82.0% | deterministic | brief target 230s; blueprint target 229.75s<br>6 beats planned<br>duration_policy mode=guide | — |
| visual_variety_and_focus | 65.0% | 45.0% | deterministic | 6 beats define role requirements | — |

## Notes

- composite capped at 0.50 because must_avoid evidence was found
