# BGM Library, Selection, Arrangement, and Mixing implementation plan

Status: implementation in progress; candidate Pack promotion and explicit hash-pinned cue-to-A2 projection complete

Date: 2026-07-28

Music-production workstream: Cockpit task `9cd0d6eb`

Implementation checkpoint (2026-07-16):

- Contract schemas and the read-only installed-pack registry/CLI are complete.
- Deterministic intent normalization, hard-gated seven-component ranking,
  `bgm_selection.json` trace writing, and `scripts/select-bgm.ts` are complete.
- The current CLI records the semantic channel as unavailable and applies the
  stricter metadata-only auto thresholds. Brief-to-track CLAP comparison is a
  later additive channel; no semantic score is fabricated.
- Shared preview/final mixing, dialogue finishing, Studio apply controls, and
  public Core Pack release approval remain pending.

Phase 2 checkpoint (2026-07-28):

- A caller-supplied `track_id` can be locked only after it resolves to one
  Registry-verified Pack candidate. The selection pins Pack ID/version,
  Registry canonical manifest hash, full-mix hash/size, and analysis hash/size.
- Additive `music-cues/v2` records exact rational-FPS source/timeline ranges,
  section/phase, semantic anchor, and the beat-alignment decision. Degraded
  analysis stays visible and never becomes a fabricated high-confidence grid.
- The compiler validates selection/hash drift and projects v2 cues idempotently
  onto A2. Missing cues, no-BGM projects, and legacy `original_only` behavior
  remain unchanged.
- The decision report is always `audition_only`; ranked top-three output is
  never treated as final music selection or public-release approval.

Candidate-intake checkpoint (2026-07-17):

- `technical-shortlist/v1` and `bgm-shortlist-review` contracts now separate
  machine ranking from musical, dialogue-bed, artifact, originality, and rights
  review.
- `scripts/bgm-shortlist.ts verify` resolves private batch inputs without
  copying them, rejects unsafe paths/symlinks, and verifies every candidate by
  SHA-256. `prepare-review` writes a path-redacted private review queue and
  preserves completed reviews only when candidate identity and hash still
  match.
- The first 16-slot shortlist contains 48 candidates; all 48 source files were
  hash-verified. Zero candidates are promotion-eligible until the explicit
  human review gates pass. Technical ranking is never treated as acceptance.
- Candidate audio and private evidence remain outside Git. Studio audition and
  review controls are now available. Accepted-master arrangement, rights
  release, and pack promotion remain pending.

Studio-review checkpoint (2026-07-17):

- Studio opens the private, path-redacted `musical-review-queue.json` from the
  top-bar music action and displays all candidates in a native three-pane
  review surface.
- The selected source is contained and SHA-256 verified before audition and is
  re-verified by the shared Node review command before an atomic save.
- Reviewers can audition 15 seconds of BGM alone, or mix it with the exact
  project timeline preview when one exists. Studio never substitutes an
  approximate dialogue source when the exact preview is absent.
- Musical fit, dialogue-bed fit, generated-artifact quality, originality, and
  rights evidence remain independent human gates. Explicit save is required;
  opening, filtering, or auditioning the queue does not mutate it.
- Review completion and promotion eligibility are not public-release approval.
  Arrangement, project A2 application/lock, final mix parity, and release
  rights approval remain later gates.

## 1. Objective

Build a local-first BGM subsystem that ships an openly reusable core music pack,
understands each track editorially, selects music from the video intent, fits it
to the timeline, and produces a speech-safe final mix. The subsystem must work
for interviews, explainers, LP/SNS ads, event recaps, product videos, and
documentary edits without making BGM mandatory for existing projects.

The first production proof is an interview project such as the AX-1 vertical
short. Given a BGM-enabled brief, the system must be able to install or discover
the Core Pack, rank suitable instrumental tracks, explain the ranking, project
one approved track onto A2, duck it under dialogue, preserve the ending
treatment, and render the same audible result in preview and final output.

### 1.1 Success conditions

- A clean installation can discover the pinned Core Pack without a commercial
  music account or network request during editing.
- Every selectable track has a verified content hash, a machine-readable rights
  record, technical analysis, authored editorial metadata, and a usable audio
  file.
- Public/external output cannot pass the release-safety gate when the selected
  music rights record is missing, unknown, restricted, or hash-mismatched.
- No-BGM projects compile and render byte-for-byte identically at the canonical
  artifact level unless the operator explicitly enables music.
- Cached selection across a 16-track Core Pack completes in under 2 seconds on
  the supported Apple Silicon development machine. When CLAP is unavailable,
  deterministic metadata selection completes in under 250 milliseconds.
- Auto mode selects a track only when all hard gates pass, the top score is at
  least 70/100, and its margin over the second candidate is at least 8 points.
  Otherwise Studio or the CLI presents three ranked candidates.
- Dialogue-led output meets the current mastering baseline of -16 LUFS
  integrated, at most -1.5 dBTP, and has no audible music restart, abrupt loop,
  or un-faded music cut at the ending.
- Exact preview and final render use the same A2 source ranges, gain envelope,
  ducking parameters, and ending frames.
