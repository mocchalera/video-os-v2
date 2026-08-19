# Public promotion contract

Routine OSS publication is the default. Scan the public projection, branch
from current public `main`, push without force, let GitHub CI run, then merge
after ordinary PR/human review. No command in this repository pushes, updates a
ref, or merges. The parentless signed Stage A/B envelope path is optional
high-assurance only and is not required for normal OSS maintenance.

The public tree must exclude private history and pass the pinned secret scan.
A routine public commit may have the current public `main` as its only parent
and must use only that already-scanned public projection tree.

## Current status

- Stage A has an approved repository-owned scanner route. The policy pins the
  scanner, encoded rules, wrapper, verifier, and execution trust-root IDs by
  digest. The finalizer never trusts a clean boolean: it validates the complete
  findings ledger and re-runs the pinned scanner against the same immutable
  staging payload between the existing pre/post source and staging checks.
- The scanner reports only rule ID, raw-path base64, location, and a hash of the
  matched bytes. It recognizes private-key material and high-confidence GitHub,
  GitLab, AWS, Google, npm, PyPI, OpenAI, Slack, Stripe, and assigned
  high-entropy credential forms. Rules are explicit and digest-bound; changing
  coverage requires a policy review and new digest.
- GitHub provider evidence is collected and revalidated through authenticated,
  read-only `gh api` calls against fixed repository ID `1188541623`, fixed name
  `mocchalera/video-os-v2`, and fixed workflow `.github/workflows/ci.yml`.
- Optional Stage B remains unused for routine OSS work. It stays blocked until
  a custodian supplies an external Stage-A public key/digest reviewed into
  `runtime/release/public-promotion-trust.json`. No private key may enter this
  repository.
- The Cockpit adapter still cannot mint an approval receipt from current
  `cockpit task get` conversation text, even when that text contains
  hand-written v2 JSON, a fake `resolved_at`, or `kind`/`source` labels.
  Recording fail-closes with typed blocker
  `cockpit-ask-authenticated-surface-unavailable/v1`
  (`cockpit_ask_authenticated_surface_unavailable`). Conversation text, a
  hand-written timestamp, wall clock, filesystem mtime, or conversation order
  is not accepted.
- No command in this repository pushes, updates a ref, changes settings, tags,
  or creates a release. Candidate and `main` mutations remain parent/operator
  actions after explicit authorization.

Repository hygiene is not a secret scan. See `docs/SECURITY_MODEL.md`.

## Stage A: public projection receipt

1. Start from an exact clean source commit and tree.
2. Generate into a new empty staging directory with `--no-receipt`.
3. Keep the generated `<staging>.generation.json` outside staging. It binds the
   source commit/tree, raw policy hash, policy ledger, complete public path
   ledger, and staging payload hash at generation time.
4. An approved wrapper must scan that immutable staging directory directly.
5. The wrapper must produce a canonical attestation and detached signature (or
   an approved execution receipt) binding scanner identity/version, scanner
   binary digest, rules digest, target payload digest, exit code, result, and
   finding count.
6. Finalization rechecks source HEAD/tree/cleanliness, raw policy bytes, every
   staging path/type/mode/content or symlink target, the attestation target, and
   its trusted producer. It performs the same checks again after signature
   verification to close the scan-to-finalize race.
7. Only then may canonical Stage A bytes be written outside staging.

Generation interface:

```sh
npx tsx scripts/generate-public-projection.ts \
  --source /absolute/path/to/exact-clean-source \
  --output /absolute/path/to/new-public-staging \
  --policy runtime/release/public-projection-policy.yaml \
  --no-receipt
```

The generator refuses dirty input, unknown policy paths, unknown transforms,
gitlinks, unsupported modes/types, absolute or escaping symlinks, and non-empty
output. It materializes regular files read-only and directories non-writable.
Generator materialization remains path-based and therefore assumes a trusted
local output parent that is not writable by an adversary during generation.
Do not place staging beneath a shared or attacker-writable directory. Stage A
and Stage B final evidence files use the stronger anchored exclusive-output
boundary described below.

Run the pinned scanner against the immutable staging directory:

```sh
npx tsx scripts/run-public-projection-secret-scan.ts \
  --staging /absolute/path/to/public-staging \
  --generation-snapshot /private/evidence/generation.json \
  --attestation-out /private/evidence/scan-attestation.json \
  --execution-receipt-out /private/evidence/scan-execution-receipt.json
```

