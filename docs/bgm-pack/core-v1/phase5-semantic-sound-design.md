# Phase 5 — semantic-first short sound design

Phase 5 decides whether a pinned SFX candidate belongs at a meaningful visual
or spoken event before considering tempo. It does not move picture/dialogue
timing, invent beats, approve final sound character, or authorize publication.

## Decision artifacts

`sound-design-request/v1` pins the project/timeline identity, rational FPS,
timeline hash, formal SFX library, candidate assets, dialogue windows,
congestion evidence, optional beat/downbeat evidence, and density/snap policy.
Every candidate carries semantic purpose and evidence, an anchor/window,
asset/content/rights/provenance pins, and exact audio parameters.

`sound-design-decision/v1` records deterministic adopt/reject results, resolved
frames, score components, conflicts, snap decisions and reasons, solver
identity/version, input hashes, and a semantic decision hash. The solver:

- rejects candidates without semantic purpose/evidence;
- penalizes or rejects dialogue, music-entry, lower-third, section, caption,
  overlay, or picture-edit congestion;
- enforces minimum spacing and duration-scaled maximum density;
- uses stable candidate ID as the exact-score tie-break;
- never changes picture, dialogue, caption, or overlay timing; and
- snaps no more than three frames only when a pinned, ready, sufficiently
  confident beat/downbeat grid exists and the move remains inside the semantic
  window without crossing picture/dialogue boundaries.

A BPM alone, empty beat arrays, unknown analysis hash, low confidence, or
degraded analysis produces an explicit no-snap decision.

## Decision-pinned A3 route

The planner projects only adopted decisions into backward-compatible
`sfx-cues/v1`. When a decision is present, the root artifact pins its file and
semantic hashes and every cue pins candidate ID, resolved frame, role, asset,
and decision hash. Resolver, timeline projection, shared AudioRenderPlan,
executor preflight, report, and conditional package QA fail closed on drift.
Phase 4/no-SFX/no-BGM/`original_only`/legacy artifacts without a decision keep
their previous shape and required checks.

The existing Phase 3/4 executor remains the sole audio implementation:
A1-only dialogue finishing, A2/A3 gain/fade/duck, A1-waveform sidechain, stable
mix order, and one final mastering pass.

## CLI

Review a write-free decision and formal cue projection:

```bash
npm run sound-design:plan -- \
  --project /path/to/scratch \
  --timeline /path/to/scratch/05_timeline/timeline.json \
  --request /path/to/scratch/04_plan/sound-design-request.json \
  --decision-output /path/to/scratch/07_package/sound-design-decision.json \
  --cues-output /path/to/scratch/07_package/sfx_cues.json \
  --dry-run
```

Remove `--dry-run` only after reviewing the decision. Both explicit outputs
must be new files inside the project. Then use `sfx:project`,
`render-audio-plan`, and `social-review --timeline <projected-timeline>`;
the reusable
`$short-sound-design` skill documents the full identity, rights, QA, human
audition, and publication-gate workflow.
