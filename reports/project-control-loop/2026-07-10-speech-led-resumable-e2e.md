# T-0013 — Resumable speech-led brief-to-NLE E2E proof

Date: 2026-07-10
Task: T-0013
Goal: G-0004

## Outcome

`lively-alt-vol5` now completes the existing speech-led route from its canonical
brief and registered sources through approved review, deterministic timeline,
Studio exact preview, engine package, and Premiere XML round-trip. No parallel
orchestrator or duplicate artifact model was added.

- final state: `packaged`
- stale artifacts: none
- source of truth: `engine_render`
- handoff: `HND_lively_alt_vol5_golden_v3_20260710`, decided by `operator`
- timeline: version `2`, 2,192 frames, 6 video clips, 6 audio clips
- final MP4: 91.333333 seconds, 1,920×1,080, 24 fps, 48 kHz stereo
- final MP4 SHA-256:
  `abfe5ac74dbc9d1bbcf41163abb7ce933453d54af41cd45c0789de022f24b535`
- package QA: pass, A/V drift 16 ms, -15.8 LUFS, -1.5 dBTP
- approved captions: 18 cues, 60 px at 1080p, 3 px outline
- automated Marlin visual QA: blocked and not counted as passing

Private sources, generated previews, exports, and renders remain ignored under
`projects/lively-alt-vol5` and were not committed.

## Gate-by-gate route

| Gate | State / artifact | Evidence and result |
|---|---|---|
| 0. Brief | `01_intent/creative_brief.yaml` | `interview-highlight` / `interview`; SHA-256 `09b862d4c7fb6c1c4603e76caaae0ad0acf1e1581cac5b5d4e3d058993c1a572` |
| 1. Sources | `02_media/source_map.json` | 9 registered sources; all 6 timeline assets resolved for Studio; SHA-256 `80eec35f8f492b3c29e7c183db4a455f79c195b57d2e6e892d8425bb5b9243c2` |
| 2. Analysis | `03_analysis/assets.json`, `segments.json` | Existing analysis resumed without rerun; `analysis_gate=partial_override`; optional/local visual lanes remain explicit degraded evidence rather than silent success |
| 3. Selects | `04_plan/selects_candidates.yaml` | SHA-256 `82c6fbf868f2a1dc4f61dd5686471a9a027275f49785a698d57f7b72fcb03b72` |
| 4. Blueprint | `04_plan/edit_blueprint.yaml` | SHA-256 `eda9a2c50bcacc914aa892207705ae8755c4635093c93f99909d1501cbde2e33` |
| 5. Timeline | `05_timeline/timeline.json` | Version 2; SHA-256 `fc1b0a3a2127eec0a90f1ecb9532f545c4f28798a6a8f2c6186c79c471d6057d`; repeat compile/patch from T-0012 was deterministic |
| 6. Review | `06_review/*` | User backtracked after reviewing 48 px captions, approved the 60 px v3 after full-video review, and retained the Marlin fail-closed note |
| 7. Studio | `preview-e95f8060f7087b0f.mp4` | `PreviewJobService` rendered the real project in 46.3 s: RenderSpec v3, 6 video, 6 audio, 18 captions, warning 0, missing source 0, 24 fps / 2,192 frames / 91.333333 s / 48 kHz |
| 8. Review MP4 | `09_output/final.mp4` | Engine render QA passed all 9 checks; repeated package runs produced the same MP4 SHA-256 |
| 9. Handoff decision | `project_state.yaml` | Explicit collaborative decision: `engine_render`, operator, `2026-07-10T08:42:18.318Z` |
| 10. NLE export | `09_output/lively-alt-vol5_premiere.xml` | XML well formed; 12 clipitems; dry-run import mapped 12/12 clips, unmapped 0, diffs 0; SHA-256 `c609dc709b314ca6233541bbc9a9eeb237c395c1951058b3198e8b3db3af0626` |

## Resume and backtrack proof

The operator restarted the PC after the v3 approval. On restart, `/status` read the
project at `approved` with the clean operator approval, mounted source links, and
the existing analysis artifacts intact. Work resumed at Gate 9; no intent,
analysis, selection, blueprint, or timeline regeneration was required.

The review loop also moved backward for a real product reason:

1. v2 used the then-current 48 px `clean-lower-third` caption token.
2. The operator reported that `lively-alt-vol5` captions were too small.
3. The review note recorded the concern; caption projection was normalized to the
   24 fps timeline while preserving seconds.
4. v3 increased the shared token to 60 px / 3 px outline.
5. The operator explicitly approved the 60 px version.
6. Timeline version and hash stayed unchanged because this was a packaging/style
   backtrack, not an editorial cut mutation.

## Optional-model and human-gate behavior

- `analysis_gate=partial_override` remains visible in final state.
- Full verification exercises VLM failure and degraded peak fallback without
  blocking deterministic downstream work.
- The real Marlin visual run previously timed out. The current review report keeps
  `visual_qa.status=blocked` and records an operator full-video waiver.
- No skipped, mocked, timed-out, or unavailable Marlin result is reported as an
  automated pass. Mandatory automated visual regression remains T-0016.

## Studio proof

The live project exposed three Studio exact-preview defects and verified their
repairs on real media:

1. Studio looked for `caption_approval.json` at the project root instead of the
   canonical `07_package` path.
2. Studio loaded the 18 approved cues but ignored blueprint `styling_class`, which
   reduced them to the 24 px default instead of the approved 60 px token.
3. Clip intermediates inherited 29.97 fps from source media despite a 24 fps
   sequence, and mastered audio ended 77 ms early.

The route now resolves canonical caption approval, resolves the blueprint style
through shared caption tokens, pins intermediates and caption output to sequence
CFR, pads audio to the timeline end, and includes a renderer contract version in
the RenderSpec hash so stale preview caches invalidate. The resulting exact preview
has SHA-256
`01787241b4b56bdc5462f45b6543237cbf76848fe52c63ce57b38dca97008312`.

Focused macOS tests verify the edit-side contracts without mutating the approved
golden timeline: `ReviewPatchDocumentTests`, `StudioFeedbackSessionTests`, and
`TimelineAgentReviewPatchApplyPlanTests` passed 31/31, covering patch serialization,
dirty-state clearing/undo behavior, supported apply, before/after preview, version
guards, and prevention of partial apply.

## Runtime and state-machine defects closed

The golden path found and fixed the following contract breaks:

- package preflight and `packageCommand` now accept both `approved` and `packaged`
  for safe rerender;
- final mux pins timeline duration, exact video frame count, and 48 kHz audio;
- `-shortest` no longer drops B-frame-backed video before the timeline end;
- downstream caption/music/QA changes invalidate package outputs without staling
  the unchanged editorial approval;
- failed QA or malformed QA can no longer promote a project to `packaged` merely
  because old package files exist;
- `/review` and `/package` persist hashes of the artifacts they write, preventing
  immediate self-invalidation;
- QA check serialization keeps resolution detail in the schema-defined top-level
  metrics object;
- the package after repeated retry ends at `packaged`, `packaging_gate=open`, and
  stale artifact count 0.

Unit coverage also verifies upstream invalidation for brief, selects, style,
timeline, human notes, QA, source-of-truth changes, and missing package artifacts.
This keeps explicit backtracking while allowing downstream package retry without
requiring a duplicate human editorial approval.

## Verification

| Check | Result |
|---|---|
| Focused TypeScript route/state/package tests | Pass — 301 tests |
| Focused macOS patch/edit tests | Pass — 31 tests |
| Schema contract | Pass — 87 tests |
| `lively-alt-vol5` schema/semantic validation | Pass — 24 artifacts, 0 errors, 0 warnings |
| `npm run verify:repo` | Pass — 1,375 tracked files |
| `npm run verify -- --full` | Pass — all aggregate gates |
| Full unit suite | Pass — 2,602 tests, 39 skipped |
| Preview/final render parity | Pass — 65 tests |
| Golden agreement | Pass — `lively-alt-vol5` 94.2/100 |
| Final engine package | Pass — 9/9 QA checks |
| Premiere XML parse/import dry run | Pass — 12/12 mapped, 0 diff |

## Boundary and next action

Gate 3 is complete for the existing route. This does not claim automated Marlin
regression or new-user first-run UX are complete. The next productization work is:

1. T-0016 — make the speech-led product regression mandatory without treating
   unavailable visual QA as success;
2. T-0015 — expose the proven route as the default Studio first-run product flow;
3. Gate 4 metrics — measure editor effort and post-export edit distance across
   successive accepted runs.
