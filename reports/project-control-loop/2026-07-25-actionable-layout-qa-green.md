# F-0082 actionable layout QA review projection — green evidence

Date: 2026-07-25

Story: `US-0052`

Feature: `F-0082`

Acceptance test: `TC-0148`

## Outcome

Deterministic layout failures now produce stable, editor-facing review items in
the package QA report. Each item includes:

- a stable issue ID and blocking issue code;
- a deterministic Japanese title and remediation;
- affected layer IDs;
- an inclusive frame range;
- an exact rational-timebase timecode range.

Items are deterministically ordered by frame and issue priority. Version 2
reports require `review_items`, while version 1 reports remain schema-compatible.
The macOS Studio reads this hash-bound package QA projection and displays the
verified state or the first actionable issue plus the remaining issue count. It
does not duplicate the TypeScript policy.

## Verification

```text
PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH \
  npx vitest run \
    tests/deterministic-layout-qa.test.ts \
    tests/package-cli.test.ts
```

Result: 36 tests passed. The package CLI coverage uses the actual
FFmpeg-backed canonical media fixture and confirms a verified v2 report with no
review items.

```text
swift test --package-path apps/macos-studio
```

Result: 600 tests passed with 0 failures. The suite covers blocked and verified
layout-QA decoding, deterministic ordering, Japanese remediation, and Studio
status summaries. The cross-language fixture count assertions were updated to
the current canonical fixture set.

```text
PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH npm run verify
```

Result: passed. Typecheck, unit tests, demo schema validation, and review-metrics
validation succeeded: 248 test files passed, 6 skipped; 3,666 tests passed, 44
skipped.

```text
PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH \
  npm run verify:studio-contracts

git diff --check
```

Result: both passed. The generated Studio contract fixtures remain current and
the task-owned diff has no whitespace errors.

## Scope and safety

- No source media or rendered media was changed or committed.
- No publishing, upload, or external messaging action was performed.
- Existing unrelated worktree changes were preserved.
- This slice projects canonical layout-QA evidence for review; it does not claim
  pixel/OCR inspection of arbitrary rendered frames.
