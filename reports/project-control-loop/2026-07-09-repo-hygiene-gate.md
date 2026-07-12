# Repo Hygiene Gate Evidence

Date: 2026-07-09

## Scope

Implemented the repository-boundary slice from the third-party review:
generated outputs and generated inspection artifacts are no longer valid tracked
repo content, and CI now checks that boundary.

This slice covers:

- `scripts/check-repo-hygiene.ts`
- `package.json`
- `.github/workflows/ci.yml`
- tracked generated files under `outputs/`
- tracked generated `*.inspect.ndjson` artifacts

## Changes

- Added `npm run verify:repo`.
- Added a `repo-hygiene` GitHub Actions job on Node 22.
- The hygiene checker scans `git ls-files`, not the local filesystem, so ignored
  local footage, virtualenvs, caches, and generated outputs do not create false
  local failures.
- The checker blocks tracked:
  - `outputs/`
  - `reports/generated/`
  - `.env` / `.env.local` / `.env.*`
  - `*.inspect.ndjson`
  - `*.render.json`
  - `*.qa.json`
  - `projects/*/09_output/`
  - unexpected tracked files larger than 2 MiB
- Removed generated tracked artifacts from the index:
  - `outputs/`: 234 tracked files removed from Git tracking
  - `*.inspect.ndjson`: 2 tracked files before cleanup, 0 after cleanup
- Local `outputs/` files were preserved; only Git tracking was removed.

## Verification

Commands run locally with Node v22.23.1 / npm 10.9.8 by pinning PATH to
`$HOME/.nvm/versions/node/v22.23.1/bin`:

```text
npm run verify:repo
=> Repo hygiene passed for 1349 tracked file(s).

npm run typecheck
=> passed

npm run validate
=> valid=true, artifacts_checked=15, error_count=0, warning_count=0

ruby -e 'require "yaml"; YAML.load_file(".github/workflows/ci.yml"); puts "workflow yaml ok"'
=> workflow yaml ok

git diff --check
=> passed

git ls-files outputs | wc -l
=> 0

git ls-files '*.inspect.ndjson' '*.render.json' '*.qa.json' | wc -l
=> 0

test -e outputs/019eee15-26e2-7cd0-b070-cb96ee4ee5ed/preview-debug/current-app.png
=> local outputs preserved
```

## Notes

- Large tracked UX screenshots under `docs/ux/screenshots/` and current native
  editor visual QA evidence under `reports/native-editor-visual-qa*.png` are
  explicitly allowed as existing review artifacts.
- This prevents new generated-output drift; it does not rewrite historical Git
  blobs.
