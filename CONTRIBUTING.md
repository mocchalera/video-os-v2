# Contributing

RoughCut Agent is an artifact-driven video editing pipeline. Contributions should keep the pipeline reproducible, schema-first, and safe for real media projects.

## Development setup

```bash
npm install
npm run validate
npm test
npm run build
```

The optional editor UI has separate dependencies:

```bash
cd editor
npm install
cd client
npm install
npm run build
```

## Pull request checklist

- Keep generated media, local project outputs, API credentials, and private footage out of Git.
- Add or update schemas when changing canonical artifact shape.
- Add tests for compiler, validator, render, or command behavior changes.
- Update `README.md` or `docs/` when public CLI behavior changes.
- Run `npm run validate`, `npm test`, and `npm run build` before opening a PR.

## Repository boundaries

- `projects/demo/` and `projects/_template/` are the only project directories intended for version control.
- `projects/*` is otherwise local output and may contain private or licensed media.
- `.env.local`, API keys, source footage, rendered videos, and temporary contact sheets must remain local.

## Coding style

- Prefer deterministic transformations over hidden mutable state.
- Treat YAML/JSON artifacts as public contracts.
- Keep CLI output actionable for operators.
- Do not add network calls to deterministic compiler paths.
