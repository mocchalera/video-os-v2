# Video pipeline review fixes final verification

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

Final focused coverage includes:

1. legacy clip-caption production rejection and explicit preview compatibility;
2. cross-renderer z-order interleaving, ties, embedded-base constraints, and render-boundary rejection;
3. route minimum and execution-derived H.264 generation counts plus copy/decode/alpha/lossless classification;
4. HyperFrames and Remotion reuse rejection for hash, renderer-version, codec, pixel format, alpha, dimensions, FPS, duration, WebM timebase, or audio drift;
5. valid captioned provenance plus `verify-existing` rejection for route receipt tamper, route/version/encode drift, font receipt missing/tamper, and layer receipt missing;
6. all-genre unknown style/font rejection while preserving `caption_policy.source: none`.
