# AGENTS.md

## Project

RoughCut Agent — artifact-driven video editing agent for turning source footage and a short brief into analysis, retrieval, rough/fine planning, compiled timelines, rendered outputs, and QA feedback loops.

## Setup

```sh
npm install
cp .env.example .env.local
```

Required local toolchain:

- Node.js 22.x LTS (CI parity; see `.nvmrc` / `.node-version`)
- npm 10.x

## Common Commands

| Task | Command |
|---|---|
| Demo | `npm run demo` |
| Test | `npm test` |
| Typecheck | `npx tsc --noEmit` |
| Build | `npm run build` |
| Verify | `npm run verify` |
| Full verify | `npm run verify -- --full` |

## Hard Rules

- Preserve unrelated dirty worktree changes.
- Treat canonical artifacts as truth: `creative_brief.yaml`, `selects_candidates.yaml`, `edit_blueprint.yaml`, `timeline.json`, `render-report.json`, QA reports, and `footage.db`.
- Keep Qwen3-VL, CLAP, Marlin, and other local-model paths fail-open when model cache or optional dependencies are absent.
- Do not commit `.env.local`, source footage, rendered media, or generated project outputs unless explicitly requested.
- For review-only or docs-only tasks, do not modify runtime code.

## Where Agents Should Look

- North Star: `goal.md`
- Durable plan and handoff: `docs/project-memory/`
- README and CLI entrypoints: `README.md`
- Architecture: `ARCHITECTURE.md`
- Planning route guidance: `docs/planning-routes.md`
- Source: `runtime/`, `scripts/`, `apps/`, `editor/`
- Schemas: `schemas/`
- Tests: `tests/`, `editor/tests/`

<!-- project-loop-harness:start -->
## Project Loop Harness (temporarily paused)

Project Loop Harness and the `project-control-loop` skill are temporarily
paused for this repository. Do not invoke the skill or run `pcl` commands
unless the user explicitly asks to re-enable or use them.

The installed `.project-loop/` state and `pcl.yaml` are retained unchanged so
the harness can be re-enabled later. Never hand-edit their generated or
database files while the harness is paused.
<!-- project-loop-harness:end -->
