# BGM Core v1 foundation implementation evidence

Date: 2026-07-16

Feature: `F-0064`

Story: `US-0031`

## Delivered scope

- Added canonical v1 contracts for BGM pack manifests, per-track analysis,
  explainable selection traces, and rights/license registers.
- Registered `04_plan/bgm_selection.json` and
  `07_package/rights_license_register.yaml` as optional project artifacts.
- Added metadata-only two-track fixtures. No real audio, source footage, or
  generated project output was added.
- Added a read-only pack registry and catalog with deterministic discovery
  precedence, exact SemVer ordering, canonical manifest hashing, hash/byte-size
  verification, realpath containment, and pinned track resolution.
- Pinned rights and analysis records by relative path, SHA-256, byte size, and
  format. Rights records are schema-validated and bound to the full-mix hash;
  analysis semantic failures degrade with a warning while declared pin changes
  are pack-integrity errors.
- Prevented malformed higher-priority project overrides from silently falling
  back to a lower pack with the same identity.
- Added a path-redacted `bgm-pack list|verify` JSON CLI with stable error codes
  and documented exit classes `0`, `2`, `3`, `4`, and `5`.

## Independent-review corrections incorporated

- Removed self-referential distribution archive hashes from the installed
  manifest. A future installer must verify them from an archive-external
  release receipt.
- Fixed selection scoring to the seven declared 100-point components and added
  semantic-channel threshold, margin, redistribution, and ranked/rejected
  conditions.
- Separated authored manifest axes from analyzed value/confidence axes.
- Strengthened ready/degraded analysis and licensed-rights structural states.
- Replaced unpinned rights/analysis strings with integrity-pinned data refs.
- Kept `music-cues/vNext` outside this patch because its schema, A2 projection,
  beat offsets, preview/final render path, and future Swift decoder must change
  atomically.

## Verification

Environment:

- Node `v22.23.1`
- Node module ABI `127`
- npm `10.9.8`

Commands and results:

1. `npx vitest run tests/bgm-contracts.test.ts tests/bgm-pack-runtime.test.ts tests/validate.test.ts`
   - 3 files passed
   - 70 tests passed
2. `npx tsc --noEmit`
   - passed
3. `npm test -- --reporter=dot`
   - 177 files passed, 4 skipped
   - 2,805 tests passed, 39 skipped
4. Empty-root CLI smoke
   - `list --json`: exit 0, zero tracks, recoverable `BGM_PACK_NOT_FOUND` warning
   - `verify --json`: exit 3, path-free `BGM_PACK_NOT_FOUND` issue

The first full-suite attempt accidentally resolved `~/.local/bin/node` v24
despite `nvm use`, causing only `better-sqlite3` ABI failures. The rerun placed
`$NVM_BIN` first, confirmed Node v22/ABI 127, and passed the full suite above.

## Explicitly not delivered yet

- Pack install/download/delete and archive release receipts
- Audio decoding and pack-level technical/semantic analysis execution
- Deterministic/CLAP-assisted selector runtime
- Section-aware arrangement and shared preview/final A2 render plan
- Public-output rights scope/expiry gate
- Studio library, audition, apply, lock, replace, and restore-auto UI
- Real Core Pack masters or generated Suno audio
