# P4b Delivery Profile Implementation Notes

## 1. Baseline snapshot

- Start command: `git status --short`
- Start state: worktree was already dirty outside P4b, including `.github/`, `package.json`, `package-lock.json`, `editor/`, `runtime/commands/package.ts`, `runtime/commands/render.ts`, `runtime/packaging/`, `runtime/render/`, `schemas/timeline-ir.schema.json`, `tests/e2e-m4.test.ts`, `tests/package-assembler.test.ts`, `tests/public-cli.test.ts`, `tests/render-pipeline.test.ts`, `tsconfig.json`, and `tmp/` deletions.
- Baseline canonical hash command removed `created_at` from `projects/demo/05_timeline/timeline.json`.
- Baseline canonical hash: `68c8d701302aa5150f8afd183de1a52711349834f4c9e267cb3544e26e01b100`
- Baseline tests: `npx vitest run` -> 1821 passed / 12 skipped.
- Baseline typecheck: `npx tsc --noEmit` -> pass.

## 2. Allowlist compliance

P4b-created files:

- `schemas/delivery-profile.schema.json`
- `tests/fixtures/delivery_profiles/valid_youtube_16x9_public.yaml`
- `tests/fixtures/delivery_profiles/valid_shorts_9x16_public.yaml`
- `tests/fixtures/delivery_profiles/valid_instagram_reel_9x16_external.yaml`
- `tests/fixtures/delivery_profiles/valid_internal_review_strict.yaml`
- `tests/fixtures/delivery_profiles/valid_client_handoff_external.yaml`
- `tests/fixtures/delivery_profiles/invalid_missing_platform.yaml`
- `tests/fixtures/delivery_profiles/invalid_aspect_ratio_format.yaml`
- `tests/fixtures/delivery_profiles/edge_calibrated_confidence_required.yaml`
- `tests/fixtures/delivery_profiles/edge_caption_burned_with_sidecar.yaml`
- `tests/delivery-profile.test.ts`
- `runtime/artifacts/p4b-delivery-profile.ts`
- `docs/p4b-delivery-profile-implementation-notes.md`

P4b-modified files:

- `runtime/validation/schema-validator.ts`
- `runtime/artifacts/p4a-release-safety.ts`
- `runtime/commands/status.ts`
- `tests/release-safety-report.test.ts`

No P4b edits were made under `editor/`, compiler paths, `.github/`, `package.json`, `package-lock.json`, `schemas/release-safety-report.schema.json`, `schemas/package-manifest.schema.json`, `schemas/package-qa-report.schema.json`, `schemas/project-state.schema.json`, or `schemas/timeline-ir.schema.json`.

`runtime/commands/package.ts` and `runtime/commands/render.ts` were already dirty at baseline. P4b did not change them; the existing P4a preflight hook now reaches P4b through `runtime/artifacts/p4a-release-safety.ts` when both release safety and delivery profile flags are enabled.

## 3. delivery_profile schema final form

Required root fields:

- `version`, `project_id`, `artifact_version`, `created_at`, `profile_id`, `profile_name`
- `platform`, `release_mode`
- `video_constraints`, `audio_constraints`, `caption_constraints`, `duration_constraints`
- `file_naming`, `metadata_requirements`
- `privacy_strictness`, `rights_strictness`
- `provenance`

Optional/default-compatible root field:

- `requires_calibrated_confidence` with default `false`

Main schema decisions:

- `profile_id` requires `DPROF_`.
- `artifact_version` is fixed to `delivery-profile-v1`.
- `platform` enum includes `youtube`, `shorts`, `instagram_reel`, `instagram_feed`, `tiktok`, `internal_review`, `client_handoff`, `custom`.
- `release_mode` enum is `public`, `external`, `internal`.
- `provenance.producer` is `operator-command` or `/package`.
- Hash policy canonicalization is `yaml-to-normalized-json-v1`.
- YAML anchors, aliases, and custom tags are runtime-rejected for deterministic hashing.

## 4. Loader/Validator implementation

`runtime/artifacts/p4b-delivery-profile.ts` owns:

- `isP4bDeliveryProfilesEnabled()`
- `loadDeliveryProfiles(projectPath)`
- `validateProfile(profile)`
- `computeDeliveryProfileHash(profile)`
- `readDeliveryProfileStatus(projectPath)`
- `generateDeliveryProfileChecks(...)`

Validation is schema-first, then runner rules:

- `duration_constraints.min_seconds <= max_seconds`
- `mode=sidecar` and `mode=both` require `sidecar_format`
- `mode=none` requires `sidecar_format: null`
- `mode=burned_in` with a sidecar format stays valid but emits a warning
- `requires_calibrated_confidence: true` stays valid and emits a P4c handoff warning

Multiple profiles are supported by scanning `projects/<id>/07_package/delivery_profiles/*.yaml` in sorted order.

## 5. Check generator implementation

Artifact to profile mapping:

