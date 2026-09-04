# Issue #11 bounded remediation at `66f1a5a`

- target: `66f1a5a51b87d0255a3fdaf5d5a0e9ce83e0762e`
- direct parent: `372b26891a6ef833121fd35ad688eb428cfd8715`
- toolchain: Node 22.23.1 / npm 10.9.8
- execution: repo-external proper mirror with hardlinked dependency contents,
  independent Git index, and dedicated `TMPDIR`

## Outcome

The bounded M2 candidate-selection port is retained, but A1 remains **HOLD**.
After removing every experimental fill branch, the public compiler selected
1,680 renderable frames for a strict 1,730-frame target and exited 1 with a
50-frame `renderable_content` shortfall. No generic solver, search, Day2 ID
special case, policy relaxation, or canonical mutation was retained.

M3-M6 remain independently applicable: fail-closed input/output identity and
TOCTOU checks, payload-bound report identity, file-backed human/wall-clock
provenance, and audio-inclusive no-speech program bounds.

## Proposed canonical migration (not applied)

The task-owned copy contains only:

- `apex_beat.required_roles`: `support` -> `hero`;
- every `eligible_beats` entry restricted to the current seven blueprint beats;
- `cand_intro_today_long_jog` made eligible for `setup_purpose`.

The exact unified patch is retained outside the repository as
`evidence/proposed-canonical-migration.patch`; SHA-256:
`f360fdd0787d3060ce0584bf8d0983cab82fd49e3d67c80fc6eab8a4652e7bfe`.
The canonical 535-file aggregate SHA-256 before and after the experiment was
`9903499d9f034b49384b1453e79a5c4b9c83721eb3c1157a859c671c0b46837c`;
canonical files remain byte-unchanged.

## A0 and A1 measurements

A0 used the public compile CLI with `--fps 30`, frozen `createdAt`, and the
same proposed-copy policy. Both runs exited 0 at 1,730 frames / gap 0 and
produced the same timeline SHA-256:
`e56adaa39171434f03509441a259995fdb3266537fdc498cdab6e3f146509802`.

A1 started from that same copy and removed only `human_golden_order` and the
seven exact `candidate_plan` blocks. The shrunk current-HEAD implementation
exited 1: 1,680 available frames / 1,730 target / 50-frame shortfall. It did not
produce an A1 timeline or loss report. Selects coverage remains `failed` and
analysis coverage remains `blocked`, so auto-assembly capability evaluation is
HOLD, not success or accepted failure.

Phase 2.5 was not entered: the failed A1 does not isolate cut-density or
max-shot-length policy as the loss cause. Phase 3 is **NO-GO**: there is no
hash-pinned A1 loss report, operator mandatory-repair record, proof that minor
trim is insufficient, or proof that coverage/grounding cannot explain the
loss.

Cold source-to-reviewable-preview under ten minutes and optional-model
fail-open behavior in this A1 execution remain UNVERIFIED/HOLD.

## Remediation verification boundary

Counterexamples were captured RED before implementation. After shrink, the
commit-scope suite passed 5 files / 120 tests, including continuity, V1-first,
gap-free, evaluator, and project/report boundary tests. Because A1 remained
short, the post-remediation full gate was intentionally not promoted as an
acceptance run; fresh pre-remediation review-gate evidence and historical
intermittent HOLD evidence are recorded separately in
`issue-11-phase2-evaluator.md`.
