# P4a Release Safety Dry Run Notes

## 1. Baseline snapshot

- Start command: `git status --short`
- Start state: worktree was already dirty outside P4a, including `.github/`, `package.json`, `package-lock.json`, `editor/`, `runtime/commands/package.ts`, `runtime/commands/render.ts`, `runtime/packaging/`, `runtime/render/`, `schemas/timeline-ir.schema.json`, and `tmp/` deletions.
- Baseline canonical hash command:

```sh
node - <<'NODE'
const fs=require('fs'); const crypto=require('crypto');
const data=JSON.parse(fs.readFileSync('projects/demo/05_timeline/timeline.json','utf8'));
delete data.created_at;
console.log(crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex'));
NODE
```

- Baseline result: `68c8d701302aa5150f8afd183de1a52711349834f4c9e267cb3544e26e01b100`
- Baseline tests: `npx vitest run` -> 1807 passed / 12 skipped.
- Baseline typecheck: `npx tsc --noEmit` -> pass.

## 2. Allowlist compliance

P4a-created files:

- `schemas/release-safety-report.schema.json`
- `tests/fixtures/release_safety_report/valid_dry_run_missing_inputs.yaml`
- `tests/fixtures/release_safety_report/valid_report_only_blocker.yaml`
- `tests/fixtures/release_safety_report/valid_enforce_pass_with_waiver.yaml`
- `tests/fixtures/release_safety_report/invalid_enforce_blocked_summary_pass.yaml`
- `tests/fixtures/release_safety_report/invalid_missing_base_timeline_version.yaml`
- `tests/fixtures/release_safety_report/edge_public_unknown_rights_fatal.yaml`
- `tests/fixtures/release_safety_report/edge_fatal_review_creative_override.yaml`
- `tests/release-safety-report.test.ts`
- `runtime/artifacts/p4a-release-safety.ts`
- `docs/p4a-release-safety-dry-run-notes.md`

P4a-modified existing files:

- `runtime/validation/schema-validator.ts`
- `runtime/commands/package.ts`
- `runtime/commands/status.ts`

No P4a edits were made under `editor/`, compiler paths, existing P1/P2/P3 schemas, `schemas/project-state.schema.json`, `schemas/delivery-profile.schema.json`, `schemas/timeline-ir.schema.json`, `package.json`, `package-lock.json`, or `.github/`.

## 3. Schema implementation

`release-safety-report.schema.json` follows P0 Section 3.6:

- closed root object;
- required `base_timeline_version`;
- modes: `dry_run`, `report_only`, `enforce`;
- categories: `editorial_review`, `schema_validation`, `technical_qa`, `delivery_profile`, `rights`, `privacy`, `source_of_truth`, `caption_audio`, `music_audio`, `package_completeness`, `source_manifest`;
- ID prefixes: `RSCHK_` and `RSWVR_`;
- hash policy canonicalization: `yaml-to-normalized-json-v1`.

The schema also rejects the fixture case where `mode: enforce` has an unwaived fatal failed check but `summary.status: pass`.

## 4. Preflight runner implementation

Implemented in `runtime/artifacts/p4a-release-safety.ts`.

Inputs:

- `05_timeline/timeline.json`
- `06_review/review_report.yaml`
- `07_package/package_manifest.json`
- `07_package/caption_approval.json`
- `07_package/music_cues.json`
- `02_media/source_media_manifest.json`
- `03_analysis/analysis_coverage_report.json`
- `03_analysis/audio_story_graph.json`
- `03_analysis/continuity_graph.json`
- `03_analysis/editorial_preference_memory.jsonl`
- `07_package/qa-report.json`

Check generators:

- `editorial_review`: imports fatal review findings from `review_report.yaml`.
- `schema_validation`: validates available artifacts and reports validation failures as dry-run warnings.
- `technical_qa`: reads `qa-report.json` when present.
- `delivery_profile`: P4a skeleton only, `status: not_evaluated`.
- `rights`: aggregates `source_media_manifest.json.items[].rights_status`.
- `privacy`: aggregates manifest privacy and continuity entity confirmation status.
- `source_of_truth`: records the chosen package source of truth.
- `caption_audio`: checks caption/audio artifact co-presence when captions exist.
- `music_audio`: checks music/audio artifact co-presence when music cues exist.
- `package_completeness`: checks `package_manifest.json` artifact inventory.
- `source_manifest`: checks source manifest existence and stale refs from downstream P1-P3 artifacts.

Mode behavior:

- `dry_run`: all generators execute, report is written, exit code remains 0, package/render are not blocked.
- `report_only`: skeleton only, throws `not_implemented_in_p4a`. TODO is left in code for P4b.
- `enforce`: skeleton only, throws `not_implemented_in_p4a`. TODO is left in code for P4c.

## 5. Test list and Red to Green

Red:

- `npx vitest run tests/release-safety-report.test.ts`
- Initial failure: missing `runtime/artifacts/p4a-release-safety.ts`.

Green:

- `npx vitest run tests/release-safety-report.test.ts` -> 14 passed.
- `ENABLE_P4A_RELEASE_SAFETY=true RELEASE_SAFETY_MODE=dry_run npx vitest run tests/release-safety-report.test.ts tests/e2e-m4.test.ts` -> 27 passed.
- `npx vitest run` -> 1821 passed / 12 skipped.
- `npx tsc --noEmit` -> pass.

## 6. Feature flag design

