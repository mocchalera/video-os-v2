# Deprecated and Historical Surfaces

Status: current retirement/deprecation inventory as of 2026-07-11. “Historical”
means useful evidence, not current authority. Removal still requires a separate
scoped decision and verification.

## Retired product surface

### `editor/client`

The React/Vite Web editor is retired and retained only for historical
reference. Do not add product features, routine fixes, or dependency work to
it. It is excluded from `editor/tsconfig.json` and required CI. Current UI work
belongs in `apps/macos-studio`.

This retirement does not apply to `editor/server` or `editor/shared`; both are
supported preview/parity infrastructure.

## Rejected architecture

### `providers/reasoning/*`

Reasoning is a role runtime, not an API-provider category. Interactive local
agents, automated local agents, and a bounded remote fallback may satisfy a
role. The repository must not model the current chat session as a callable
service endpoint. `ARCHITECTURE.md` records this decision.

## Historical documentation families

The following document families record design evolution and review evidence.
They do not override [CURRENT_ARCHITECTURE.md](CURRENT_ARCHITECTURE.md), current
schemas, CI, or executable paths:

- `docs/milestone-*-design.md`, `docs/milestone-*-review*.md`, and
  `docs/m*-final-review.md`;
- `docs/impl-review-*.md` and `docs/review-phase*-implementation.md`;
- `docs/editor-mvp-design.md`, `docs/editor-v3-design.md`,
  `docs/editor-ai-workflow-*.md`, and other documents whose primary subject is
  the retired Web client;
- `docs/design-three-agent-vlm-architecture.md` and
  `docs/design-simplified-two-model-pipeline.md`, which are architecture
  proposals/snapshots rather than the current runtime router;
- dated audits, reports, and project-memory entries, which remain evidence at
  their recorded revision but may describe earlier branch state.

When a historical document conflicts with code, use this order:

1. current schemas and canonical artifacts;
2. executable runtime/CLI/Studio/server paths and required CI;
3. the current-truth documents linked from the root README;
4. recorded decision/evidence reports at their exact revision;
5. historical design or review prose.

## Legacy but supported compatibility

The following surfaces are not deprecated and must not be removed merely
because newer entrypoints exist:

- individual stage scripts used for debugging and resumable recovery;
- `editor/server` and `editor/shared`;
- FCP7 XML and OTIO handoff adapters;
- backward-compatible artifact fields accepted by current schemas/runtime;
- project-state backtracking and compatibility timestamps;
- optional model connectors and deterministic fallbacks.

Their consolidation or removal requires a separate task with artifact,
consumer, migration, and CI evidence.
