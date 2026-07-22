# CI baseline repair evidence — 2026-07-10

## Outcome

The two failures from GitHub Actions run `29063263116` at base commit `8dd88144`
are repaired and verified on `Dev` at commit `08a39f53`:

- `macos-studio`: source avoids constructs rejected by Apple Swift 5.10 and uses
  deterministic Japanese collection-name collation across runner locales.
- `node-runtime`: the root TypeScript/test graph no longer depends on the editor
  server's Express installation or ignored `outputs/` fixtures, and the CI job now
  installs the FFmpeg media toolchain required by its integration tests.

Internal GitHub Actions run `29073236878` completed successfully with all six
responsibility jobs green. The private development-repository URL is omitted
from the OSS snapshot.

## Changes

### Swift source compatibility

- Removed trailing commas from the `SubprocessRunner.run` declaration and
  `SubprocessRunner.Output` construction.
- Replaced `.compactMap(\.self)` with closure forms in the two affected Studio
  source paths so Swift 5.10 does not need to infer the optional key-path root.
- Snapshotted weak `StudioViewModel` references before entering nested main-actor
  tasks, avoiding Swift 5.10 captured-variable concurrency errors.
- No behavior, package, or public contract changed.

### Clean Node responsibility boundary

- Moved `MAX_THUMBNAIL_SIZE` and `parseThumbnailDimension` into
  `editor/shared/thumbnail-dimensions.ts`, which has no Express or server runtime
  dependency.
- Kept the server route as a consumer of the same shared implementation.
- Pointed the root regression test at the dependency-free shared module.
- Replaced the timeline validation test's hard-coded ignored
  `outputs/<run-id>/ui-test-projects` dependency with checked-in, distilled
  timeline objects covering normal saves, legal same-start audio alternatives,
  and illegal temporal overlap.
- No dependency or TypeScript include/exclude change was made.

### Hosted toolchain and deterministic ordering

- Added `ffmpeg` installation to the `node-runtime` job. This preserves real media
  integration coverage rather than skipping it when the hosted image lacks
  `ffmpeg` / `ffprobe`.
- Replaced current-locale `localizedStandardCompare` ordering with explicit
  `ja_JP` numeric/case-insensitive comparison plus a literal tie-breaker.
- The ordering correction was tracked separately as `D-0009` because Swift 5.10
  compilation succeeded and the only remaining failure was a locale-dependent test
  assertion.

## Verification

### Node runtime and schema contract

Executed in a temporary checkout created from `git archive HEAD`, with only the
current repair files overlaid. The temporary checkout had no `editor/node_modules`.
Dependencies were installed with Node `v22.23.1` and npm `10.9.8`.

| Command | Result |
|---|---|
| `npm ci` | Passed; 306 packages installed from the root lockfile. |
| `npm run validate` | Passed; 15 demo artifacts checked, 0 errors, 0 warnings. |
| `npm run build` | Passed. |
| `npm test` | Passed; 152 files passed, 4 skipped; 2,584 tests passed, 40 skipped. |
| `npm run test:schema-contract` | Passed; 84 tests passed, 1 skipped. |

The first clean archive run exposed one additional clean-checkout defect after the
TypeScript boundary was fixed: `tests/timeline-validation-fixtures.test.ts` read an
ignored output from a prior local UI run. The test was made self-contained, then the
entire clean Node 22 sequence above was rerun successfully.

A Node 22 test attempt against the shared worktree's Node 24-installed
`node_modules` failed only because `better-sqlite3` had ABI 137 while Node 22
requires ABI 127. Reinstalling from the lockfile in the isolated Node 22 checkout
removed that environmental mismatch and produced the passing full result above.

### Other responsibility jobs

| Command and environment | Result |
|---|---|
| Node 22: `npm run verify:repo` | Passed for 1,366 tracked files. |
| Node 22 + Python: `npm run verify:agents` | Passed; 9 Claude/Codex role definitions generated with no diff. |
| Clean Node 22 editor install: `npm --prefix editor ci` then `npm --prefix editor run typecheck` | Passed. |
| Apple Swift 6.2.4: `swift test` | Passed; 516 tests, 0 failures. |
| Apple Swift 6.2.4: `swift run videoos-studio-cli doctor` | Passed. |

The clean npm installs reported the lockfile's existing audit findings (9 root
findings); this patch adds no dependency and does not change that baseline.

## Hosted verification

Final run `29073236878` on commit `08a39f53`:

| Job | Result | Duration |
|---|---|---:|
| `agent-definitions` | Passed | 14s |
| `editor-server` | Passed | 20s |
| `repo-hygiene` | Passed | 32s |
| `schema-contract` | Passed | 52s |
| `macos-studio` | Passed | 1m29s |
| `node-runtime` | Passed | 4m51s |

The hosted macOS job used Apple Swift 5.10, executed all 516 Swift tests, and ran the
Studio CLI doctor. The hosted Node job installed FFmpeg, validated schemas,
typechecked, and completed the full test suite. Gate 0 and defects `D-0007`,
`D-0008`, and `D-0009` now have hosted verification evidence.
