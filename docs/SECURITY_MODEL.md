# Security Model

Status: current local security boundary as of 2026-07-11. This is an
implementation description, not a claim that the repository is a hardened
multi-user or internet-facing service.

## Trust model

RoughCut Agent is local-first tooling for a trusted operator and trusted local
project directories. Source footage, absolute paths, model caches, API keys,
analysis databases, rendered outputs, and package artifacts are sensitive
local capabilities. They are not public repository content.

The supported preview server has no authentication or authorization layer and
`server.listen(port)` does not explicitly restrict the bind address to
loopback. CORS permits only known localhost browser origins, but CORS is not a
network access control. Run the server only on a trusted machine/network,
prefer local firewall/loopback isolation, and do not expose port 3100 to an
untrusted network.

## Secrets and repository boundaries

- Keep secrets in `.env.local`; `.env`, `.env.local`, and `.env.*.local` are
  ignored and rejected if tracked by `npm run verify:repo`.
- Do not commit source footage, rendered media, local footage databases,
  generated project outputs, or Project Loop runtime state.
- `.gitignore` excludes `projects/*` except checked fixtures, media extensions,
  `projects/*/03_analysis/search/`, `projects/*/09_output/`, generated reports,
  and Project Loop database/evidence/dashboard surfaces.
- `scripts/check-repo-hygiene.ts` rejects tracked env files, generated outputs,
  render/QA inspection artifacts, project outputs, project directories outside
  the `_template` / `demo` / `sample` public fixture allowlist, and non-approved
  tracked files over 2 MiB.

Repository hygiene is a publication guard, not a secret scanner. Before a
public release, review the actual Git diff and history for credentials,
personal paths, private content, and binary artifacts.

## Project and media path authorization

`editor/server/utils.ts` applies these controls:

- `safeProjectDir` rejects empty IDs, traversal components, separators, NUL,
  and sibling-prefix escapes before resolving under the configured projects
  directory.
- Source-map candidates are resolved to real paths before authorization.
- Allowed roots are the project, its `02_media`, its `.cache`, and roots
  explicitly supplied through `VIDEO_OS_ALLOWED_MEDIA_ROOTS` or
  `VOS_ALLOWED_MEDIA_ROOTS`.
- An external file is also allowed when its exact real path is reached through
  a symlink located inside the project's `02_media` directory. This supports
  local media libraries without authorizing arbitrary absolute paths.
- API source-map responses remove `local_source_path`, `link_path`, and
  `source_locator`, preserving stable client fields without disclosing local
  capability paths.

`editor/server/routes/media.ts` additionally rejects traversal in the legacy
filename route, uses `realpath`, supports bounded byte ranges, and refuses a
forced full interactive transcode above 1 GiB. Thumbnail dimensions are
bounded by the shared parser and covered by security regression tests.

The core `runtime/media/source-map.ts` may persist absolute local locators in a
project-local source map because runtime processes need them. That document is
sensitive and must not be exposed raw or committed with private project data.

## Write integrity and concurrency

Timeline writes through the preview server use a per-project advisory
`timeline.json.lock` with PID/operation metadata, stale-lock cleanup, exclusive
creation, and atomic temp-file rename. Project-state writes are atomic and can
use revision hashes to reject concurrent changes with `STATE_CONFLICT`.

Locks prevent common local races; they are not a distributed transaction or a
multi-user authorization system. Generated lock files are transient and must
not be committed.

## Process execution boundaries

Media operations invoke known binaries with argument arrays (`execFile` or
`spawn`) rather than shell-composed media paths. Agent output may propose
bounded patch operations, but only repository compiler/render/package engines
write canonical timelines or media. External agent execution, public pushes,
dependency changes, production configuration, and destructive operations
remain explicit human-authority boundaries.

## Network and external-model boundaries

Local Qwen3-VL, CLAP, Marlin, E5, FFmpeg, and SQLite paths are preferred.
Gemini, Groq, OpenAI, pyannote, or other configured integrations may send the
inputs required by their connector. Enabling one is an operator decision:
review the connector, provider policy, credentials, and media rights first.

Ordinary local operation is fail-open when optional model infrastructure is
missing. `.github/workflows/speech-led-real-media.yml` is different: it runs on
a controlled self-hosted media runner, requires the rights-cleared project
mount and live-model credential, fails closed, and uploads JSON evidence while
excluding `rough-cut.mp4`.

## Known limitations

- The preview server is unauthenticated and not explicitly loopback-bound.
- The JSON request limit is 50 MiB; this is a functional cap, not comprehensive
  denial-of-service protection.
- Allowed environment media roots grant read capability to files underneath
  them; configure the narrowest possible roots.
- Symlinks intentionally extend read capability to their exact external target.
- Repo hygiene does not inspect Git history or guarantee that text files lack
  secrets/private paths.
- Release-safety `report_only` and `enforce` modes are not implemented; current
  executable support is feature-flagged `dry_run` only.

## Minimum security verification

```sh
npm run verify:repo
npx vitest run tests/editor-server-media-roots.test.ts
npm --prefix editor run typecheck
git diff --check
git status --short --branch
```

For a public release, also follow [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md)
and the disclosure policy in the root [SECURITY.md](../SECURITY.md).
