# Source Map Media Boundary

Date: 2026-07-09

## Scope

- Kept the existing editor-server media resolver boundary in place:
  - source-map paths resolve through `realpath`.
  - arbitrary absolute paths are rejected.
  - project-local media and explicit allowed media roots remain supported.
  - linked external media is only allowed when linked through project `02_media`.
- Redacted source-map API responses so `local_source_path`, `source_locator`, and `link_path` are not exposed to the browser.
- Preserved client playback through server-issued asset URLs under `/api/projects/:id/media/by-asset/:assetId`.
- Added tests for source-map API redaction and thumbnail dimension limits.
- Documented `source_map.json` as a capability file in `SECURITY.md`, including allowed-root, redaction, and thumbnail resource-limit rules.

## Verification

```text
npx vitest run tests/editor-server-media-roots.test.ts
-> 1 test file passed, 7 tests passed

npm --prefix editor run typecheck
-> passed

npx tsc --noEmit
-> passed

npm run verify:repo
-> Repo hygiene passed for 1364 tracked file(s)

git diff --check
-> passed
```
