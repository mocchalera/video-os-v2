# BGM generated-candidate shortlist intake evidence

Date: 2026-07-17

Feature: `F-0064` BGM library, rights-safe selection, and shared A2 mixing

Scope: import a private `technical-shortlist/v1` into a hash-verified human
review queue without copying candidate audio or treating technical rank as
musical/rights acceptance.

## Implemented contract and runtime

- `schemas/bgm-technical-shortlist.schema.json` rejects malformed candidate
  metadata and unsafe filenames.
- `schemas/bgm-shortlist-review.schema.json` records musical fit,
  dialogue-bed, artifact quality, originality, rights, and reviewer state as
  independent gates.
- `runtime/music/shortlist-import.ts` infers sequential private batch roots,
  contains paths below each `input/` directory, rejects symlink escape, and
  verifies full-file SHA-256.
- `scripts/bgm-shortlist.ts verify` is read-only. `prepare-review` writes a
  path-redacted queue only when every shortlisted source verifies.
- Re-running `prepare-review` preserves review decisions only when candidate ID
  and content hash match. A malformed existing queue blocks overwrite.

## Real shortlist smoke

The private aggregate shortlist was verified in place. Private source paths,
audio, generator identifiers, and evidence files were not copied into this
repository or Project Loop evidence.

| Fact | Result |
| --- | --- |
| Core catalog slots | 16 |
| Shortlisted candidates | 48 |
| SHA-256 verified sources | 48 |
| Verification errors | 0 |
| Verification warnings | 0 |
| Promotion-eligible before human review | 0 |
| Shortlist SHA-256 | `583ba049d8bcef95d9b6c9c90b577c23e9c65b7abefbd662e310ba06b9a02801` |
| Catalog SHA-256 | `66acae2c53052abcff9baefb6667e6b1c20567889cb7fe73d9aad3702cf2a120` |

The derived `musical-review-queue.json` remains beside the private source
shortlist. A redaction check found no host absolute paths in that artifact.

## Verification

Focused BGM regression:

```text
npx vitest run tests/bgm-shortlist-import.test.ts tests/bgm-contracts.test.ts tests/bgm-pack-runtime.test.ts tests/bgm-selection-intent.test.ts tests/bgm-selection-service.test.ts tests/bgm-selector.test.ts --reporter=dot
Test Files 6 passed
Tests 74 passed
```

TypeScript:

```text
npx tsc --noEmit
exit 0
```

Full Node regression:

```text
npm test -- --reporter=dot
Test Files 181 passed, 4 skipped
Tests 2849 passed, 39 skipped
```

## Remaining human gates

No candidate is accepted or distributable yet. Each catalog slot still needs
representative-dialogue audition, artifact/arrangement review, independent
originality/similarity review, provenance and rights review, accepted-master
editing, loudness/true-peak validation, and explicit release approval. Studio
audition/review UI and pack promotion remain later `F-0064` slices.
