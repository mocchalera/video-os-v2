# Review: QA Improvement Loop Design

Date: 2026-06-20
Scope: `docs/design-qa-improvement-loop.md` against the current QA, search, compiler, patch, and editorial-pipeline implementation.

## Verdict

Approve with changes for Phase 0 and Phase 1 only. The design fits the north star of weak agents plus structured evidence: typed QA issues, bounded fixes, score-level Qwen/CLAP fusion, fail-open behavior, and audit trails are the right direction.

Do not start Phase 2 preview-patch implementation until the patch/recompile path is isolated from canonical outputs and adjacency/transition evidence is recomputed after the patch. The current design is strongest as a report-only proposal engine; it is not yet safe enough as an automatic patch loop.

## Findings

### High: Preview-patch mode is not isolated and can evaluate stale continuity evidence

The design says Phase 2 should apply `review_patch.json`, rerender, rerun QA, and leave original output intact on failure (`docs/design-qa-improvement-loop.md:385`, `docs/design-qa-improvement-loop.md:689`, `docs/design-qa-improvement-loop.md:701`). Current patch paths do not provide that safety by default.

Current behavior:

- `scripts/compile-timeline.ts --patch` writes directly back to `05_timeline/timeline.json` (`scripts/compile-timeline.ts:223`).
- `compile({ reviewPatch })` also writes the patched result to the normal timeline output (`runtime/compiler/index.ts:938`, `runtime/compiler/index.ts:958`).
- The compiler writes `adjacency_analysis.json` before applying `reviewPatch` (`runtime/compiler/index.ts:761`, `runtime/compiler/index.ts:832`, `runtime/compiler/index.ts:938`).
- `runtime/compiler/patch.ts` only reruns `resolve()`, not adjacency decision, transitions, beat-snap, or audio mirror reconciliation (`runtime/compiler/patch.ts:175`, `runtime/compiler/patch.ts:429`).

Impact: reorder, insert, remove, and even some replace fixes can be evaluated against stale adjacency/transition evidence or mutate canonical outputs before the iteration is accepted.

Recommendation: add a Phase 1.5 before preview-patch:

- run patch iterations in a scratch iteration directory or project copy;
- render to iteration-local output paths;
- either apply the patch before adjacency decision or rerun adjacency/transition generation after patching;
- initially allow only replace/trim fixes in preview mode, and keep reorder/insert/remove report-only until transition and audio mirror resync are proven.

### Medium: Pacing fixes are not implementable with the proposed fix vocabulary

The taxonomy says `pacing_too_fast` should usually lengthen holds, but its fix types are `trim`, `remove`, and `swap` (`docs/design-qa-improvement-loop.md:73`). The proposal mapping sends `trim` to `trim_segment` (`docs/design-qa-improvement-loop.md:402`), but `trim_segment` only changes source in/out; it does not increase `timeline_duration_frames` (`runtime/compiler/patch.ts:255`). `replace_segment` also preserves the target clip timeline duration (`runtime/compiler/patch.ts:240`).

Impact: the loop can detect too-fast pacing but cannot deterministically lengthen a clip or close a micro-gap unless it abuses `move_segment.new_duration_frames`, which the design currently treats as reorder.

Recommendation: add an explicit `retime_segment` or `extend_hold` fix type, with gates for source handles, max duration delta, beat fill, and audio mirror sync. Until then, keep `pacing_too_fast` automatic fixes limited to removing accidental flashes or replacing with an already longer candidate whose timeline duration is explicitly set.

### Medium: Brief-alignment gates are not deterministic unless LLM judging is disabled

The design correctly says proposal scoring must not call LLMs (`docs/design-qa-improvement-loop.md:546`). However, the proposed loop reruns brief alignment each iteration (`docs/design-qa-improvement-loop.md:607`), and the current evaluator calls the Gemini judge whenever `useLlm` is not false and a key is available (`runtime/eval/brief-alignment.ts:278`, `runtime/eval/brief-alignment.ts:319`). Reports also get a fresh timestamp unless `evaluatedAt` is supplied (`runtime/eval/brief-alignment.ts:390`).

Impact: the same patch could pass or fail depending on environment and judge variance.

Recommendation: auto-acceptance should use `evaluateBriefAlignment(projectDir, { useLlm: false, evaluatedAt })`. Optional LLM alignment reports can be stored as advisory evidence, but should not drive the rollback floor.

### Medium: The normalized taxonomy and persisted interface do not line up

The taxonomy names precise normalized issues such as `visual_quality_low`, `continuity_break`, `pacing_too_fast`, and `must_have_gap` (`docs/design-qa-improvement-loop.md:69`). The proposed `QAFix.issue_type` collapses these into broad families like `quality`, `continuity`, and `pacing` (`docs/design-qa-improvement-loop.md:217`). Current Marlin issues also have no source issue id (`runtime/eval/marlin-qa-types.ts:1`).