Finalize Stage A through the approved execution-receipt lane:

```sh
npx tsx scripts/finalize-public-projection-receipt.ts \
  --source /absolute/path/to/exact-clean-source \
  --staging /absolute/path/to/public-staging \
  --policy runtime/release/public-projection-policy.yaml \
  --scan-attestation /private/evidence/scan-attestation.json \
  --wrapper-execution-receipt /private/evidence/scan-execution-receipt.json \
  --receipt-out /private/evidence/stage-a-receipt.json
```

Supplying both evidence routes, neither route, a manual JSON result, or a
detached scan signature without a configured verifier is rejected.

### Stage A contents

Stage A contains:

- hashed source repository identity, exact source commit/tree, and `dirty:
  false`;
- raw policy SHA-256 and verifier version;
- include/exclude/transform decisions for every source path;
- every public path in raw-byte canonical order, with lossless `path_b64`,
  auxiliary display path, Git type/mode, raw content SHA-256 or symlink target
  bytes/hash, and source/transform mapping;
- canonical public ledger hash and complete staging payload hash;
- the trusted scan attestation, its hash/signature, and verifier receipt.

Stage A never contains its own final-byte SHA-256, a public commit/tree SHA, or
a CI URL. Its final-byte SHA-256 is external evidence that later binds both the
canonical public commit message and `stage_a_receipt_sha256` in private Stage B.

Any source, policy, staging, scan, or receipt mismatch invalidates Stage A.
After scan-time drift, discard staging and regenerate; do not rescan or repair
it in place.

Stage A receipts and Stage B envelopes are created by a same-runtime worker
with a hermetic environment whose current directory is fixed to the verified
parent inode. In that anchored directory the worker writes and fsyncs all bytes
to an unpredictable exclusive/no-follow temporary leaf, verifies its exact
inode, size, mode, name identity, and single-link state, and rechecks the parent
and containing-directory identities. Only then does an atomic no-clobber hard
link publish the final leaf. The worker requires link counts `1 -> 2 -> 1`
across temp-only, temp-plus-final, and final-only states. A same-UID process
that adds a hard link or replaces either name while the worker runs therefore
fails closed. Cleanup is limited to identity-matching entries in the anchored
parent and never searches or removes aliases through external paths.

A crash before publication can leave only an unpublished partial temporary
leaf. A crash after the hard link but before temporary-name removal may leave
the final leaf plus a hidden recovery artifact; both names reference the same
fully written, fsynced inode with the exact final mode, never partial bytes.
The temp unlink is otherwise the next mutation after publication verification.
New output directories are mode `0700`; pre-existing parents and changes made
by same-UID processes after the worker's final identity check are a
trusted-local boundary.

## Optional high-assurance Stage B

The parentless signed Stage A/B envelope is optional high-assurance evidence.
It is not required to publish scanned public trees through ordinary GitHub
review. When used, Stage B is created only after human approval, an exact
public commit exists, and public CI has completed. It must remain outside the
public repository.

The verifier requires:

- canonical Stage A bytes authenticated in full by an independently configured
  detached-signature verifier, including a digest-bound verification receipt;
- a read-only repository containing the full exact public commit object;
- an exact public commit with no parent headers, so the public destination
  cannot make private or excluded history reachable;
- exact canonical commit metadata: the fixed non-person identity
  `Video OS Public Projection <public-projection@video-os.invalid>`, timestamp
  `0 +0000`, no optional headers, and the canonical message bound to the Stage
  A receipt SHA-256;
- destination provider, immutable repository ID, full name, and exact branch;
- workflow path and exact-commit workflow blob SHA;
- trusted provider evidence for run ID/attempt/event/head SHA/head branch/URL,
  destination identity, exact required jobs, and `product-gate`, verified only
  through `provider-api-execution-receipt`;
- a trusted durable Cockpit approval event binding Stage A SHA, destination,
  branch, exact `push-exact-projection` operation/event/workflow scope, human
  identity, and approval time, verified only through a
  provider-authenticated Ask resolution surface
  (`cockpit-authenticated-ask-resolution/v1`). Current `cockpit task get`
  conversation text cannot supply that evidence. Approval time uses the
  supported RFC 3339 subset with calendar-valid month/day/leap-year values,
  seconds `00` through `59`, and a valid offset; leap-second `:60` values are
  intentionally unsupported by both the runtime and schema.

