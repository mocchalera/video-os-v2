# F-0085 YouTube publication request contract — green verification

## Outcome

The mutating YouTube CLI now requires `publication-approval/v2` and resolves
the canonical video, metadata hash, visibility, approved channel ID, and
approval artifact hash before reading an access token or making any network
request.

The upload worker independently verifies the same request identity against the
open video file and authenticated YouTube channel. The approval hash is bound
into the idempotency key, resumable session state, duplicate detection, and
redacted publication receipt.

Legacy `publication-approval/v1` remains readable by publication preflight but
cannot authorize a mutating YouTube request.

## Acceptance evidence

Command:

```sh
PATH=/Users/operator/.nvm/versions/node/v22.23.1/bin:$PATH \
  npx vitest run \
  tests/youtube-resumable-upload.test.ts \
  tests/youtube-publication-request.test.ts \
  tests/publication-preflight.test.ts
```

Result: 3 files passed, 16 tests passed.

The controls prove that:

- an exact v2 approval derives the approved channel and metadata identity;
- modified metadata and conflicting channel overrides fail before upload;
- worker-side metadata mismatches fail before any HTTP request;
- changed approval identity cannot reuse an existing upload receipt;
- receipt and session identity contain the approval hash without secrets; and
- v1 approvals remain preflight-readable but fail the strict mutating request.

Additional verification:

```sh
PATH=/Users/operator/.nvm/versions/node/v22.23.1/bin:$PATH npx tsc --noEmit
PATH=/Users/operator/.nvm/versions/node/v22.23.1/bin:$PATH npm run verify
git diff --check
```

Result: typecheck passed; 3,678 tests passed and 44 skipped; normal verify gates
all passed; diff check passed.

`npm run verify -- --full` also passed typecheck, 3,678 tests, schema
validation, review metrics, and golden evaluation. Its optional render-parity
gate exposed an unrelated existing caption cross-path SSIM mismatch:
`0.996901 < 0.999`. A focused retry reproduced that same mismatch. This slice
does not modify either render path and does not relax that gate.

No YouTube API request, publication, upload, or external message was made.
