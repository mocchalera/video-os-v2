# OSS Readiness

This checklist documents the minimum bar before publishing RoughCut Agent as a public repository.

## Ready

- MIT license is present in `LICENSE`.
- Contribution, security, and conduct policies are present.
- CI runs schema validation, tests, and TypeScript build on pull requests.
- `.env.local`, local media, generated renders, temporary files, and non-demo project outputs are ignored.
- `projects/_template/`, `projects/demo/`, and `projects/sample/` are the only project directories intended for version control.
- `npm run verify:repo` enforces that project-directory allowlist.

## Before public announcement

- Confirm the copyright holder text in `LICENSE`.
- Confirm every image under `docs/images/` is either owned by the project or safe to redistribute.
- Review `projects/demo/` for private names, local paths, or third-party media references.
- Decide whether the package should remain `"private": true` or become publishable to npm.
- Run `npm run validate:all-local` only when you intentionally want to audit checkout-local projects; it may fail on ignored work-in-progress outputs.
- Add release notes once the first public tag is created.

## Maintainer release check

```bash
npm install
npm run validate
npm test
npm run build
```

Optional editor check:

```bash
cd editor
npm install
npm run server -- --help
cd client
npm install
npm run build
```