- The standard 16-track installed pack is at most 120 MB. Lossless masters and
  stems are optional creator/HQ packs and are not required for normal runtime.

### 1.2 Requirement IDs

The implementation and its evidence use these stable requirement IDs:

- `BGM-R1 Pack integrity`: only contained, hash-valid, compatible packs resolve.
- `BGM-R2 Rights safety`: public/external output requires a licensed,
  hash-matching, non-expired rights record.
- `BGM-R3 Backward compatibility`: no-BGM, project-local BGM, and explicit
  `--bgm` behavior remain supported.
- `BGM-R4 Analysis`: deterministic technical/editorial facts remain available
  without optional local models.
- `BGM-R5 Explainable selection`: every ranked/rejected candidate has stable
  score or gate evidence; uncertain auto decisions become suggestions.
- `BGM-R6 Arrangement`: chosen music fits exact picture duration through
  approved source ranges, sections, loops, seams, and endings.
- `BGM-R7 Speech-safe mix`: one shared audio render plan governs A1/A2 gain,
  ducking, optional dynamic EQ, fade, and mastering.
- `BGM-R8 Preview/final parity`: exact preview and final output consume the same
  content-hash-bound audio render plan.
- `BGM-R9 Studio control`: operators can audition, understand, apply, lock,
  replace, remove, and inspect rights without hidden artifact mutation.
- `BGM-R10 Reproducibility and operations`: projects pin pack/track hashes;
  installs are atomic; reports expose degraded channels and render facts.

## 2. Scope

### 2.1 In scope

- Versioned, integrity-checked local BGM packs.
- The first CC0-oriented Core Pack production contract.
- Catalog and rights/provenance artifacts.
- Technical, structural, semantic, and editorial music analysis.
- Brief/timeline-aware ranking with an explainable score trace.
- Section-aware fitting, clean starts/endings, and bounded looping.
- A2 projection through the existing `music_cues.json` authority.
- Dialogue ducking, speech-band dynamic EQ, fade, and final mastering.
- Studio search, audition, apply, lock, replace, remove, and license visibility.
- CLI/headless parity and release-safety enforcement.
- Backward compatibility with project-local `bgm*.mp3` / `bgm*.wav` and
  `--bgm` operation.

### 2.2 Out of scope for the first implementation

- Calling Suno or another generation service from Video OS.
- A commercial music marketplace, purchase flow, subscription, or billing.
- Runtime generation of music for each video.
- Automated Content ID registration or dispute handling.
- Vocals, recognizable voice clones, artist-name prompts, or imitation briefs
  in the bundled Core Pack.
- General SFX, jingles, or sound-logo authoring.
- Multi-song feature-film scoring. Phase 1 supports one selected composition
  with one or more cues derived from that same composition.
- Time stretching or pitch shifting in the first arrangement engine.

## 3. Current state and gaps

The repository already has the following useful foundations:

- `runtime/media/bgm-analyzer.ts` detects audio-only files and derives duration,
  loudness, beats, downbeats, energy sections, and a fail-open analysis status.
- `schemas/bgm-analysis.schema.json` is the current project-level beat/section
  contract.
- `schemas/music-cues.schema.json` and `runtime/audio/music-cues.ts` validate a
  selected music asset and project cues onto the A2 music track.
- `runtime/audio/mixer.ts`, `runtime/audio/ducking.ts`, and
  `runtime/audio/mastering.ts` provide basic ducking, fade, mix, and loudness
  handling.
- `runtime/render/assembler.ts` already recognizes A2/music separately from A1
  speech and can sidechain-compress BGM.
- The local CLAP connector can embed audio and text and already fails open when
  the optional model environment is absent.
- `source_media_manifest.json` already has a `rights_status`, and release safety
  already understands a rights category.

The missing product path is between those pieces:

- There is no shared BGM catalog or installed-pack registry.
- Project analysis currently assumes one canonical `bgm_analysis.json`; it is
  not a multi-track library index.
- Rough-cut fallback selection uses filename and duration, not intent, mood,
  speech compatibility, or rights.
- The proposed `rights_license_register.yaml` does not yet have an implemented
  schema/runtime/UI.
- The basic rough-cut mux uses a fixed gain, while package/assembler paths have
  richer ducking. These paths must converge on one audio render plan.
- Studio can inspect BGM evidence already present in a project but cannot browse
  a library, audition ranked tracks, or save a selection.
- There is no per-track usage history, selection explanation, license badge, or
  pack integrity UI.

## 4. Architecture decisions

### 4.1 Product-included, repository-separated audio

The BGM experience is included in Video OS, but large binary masters must not be
stored in normal Git history. The repository stores schemas, catalog metadata,
license text, pack index, hashes, tests, and a tiny synthetic fixture. A
versioned release archive stores the normal listening/render pack. An offline
application distribution may pre-seed the exact same archive.

The archive is content-addressed and contains no executable files. Pack install
must reject path traversal, absolute archive paths, symlink escape, unexpected
extensions, duplicate IDs, oversized members, or hash mismatch.

Resolution order is deterministic:

