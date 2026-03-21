#!/usr/bin/env python3
from pathlib import Path
import yaml

ROOT = Path(__file__).resolve().parents[1]
ROLE_DIR = ROOT / "agent-src" / "roles"
CLAUDE_DIR = ROOT / ".claude" / "agents"
CODEX_DIR = ROOT / ".codex" / "agents"

CLAUDE_DIR.mkdir(parents=True, exist_ok=True)
CODEX_DIR.mkdir(parents=True, exist_ok=True)

def to_codex_name(name: str) -> str:
    return name.replace("-", "_")

for path in sorted(ROLE_DIR.glob("*.yaml")):
    spec = yaml.safe_load(path.read_text(encoding="utf-8"))

    # Claude
    fm = {
        "name": spec["name"],
        "description": spec["description"],
        "tools": spec["claude"]["tools"],
        "model": spec["claude"]["model"],
        "permissionMode": spec["claude"]["permissionMode"],
        "maxTurns": spec["claude"]["maxTurns"],
        "effort": spec["claude"]["effort"],
        "background": spec["claude"]["background"],
    }
    frontmatter = yaml.safe_dump(fm, sort_keys=False, allow_unicode=True).strip()
    claude_text = f"---\n{frontmatter}\n---\n\n{spec['prompt'].strip()}\n"
    (CLAUDE_DIR / f"{spec['name']}.md").write_text(claude_text, encoding="utf-8")

    # Codex
    codex_name = to_codex_name(spec["name"])
    lines = [
        f'name = "{codex_name}"',
        f'description = "{spec["description"].replace(chr(34), r"\"")}"',
        f'model = "{spec["codex"]["model"]}"',
        f'model_reasoning_effort = "{spec["codex"]["model_reasoning_effort"]}"',
        f'sandbox_mode = "{spec["codex"]["sandbox_mode"]}"',
        'developer_instructions = """',
        spec["prompt"].strip(),
        '"""',
    ]
    if spec["codex"].get("nickname_candidates"):
        nicks = ", ".join(f'"{n}"' for n in spec["codex"]["nickname_candidates"])
        lines.append(f"nickname_candidates = [{nicks}]")
    (CODEX_DIR / f"{codex_name}.toml").write_text("\n".join(lines) + "\n", encoding="utf-8")

print("Generated Claude and Codex agent definitions.")
