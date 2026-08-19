# Video pipeline review fixes verification

- Runtime: Node.js v22.23.1, npm 10.9.8
- Focused regression suite:
  - 13 test files passed
  - 119 tests passed
  - 3 environment-dependent tests skipped
- `npx tsc --noEmit`: passed
- `npm run build`: passed
- `npm run verify:studio-contracts`: passed; generated macOS Studio contract fixture is current
- `npm run verify`: all gates passed
  - typecheck: passed
  - unit tests: 243 files passed, 6 files skipped; 3613 tests passed, 45 skipped
  - demo schema validation: 15 artifacts checked, 0 errors, 0 warnings
  - demo review-metrics gate: passed

Focused tests cover:

1. production rejection and explicit preview compatibility for legacy clip captions;
2. cross-renderer z-order interleaving, ties, embedded-base constraints, and render-boundary rejection;
3. planned and execution-derived H.264 generation counts plus non-lossy operation classification;
4. HyperFrames and Remotion alpha receipt reuse with live codec, pixel format, alpha, dimensions, FPS, duration, timebase, audio, hash, and version checks;
5. route/layer/font/input/output provenance and existing-package tamper, route, renderer-version, and encode-count drift;
6. all-genre unknown caption style/font rejection while preserving `caption_policy.source: none`.