1. Project-pinned local pack override.
2. `VIDEO_OS_BGM_PACK_DIR` for development and self-hosting.
3. User application-support pack directory.
4. Application-bundled Core Pack.
5. No music, with an operator-visible reason.

Network download is never performed inside compilation or final rendering.
Pack installation is an explicit Studio/CLI operation. Ordinary no-BGM editing
continues when no pack is installed.

### 4.2 Authority boundaries

```text
Core/user pack archive
  pack-manifest.json + rights + audio + derived analysis
                         |
                         v
              Installed BGM registry
                         |
         creative_brief + edit_blueprint + timeline evidence
                         |
                         v
              bgm_selection.json
                         |
                         v
                 music_cues.json
                         |
                         v
              timeline.json A2 clips
                         |
              shared audio render plan
                 /                \
          exact preview        final render
```

- Pack manifests are immutable distribution authorities for pack contents.
- `bgm_selection.json` is a derived planning/audit artifact. It records why a
  track won but does not own the timeline.
- `music_cues.json` remains the project authority for music placement.
- `timeline.json` remains the canonical compiled timeline; A2 is music.
- Renderers may not independently rescan or choose a different track.
- Rights records are declarative operator/contributor evidence. The analyzer
  may verify hashes and completeness but may not infer legal ownership.

### 4.3 Local and optional machine learning

Technical constraints, authored metadata, and rights checks are deterministic.
CLAP supplies an optional semantic similarity channel. A missing model cache or
worker cannot break the project; selection falls back to authored metadata and
records `semantic_channel: unavailable`. Auto selection requires stricter
confidence when the semantic channel is absent.

## 5. Music coverage contract

Core Pack v1 targets 16 instrumental tracks: eight editorial families with low
and high energy variants.

| Family | Primary use | Tempo direction |
| --- | --- | --- |
| `trust_clarity` | interviews, company stories, explainers | 82-100 BPM |
| `warm_human` | customer stories, recruiting, documentary | 70-94 BPM |
| `reflective_emotional` | before-state, reflection,余韻 | 64-84 BPM |
| `problem_tension` | challenge, investigation, pre-turning point | 76-104 BPM |
| `future_technology` | AI, SaaS, product, innovation | 96-120 BPM |
| `progress_uplift` | after-state, results, growth, CTA | 104-126 BPM |
| `premium_minimal` | LP hero, product, restrained brand film | 84-112 BPM |
| `playful_bold` | social hooks, event energy, light tutorials | 116-138 BPM |

Every track production brief must specify:

- intended family and intensity;
- perceived BPM as well as measured BPM;
- meter and key/mode direction;
- instruments and forbidden elements;
- 90-150 second master structure with bar-numbered section boundaries;
- clean intro, loopable middle, build, peak, release, and resolved ending;
- suitable 15/30/60/90-second edit paths;
- full mix, low-density/no-lead mix, and optional stems;
- no lead vocal and no recognizable third-party voice;
- speech-friendly arrangement and restrained 300 Hz-4 kHz density;
- no artist names, existing song titles, or imitation language in prompts.

The music-production details live in `docs/bgm-pack/core-v1/` and are owned by
Cockpit task `9cd0d6eb`. Missing audio is expected while that slow workstream is
in progress and must not block engine implementation using synthetic fixtures.

## 6. Data contracts

### 6.1 `bgm-pack-manifest/v1`

Proposed repository schema: `schemas/bgm-pack-manifest.schema.json`.

Proposed metadata location:
`resources/bgm-packs/core-v1/pack-manifest.json`.

Required pack fields:

- `version`, `pack_id`, `pack_version`, `title`, `created_at`;
- `catalog_license`, `default_content_license`;
- a canonical manifest hash policy that excludes its own derived hash fields;
- compatible Video OS contract range;
- ordered `tracks` array;
- provenance and hash canonicalization policy.

Required track fields:

- stable `track_id`, title, creator/contributor ID, duration, format;
- full-mix and preview refs with SHA-256 and byte size;
- optional alternate-mix/stem refs;
- hash- and byte-size-pinned `rights_ref` and `analysis_ref` data members;
- authored family, intensity, use cases, exclusions, instruments;
- authored edit points and loop windows;
- authored continuous editorial axes.

### 6.2 Continuous editorial axes

Each axis is normalized to `[0, 1]` and includes `source: authored | analyzed`:

- `energy`, `valence`, `tension`, `warmth`;
- `modernity`, `playfulness`, `sophistication`;
- `organic_electronic`, `density`, `speech_friendliness`;
- `beat_prominence`, `build_strength`, `ending_resolution`.

`vocal_presence` is `none | texture | lead | unknown`, not a float.
Authored values are never silently overwritten by analysis. Analysis writes a
separate value and confidence so disagreement remains inspectable.

The installed manifest does not embed the hash of the archive that contains
it. Doing so creates a self-referential digest. Distribution archive hash and
byte size belong to an archive-external release receipt/index, which the
installer verifies before extraction. The installed manifest pins every audio
member by content hash and byte size and defines its own canonical JSON hash
policy.

### 6.3 `bgm-track-analysis/v1`

