# Video OS OSS Bundled BGM — Core Pack v1

## Status

This directory is a production specification, not a claim that audio has been generated or accepted.

- Catalog design: complete for 16 proposed tracks.
- Suno production briefs: ready for human generation sessions.
- Audio generation, selection, editing, mixing, similarity review, and legal approval: not started; human action required.
- No audio, stems, account data, receipts, contracts, or personal information belongs in this directory.

## Goal

Create a compact, edit-friendly instrumental library for dialogue-led product, corporate, documentary, education, and social video. The pack covers eight editorial families at low and high energy:

1. Trust / Clarity
2. Warm / Human
3. Reflective / Emotional
4. Problem / Tension
5. Future / Technology
6. Progress / Uplift
7. Premium / Minimal
8. Playful / Bold

Each master is designed for 90–150 seconds, editorial cut-downs, looping, clean intros/outros, and stem delivery. Track IDs and filenames are deliberately functional and stable; display titles may be chosen after acceptance.

## Files

- `track-catalog.yaml`: authoritative musical and edit-delivery specification.
- `suno-production-briefs.md`: generation prompts and rejection cues for each track.
- `rights-and-provenance-checklist.md`: human workflow, evidence manifest, review gates, and acceptance criteria.

## Production sequence

Work in pairs so the low/high variants share a family identity without becoming alternate mixes of the same composition:

1. `trust-clarity-low-01` and `trust-clarity-high-01`
2. `warm-human-low-01` and `warm-human-high-01`
3. `reflective-emotional-low-01` and `reflective-emotional-high-01`
4. `problem-tension-low-01` and `problem-tension-high-01`
5. `future-technology-low-01` and `future-technology-high-01`
6. `progress-uplift-low-01` and `progress-uplift-high-01`
7. `premium-minimal-low-01` and `premium-minimal-high-01`
8. `playful-bold-low-01` and `playful-bold-high-01`

For each pair: generate candidates, log every candidate, shortlist without overwriting originals, perform human arrangement/editing, run similarity and rights reviews, then mix and derive deliverables. Do not proceed from a generated candidate directly to distribution.

When a generator workstream has produced `technical-shortlist/v1`, verify the
original private downloads and create the review queue without copying audio:

```bash
npx tsx scripts/bgm-shortlist.ts verify \
  --shortlist /private/batch/analysis/technical-shortlist.json

npx tsx scripts/bgm-shortlist.ts prepare-review \
  --shortlist /private/batch/analysis/technical-shortlist.json \
  --output /private/batch/analysis/musical-review-queue.json
```

The importer infers sequential sibling batches (`workspace`, `workspace-1`,
`workspace-2`) and accepts repeatable `--batch-root N=/path` overrides. The
review queue uses redacted `batch:N/input/...` references and requires musical
fit, dialogue-bed, artifact, originality, and rights approval before a
candidate becomes promotion-eligible. Re-running it preserves reviews only for
the exact candidate ID and SHA-256; it refuses to overwrite a malformed queue.

To review in VideoOSStudio, open a project, choose the music-note action in the
top bar, and select `musical-review-queue.json`. Studio provides 15-second
single-track audition, exact-timeline dialogue overlay when a project preview
exists, filters/search, and five independent review gates. Saving uses the same
hash-verifying CLI contract:

```bash
npx tsx scripts/bgm-shortlist.ts review \
  --queue /private/batch/analysis/musical-review-queue.json \
  --candidate <candidate-id> \
  --reviewer <reviewer-ref> \
  --musical-fit pass \
  --dialogue-bed pass \
  --artifact-quality pass \
  --originality pass \
  --rights operator_declared_ok
```

Do not use `licensed` unless a qualified reviewer has checked the private
rights evidence. A promotion-eligible review candidate is still not approved
for public release.

## First concrete composition unit

Start with the Trust / Clarity pair. It is the best calibration unit for speech masking, edit-point regularity, restrained branding, and the distinction between low and high energy.

Human operator inputs required before generation:

- Confirm the Suno account was on an eligible paid plan at the exact generation time.
- Record the account holder or rights-owning entity in a private evidence store, not Git.
- Save a PDF or screenshot of the applicable terms and plan page, plus timestamp and URL, outside the repository.
- Keep tracks Link-Only/private during review; do not enable public remixing or collaboration.
- Use the two briefs exactly as a baseline, then record any prompt changes and generated track IDs/URLs.

## Repository boundary

Only specification documents and intake contracts belong here. Candidate audio
and generated review queues stay in the private evidence workspace. Final
distributable audio, if later approved, needs a separately agreed asset
location, license notice, checksums, and release process. Nothing in this
directory constitutes legal advice or final clearance.
