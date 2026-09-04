# RFA-016 private-pilot gate receipts

RFA-016 keeps four pilot decisions independent:

1. `agent_qa` — deterministic schema, timing, caption, safe-zone, audio, SFX,
   route, and accessibility checks.
2. `human_visual_audio` — Studio visual review, mute readability, speaker/mobile/
   mono audition, and artistic decision.
3. `nle_handoff` — supplied/external assets, ASS/alpha/XML, hashes, geometry,
   codec, and handoff confirmation.
4. `platform_preview` — a current platform delivery profile, safe-zone evidence,
   and a human preview in the current app/UI profile.

The manifest at
`07_package/private-pilot/manifest.json` only indexes one
`private-pilot-gate-receipt/v1` file for each gate. It does not contain an
aggregate readiness claim. `npm run pilot:verify -- --project <project>` reads
the manifest and evaluates each receipt separately. A receipt is usable only
when its own status, decision, evidence artifacts, provenance, and freshness
are valid and hash-bound. Missing, pending, rejected, stale, mismatched, or
out-of-root evidence holds the pilot with an actionable reason.

`nle_handoff` may pass as `not_required` only when `requirement`, `status`,
`decision`, `confirmation`, and `route_kind` all explicitly say not-required.
For a required handoff, at least one explicitly identified handoff artifact must
also be a valid existing M5A `render-route-receipt/v3` with a confirmed
supplied/external handoff and a source timeline identity bound independently to
both the pilot manifest and the NLE receipt's common provenance inputs. A
generic notes/evidence JSON or an internally pending route receipt cannot pass.
The evaluator never infers not-required from a canonical route or from another
gate.

`platform_preview` requires both `current_profile: true` and
`human_preview: true`. The evaluator loads the referenced profile through the
existing platform-safe-zone schema/contract, binds platform/surface,
evidence-status, supersession, profile hash, and safe-zone receipt identity,
and rejects stale or invalid profile claims; a safe-zone regression receipt
alone cannot pass it.
Public upload or promotion is outside this contract and is recorded as
`public_promotion: out_of_scope`.

Fixtures under `tests/fixtures/private-pilot/` include a pending/HOLD pilot
and a fully ready metadata-only synthetic fixture. The latter is labeled
`synthetic_fixture: true` and is test evidence only; it is not real human
approval, an NLE action, a device preview, or permission to publish.