- `ENABLE_P4A_RELEASE_SAFETY` defaults OFF.
- Truthy values: `1`, `true`, `yes`, `on`.
- `RELEASE_SAFETY_MODE` defaults to `dry_run`.
- With flag OFF, no release safety report is generated and existing package/render behavior is unchanged.
- With flag ON and `dry_run`, `/package` and `/render` code paths write `07_package/release_safety_report.yaml` through the shared package command path and do not block.
- `/status` reports release safety only when the feature flag is ON.

## 7. Open Questions

Q4 rights responsibility:

- P4a mechanically aggregates `source_media_manifest.json.items[].rights_status`.
- Waiver records can be accepted by the runtime API, but approver authority is not checked.
- Planned escalation: `rights_status=unknown` is warning in `dry_run`, blocker in `report_only`, and fatal in `enforce`.

Q5 human approval UI:

- P4a supports waiver fields in YAML/runtime objects only.
- UI and approver authority checks are deferred to P4b or later.

Q6 search index blocking:

- Out of scope for P4a.
- `segment_search_index` remains P4d scope.

Q8 confidence calibration:

- Out of scope for P4a.
- Calibration policy remains P4c scope.

## 8. Canonical hash verification

Command:

```sh
node - <<'NODE'
const fs=require('fs'); const crypto=require('crypto');
const data=JSON.parse(fs.readFileSync('projects/demo/05_timeline/timeline.json','utf8'));
delete data.created_at;
const hash=crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
console.log(hash);
console.log(hash === '68c8d701302aa5150f8afd183de1a52711349834f4c9e267cb3544e26e01b100' ? 'baseline_match=yes' : 'baseline_match=no');
NODE
```

Result:

- `68c8d701302aa5150f8afd183de1a52711349834f4c9e267cb3544e26e01b100`
- `baseline_match=yes`

## 9. YAML hash recipe verification

Command:

```sh
node - <<'NODE'
const fs=require('fs'); const crypto=require('crypto');
const {parse}=require('yaml');
function norm(v){ if(typeof v==='string') return v.normalize('NFC'); if(Array.isArray(v)) return v.map(norm); if(v&&typeof v==='object'){ const o={}; for(const k of Object.keys(v).sort()){ if(k==='created_at') continue; o[k.normalize('NFC')]=norm(v[k]); } return o;} return v;}
const raw=fs.readFileSync('tests/fixtures/release_safety_report/valid_dry_run_missing_inputs.yaml','utf8');
const a=crypto.createHash('sha256').update(JSON.stringify(norm(parse(raw))),'utf8').digest('hex');
const b=crypto.createHash('sha256').update(JSON.stringify(norm({...parse(raw), created_at:'2026-04-27T00:00:00Z'})),'utf8').digest('hex');
console.log('yaml_hash_a=sha256:'+a); console.log('yaml_hash_b=sha256:'+b); console.log('deterministic='+(a===b));
NODE
```

Result:

- `yaml_hash_a=sha256:398facffc470807350fb2327eccef778e46d461b50bab0624361e68a29798188`
- `yaml_hash_b=sha256:398facffc470807350fb2327eccef778e46d461b50bab0624361e68a29798188`
- `deterministic=true`

## 10. report_only / enforce skeleton

- `runReleaseSafetyPreflight({ mode: "report_only" })` throws `not_implemented_in_p4a`.
- `runReleaseSafetyPreflight({ mode: "enforce" })` throws `not_implemented_in_p4a`.
- Both code branches include TODO comments for P4b/P4c.
- The schema and fixtures already allow both modes so downstream phases can extend behavior without schema churn.

## 11. Compiler non-impact

Command:

```sh
rg -n "release_safety|ReleaseSafety|p4a-release-safety|ENABLE_P4A_RELEASE_SAFETY|release-safety-report" runtime/compiler scripts/compile-timeline.ts runtime/commands/compile.ts runtime/commands/blueprint.ts runtime/commands/triage.ts
```

Result:

- exit code 1 with no matches.
- No compiler path reads release safety artifacts.

## 12. P4b handoff

- Implement `delivery_profiles/*.yaml` and delivery-profile schema.
- Replace the P4a `delivery_profile` `not_evaluated` check with real profile loading.
- Implement `report_only` escalation without blocking package/render.
- Add approver authority policy for waivers.
- Decide how CLI appends waiver records without mutating preference memory.

## 13. Final git status, P4a-derived only

```text
 M runtime/commands/package.ts
 M runtime/commands/status.ts
 M runtime/validation/schema-validator.ts
?? docs/p4a-release-safety-dry-run-notes.md
?? runtime/artifacts/p4a-release-safety.ts
?? schemas/release-safety-report.schema.json
?? tests/fixtures/release_safety_report/
?? tests/release-safety-report.test.ts
```

Note: `runtime/commands/render.ts` was already dirty at baseline; P4a integration is reached through `packageCommand` with producer `/render` when called by `runRender`.

## 14. Acceptance checklist

- [x] allowlist outside P4a: no P4a edits.
- [x] valid 3 fixtures pass, invalid 2 fixtures fail, edge 2 fixtures schema-valid.
- [x] dry-run preflight executes all 11 check categories.
- [x] dry_run package/render path is non-blocking; verified package path with feature flag ON through M4 E2E.
- [x] `report_only` / `enforce` are skeleton-only and throw `not_implemented_in_p4a`.
- [x] feature flag OFF demo timeline canonical hash equals baseline.
- [x] feature flag OFF full test suite passes.
- [x] YAML hash recipe is deterministic with `created_at` excluded.
- [x] waiver matcher covers `creative_override:beat_<id>`.
- [x] stale `artifact_refs.hash` / manifest hash refs are detected.
- [x] baseline and final git status are recorded.
