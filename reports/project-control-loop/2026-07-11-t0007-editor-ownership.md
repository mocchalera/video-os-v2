# T-0007 Editor Ownership Evidence

Date: 2026-07-11 JST  
Task: `T-0007` — Clarify editor legacy and preview-server ownership  
Branch baseline: `Dev` at `d5c5f181`, one local commit ahead of `origin/Dev`

## Decision

1. `apps/macos-studio` is the canonical current operator product. Its Swift GUI and `videoos-studio-cli` read canonical artifacts and invoke repository scripts/runtimes directly.
2. `editor/server` remains current, supported local preview/API infrastructure. It is an independently started Express/WebSocket service that owns exact-preview jobs, media delivery, timeline/review APIs, and project notifications.
3. `editor/server` is not a runtime dependency of macOS Studio. The native app does not start it or call its port-3100 HTTP/WebSocket API; Studio instead resolves project media/artifacts and invokes TypeScript scripts through Swift subprocess runners.
4. `editor/shared` remains supported because preview and final-render paths consume its parity contracts.
5. `editor/client` is retired/legacy. It remains in the repository for historical reference but is not a supported product surface, is excluded from `editor/tsconfig.json`, and is intentionally absent from required CI.

No runtime behavior or dependency changed. Existing CI ownership checks were present, so only their contributor-facing labels/comments were clarified.

## Executable and CI evidence

- `Package.swift` declares `VideoOSStudio`, `VideoOSStudioCore`, and `videoos-studio-cli`; `.github/workflows/ci.yml` runs SwiftPM tests plus `swift run videoos-studio-cli doctor` in the required `macos-studio` job.
- `apps/macos-studio/Sources/VideoOSStudio/VideoOSStudioApp.swift` is the native `@main` application entrypoint. Swift runner types, including `ProjectRenderRunner`, execute `scripts/editor-job-worker.ts` and other repository entrypoints directly.
- `editor/package.json` exposes `server` / `server:dev` as executable scripts. `editor/server/index.ts` creates the Express HTTP server, mounts preview/media/timeline/review routes, creates the WebSocket and watch hubs, and listens on port 3100 by default.
- `editor/server/routes/preview.ts` builds RenderSpec-backed preview jobs and `editor/server/services/preview-job-service.ts` renders/broadcasts their state.
- `editor/client/vite.config.ts` proxies the retired client to port 3100, but a repository-wide executable reference search found no macOS Studio source that launches or calls `editor/server`.
- `editor/tsconfig.json` includes only `server/**/*.ts` and `shared/**/*.ts`. The required CI `editor-server` job runs this typecheck. Root Vitest discovery also includes `editor/tests/parity/**` and `tests/editor-server-media-roots.test.ts`; it does not build `editor/client`.
- Existing `editor/README.md` recorded the 2026-07-07 human-approved Web client retirement, but its title described the entire directory as retired. The updated ownership matrix removes that ambiguity without reversing the client retirement decision.

## Documentation and CI guidance changed

- `README.md`: added contributor-facing current product/runtime ownership and supported CI boundaries.
- `ARCHITECTURE.md`: added an executable/CI ownership table and stated the independence of Studio and the preview server.
- `editor/README.md`: split supported server/shared ownership from the retired client policy and documented the verified server startup command.
- `.github/workflows/ci.yml`: clarified the existing editor job step and product-gate success label; commands, dependencies, job graph, and enforcement behavior are unchanged.

## Acceptance check

| T-0007 acceptance area | Result |
| --- | --- |
| Decide whether `editor/server` remains live preview infrastructure | Met: documented as current supported, independently started local preview/API infrastructure |
| Decide whether `editor/client` is legacy only | Met: documented as retired/legacy and outside normal feature, bug-fix, dependency-update, and required-CI ownership |
| Update directory ownership and README guidance | Met in root `README.md`, `ARCHITECTURE.md`, and `editor/README.md` |
| Align CI coverage guidance | Met by documenting the existing `macos-studio`, `editor-server`, and Node-test boundaries and clarifying CI labels without behavior changes |
| Avoid runtime/dependency changes | Met: documentation and CI labels/comments only; no dependency files or runtime source changed |

## Verification

| Command | Result |
| --- | --- |
| `pcl doctor --json` | Passed; one pre-existing warning that `pcl.yaml` has an empty lint command |
| `pcl validate --strict --json` (baseline) | Passed with pre-existing lifecycle/evidence advisories and no errors |
| `npm --prefix editor run typecheck` | Passed |
| `npx vitest run editor/tests/parity tests/editor-server-media-roots.test.ts` | Passed: 6 files / 36 tests; 2 files / 36 ffmpeg-gated tests skipped because `PARITY=1` was not set |
| `npm run verify:repo` | Passed for 1,392 tracked files |
| `swift run videoos-studio-cli doctor` | Passed; built the CLI and reported the repository plus 29 projects |
| Process smoke: start `npm --prefix editor run server -- --project ../projects --port 3317`, then `curl -fsS http://127.0.0.1:3317/api/health` | Passed; returned `status: ok` and the repository `projects` directory |
| `git diff --check` | Passed |
| `ruby -e 'require "yaml"; YAML.parse_file(".github/workflows/ci.yml")'` | Passed YAML syntax parse |
| `actionlint .github/workflows/ci.yml` | Not run: `actionlint` is not installed locally; workflow commands and structure were not changed |

The first process-smoke draft used `--project projects`, which npm resolved under `editor/` and correctly rejected. The documentation and smoke command were corrected to `--project ../projects`; the second and final smoke passed. This was a documentation-path error, not a runtime failure.

## Residual risk

- The full ffmpeg parity suite was not enabled; this task changed no render/runtime code, and the fast parity/security suite plus process health check passed.
- GitHub Actions was not executed locally and `actionlint` was unavailable. CI behavior was not expanded or weakened; only comments, a step label, and a success message changed.
- `editor/server` currently has no canonical macOS Studio consumer. It remains supported because it is executable, required by CI, and owns tested preview/parity infrastructure; future removal or integration should be a separate explicit task.

## Repository hygiene

- The pre-existing local commit `d5c5f181` remains the branch tip and was not amended or reset.
- No commit or push was performed.
- Generated Project Loop lock files must be removed after the final PCL validate/render sequence.