Proposed schema: `schemas/bgm-track-analysis.schema.json`.

Pack analysis is per content hash, not per project, and contains:

- duration, sample rate, channels, codec;
- integrated LUFS, LRA, true peak, clipping and silence facts;
- BPM, perceived tempo, meter, key/mode when available;
- beats, downbeats, sections, energy curve, transient density;
- safe entry/exit points and loop candidates;
- spectral density and speech-band masking score;
- CLAP embedding reference and fixed-label mood/genre scores;
- analyzer versions, model revision, fallback/degraded status;
- input content hash and deterministic analysis hash.

The deterministic analysis hash excludes `analysis_hash` and `created_at` and
uses normalized JSON v1 canonicalization. Analyzed editorial axes are stored
separately from authored manifest axes as value/confidence pairs; analysis may
disagree with authored metadata but never replace it in place.

The existing project `bgm_analysis.json` remains readable. A selected library
track can project its pack analysis into that legacy view during migration.

### 6.4 `bgm-selection/v1`

Proposed path: `projects/<id>/04_plan/bgm_selection.json`.

It records:

- project, brief, blueprint, timeline, catalog, and analysis hashes;
- selection mode: `suggest | auto | operator_locked`;
- normalized requirements and hard constraints;
- all considered candidates, rejection reasons, score breakdowns, rank;
- selected track, confidence, top-two margin, selection explanation;
- optional operator override and reason;
- semantic channel status and degraded warnings;
- local usage-history penalty inputs without exposing unrelated project text.

### 6.5 `rights-license-register/v1`

Implement the already-planned generic artifact at
`07_package/rights_license_register.yaml`, initially with the BGM item type.

Each BGM record contains:

- selected asset ID and exact content hash;
- source type: bundled pack, user library, or project local;
- creator/contributor declaration ID;
- generator/tool and account-tier facts when declared;
- creation date and evidence references without embedding receipts or personal
  billing information;
- license identifier, license text ref, permitted scope, attribution rule;
- human similarity-review status;
- machine integrity status;
- `rights_status` compatible with the source-media manifest;
- waivers, reviewer, review time, and expiry if applicable.

Preview may use `operator_declared_ok` with a visible warning. Public/external
enforce mode requires `licensed`, a matching hash, and no expired/restricted
record.

### 6.6 Additive `music-cues/vNext`

The Phase 2 TypeScript, JSON Schema, planner, CLI, and compiler path implement
`music-cues/v2` additively while v1 remains readable. V2 adds:

- `selection_ref` and exact Pack, full-mix, and analysis pins;
- rational timeline FPS and exact source/timeline ranges;
- section, phase, semantic anchor, and explicit beat-alignment decision;
- degraded-analysis status and warnings without fabricated grid confidence.

V2 source ranges are authoritative and are not inferred from timeline entry
frames. Loop policy/repetitions, gain envelope, dynamic EQ, ending resolution,
shared render-plan versioning, and Swift apply controls remain Phase 3 or later.

## 7. Pack installation and registry

Proposed runtime modules:

- `runtime/music/pack-types.ts`
- `runtime/music/pack-registry.ts`
- `runtime/music/pack-installer.ts`
- `runtime/music/catalog.ts`

The registry API is read-only during compile/render:

```ts
resolveInstalledPacks(options): InstalledPack[]
verifyPack(packPath): PackVerification
listTracks(filters): CatalogTrack[]
resolveTrack(trackId, pinnedHash): ResolvedTrack
```

Install is a separate mutation:

```text
npx tsx scripts/bgm-pack.ts install <archive>
npx tsx scripts/bgm-pack.ts verify [--pack core-v1]
npx tsx scripts/bgm-pack.ts list
```

Installation extracts into a temporary sibling directory, verifies every
member, then atomically renames the complete pack. Interrupted installs leave
the previous pack active. At most one version is active per `pack_id`, while
projects pin the exact version/hash needed for reproducibility.

Before extraction, installation verifies an archive-external signed or pinned
release receipt containing the distribution archive SHA-256 and byte size.
The receipt is not stored inside the archive it hashes. Read-only registry and
render paths consume only the activated installed manifest and member hashes;
they never infer trust from a filename or installation directory.

Every referenced rights and analysis member is pinned in the manifest by
relative path, SHA-256, byte size, and data format. Registry verification parses
those members against their canonical schemas and cross-checks their track and
audio content hashes. Missing optional analysis degrades to authored metadata;
malformed rights or any pinned-member integrity mismatch never silently falls
back to a lower-priority pack with the same identity.

The installer takes an advisory lock scoped to the destination `pack_id`. A
second installer exits without mutation as `BGM_PACK_BUSY`; stale locks are
recovered only when the recorded process is absent and the temporary directory
fails verification. Compile/render never waits for the installer: it reads the
last fully activated registry snapshot.

### 7.1 Stable pack error contract

CLI JSON and StudioCore use the same codes:

- `BGM_PACK_NOT_FOUND`
- `BGM_PACK_BUSY`
- `BGM_PACK_INCOMPATIBLE`
- `BGM_PACK_ARCHIVE_UNSAFE`
- `BGM_PACK_MEMBER_UNSUPPORTED`
- `BGM_PACK_SIZE_LIMIT`
- `BGM_PACK_HASH_MISMATCH`
- `BGM_TRACK_MISSING`
- `BGM_TRACK_HASH_MISMATCH`
- `BGM_RIGHTS_BLOCKED`
- `BGM_ANALYSIS_UNAVAILABLE`
- `BGM_SELECTION_INCONCLUSIVE`
- `BGM_ARRANGEMENT_NO_SAFE_FIT`
- `BGM_RENDER_PLAN_STALE`

Errors include `code`, `message`, `recoverable`, `affected_ref`, and
`suggested_action`. They do not include account data or unrestricted absolute
paths. Missing optional analysis is a warning/degraded channel; integrity,
rights, stale render plan, and unsafe arrangement are hard errors at the
corresponding final-output gate.

## 8. Analysis pipeline

Proposed modules:

- Extend `runtime/media/bgm-analyzer.ts` only for reusable low-level facts.
- Add `runtime/music/track-analysis.ts` for pack-level orchestration.
- Add `runtime/music/editorial-descriptors.ts` for fixed labels and scores.
- Reuse `runtime/connectors/clap-audio-local.ts`; do not create a second CLAP
  worker or model registry.

Analysis stages:

1. Verify source and rights hashes.
2. Probe technical format and duration.
3. Measure loudness, peak, silence, spectrum, and speech-band occupancy.
4. Detect tempo, beat/downbeat, sections, energy curve, and loop candidates.
5. Embed full track and representative sections with CLAP when available.
6. Compare against a versioned text-label set for mood/genre descriptors.
7. Reconcile authored and analyzed facts without overwriting either.
8. Write content-hash-keyed analysis atomically.

The fixed text-label set and scoring version must be committed. Model absence,
timeout, or invalid vectors produce `partial`, retain deterministic facts, and
do not fabricate semantic scores.

## 9. Selection engine

Proposed modules:

- `runtime/music/selection-input.ts`
- `runtime/music/selector.ts`
- `runtime/music/selection-trace.ts`
- `scripts/select-bgm.ts`

Selection inputs are:

- `creative_brief.yaml` audience, purpose, tone, platform, runtime, and BGM
  policy;
- `edit_blueprint.yaml` story arc, beat roles, music policy, and ending policy;
- timeline duration, cut density, speech ratio, section/chapter boundaries, and
  desired energy curve;
- catalog metadata, analysis, rights, installed availability, and local usage
  history.

Hard rejections occur before scoring:

- missing or mismatched audio/pack hash;
- rights not permitted for the requested output mode;
- vocal policy conflict;
- unsupported codec or unreadable file;
- insufficient duration with no approved edit/loop path;
- explicit brief exclusion;
- analysis marked failed with insufficient authored fallback metadata.

Initial score is 100 points:

| Component | Weight |
| --- | ---: |
| CLAP brief-to-track semantic fit | 30 |
| editorial family and narrative-arc fit | 20 |
| speech friendliness for observed dialogue ratio | 15 |
| energy/tempo fit for pacing and platform | 15 |
| duration, edit-point, and resolved-ending fit | 10 |
| beat/downbeat confidence for cut synchronization | 5 |
| diversity and recent-use penalty | 5 |

When CLAP is unavailable, its 30 points are redistributed proportionally among
the first five deterministic components, the trace records that redistribution,
and auto mode additionally requires a top score of 78 and a margin of 12.

The result explanation names positive and negative evidence. It must never say
only “AI chose this track.” Example: “Trust/Clarity high-energy metadata matches
the case-study brief; 0.91 speech-friendliness suits 82% dialogue; the resolved
ending lands within 0.4 seconds of the 61.1-second target.”

## 10. Arrangement and cue planning

Proposed modules:

- `runtime/music/arranger.ts`
- `runtime/music/loop-planner.ts`
- `runtime/music/cue-planner.ts`

Phase 1 uses one composition and a bounded search over approved sections:

1. Resolve desired entry, exit, and video ending treatment.
2. Prefer a single contiguous source range ending at a resolved musical exit.
3. Otherwise concatenate only authored/analyzed compatible section boundaries.
4. Use loop windows only at bar/downbeat boundaries and within declared maximum
   repetitions.
5. Apply short equal-power audio crossfades at internal music edit seams.
6. Reject plans with audible discontinuity risk rather than hiding them with a
   long fade.
7. Emit exact source ranges and repetitions into `music_cues.json`.

The planner is deterministic and bounded by a fixed candidate count. It does
not stretch tempo. A future phase may permit at most +/-2% time stretch after
quality evaluation and explicit render-plan versioning.

## 11. Shared mix and render plan

The final architecture must remove the difference between the fixed-gain
rough-cut mux and the richer package/assembler path. All renderers consume one
normalized audio render plan produced from A1/A2 and music cues.

Proposed modules:

- `runtime/audio/render-plan.ts`
- Extend `runtime/audio/mixer.ts` and `runtime/audio/ducking.ts`.
- Make `scripts/render-rough-cut.ts`, the assembler, exact preview, and package
  render consume the shared plan.

