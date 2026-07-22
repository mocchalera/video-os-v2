# Review P0 Hardening Evidence

Date: 2026-07-09

## Scope

Implemented the low-risk P0 governance fixes from the third-party senior
engineering review:

- Make timeline clip root fields schema-strict while keeping `clip.metadata`
  as the extension point.
- Add negative schema tests for clip root, clip metadata, marker root, and
  marker metadata behavior.
- Add thumbnail `width` / `height` bounds checking for the editor server.
- Align project toolchain metadata with CI: Node 22 / npm 10.
- Ignore new generated output artifacts.

Out of scope for this slice:

- Removing already-tracked `outputs/` history.
- Pipeline entrypoint consolidation.
- QA failure state artifact redesign.
- `source_map` allowed-root capability checks.
- macOS Studio ViewModel/View decomposition.

## Changed Files

- `.gitignore`
- `.nvmrc`
- `.node-version`
- `AGENTS.md`
- `package.json`
- `package-lock.json`
- `editor/package.json`
- `editor/server/routes/thumbnails.ts`
- `schemas/timeline-ir.schema.json`
- `tests/cut-transition.test.ts`

## Verification

Commands run locally:

```text
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
which node
=> /Users/operator/.nvm/versions/node/v22.23.1/bin/node
node -v
=> v22.23.1
npm -v
=> 10.9.8

npx vitest run tests/cut-transition.test.ts
=> 80 tests passed

npm run typecheck
=> passed

npm --prefix editor run typecheck
=> passed

npm run validate
=> valid=true, artifacts_checked=15, error_count=0, warning_count=0

npx tsx -e 'import { parseThumbnailDimension } from "./editor/server/routes/thumbnails.ts"; ...'
=> [160,2048,null,null,null,160]

git diff --check
=> passed
```

Environment note:

```text
The login shell still resolves bare node to /Users/operator/.local/bin/node
v24.8.0, so verification pinned PATH to the nvm Node 22 binary explicitly.
```
