# CI Responsibility Boundaries

Date: 2026-07-09

## Scope

- Renamed the root Node CI job to `node-runtime` and kept it responsible for root install, schema validation, build/typecheck, and root tests.
- Added a dedicated `schema-contract` CI job running focused schema negative/contract tests via `npm run test:schema-contract`.
- Kept `repo-hygiene` as a dedicated job using `npm run verify:repo`.
- Added an `editor-server` CI job that installs `editor/` dependencies and runs the server/shared TypeScript typecheck.
- Added an `agent-definitions` CI job that installs PyYAML, regenerates agent definitions, and fails on generated drift.
- Added `npm run verify:agents` and `npm run test:schema-contract` scripts.
- Hardened `scripts/generate_agents.py` so non-agent role specs without `claude`/`codex`/`prompt` sections are skipped explicitly instead of crashing.
- Regenerated tracked `.claude/agents` and `.codex/agents` outputs so the new agent drift check has a clean baseline.

## Verification

```text
npm run test:schema-contract
-> 3 test files passed, 80 tests passed

npm --prefix editor run typecheck
-> passed

python3 - <<'PY'
from pathlib import Path
import yaml
path = Path('.github/workflows/ci.yml')
yaml.safe_load(path.read_text())
print('ci.yml parse ok')
PY
-> ci.yml parse ok

npx tsc --noEmit
-> passed

npm run verify:repo
-> Repo hygiene passed for 1363 tracked file(s)

npm run verify:agents
-> Generated Claude and Codex agent definitions for 9 role(s)
-> Skipped role specs without claude/codex/prompt sections: premiere-roundtrip.yaml
-> no generated agent drift after regeneration

git diff --check
-> passed
```

## Notes

- The existing `macos-studio` CI job already runs `swift test` and `swift run videoos-studio-cli doctor`, so this change kept that job and filled the missing schema/editor/agent boundaries.
