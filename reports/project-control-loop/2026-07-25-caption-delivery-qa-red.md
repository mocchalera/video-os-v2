# Caption Delivery QA — Red Evidence

## Scope

- Goal: G-0012
- Task: T-0052
- Feature: F-0084
- User story: US-0054
- Test case: TC-0150

## Reproduced gap

AX-1 review feedback exposed four reusable caption-delivery failures:

1. caption text appears before its spoken phrase;
2. caption text appears noticeably after the spoken phrase;
3. a cue disappears before the referenced phrase is fully spoken;
4. a strong phrase is displayed for too little time to read.

The repository already has semantic retiming and aggregate dwell/CPS checks, but
package QA does not emit exact, stable editor-facing review items for these
failures, and macOS Studio cannot present their timeline positions or remedies.

## Red test

Command:

```sh
npx vitest run tests/caption-delivery-qa.test.ts
```

Result: failed before collection because
`runtime/review/caption-delivery-qa.ts` does not exist.

The acceptance fixture is media-independent and includes early, late,
premature-exit, short-dwell, intentional protected-reveal, missing evidence,
stale evidence, and non-social cases.
