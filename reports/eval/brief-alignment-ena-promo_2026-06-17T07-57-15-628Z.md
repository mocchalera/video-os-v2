# Brief Alignment Report

- Project: ena-promo
- Evaluated at: 2026-06-17T07:57:15.628Z
- Brief hash: sha256:4fffa7c3115604e0f3a439f2f122bfea5010b82737d7e10e7b8ab945a87d5805

## Composite: 83.3%

## Selects — 83.3%

| axis | score | confidence | source | evidence | gaps |
| --- | ---: | ---: | --- | --- | --- |
| intent_message_alignment | 81.3% | 55.0% | deterministic | 3/4 brief message items represented across active candidates | not all brief message items are represented by active candidate evidence |
| must_have_coverage | 100.0% | 90.0% | deterministic | 5/5 selectable must_have items matched<br>selection coverage analyzer score 100.0% | — |
| emotion_curve_alignment | 80.3% | 70.0% | deterministic | 5/5 brief emotion_curve terms found in candidate beats/evidence<br>1/61 active candidates carry emotion/peak signals<br>61/61 active candidates carry eligible_beats | — |
| narrative_structure | 53.8% | 80.0% | deterministic | 2 role types represented in selects<br>story_role present on 61/61 candidates<br>eligible_beats present on 61/61 candidates<br>hook/opening function detected<br>experience/development function detected<br>closing/payoff function detected<br>story_role semantic_rank order is not hook -> experience -> closing | selects do not expose setup/context candidates<br>story_role sequence is not ordered hook -> experience -> closing by semantic_rank |
| pacing_coherence | 95.4% | 45.0% | deterministic | selected source duration 1060.7s for 230s target | — |
| visual_variety_and_focus | 86.5% | 80.0% | deterministic | 59/61 unique assets<br>2 active roles represented<br>6 semantic clusters represented | role distribution is narrow |

## Notes

- blueprint stage skipped: 04_plan/edit_blueprint.yaml not found