The plan contains:

- exact source/timeline ranges;
- music pre-normalization gain;
- dialogue and music base gain;
- speech intervals;
- ducking attack, hold, release, and maximum reduction;
- optional dynamic EQ centered on speech-conflicting bands;
- internal edit crossfades and final fade;
- mastering and output channel policy.

Baseline behavior:

- Dialogue retains the existing -16 LUFS / -1.5 dBTP finishing baseline.
- BGM is pre-normalized before artistic gain is applied.
- Speech triggers ducking from actual A1/VAD intervals; music does not trigger
  itself and dialogue edge-fade logic never modifies A2.
- Dynamic EQ is bounded and optional; if unavailable, level ducking remains.
- The final mix is measured after mixing. A failed loudness or clipping gate is
  a render failure, not a warning for final output.
- Final music follows the moving-video ending treatment and does not introduce
  a frozen frame or abrupt audio cutoff.

## 12. Studio experience

Add a BGM Library surface without creating a second timeline:

- Installed-pack status, version, integrity, and license summary.
- Search and filters for family, mood axes, energy, BPM, duration, instruments,
  speech friendliness, and usage status.
- “Recommended” view with three candidates and score explanations.
- Waveform/energy/section strip and playhead-synchronized audition.
- Audition against current dialogue with the actual ducking preview plan.
- Apply, lock, replace, remove, and restore-auto actions.
- License/right status badge that opens the selected record.
- A2 timeline clips and cue boundaries remain visible/editable through existing
  timeline conventions.
- Unsaved audition and selection stay in memory. Explicit save writes the
  selection/cue artifacts and recompiles through shared runtime entrypoints.

Suggested Swift surfaces:

- `BGMReviewView.swift` and `BGMReviewSession.swift` for generated-candidate
  intake review.
- `BGMLibraryView.swift`
- `BGMRecommendationView.swift`
- `BGMTrackInspectorView.swift`
- `BGMSelectionDocument.swift` in StudioCore
- `ProjectBGMPackStatus.swift` in StudioCore

Studio must not download packs or alter rights status as a side effect of
opening a project.

The generated-candidate review surface is the first delivered slice of this
experience. It intentionally stops before applying or locking a candidate on
A2, so a technical shortlist or review-session choice cannot silently become
an edit or a releasable asset.

## 13. CLI and agent interfaces

Headless commands:

```text
npx tsx scripts/bgm-pack.ts list|verify|install
npx tsx scripts/analyze-bgm-library.ts --pack core-v1
npx tsx scripts/select-bgm.ts --project projects/<id> --mode suggest|auto
npm run bgm:plan-cues -- --project projects/<id> --track-id <id> --output <new-dir> ...
```

Agent tools receive compact structured evidence, not raw embeddings:

- top candidates and score components;
- rights and availability gates;
- energy/section summary;
- speech friendliness and duration fit;
- explicit unavailable channels and warnings.

Agents may propose selection or replacement. They may not waive rights gates or
install/download a pack implicitly.

All headless commands support `--json`. Exit code `0` means the requested
operation completed, `2` means invalid input/contract, `3` means unavailable but
recoverable local capability, `4` means integrity or rights denial, and `5`
means internal execution failure. Suggest mode may return no selected track with
exit code `0` when it correctly emits ranked candidates for a human decision.

## 14. Implementation phases

### Phase 0 — Contracts and fixtures

Files:

- Add pack, track-analysis, selection, and rights-register schemas.
- Add TypeScript types and schema validation registrations.
- Add a tiny synthetic two-track fixture with permissive in-repo provenance.
- Extend `music-cues` TypeScript/Schema/Swift contracts atomically.

Acceptance:

- All new valid/invalid schema fixtures behave deterministically.
- Existing project artifacts still validate unchanged.
- No dependency, database migration, source footage, or real music binary is
  added.

### Phase 1 — Pack registry and rights gate

Files:

- Add `runtime/music/pack-*`, catalog, and `scripts/bgm-pack.ts`.
- Add rights-register loader and release-safety integration.
- Add standard install locations and environment override.

Acceptance:

- Install, verify, activate, corrupt, interrupt, and rollback scenarios pass.
- Archive traversal/symlink/oversize fixtures are rejected.
- Preview can warn on operator-declared music; public enforce mode blocks any
  non-licensed or mismatched selection.

### Phase 2 — Library analysis

Files:

- Add pack-level track analysis and editorial descriptors.
- Reuse the CLAP connector and versioned label vocabulary.
- Add analysis CLI and cache invalidation by content hash/tool version.

Acceptance:

- Technical facts and deterministic fallbacks work without CLAP.
- Ready CLAP mode yields finite 512-dimensional embeddings and fixed-label
  scores.
- Cache hit produces no audio/model recomputation.

### Phase 3 — Explainable selection

Files:

- Add selection input normalization, scorer, trace writer, and CLI.
- Add brief/blueprint/timeline feature extraction.
- Add local, privacy-minimal usage history.

Acceptance:

- Golden fixtures rank expected families for interview, social ad, product,
  event, and documentary intents.
