# D-0012 Marlin continuity calibration

- Date: 2026-07-11 JST
- Feature: F-0023
- Trigger evidence: E-0253 / T-0022

## Findings

### Defect

The continuity detector treated every description token of six or more characters as a scene identity. One shared word such as a subject, action, color, or location could therefore create an eight-point approval-gate deduction.

The live, non-mock fumoto run produced 11 continuity warnings, zero critical issues, acceptable pacing, and a matching emotion arc, yet scored 12/100.

### Repair

Continuity evidence is now limited to:

1. exact normalized scene descriptions; or
2. a shared contiguous phrase of at least four meaningful tokens where the complete token sets have Jaccard similarity of at least 0.75.

A single returning token or a generic three-word action phrase is insufficient. Adjacent matching descriptions remain part of one scene run and do not warn.

## Evidence

### Verification

Node 22 focused verification:

```text
npx vitest run tests/marlin-qa.test.ts tests/qa-loop.test.ts
2 files passed; 30 tests passed

npx tsc --noEmit
passed

npm run verify
161 files passed, 4 skipped; 2640 tests passed, 39 skipped; all gates passed

git diff --check
passed
```

The saved T-0022 scene descriptions were re-scored without rerunning inference:

```text
continuity warnings: 11 -> 0
score:               12 -> 100
```

The original live report remains immutable at 12/100. The re-score proves deterministic calibration behavior, not new visual inference or human editorial approval.

## Residual risk

The matcher remains lexical. It intentionally favors avoiding false approval-gate failures, so strongly paraphrased duplicate scenes may be missed. Future semantic continuity scoring should use shot identity, asset/time provenance, or visual embeddings and must be evaluated against labeled human examples before becoming gate authority.
