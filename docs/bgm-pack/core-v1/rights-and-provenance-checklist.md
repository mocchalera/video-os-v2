# Rights, Provenance, and Acceptance Checklist

## Release gate

No track may enter an OSS bundle until every required item below is completed by a human reviewer. “Commercial use allowed” is not by itself proof that an output can safely be licensed for unrestricted modification and redistribution under the repository's chosen asset license.

As checked on 2026-07-16, Suno's official terms say paid-tier outputs generated during the paid subscription are assigned to the subscriber, while free/Basic outputs are limited to non-commercial use. Suno also states that copyright may not vest, outputs may not be unique, and its terms impose additional restrictions. The governing text is the version in force when each candidate is generated, so archive and review that version rather than relying on this summary:

- [Suno Terms of Service](https://suno.com/terms)
- [Does Suno own the music I make?](https://help.suno.com/en/articles/2416769)
- [What rights do I have with a paid subscription?](https://help.suno.com/en/articles/9601665)
- [Can I distribute my songs?](https://help.suno.com/en/articles/2410177)

This checklist is operational guidance, not legal advice. Counsel or an authorized project owner must approve the final asset license and release.

## A. Before generation

- [ ] Assign the generation session a stable private `session_id` and the intended track ID.
- [ ] Confirm the generator account is controlled by the person/entity that will grant rights to the project.
- [ ] Confirm an eligible paid plan is active before generation; later subscription is not treated as retroactive clearance.
- [ ] Archive dated evidence of plan status and the applicable Terms of Service in the private evidence store.
- [ ] Record terms revision date, retrieval timestamp, source URL, plan name, and jurisdiction.
- [ ] Keep outputs non-public/Link-Only and do not enable remix, collaboration, personas based on third parties, or public sharing.
- [ ] Use only original text prompts; no artist names, song titles, lyrics, copyrighted recordings, third-party MIDI, samples, or reference audio.
- [ ] Confirm no personal data, client-confidential material, trademarks, or voice likenesses are in prompts or uploads.
- [ ] Confirm the intended OSS asset license and contributor/assignment instrument have been selected by an authorized human.

## B. Candidate provenance record

Maintain a private manifest (CSV, JSON, or rights-management system). Do not commit account identity, receipts, contracts, or private URLs. One row per generation, extension, remix, stem split, or uploaded edit:

```text
candidate_id
track_id
session_id
generator_service
model_or_version_displayed
generation_timestamp_utc
paid_plan_at_generation
account_rights_holder_private_ref
prompt_exact
negative_prompt_or_exclusions
instrumental_toggle
source_candidate_ids
service_track_id_private_ref
service_url_private_ref
visibility_state
downloaded_original_filename
download_sha256
terms_revision_date
terms_snapshot_private_ref
plan_evidence_private_ref
operator_private_ref
notes
```

- [ ] Preserve original downloads as read-only evidence; edit duplicates only.
- [ ] Hash each original immediately after download.
- [ ] Record all extensions/remixes as descendants; never replace the parent record.
- [ ] If any externally created performance, sample, loop, or recording is introduced, add its creator, source, license, consent, and file hash or reject it.
- [ ] Record DAW session version, plugins, sample libraries, and license evidence for every non-stock processing dependency.

## C. Human selection and music edit

Review at least three materially distinct candidates per track when feasible.

- [ ] Two reviewers independently score editorial fit, speech compatibility, structure, originality risk, and technical quality on 1–5 scales.
- [ ] Reject candidates with intelligible or pseudo-vocal content, producer tags, watermarks, abrupt artifacts, exposed generation noise, or implausible instrument attacks.
- [ ] Reject candidates whose core identity depends on a familiar melody, bass line, hook, sound-alike vocal, signature instrumentation, or recognizable arrangement.
- [ ] Select by candidate ID and document the reason; preserve rejected candidate records.
- [ ] A human performs substantive arrangement decisions: structure, cuts, transitions, automation, mix balance, and deliverable derivation.
- [ ] Confirm edit points on bar boundaries and audition every 15/30/60/90-second cut.
- [ ] Confirm loop seam with equal-power and hard-boundary tests; loops must not depend on a reverb tail that clicks when removed.
- [ ] Create a truly clean intro and clean outro, not only fades over a busy full mix.

## D. Similarity review

- [ ] Run human listening review by at least two musically informed reviewers without telling them the prompt first.
- [ ] Review melody, harmony, rhythm, bass contour, timbre, arrangement, and overall “sound-alike” impression separately.
- [ ] Search distinctive melodic fragments and likely descriptive phrases using available music-identification/search tools.
- [ ] Compare against obvious genre benchmarks without adding those works to the production prompt or upload workflow.
- [ ] Record tools, search dates, queries/fingerprints, results, reviewer names/private refs, and verdict.
- [ ] Escalate any credible resemblance; do not “fix” a risky hook with a superficial mix change.
- [ ] Require replacement or substantive recomposition when reasonable listeners identify the same existing work or artist independently.

Similarity review reduces risk; it cannot prove uniqueness or non-infringement.

## E. Mix and technical acceptance

Unless the product-wide audio specification later overrides these values:

- [ ] Deliver 48 kHz, 24-bit WAV masters; no lossy source in the mastering chain.
- [ ] Integrated loudness target: `-18 LUFS ±1 LU` for dialogue-bed masters.
- [ ] True peak: at or below `-1.0 dBTP`; no clipping or inter-sample overs.
- [ ] Loudness range: normally `3–8 LU`, with no surprise transient that forces narration ducking.
- [ ] Preserve usable headroom and dynamics; no audible pumping, brittle limiting, or excessive stereo widening.
- [ ] Check mono compatibility and phase correlation; essential musical information must survive mono.
- [ ] Speech test with representative low, mid, and high voices at normal playback and phone-speaker level.
- [ ] No persistent lead content in the speech-presence region; automate or re-orchestrate rather than relying only on EQ cuts.
- [ ] No DC offset, clicks, truncated tails, unintended silence, encoded metadata with personal information, or hidden watermarks.
- [ ] Verify duration, BPM/grid alignment, key metadata, bar count, and all edit markers against `track-catalog.yaml`.
- [ ] Export full mix, no-drums, rhythm, harmonic, melodic/accent, bass, and FX stems as applicable; summed stems must null closely against the approved master apart from documented bus processing.
- [ ] All stems start at the same timestamp, have identical length, and include appropriate tails.

## F. Deliverable acceptance

For each track, require:

- [ ] One approved 90–150 second full master.
- [ ] 15, 30, 60, and 90-second editorial versions with musical endings.
- [ ] At least one seamless loop and a documented loop region.
- [ ] Clean intro and clean outro versions/handles.
- [ ] Required aligned stems.
- [ ] Cue sheet metadata: track ID, display title, duration, BPM, meter, key/mode, composer/producer credit policy, asset license, version, and checksum.
- [ ] Private provenance manifest and evidence package complete.
- [ ] Similarity review passed.
- [ ] Rights owner/contributor paperwork completed and stored privately.
- [ ] Authorized legal/project owner explicitly approves commercial use, modification, sublicensing, and OSS redistribution under the exact selected license.
- [ ] A release reviewer verifies that the public bundle contains no private URLs, account identifiers, receipts, contracts, source prompts with personal data, or non-approved audio.

## G. Hard rejection / stop conditions

Stop and do not bundle when any of these is true:

- Generated on a free/Basic tier, or plan-at-generation cannot be proven.
- Applicable terms snapshot or generation timestamp is missing.
- Account/rights-holder chain is ambiguous.
- Candidate used third-party audio, lyrics, voice, MIDI, samples, or an artist/song imitation without independently sufficient written rights.
- Output was publicly remixed or has joint/unclear ownership.
- Similarity review is unresolved.
- The intended OSS license conflicts with service terms or cannot be granted confidently.
- A required human contributor has not signed the selected assignment/license.
- Technical deliverables or stems cannot be reproduced from the retained project files.

## H. Repository record after approval

Commit only a sanitized release manifest, license/NOTICE text, final approved assets in the separately authorized asset location, and public checksums. Keep identity evidence, terms snapshots, receipts, contracts, private track URLs, source working sessions, and rejected audio in the controlled private evidence store according to its retention policy.
