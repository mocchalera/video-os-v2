# Video pipeline review fixes completion verification

- Runtime: Node.js v22.23.1, npm 10.9.8
- Focused final regression:
  - `tests/package-cli.test.ts`
  - `tests/macos-studio-contract-fixture.test.ts`
  - `tests/render-pipeline.test.ts`
  - 3 test files passed; 42 tests passed
- Earlier complete focused regression:
  - 13 test files passed
  - 119 tests passed
  - 3 environment-dependent tests skipped
- `npx tsc --noEmit`: passed
- `npm run build`: passed
- `npm run verify:studio-contracts`: passed; generated macOS Studio contract fixture is current and contains no worktree-absolute font paths
- `npm run verify`: all gates passed on the final source state
  - typecheck: passed
  - unit tests: 243 files passed, 6 files skipped; 3613 tests passed, 45 skipped
  - demo schema validation: 15 artifacts checked, 0 errors, 0 warnings
  - demo review-metrics gate: passed

Verified review findings:

1. production package/render boundaries reject legacy clip captions while explicit preview compatibility remains available;
2. shared preflight and render boundaries reject cross-renderer interleaving, cross-renderer z-index ties, and unsupported embedded-base ordering instead of silently reordering;
3. route-planned minimum and runtime-traced H.264 generations remain distinct, with copy, decode, alpha, lossless, and lossy operations classified explicitly;
4. HyperFrames and Remotion cache reuse verifies live codec, pixel format, alpha, dimensions, FPS, duration, WebM timebase, audio absence, hashes, and renderer version;
5. package provenance is hash-bound to route, renderer versions, delivery execution, timeline/captions/final output, layer receipts, and font receipts, including negative `--verify-existing --json` fixtures;
6. caption-enabled genres use the shared style/font oracle and fail closed on unknown styles or invalid font contracts, while `caption_policy.source: none` remains valid.
