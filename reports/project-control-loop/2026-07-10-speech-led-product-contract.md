# T-0011 — Speech-led highlight product contract

Date: 2026-07-10

Task: T-0011

Goal: G-0004

## Outcome

`docs/speech-led-highlight-product-contract.md` is now the normative P0 product
contract. It fixes the first-run product route to `interview-highlight` with the
`interview` policy, requires an actual 60–180 second output, and maps every proposed
domain concept to existing canonical artifacts and the existing persisted state
machine.

No runtime code, schema, dependency, profile, editing skill, or parallel pipeline was
added.

## Contract coverage

- input media and exact `creative_brief.yaml` field mapping
- rough-cut, Studio, render, review, approval, and NLE handoff outputs
- canonical artifact and authority precedence
- fail-open and human-approved degraded behavior
- existing `project_state.yaml` transitions and backtracking semantics
- run acceptance and editor-effort / post-export revision metrics
- explicit P0 exclusions and next-gate criterion

## Verification

| Check | Result |
|---|---|
| Contract reference check against profile, policy, schemas, state reconcile, and handoff paths | Pass |
| `npm run validate` | Pass — 15 artifacts, 0 errors, 0 warnings |
| `npm run typecheck` | Pass |
| `npm run verify:repo` | Pass — 1,369 tracked files checked |
| `pcl validate` after T-0011 completion | Pass |
| `git diff --check` | Pass |

The Project Loop task links this contract and report as evidence.