- Rights, vocal, missing-file, and no-fit candidates are hard rejected.
- Auto threshold/margin and CLAP-degraded thresholds are exact.
- Re-running identical inputs produces byte-stable selection content except
  declared volatile timestamps.

### Phase 4 — Arrangement and render parity

Files:

- Add arranger, loop/cue planner, and shared audio render plan.
- Route rough-cut, assembler, exact preview, and package render through it.
- Add music seam, ending, loudness, and clipping QA.

Acceptance:

- 15/30/60/90-second golden timelines end on an approved musical boundary.
- Preview/final source ranges and gain envelopes match exactly.
- Dialogue/BGM output meets loudness/true-peak gates and has no abrupt seam in
  sampled/manual QA.
- No-BGM and legacy `--bgm` projects retain compatibility.

### Phase 5 — Studio BGM Library

Files:

- Add StudioCore documents/status and SwiftUI library/recommendation/inspector.
- Add commands for suggest, audition, apply, lock, replace, remove, and pack
  verification.

Acceptance:

- A user can open the AX-1 short, audition the top three with dialogue ducking,
  apply one, save, reopen, render, and inspect its license record.
- IME, captions, source edits, and existing timeline shortcuts remain intact.
- Accessibility identifiers and keyboard paths cover all repeated actions.

### Phase 6 — Core Pack release and expansion

- Complete the separate music-production workstream.
- Import generated technical shortlists through `scripts/bgm-shortlist.ts` and
  retain the hash-bound human review queue beside the private source batches.
- Verify all 16 tracks, hashes, rights declarations, edit points, and mixes.
- Publish the versioned pack archive only after explicit human approval and
  legal/rights review.
- Add optional HQ/stem pack and future user-library import after Core v1 proof.

## 15. Test strategy

### 15.1 Unit and schema

- Pack parsing, path containment, hash verification, version resolution.
- Analysis normalization, authored/analyzed disagreement preservation.
- Selection hard gates, score components, redistribution, thresholds, margins.
- Arrangement boundary and loop search, fade/seam math.
- Rights status transitions and public-output gate.
- Music cue vNext normalization and old-version compatibility.

### 15.2 Integration

- Synthetic pack install -> analysis -> selection -> cues -> A2 -> mix.
- Project-local BGM and `--bgm` fallback routes.
- CLAP available/unavailable/timeout/invalid-vector routes.
- Exact preview and final render-plan parity.
- Package freshness invalidation when catalog, track, selection, cues, or rights
  hashes change.

### 15.3 Real-media golden evaluation

Use rights-cleared local evaluation media that is never committed:

- AX-1 60-second vertical interview: high dialogue ratio.
- 90-second LP case study: narrative build and CTA.
- 30-second social ad: strong hook and resolved short ending.
- Event recap: stronger beat sync and lower dialogue ratio.
- Reflective documentary sample: sparse music and breathing room.

Record top-three ranking, selection rationale, speech ratio, measured output
LUFS/TP/LRA, seam checks, ending checks, preview/final hashes, and operator
preference. Do not claim genre/mood quality from unit tests alone.

### 15.4 Performance and reliability

- Catalog and cached selection latency at 16, 100, and 1,000 metadata entries.
- Pack installation interruption and disk-full behavior.
- Corrupt archive/member/hash behavior.
- Optional model peak memory and fail-open cleanup.
- Long-form render memory and audio-plan size.

### 15.5 Requirement-to-evidence matrix

| Requirement | Minimum automated evidence | Required real/operator evidence |
| --- | --- | --- |
| `BGM-R1` | archive containment, extension, size, compatibility, hash, atomic install, lock tests | install/corrupt/rollback smoke with the release-shaped pack |
| `BGM-R2` | rights schema and preview/report/enforce gate matrix | rights reviewer approval before public pack release |
| `BGM-R3` | no-BGM artifact comparison; legacy local and `--bgm` integration | reopen/render one existing no-BGM and one legacy-BGM project |
| `BGM-R4` | ffprobe/loudness/beat/section/descriptor fixtures; CLAP ready/degraded tests | analysis report for every Core v1 candidate |
| `BGM-R5` | five intent goldens, hard gates, score/margin byte stability | operator ranks top three across the five real-media evaluations |
| `BGM-R6` | 15/30/60/90 arrangement and unsafe-fit tests | seam and musical-ending listening review |
| `BGM-R7` | A1/A2 render-plan, sidechain, EQ fallback, loudness/peak tests | dialogue intelligibility and mix review on AX-1 plus event sample |
| `BGM-R8` | render-plan hash and source/gain/fade parity assertions | synchronized preview/final spot check |
| `BGM-R9` | Swift model/view tests, accessibility IDs, save/reopen integration | Studio audition/apply/lock/replace/remove walkthrough |
| `BGM-R10` | version pin, cache invalidation, concurrency, rollback, redacted logs | pack upgrade and offline self-host smoke |

## 16. Migration, rollout, and rollback

- Feature flags: `VOS_BGM_LIBRARY_ENABLED`, `VOS_BGM_AUTO_SELECT_ENABLED`, and
  `VOS_BGM_DYNAMIC_EQ_ENABLED`; defaults remain off until each phase passes its
  acceptance suite.
