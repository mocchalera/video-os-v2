# BGM explainable selection implementation evidence

Date: 2026-07-16

Feature: `F-0064`

Story/Test: `US-0032` / `TC-0109`

## Implemented slice

- Deterministic normalization of creative brief, edit blueprint, and derived
  timeline facts into a small BGM intent contract.
- Timeline duration, video cut count, and merged dialogue occupancy extraction;
  A2/BGM is explicitly excluded from speech measurement.
- Twelve pre-score hard gates covering installation, integrity, content hash,
  rights permission/status/hash, vocal policy, codec/readability, duration,
  exclusions, and analysis fallback.
- Seven-component, 100-point explainable scoring with stable ordering.
- Proportional redistribution of the unavailable 30-point semantic channel.
- Auto thresholds of 70/8 with semantic comparison and 78/12 when degraded or
  unavailable. Auto selection requires a real second candidate and numeric
  margin; otherwise the artifact remains a suggestion.
- Hash-bound, schema-validated, atomically written
  `04_plan/bgm_selection.json`.
- Read-only `scripts/select-bgm.ts` dry-run plus explicit suggestion/auto modes.
- External/public/commercial rights scopes fail closed; internal preview may
  use operator-declared rights only when the hash and requested scopes match.
- `audio_policy: original_only` never writes a BGM selection artifact.

## Files

- `runtime/music/selection-intent.ts`
- `runtime/music/selector.ts`
- `runtime/music/selection-project-input.ts`
- `runtime/music/selection-service.ts`
- `scripts/select-bgm.ts`
- `tests/bgm-selection-intent.test.ts`
- `tests/bgm-selector.test.ts`
- `tests/bgm-selection-service.test.ts`
- `docs/design-bgm-library-selection-mixing.md`

## Verification

Runtime parity:

- Node `v22.23.1`
- npm `10.9.8`

Targeted command:

```sh
npx vitest run tests/bgm-selection-intent.test.ts tests/bgm-selector.test.ts tests/bgm-selection-service.test.ts
```

Result:

- 3 test files passed
- 34 tests passed

Contract/registry regression command:

```sh
npx vitest run tests/bgm-selection-intent.test.ts tests/bgm-selector.test.ts tests/bgm-selection-service.test.ts tests/bgm-contracts.test.ts tests/bgm-pack-runtime.test.ts
```

Result:

- 5 test files passed
- 63 tests passed

Type and whitespace checks:

```sh
npx tsc --noEmit
git diff --check
```

Result: passed.

Full regression command:

```sh
npm test -- --reporter=dot
```

Result:

- 180 test files passed, 4 skipped
- 2,839 tests passed, 39 skipped
- exit code 0

CLI absence smoke:

```sh
npx tsx scripts/select-bgm.ts --project projects/demo --pack-root <empty-directory> --json
```

Result:

- exit code 3
- sanitized `BGM_PACK_NOT_FOUND`
- no project artifact written

## Safety and remaining scope

- No dependencies, database migrations, network calls, pack installs, source
  footage, rendered media, or real music binaries were added.
- The selector consumes verified cached analysis but does not yet generate pack
  analysis or perform brief-to-track CLAP similarity. It records the channel as
  unavailable and uses the stricter deterministic thresholds.
- The selection artifact does not yet mutate `music_cues.json`, A2, preview, or
  final render. Those must move together in the next atomic arrangement/render
  slice to avoid duplicate BGM authority.
- Studio browsing/audition/application and release UI remain planned under
  `US-0034` / `TC-0111`.
