# Video OS v2 spec bundle

This bundle captures the next design layer after introducing subagent roles.

## Included

- `ARCHITECTURE.md` - design decisions and state machine
- `runtime/project.runtime.yaml` - runtime policy
- `contracts/media-mcp.md` - MCP tool contract
- `schemas/timeline-ir.schema.json` - canonical timeline IR
- `schemas/review-patch.schema.json` - validated patch operations
- `agent-src/roles/*.yaml` - canonical role specs
- `.claude/agents/*.md` - generated Claude subagents
- `.codex/agents/*.toml` - generated Codex custom agents
- `scripts/generate_agents.py` - regeneration script
- `projects/_template/` - starter artifact templates