- Existing `03_analysis/bgm_analysis.json`, local `bgm*.mp3|wav`, and `--bgm`
  remain supported during migration.
- Old `music_cues.json` stays readable. V2 fields are emitted only by the
  explicit, hash-pinned cue planner; missing cues and legacy `original_only`
  projects retain their previous compiler behavior.
- A project selection pins pack ID/version and content hash, so upgrading an
  installed pack cannot silently change an existing edit.
- Rollback disables library/auto-select and keeps project-local BGM plus the old
  cue reader. It never deletes installed packs or project artifacts.
- Pack uninstall is blocked while an open project pins that exact only-available
  version unless the operator explicitly confirms the broken reference.

## 17. Observability and maintenance

Selection and render reports expose:

- installed/resolved pack and track hashes;
- rights gate result;
- analysis status and unavailable channels;
- candidate rejection and score breakdown;
- auto/suggest/operator decision provenance;
- arrangement edits, loops, seams, and ending choice;
- dialogue/music gain, ducking, dynamic EQ, and loudness measurements;
- preview/final render-plan hash.

Do not log prompts containing unrelated project text, receipts, account IDs, or
absolute private evidence paths. Pack metadata/schema changes use semantic
versions. Analyzer or scorer changes invalidate only derived analysis/selection,
not immutable source audio or rights declarations.

## 18. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Generated-music rights are less certain than ordinary commissioned audio | Paid-plan evidence, contributor declaration, no third-party inputs, similarity review, explicit rights gate, specialist review before public pack release |
| Git/release size grows quickly | Metadata in Git; standard/HQ/stem archives separated and hash-pinned |
| Music masks speech | Speech-friendliness analysis, A1-driven ducking, bounded dynamic EQ, real dialogue goldens |
| Semantic labels feel arbitrary | Fixed vocabulary, authored/analyzed separation, score trace, human top-three mode |
| CLAP unavailable on user machine | Pack can ship derived descriptors; runtime fallback is deterministic and local |
| Looping sounds mechanical | Authored loop points, section-boundary search, repetition caps, seam QA, reject unsafe plans |
| Different render paths drift | One shared audio render plan and parity tests |
| Same bundled tracks become repetitive | Local usage penalty, alternate density mixes, future pack expansion |
| Existing projects regress | Feature flags, old cue normalization, no-BGM byte-stability tests |

## 19. Unresolved decisions

| Decision | Owner | Deadline | Resolution condition |
| --- | --- | --- | --- |
| Confirm that each Suno-produced candidate can be redistributed under the chosen open-content declaration | Product owner + qualified rights reviewer | Before the first public Core Pack archive; target 2026-08-15 | Written decision and contributor declaration template approved; otherwise do not publish those tracks |
| Choose standard runtime codec and whether an HQ lossless pack ships simultaneously | Audio/runtime engineering | Before Phase 1 pack-manifest schema freezes; target 2026-07-31 | Decode support, 16-track pack-size measurement, and one-generation render quality comparison recorded |
| Choose release-asset hosting versus fully bundled app archive | Release engineering | Before Phase 1 installer implementation; target 2026-07-31 | Offline, checksum, update, and self-hosting paths demonstrated |
| Finalize Core Pack track IDs and music briefs | Cockpit task `9cd0d6eb` + product owner | Before Phase 6 music acceptance | All 16 catalog rows validate and each has an approved generation brief |
| Approve public-output loudness profiles beyond the current -16 LUFS baseline | Audio engineering + product owner | Before Phase 4 final-output gate | Delivery-profile targets and tolerances are versioned and covered by fixtures |

No unresolved decision blocks Phase 0 contract work. Pack publication, external
download, dependency additions, and production configuration remain human-gated.

## 20. Rights reference baseline

The public pack must record the exact terms snapshot and review decision used at
release time. As of the design date, the official Suno terms state that eligible
paid-tier output rights owned by Suno are assigned to the paid user, while Suno
does not warrant that copyright vests in an output. Basic/free output is not the
Core Pack source path. CC0 permits copying, modifying, distributing, and
performing the work, including commercially, to the extent the affirmer owns
the relevant rights. These sources inform the planned gate but are not
themselves legal approval for a particular track.

- Suno Terms: <https://suno.com/terms/>
- Suno Rights & Ownership: <https://help.suno.com/en/categories/550145>
- CC0 1.0 deed and legal-code link: <https://creativecommons.org/publicdomain/zero/1.0/>

## 21. Implementation start order

The first implementation slice should be Phase 0 plus the read-only portion of
Phase 1:

1. Commit schemas and synthetic fixtures.
2. Implement pack verification/listing without download or install mutation.
3. Implement a rights-register reader and report-only release-safety check.
4. Preserve all old BGM/no-BGM paths.
5. Verify with schema tests, Node tests, Swift decoding tests, and one synthetic
   end-to-end project before adding selection intelligence.

This order proves the authority, integrity, and rights boundaries before model
scoring or Studio UI can make an unsafe music choice look complete.
