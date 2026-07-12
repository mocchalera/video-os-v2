# D-0010 preview API path redaction

## Result

`GET /api/projects` and `GET /api/health` no longer disclose the host filesystem layout. The project list retains `id`, `name`, and `hasTimeline`; health retains `status` and a parseable `timestamp`.

## Changes

- `editor/server/index.ts`
  - removed `projects[].path`
  - removed `health.projectsDir`
- `tests/editor-server-project-health-redaction.test.ts`
  - starts the real editor server against a temporary projects container
  - confirms non-project directories are excluded
  - confirms the useful public fields remain
  - recursively rejects `path` and `projectsDir` keys
  - recursively rejects POSIX and Windows absolute paths, fixture/repository prefixes, `/Users/`, and `/home/`

## Verification

All commands ran with Node.js `v22.23.1` and npm `10.9.8`.

```text
npm run typecheck
PASS

npm --prefix editor run typecheck
PASS

npx vitest run tests/editor-server-project-health-redaction.test.ts tests/editor-server-media-roots.test.ts
2 test files passed; 8 tests passed

npm run verify
158 test files passed; 4 skipped
2622 tests passed; 39 skipped
demo schema: 15 artifacts checked; 0 errors; 0 warnings
all verify gates passed

git diff --check
PASS
```

## Scope and residual risk

This repair changes only two response fields and adds one process-level regression test. It does not add authentication or change the preview server's trusted-local deployment model; that limitation remains documented in `docs/SECURITY_MODEL.md`.

Cockpit implementation task: `28acc637`.
PCL entities: `D-0010`, `F-0048`, `US-0014`, `TC-0056`.

## Closure

- Repair workflow: `WR-0036` (`passed`)
- Human verification: `V-0037` (`approved`)
- Defect: `D-0010` (`closed`)
- Feature: `F-0048` (`done`)
