# M2 Final Review

## Summary

- Verdict: `FAIL`
- FATAL: 4
- WARNING: 2
- Test execution:
  - `npx vitest run`: PASS (`12` files, `351` tests)
  - `npx tsc --noEmit`: PASS

Green tests are not sufficient for a PASS here. The current suite proves the engine layer well, but the M2 final gate still fails on live VLM wiring, MCP contract completeness, E2E scope, and one Phase 3 design mismatch.

## Fatal Findings

### [FATAL 1] `media.extract_window` is missing from the repository contract implementation

- `contracts/media-mcp.md:214-236` defines `media.extract_window` as a first-class MCP tool.
- `runtime/mcp/repository.ts:160-174` defines the `AnalysisRepository` interface, but there is no `extractWindow(...)` method.
- `runtime/mcp/repository.ts:191-500` implements the live repository methods; `projectSummary`, `listAssets`, `getAsset`, `peekSegment`, `readTranscriptSpan`, `openContactSheet`, and `searchSegments` exist, but `extract_window` does not.
- `tests/mcp-repository.test.ts:188-327` covers the implemented tools only; there is no contract test for `extract_window`.

Impact:

- Review point 5 fails.
- Phase 5 "unchanged MCP tools read live artifacts successfully" is not met.
- M2 cannot be marked PASS while one of the contract tools is entirely absent.

### [FATAL 2] The live pipeline cannot execute the Gemini VLM stage outside tests

- `runtime/pipeline/ingest.ts:795-824` only runs Stage 9-10 when `opts.vlmFn` is supplied.
- `scripts/analyze.ts:74-79` calls `runPipeline(...)` without supplying any VLM implementation.
- Unlike STT, there is no default live Gemini adapter factory analogous to `createOpenAiTranscribeFn()`.

Impact:

- A real `scripts/analyze.ts` run cannot satisfy Success Criterion 1 (`ingest -> segment -> contact_sheet -> stt -> vlm`).
- Phase 4 is only implemented as mock-injectable enrichment logic, not as a live connector path.
- Review points 1, 4, 7, and 8 fail at milestone level.

### [FATAL 3] The M2 E2E proof skips both STT and VLM, so Success Criteria 1-5 are not end-to-end verified

- `tests/e2e-m2.test.ts:226-233` runs the main E2E setup with `skipStt: true` and `skipVlm: true`.
- `tests/e2e-m2.test.ts:421-434` repeats the determinism run with `skipStt: true` and `skipVlm: true`.
- The file proves Phase 2 + MCP + M1 compiler compatibility, but it does not prove Phase 3-4 integration in the final end-to-end lane.

Impact:

- Review point 2 fails as written.
- The current E2E does not demonstrate the full M2 success criteria, especially transcript generation, transcript alignment, VLM enrichment, or gap behavior after provider failures in the integrated path.
- A passing E2E suite here would still leave the final milestone gate unproven.

### [FATAL 4] STT speaker normalization does not implement the overlap-anchor design across chunk boundaries

- `runtime/connectors/openai-stt.ts:364-383` normalizes speakers by raw provider label string only.
- `runtime/connectors/openai-stt.ts:318-353` de-duplicates overlap utterances, but it does not build any cross-chunk speaker identity mapping from those duplicates.
- The design requires overlap duplicates to anchor speaker identity across chunk boundaries (`docs/milestone-2-design.md:612-616`).
- `tests/openai-stt.test.ts:350-391` only covers same-label reuse and simple order-of-appearance cases; it does not cover the case where provider-local labels are re-assigned per chunk.

Impact:

- Review point 3 fails.
- Phase 3 deliverable "speaker normalization" is only partially implemented.
- In multi-chunk assets, canonical `S1/S2/...` can be wrong whenever the provider reuses chunk-local labels for different people or changes raw labels for the same person.

## Warnings

### [WARNING 1] `gap_report.yaml` entries are less specific than the design requires, especially for VLM failures

- `docs/milestone-2-design.md:1119-1128` expects `blocking`, `retriable`, `reason`, `attempted_at`, and optional `segment_id`.
- `runtime/pipeline/ingest.ts:672-682` emits VLM gaps with only `stage`, derived `asset_id`, `issue`, and `severity`.
- The same VLM gap path drops `segment_id`, even though the failure is segment-scoped.

Impact:

- Review point 6 is only partially met.
- `analysis_gaps` projection still works, but the underlying ledger loses retry/debug value and segment-level precision.

### [WARNING 2] STT artifact writing bypasses the reducer design and partial transcript persistence is incomplete

- `docs/milestone-2-design.md:1062-1067` says `stt.map` writes shards and `stt.reduce` writes `transcripts/TR_*.json`.
- `runtime/connectors/openai-stt.ts:653-657` writes the final transcript file directly from the map-stage worker path.
- On failure, `runtime/connectors/openai-stt.ts:660-677` returns an in-memory failed transcript but does not persist a `partial` or `failed` transcript artifact.

Impact:

- This does not currently break the green test suite, but it diverges from the documented reducer discipline and leaves the partial-coverage path under-specified.

## Criteria Matrix

1. Phase 3-5 deliverables implemented: `FAIL`
   - Phase 3 has a speaker-normalization gap.
   - Phase 4 lacks a live runtime connector path.
   - Phase 5 is missing `media.extract_window`.

2. Success Criteria 1-5 verified by E2E: `FAIL`
   - E2E skips STT and VLM entirely.

3. STT chunking / merge / speaker normalization: `FAIL`
   - Chunking and duplicate merge are present.
   - Cross-chunk speaker anchoring is not.

4. VLM adaptive sampling / output normalization: `FAIL`
   - Normalization utilities are present and tested.
   - Live VLM execution is not wired into the runtime path.

5. MCP repository vs `contracts/media-mcp.md`: `FAIL`
   - `media.extract_window` is missing.

6. `gap_report` -> `analysis_gaps` projection: `WARNING`
   - Projection ordering/formatting is implemented.
   - Gap entries are missing some required fields and VLM segment granularity.

7. Pipeline stage linkage (`ingest -> segment -> derivatives -> stt -> vlm`): `FAIL`
   - The live CLI path cannot complete the VLM stage.

8. Provider-agnostic interface quality: `WARNING`
   - Type-level abstraction exists for STT/VLM.
   - Runtime factory/injection is incomplete for VLM, so replacement is not yet operationally symmetric.

9. Security (`API key` handling, `execFile`): `PASS`
   - STT uses environment-based key lookup.
   - ffmpeg/ffprobe execution uses `execFile`, not shell interpolation.
   - No auth material persistence issue was found in the reviewed files.

10. Test coverage / failure paths: `WARNING`
   - Strong unit and engine integration coverage.
   - Missing final-lane proof for live STT+VLM together.
   - No repository test for `extract_window`.
   - No test for cross-chunk speaker relabeling.

## Final Judgment

`FAIL`

M2 is not ready for a PASS or commit gate yet. The milestone should be re-reviewed after:

- implementing `media.extract_window` in the repository layer and tests,
- wiring a default live Gemini connector into `runPipeline` / `scripts/analyze.ts`,
- extending `tests/e2e-m2.test.ts` to run the full Phase 2-5 path,
- fixing STT speaker normalization to use overlap-anchor identity reconciliation across chunk boundaries.
