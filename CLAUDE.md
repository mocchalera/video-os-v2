
<!-- project-loop-harness:start -->
## Project Loop Harness

Claude Code should use `pcl` as the only state mutation interface for `.project-loop`.

Before acting:

1. Read `AGENTS.md` and `pcl.yaml`.
2. Run `pcl loop status` or `pcl next` when the next action is unclear.
3. Do not hand-edit generated dashboard HTML or `.project-loop/events.jsonl`.
4. Do not write raw SQL against `.project-loop/project.db`.
5. Preserve evidence paths for claims of completion.
<!-- project-loop-harness:end -->