- `timeline.sequence.width/height/output_aspect_ratio/fps_*` -> video constraints
- timeline max clip end frame divided by fps -> duration constraints
- `package-qa-report.metrics.integrated_lufs` and `true_peak_dbtp` -> audio constraints
- `package_manifest.artifacts.captions[]` and caption artifact refs -> caption sidecar constraints
- `package_manifest.artifacts.final_video.path` -> file extension constraints

Severity:

- public/external mismatch -> `blocker`
- internal mismatch -> `warning`
- public/external expected profile absent -> `fatal`
- malformed profile -> `fatal`

P4b is report-only through P4a dry-run behavior; it does not add enforcement mode.

## 6. P4a integration

`runtime/artifacts/p4a-release-safety.ts` keeps the existing delivery_profile skeleton when `ENABLE_P4B_DELIVERY_PROFILES` is off:

- `RSCHK_delivery_profile_p4b`
- `status: not_evaluated`

When the flag is on, it loads delivery profiles and replaces that single skeleton check with real `delivery_profile` checks. The other 10 P4a categories are unchanged.

## 7. Test list and Red to Green

Red check:

- `npx vitest run tests/delivery-profile.test.ts tests/release-safety-report.test.ts`
- Expected failures: missing `runtime/artifacts/p4b-delivery-profile.ts`, missing schema/runtime integration, and P4a still returning the skeleton check.

Green checks:

- `npx vitest run tests/delivery-profile.test.ts tests/release-safety-report.test.ts` -> 37 passed.
- `npx tsc --noEmit` -> pass.
- `npx vitest run` -> 1844 passed / 12 skipped.

New delivery profile coverage:

- valid fixtures: 5 pass.
- invalid fixtures: 2 fail.
- edge fixtures: 2 schema-valid.
- hash determinism with `created_at` excluded.
- profile ID, enum, duration, caption cross-field validation.
- multi-profile directory loading.
- pass, absent fatal, public blocker, and internal warning check generation.

## 8. Feature flag design

- Env var: `ENABLE_P4B_DELIVERY_PROFILES`
- Default: false.
- Truthy values: `1`, `true`, `yes`, `on`.

OFF:

- delivery profiles are not loaded by P4a.
- P4a delivery_profile category remains `not_evaluated`.
- existing package/render behavior is unchanged.

ON:

- `delivery_profiles/*.yaml` are scanned and validated.
- P4a delivery_profile checks become real checks.
- `/status` includes a delivery profile listing.

## 9. Open Questions

Q4 rights authority:

- P4b only maps `delivery_profile.rights_strictness` as a declared strictness field.
- Approver authority and waiver governance remain out of scope for P4b.

Q5 human approval UI:

- P4b remains CLI/report artifact only.
- No UI flow was added.

Q8 confidence calibration:

- `requires_calibrated_confidence` is present and valid.
- Real confidence calibration remains P4c scope.

## 10. Canonical hash verification

Demo timeline canonical hash after implementation:

- `68c8d701302aa5150f8afd183de1a52711349834f4c9e267cb3544e26e01b100`
- `baseline_match=yes`

Delivery profile YAML hash verification:

- `yaml_hash_a=sha256:ed98e1f61de924149f0f8f7e4ae357e94eb84053e5a5440748574215ba44fba3`
- `yaml_hash_b=sha256:ed98e1f61de924149f0f8f7e4ae357e94eb84053e5a5440748574215ba44fba3`
- `deterministic=true`

## 11. P4c handoff

- Implement actual `confidence_calibration` artifact/report and wire it to `requires_calibrated_confidence`.
- Decide whether calibrated confidence failures are blocker or fatal by release mode.
- Add waiver authority checks for rights/privacy/confidence waivers.
- Keep P4b checks report-only until P4 release safety enforcement migration explicitly starts.

## 12. Final git status, P4b-derived only

```text
 M runtime/artifacts/p4a-release-safety.ts
 M runtime/commands/status.ts
 M runtime/validation/schema-validator.ts
 M tests/release-safety-report.test.ts
?? docs/p4b-delivery-profile-implementation-notes.md
?? runtime/artifacts/p4b-delivery-profile.ts
?? schemas/delivery-profile.schema.json
?? tests/delivery-profile.test.ts
?? tests/fixtures/delivery_profiles/
```

## 13. Acceptance checklist

- [x] allowlist outside changes: zero P4b-caused changes.
- [x] delivery_profile schema valid 5 PASS, invalid 2 FAIL, edge 2 valid.
- [x] P4a release_safety_report delivery_profile returns real checks when flag ON.
- [x] Flag OFF keeps delivery_profile `not_evaluated`.
- [x] Flag OFF preserves demo canonical hash baseline.
- [x] Existing full test suite passes with new tests included: 1844 passed / 12 skipped.
- [x] YAML hash recipe is deterministic with `created_at` excluded.
- [x] Severity rules covered: public/external blocker, internal warning, absent fatal.
- [x] Notes include baseline and final P4b-derived git status.
- [x] Multiple profiles can coexist under `07_package/delivery_profiles/*.yaml`.
