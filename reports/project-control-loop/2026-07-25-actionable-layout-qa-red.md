# F-0082 actionable layout QA review projection — red baseline

Date: 2026-07-25

Acceptance test: `TC-0148`

## Commands

```text
PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH \
  npx vitest run tests/deterministic-layout-qa.test.ts

swift test --package-path apps/macos-studio \
  --filter ProjectRenderPackageStatusTests
```

## Observed red state

- TypeScript: 11 of 15 layout-QA tests failed because
  `DeterministicLayoutQAResult.review_items` did not exist.
- Swift: `ProjectRenderPackageStatusTests` failed to compile because
  `layoutQAStatus`, `layoutQAReviewSummary`, and `layoutQAReviewItems` did not
  exist.

This confirms that package QA had machine blocking codes but no stable
editor-facing projection, and Studio could only show the aggregate QA failure
count.
