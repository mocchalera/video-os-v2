---
name: vertical-social-platform-delivery
description: Select an evidence-backed platform delivery profile, preserve organic and ads scope boundaries, and produce safe-zone QA input with an explicit human preview gate when evidence is unknown or stale.
---

# Vertical Social Platform Delivery

Select the registered platform and surface profile before delivery review. Keep profile evidence, freshness, safe-zone geometry, fallback, and human preview separate from the render and from the platform's own preview.

## Inspection order

1. Select the exact platform, surface, and delivery variant under `delivery_profiles/platform-safe-zone`. Read source URL, retrieved date, published date, owner, evidence status, scope, supersession, and profile hash.
2. Keep organic and ads profiles separate. Reject an ads profile for an organic surface and reject organic evidence as an ads measurement.
3. For a verified profile, verify device evidence, viewport/output geometry, pixel density, UI and safe regions, method, confidence, screenshot path, and SHA256. Use the existing visual-status producer, which loads the registered profile and runs its regression runtime, before delivery review:

   ```bash
   npx tsx scripts/caption-review.ts visual-status --project <project> --safe-zone-profile <project-relative-profile>
   ```
4. For partial, unavailable, stale, or unknown evidence, keep regions unknown, select the registered fallback, and require a human platform preview. Do not infer or add coordinates.
5. Treat regression as an artifact check for known anchors, captions, content, and profile overlays. The human platform preview is a separate gate and is required whenever the profile says so.

## Evidence acquisition

When a current measurement is authorized, record platform, surface, iOS or Android, device, viewport resolution, pixel density, notch or insets, app version and build, locale, and measurement date. Use a rights-cleared test clip, capture a lossless screenshot, record its SHA256, and record the measurement method and confidence. Check viewer variants separately, isolate ads from organic, and retain unknown status when any required evidence is absent or stale.

## Checks

Run `npm run validate:all-local`, `npm run typecheck`, and `npm run verify`. Inspect `delivery_profiles/platform-safe-zone` and the safe-zone regression result (`platform-safe-zone-qa/v1`) when emitted by the runtime and route receipt; do not invent a separate receipt file. Keep platform preview evidence and renderer output as separate artifacts; this skill does not authorize compositor or Studio UI work.
