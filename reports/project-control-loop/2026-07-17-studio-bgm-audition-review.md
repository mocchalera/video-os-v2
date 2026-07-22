# Studio BGM audition and human-review evidence

Date: 2026-07-17

Scope: generated Core Pack candidate audition and five-gate review in
VideoOSStudio. This evidence intentionally excludes accepted-master
arrangement, A2 apply/lock, final mix parity, and public-release approval.

## Implemented behavior

- Studio exposes a top-bar BGM review action and command-palette entry.
- A dedicated three-pane surface lists and filters the path-redacted review
  queue, auditions the selected candidate, and records five independent gates:
  musical fit, dialogue-bed fit, generated-artifact quality, originality, and
  rights evidence.
- Candidate audio is contained within inferred private batch roots and its
  SHA-256 is checked before audition. Save uses the shared Node CLI, repeats the
  source check, validates the whole artifact, and atomically replaces the queue.
- The dialogue-overlay action uses only an exact project timeline preview. It
  remains unavailable with an explanatory message when no exact preview exists.
- Opening, searching, filtering, and auditioning do not mutate the queue.
  Explicit human input and save are required. A review-complete or
  promotion-eligible candidate is not treated as public-release approval.

## Real candidate intake verification

Read-only verification of the private `technical-shortlist/v1` returned:

- tracks: 16
- shortlisted candidates: 48
- source SHA verified: 48
- promotion eligible: 0
- errors: 0
- warnings: 0
- shortlist hash:
  `sha256:583ba049d8bcef95d9b6c9c90b577c23e9c65b7abefbd662e310ba06b9a02801`
- catalog hash:
  `sha256:66acae2c53052abcff9baefb6667e6b1c20567889cb7fe73d9aad3702cf2a120`

No human review values were written during verification or visual QA.

## Automated verification

```text
npx vitest run tests/bgm-shortlist-import.test.ts --reporter=dot
12 passed

npx tsc --noEmit
passed

swift test --filter BGMReviewTests
5 passed

swift test --filter StudioCommandPaletteCommandTests
5 passed

swift build --target VideoOSStudio
passed

swift test
543 passed, 0 failed

PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH npm test -- --reporter=dot
2852 passed, 39 skipped, 0 failed

./script/build_and_run.sh --verify
passed; a visible Video OS Studio window was created
```

The first full Node attempt used a host-level Node 24 shim and failed only in
native `better-sqlite3` tests because the repository dependency was built for
Node ABI 127. Re-running with the repository-required Node 22.23.1 matched ABI
127 and passed the full suite. No dependency rebuild or lockfile mutation was
used to hide the environment mismatch.

## Manual visual verification

- The remembered private queue loaded in Studio after the macOS Documents
  access prompt was approved.
- The header reported 48 SHA-verified, 0 complete, 48 incomplete, and 0
  promotion-eligible candidates.
- The first candidate exposed rank, BPM, technical score, generator comments,
  BGM-only audition, dialogue/BGM monitor levels, and all five review gates.
- With the current sample project lacking an exact timeline preview, Studio
  disabled dialogue-overlay audition and explained how to enable it instead of
  substituting approximate media.

## Remaining gates

- A reviewer must listen and record the five gates; this implementation does
  not infer human acceptance from technical rank.
- Review-passed audio still requires arrangement/editing, similarity and
  qualified rights review, accepted-master creation, A2 apply/lock, shared
  preview/final mix QA, and explicit pack/public-release approval.
