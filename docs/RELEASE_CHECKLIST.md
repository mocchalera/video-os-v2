# Release Checklist

Status: current maintainer checklist as of 2026-07-27. This checklist does not
authorize a commit, push, tag, upload, or public release; those remain explicit
human actions.

## 1. Fix the release identity

- Record branch, full commit SHA, upstream divergence, Node/npm/Swift versions,
  and whether the worktree contains unrelated changes.
- Confirm the release surface: code/docs only, package artifact, Studio build,
  NLE handoff, or public repository publication.
- Confirm the source project is rights-cleared and identify whether final
  authority is `engine_render` or `nle_finishing`.
- Do not build release claims from an uncommitted or moving artifact set.

```sh
git status --short --branch
git rev-parse HEAD
git log -3 --oneline
node --version
npm --version
swift --version
```

## 2. Validate repository boundaries

- Inspect the actual diff and untracked files for secrets, personal absolute
  paths, private media, databases, generated reports, renders, and large files.
- Confirm `.env.local`, source footage, `footage.db`, project outputs, and
  Project Loop runtime state are not staged or tracked.
- Run the enforced hygiene check.

```sh
npm run verify:repo
git diff --check
git status --short
```

For a public release, inspect Git history as well; `verify:repo` checks tracked
current files, not historical secrets.

## 3. Validate schemas and executable contracts

Use the smallest checks while iterating, then the aggregate gate before a
release candidate:

```sh
npm run test:schema-contract
npm run test:speech-led-contract
npm run test:event-recap-contract
npm run verify:studio-contracts
npm run test:render-integration
npm run verify
```

`npm run validate` validates the checked-in demo. Use
`npm run validate:all-local` only when intentionally validating local project
artifacts; failures may reflect private/in-progress projects rather than the
release source tree.

For a broad release candidate, run the expensive parity/golden checks:

```sh
npm run verify -- --full
```

The full gate adds golden agreement evaluation and `PARITY=1` render parity.
Record exact file/test counts and any skips from command output.

## 4. Validate supported product boundaries

```sh
npm --prefix editor run typecheck
npx vitest run tests/editor-server-media-roots.test.ts editor/tests/parity
swift test
swift run videoos-studio-cli doctor
npm run verify:agents
```

The required real-render boundary is exactly
`tests/integration/final-render-review-pack.real.test.ts`, selected only by
`vitest.integration.config.ts`. The default Vitest suite must continue to
exclude `tests/integration/**`.

Do not substitute an `editor/client` build for the supported preview-server or
macOS Studio checks. When CI YAML changes, validate its syntax and run
`actionlint` if installed.

## 5. Validate the candidate project state

- Reconcile/status the exact project and record current state, gates, stale
  artifacts, approval status, and pending human steps.
- Confirm the creative brief, analysis, selects, blueprint, timeline, review,
  caption/music, and package artifacts validate against their current schemas.
- Confirm approval artifact bindings still match.
- Confirm `handoff_resolution` is decided and matches the intended manifest.
- Confirm preview evidence is not being mistaken for final/package authority.
- Require passed package QA and a current manifest before claiming `packaged`.

```sh
npx tsx scripts/status.ts projects/<project-id>
npm run package -- projects/<project-id>
```

Run `package` only when the operator has approved its inputs and wants a local
package write. A docs/code release does not require mutating a private project.

## 6. Record media and editorial evidence

For a packaged video, capture:

- final path, SHA-256, duration, frame rate, resolution, audio sample rate, and
  loudness/AV-drift results;
- caption approval and caption count/style evidence when captions are enabled;
- review result, visual-QA verification or explicit reasoned waiver, package
  QA check results, and package manifest hash;
- NLE export/import mapping and human revision diff when the finishing source
  of truth is an NLE;
- editor-effort/product-outcome metrics required by the speech-led contract;
- model/runtime provenance and degraded/fail-open conditions.

The scheduled/manual real-media workflow is the release-grade live-Marlin
gate for the speech-led product:

```text
.github/workflows/speech-led-real-media.yml
```

It requires a rights-cleared project mount, FFmpeg/FFprobe, `HF_TOKEN`, and the
real Marlin model. Do not count a timeout, mock, skipped model, or ordinary
fail-open local result as a passing live-model regression.

## 7. Review CI evidence

The aggregate `product-gate` must show success for `node-runtime`,
`schema-contract`, `speech-led-contract`, `event-recap-contract`,
`repo-hygiene`, `editor-server`, `agent-definitions`, `macos-studio`, and
`render-integration`. Failure, cancellation, or skipping of any boundary must
keep `product-gate` red. Record the workflow URL/run ID and the exact commit
SHA. A green run for another revision is not release evidence.

`macos-studio` supported-toolchain evidence requires actual execution with
Xcode 15.4 build 15F31d and Apple Swift 5.10. A source-level CI contract or a
green run under another Xcode version is not supported-toolchain acceptance.

The optional P4a release-safety report is currently dry-run evidence only. Do
not claim `report_only` or `enforce` protection; those modes are not
implemented in `runtime/artifacts/p4a-release-safety.ts`.

## 8. Human release decision

Before any external write, obtain explicit approval for:

- public push/tag/release or App Store/upload action;
- rights/privacy and delivery destination;
- creative override, visual-QA waiver, or release-safety waiver;
- database/dependency/auth/billing/production configuration changes;
- any destructive cleanup.

Record who approved, when, the exact artifact/commit hashes, scope, reason, and
waiver expiry where applicable. Never self-approve a human gate.

## 9. Publish and verify externally

Only after approval, perform the explicitly requested publish operation. Then
verify the remote commit/tag or uploaded artifact, checksums, downloadable
assets, release notes, and final branch status. Do not infer remote success
from a local command that was not run.

## 10. Evidence report

The release evidence report should include:

- release identity and scope;
- changed files;
- exact commands and exit results;
- test/file counts and skipped checks;
- artifact hashes and media measurements;
- CI/self-hosted run IDs;
- approvals/waivers;
- residual risks and rollback/recovery route;
- the next Project Control Loop action where the repository is harnessed.