Impact: proposal IDs, rejection reasons, recurrence detection, and issue-specific safety gates become ambiguous. For example, `pacing_too_fast` and `pacing_too_slow` need different allowed fixes, but both become `pacing`.

Recommendation: define a `NormalizedQAIssue` artifact with both `normalized_type` and broad `family`. Derive `issue_id` deterministically from report hash, source, category or axis, timestamp/beat, and normalized description. Store unmapped/report-only reasons there, not only in proposals.

### Medium: Fix-set conflict handling is missing

The design budgets up to four fixes per iteration (`docs/design-qa-improvement-loop.md:477`), but it does not define compatibility rules between accepted fixes. `applyPatch()` applies operations sequentially (`runtime/compiler/patch.ts:165`), so one accepted remove/move can invalidate a later target clip, adjacent pair, or beat window.

Impact: individually safe fixes can conflict as a set, producing patch errors or making the render worse.

Recommendation: add deterministic fix-set selection:

- one accepted fix per `target_clip_id` per iteration;
- no overlapping adjacent-pair fixes in the same iteration;
- no replacement segment reused unless it is an intentional reorder;
- simulate the full patch set before rendering;
- reject conflicts with explicit `conflict_with_proposal_id` reasons.

### Medium: Search usage is conceptually right, but Phase 2 will often be unable to apply best replacements

The design uses existing Qwen visual and CLAP audio channels correctly: visual fixes use `qwen_visual`, audio fixes use `audio_similarity`, and speech/topic gaps stay on text/semantic search (`docs/design-qa-improvement-loop.md:431`, `docs/design-qa-improvement-loop.md:446`). This matches the search API, which exposes visual anchors, audio queries, score breakdowns, and unavailable channels (`runtime/tools/footage-search.ts:94`, `runtime/tools/footage-search.ts:123`).

The apply side is narrower: `replace_segment` and `insert_segment` require `with_segment_id` to exist in the current candidate map (`runtime/compiler/patch.ts:155`, `runtime/compiler/patch.ts:235`, `runtime/compiler/patch.ts:313`). The design notes this (`docs/design-qa-improvement-loop.md:408`), but the Phase 2 plan still depends on search-driven replacements.

Impact: Qwen or CLAP may find the best segment in `footage.db`, but preview-patch mode will reject it unless it is already in `selects_candidates.yaml`.

Recommendation: choose one Phase 2 rule explicitly:

- restrict replacement search to existing candidates, or
- add scratch-only candidate materialization for preview mode, then persist only in Phase 3 after successful QA.

Also add a first-class `candidate_missing` rejection reason.

### Low: Audio continuity should remain a hard-gated future phase

The design puts audio continuity in Phase 4 and says to skip audio fixes when CLAP rows or audio windows are unavailable (`docs/design-qa-improvement-loop.md:720`, `docs/design-qa-improvement-loop.md:731`). That is correct. Current search supports segment-level CLAP text/audio query scoring (`runtime/tools/footage-search.ts:1404`, `runtime/tools/footage-search.ts:1631`), but the reviewed patch path does not recompute audio mirrors after reorder/trim.

Recommendation: keep automatic `audio_continuity_break` fixes disabled until the loop can generate cut-point audio windows and verify nat-sound mirror synchronization after patching.

## Review Criteria

1. Issue taxonomy: strong for rough-cut visual QA, pacing, continuity, must-have gaps, and duration/fill. Add stable issue ids, report-only technical/caption/audio buckets, and keep normalized type names in artifacts.
2. Determinism: good in principle, but Phase 2 needs deterministic brief alignment and a scratch patch runner. Current patch timing makes continuity evidence stale.
3. Convergence and safety: max iterations, fix budgets, rollback, and quality floor are the right shape. Add fix-set conflict rules and explicit no-op/regression rejection.
4. Existing search use: Qwen visual and CLAP audio are used in the right conceptual roles. Candidate materialization is the missing bridge between search results and patch application.
5. Phased plan: Phase 0 and Phase 1 are ordered correctly. Insert Phase 1.5 for patch feasibility/scratch execution before Phase 2. Keep audio/reorder expansion after visual replace/trim is proven.
6. Edge cases: no replacement found and worse-after-fix are mostly covered, but candidate-missing, conflicting fixes, stale adjacency, LLM judge variance, and patch-output isolation need explicit tests.
7. North star fit: yes. The design avoids a stronger opaque editor and instead routes quality through typed issues, structured search evidence, deterministic scoring, bounded changes, and measured before/after results.

## Recommended Next Steps

1. Patch the design before implementation: add `NormalizedQAIssue`, deterministic issue id rules, conflict selection, candidate materialization policy, and a Phase 1.5 scratch patch runner.
2. Constrain Phase 2 to replace/trim only until adjacency and transition regeneration after patch is fixed.
3. Make auto-acceptance use deterministic brief alignment only.
4. Add tests for stale adjacency after patch, conflicting fixes, candidate missing, deterministic no-LLM alignment, no replacement found, and rollback after QA score regression.