The raw commit object is read with replacement objects disabled and must match
the canonical root-commit bytes exactly. This rejects private author/committer
identity, messages, signatures, encoding headers, or other unscanned metadata
even when the tree is unchanged. The canonical message is:

```text
Video OS public projection

Stage-A-Receipt-SHA256: <lowercase 64-hex Stage A receipt digest>
```

Its full tree is enumerated with NUL-safe Git output.
Stage A and the commit must have exact set equality for every raw path byte
sequence, regular file/symlink type, `100644`/`100755`/`120000` mode, content
SHA-256, and symlink target bytes/hash. Extra, missing, duplicate, reordered,
content, mode, type, target, gitlink, unknown-mode, replacement-object, or
parent-history differences stop promotion.

The required boundary job set is fixed in code and compared by exact set
equality:

```text
node-runtime
schema-contract
speech-led-contract
event-recap-contract
repo-hygiene
editor-server
agent-definitions
macos-studio
render-integration
```

Every boundary job and aggregate `product-gate` must be `success`. Failure,
cancelled, skipped, neutral, timed out, action required, stale, missing, extra,
or duplicate results are rejected.

Public CI runs on the deterministic new branch
`public-candidate/<exact-root-commit-sha>`. The workflow now admits only that
prefix in addition to its established branches. The evidence adapter rejects a
different branch even when its tree or commit is otherwise supplied by the
caller.

`scripts/verify-promotion-envelope.ts` exposes the final interface. Destination,
branch, workflow, provider repository ID, and public-key trust root are loaded
from repository configuration, never CLI arguments. It verifies the whole
Stage-A detached signature with OpenSSL, re-fetches the exact GitHub run/jobs,
requires a provider-authenticated Cockpit Ask resolution surface rather than
conversation text, and then re-applies the exact root-commit and tree contract.
Unsigned caller JSON, self-supplied trust roots, and manual booleans are never
accepted as Stage A, CI, or approval evidence.

## Local coordinator and operator gates

The local coordinator performs projection, immutable scan, Stage A
finalization, canonical root-commit creation, and verification. All output roots
must be new and disjoint. It has no push mode:

Candidate creation writes Git blobs and the new index exclusively from the
validated Stage A public-path ledger, using each ledger entry's raw `path_b64`,
mode, and verified staging bytes. It does not use worktree-wide `git add`, so a
copied `.gitignore` cannot omit ignored-but-source-tracked paths and cannot add
files absent from Stage A. Blob bytes are passed to `git hash-object` through a
private, fsynced regular-file descriptor rather than a pipe, avoiding Node's
synchronous large-stdin pipe boundary while retaining raw-path handling.

```sh
npx tsx scripts/public-promotion.ts prepare \
  --source /absolute/path/to/exact-clean-source \
  --source-commit <full-commit-sha> \
  --staging /private/new/public-staging \
  --evidence-directory /private/new/promotion-evidence \
  --public-repository /private/new/public-repository
```

The command returns `push_performed: false`. Routine publication then uses
the already-scanned public projection tree and ordinary Git:

1. Create a branch from the current public `main`.
2. Commit only the scanned public projection tree. The new commit may have
   that `main` as its only parent. Do not attach private or excluded history.
3. Perform one ordinary non-force push of that branch. This repository
   provides no command that does so.
4. Let GitHub CI run, then open a PR for human review and merge without
   force.

Optional high-assurance Stage B, if ever used, still cannot mint a Cockpit
approval receipt from conversation text. Unconfigured Stage A signing prints
`stage-a-signature-handoff/v1` and does not emit a Stage B envelope. A
parentless canonical commit cannot fast-forward the current public `main`
(`5f8ae04173ba9c84da675088b57df4bb3cdfd306`); that path is not the routine
publication method.

## Approval and publication boundary

Local schema/test success means only that the code contract is ready. It does
not mean:

- a secret scan ran;
- Stage A is valid for a real source/staging pair;
- a public commit was created or pushed;
- public CI ran;
- Stage B exists;
- publication was approved.

PCL evidence registration, if later approved, is performed only from the
canonical checkout with the exact executed argv and copied canonical receipt.
This implementation worktree does not initialize or mutate PCL state.
