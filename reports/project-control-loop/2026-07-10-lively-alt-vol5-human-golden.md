# T-0012 — `lively-alt-vol5` human golden

Date: 2026-07-10
Task: T-0012
Goal: G-0004

## Outcome

`lively-alt-vol5` is the first rights-confirmed, operator-approved human-tier
speech-led golden for the P0 `interview-highlight` route.

- operator rights confirmation: approved for internal regression use on 2026-07-10
- operator editorial approval: v2 approved after full-video review on 2026-07-10
- registry tier: `human` (`approval_record.approved_by: operator`)
- project state: `approved`
- handoff state: `HND_lively_alt_vol5_golden_v2_20260710`, `pending`
- timeline version: `2`
- timeline SHA-256: `fc1b0a3a2127eec0a90f1ecb9532f545c4f28798a6a8f2c6186c79c471d6057d`
- approved rendered reference SHA-256:
  `14ef2652ed1b4a32793f54aa78699c3416dfd2ebe1738f3e84c4c7811fdda3ce`

The rendered reference remains local at
`projects/lively-alt-vol5/07_package/video/golden-v2.mp4`. Source footage and
rendered media are not tracked or committed.

## Fixture policy

This is a local-private human golden:

- source footage remains on the operator-controlled external volume;
- source footage, proxies, transcripts, project outputs, and renders remain under
  the repository's existing `projects/*` ignore boundary;
- the tracked repository stores only code fixes, tests, and this evidence report;
- CI must not assume that private media exists on a clean checkout;
- T-0016 must provide an authorized runner media mount or a separate rights-cleared
  derived fixture before making this regression mandatory.

## Repairs made before approval

1. Fixed the brief route to `interview-highlight` / `interview` with inference and
   confirmation skipping disabled.
2. Corrected blueprint target frames from the legacy 30 fps values to the canonical
   24 fps sequence while preserving all six beat durations.
3. Corrected the TimelineIR caption contract: clip captions use absolute sequence
   frames, matching compiler output and Studio behavior. Split-patch captions now
   preserve that absolute-frame contract.
4. Set the project to manual captions so the compiler no longer emits English
   planning labels over approved Japanese captions.
5. Added an operator-approved C0004 alternate-angle candidate for `emotional_core`.
   Source-audio correlation measured the same 14.492-second camera offset at two
   distant points; the v2 patch alternates D5054-C0004-D5054 video while retaining
   D5054 dialogue.
6. Recompiled deterministically and applied the bounded review patch. Repeating the
   full compile plus patch produced the same timeline SHA-256.
7. Rendered the current timeline with dialogue-cut fades, burned the approved
   Japanese ASS captions, and mastered audio to -15.8 LUFS / -1.3 dBFS true peak.

## Verification

| Check | Result |
|---|---|
| Focused validation + patch E2E | Pass — 74 tests |
| `npm run test:schema-contract` | Pass — 87 tests |
| `npm run typecheck` | Pass |
| `npm run verify:repo` | Pass — 1,371 tracked files |
| `npm run verify -- --full` | Pass — all aggregate gates |
| Full unit suite | Pass — 2,587 tests, 39 skipped |
| Preview/final render parity | Pass — 59 tests |
| Project schema / semantic validation | Pass — 24 artifacts, 0 errors, 0 warnings |
| Full compile + approved patch | Pass — 1/1 operation, timeline v2 |
| Deterministic repeat SHA | Pass — identical timeline hash |
| Self recompile agreement before the human correction | Pass — 100/100 |
| Current golden agreement | Pass — 94.2/100 |
| Render duration | 91.208 seconds |
| Render parity | Pass — delta -0.048 seconds |
| Black/freeze scan | Pass — no detected interval |
| Audio | -15.8 LUFS, LRA 7.0 LU, true peak -1.3 dBFS |
| Review metrics | 8 pass, 1 fail, 1 expected skip |
| Golden registry | Discovered as `tier=human`, approved by `operator` |

The remaining deterministic failure is `audio.speech_cut` for ACL_0011. The chosen
six-second statement sits inside a coarse 20.9-second D5054 STT item; cross-camera
alignment supports its start and the render applies short cut fades. The operator
accepted this as a non-fatal rough-cut warning.

## Automated visual QA blocker

Marlin was not counted as passing:

- a real-model run timed out after 300 seconds;
- a 256 px proxy / 15-second chunk retry did not finish its first chunk in five
  minutes and was stopped;
- no mock result or skipped stage was promoted as golden evidence.

The operator completed full-video visual review for this human golden. Automated
visual regression remains fail-closed work for T-0016.

## Next action

T-0013 can now use the approved v2 timeline and mounted local source volume to prove
resume, backtrack, Studio readiness, MP4 review, NLE export, round-trip, and upstream
invalidation. The v2 handoff intentionally remains `pending` until that proof decides
the final source of truth.
