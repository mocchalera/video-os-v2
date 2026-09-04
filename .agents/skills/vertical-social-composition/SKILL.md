---
name: vertical-social-composition
description: Resolve registered vertical composition inputs from source-grounded framing evidence, source A/V identity, layout anchors, and safe degradation. Use when a blueprint contains framing candidates or visual intents for a vertical delivery.
---

# Vertical Social Composition

Inspect and resolve the existing framing policy, reframe candidate, and registered visual intent before any visual treatment is considered. Keep source asset, segment, range, source hash, A/V geometry, and first/representative/last evidence attached to the result.

## Inspection order

1. Read `04_plan/edit_blueprint.yaml`, `04_plan/selects_candidates.yaml`, and the referenced framing policy. Confirm that `policy_refs.composition_policy_ref` resolves inside the project and that any source hash is current.
2. Inspect the registered visual intent and its `source_evidence`. Verify the existing RFA-008 to RFA-010 candidate when a candidate reference is present. Treat unavailable optional vision adapters as a source-grounded degrade, not as permission to invent a crop.
3. Resolve `vertical_composition_policy_ref` through `schemas/vertical-composition-policy.schema.json` and `runtime/visual/vertical-composition.ts`. Supply policy-owned person occupancy, headroom, look-room, hands, microphone, evidence, layout-anchor, and zoom-intent inputs.
4. Attach first, representative, and last frame observations and preserve source A/V identity. Do not force a punch-in for a talking head. Use the policy's safe-degrade mode or leave a human hold when evidence is incomplete.
5. Review compiled `05_timeline/timeline.json` provenance. A `vertical-composition-resolution/v1` result is an input receipt; it is not a graphical compositor or Studio edit.

When subject-caption collision QA is requested, use a source-grounded
`subject-occupancy-track/v1` whose track labels are explicitly not person
identity. Resolve thresholds and lower/upper proposal anchors from the same
project-contained vertical composition policy, then bind the track, renderer
layout snapshot, policy hash, renderer capability, verdict, and review item to
one immutable social-review generation. Missing or mixed-generation evidence
is an incomplete/human hold. Candidate anchors never authorize caption text,
timing, approval, or canonical timeline mutation, and auto-move remains off.

Speech caption text, timing, and approval remain owned by the existing caption runtime and FFmpeg/libass route. Registered graphical content elements remain eligible for the existing Remotion or HyperFrames route in the later visual-treatment milestone; visual treatment patches, platform profiles, and Studio controls remain separate. This skill only resolves their inputs and does not rewrite the canonical timeline by hand.

## Checks

Run `npm run validate:all-local`, `npm run typecheck`, and `npm run verify` after changing a policy or consuming an artifact. Inspect `05_timeline/timeline.json` and its provenance; keep `04_plan/edit_blueprint.yaml` as the authoring source.

Record the resolved policy reference, policy hash, candidate evidence, receipt status, and any human hold in the canonical timeline provenance or an existing review/route receipt. Do not invent a standalone composition artifact. Keep renderer application and Studio graphical controls for the later milestone.
