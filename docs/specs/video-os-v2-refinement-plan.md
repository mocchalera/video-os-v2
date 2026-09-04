# Video OS v2 refinement plan

Status: implementation-ready integration plan
Updated: 2026-08-20
Scope: this document defines the implementation order, contracts, ownership, review gates, and pilot handoff for the next Video OS v2 refinement. It is a plan, not an implementation record.

## 0. 結論

The implementation order is intentionally constrained:

1. Make the Timeline Offset Engine and source-to-timeline caption timing the first executable milestone.
2. Preserve the existing canonical artifacts and renderer split. Add references and derived reports instead of creating a second timeline, a second caption truth, or a new renderer.
3. Move 9:16 composition, platform safe zones, typography, retention, and audio delivery knowledge into versioned policy/profile artifacts. Generic skills explain the method and invoke real repository commands; project names, colors, copy, and project-specific measurements remain in STYLE.md or project artifacts.
4. Add graphical caption treatment only after stable caption identity and automatic timing are reliable. Treat graphical treatment as a separate non-destructive patch stream in Studio.
5. Reuse the existing semantic-first SFX solver and shared AudioRenderPlan. Promote the Narunaru DAY1 SFX only after rights, provenance, and content-hash evidence is complete.
6. Keep Phase 7 private-pilot decisions separate: agent QA, human visual/audio approval, NLE handoff, and platform preview each produce their own evidence and do not implicitly approve one another.

The highest-priority path is therefore:

    edit_blueprint.yaml
      -> timeline.json
      -> Timeline Offset Engine
      -> caption_draft.json with stable identities
      -> caption review and canonical preview
      -> optional caption visual-treatment patch
      -> platform/audio profile validation
      -> export or explicit external/NLE handoff

Graphical Studio work must not start ahead of the Offset Engine. The current system already has caption text, line-break, split/merge, frame timing, waveform loop, preview, undo, and stale-conflict handling. The missing Studio surface is per-caption graphical treatment, not a replacement caption editor.

## 1. Success criteria and non-goals

### 1.1 Completion criteria

The refinement is complete only when all of the following are true.

| ID | Completion condition | Evidence |
| --- | --- | --- |
| C-01 | A source word timestamp can be projected through the final clip placement, speed, gaps, and rational FPS without rebuilding timing from output frame numbers. | Timeline Offset Engine unit/property tests, projection report, and caption draft hash |
| C-02 | Every caption has a deterministic stable identity and lineage. Timing/text edits and visual-treatment edits can be reviewed independently, and stale patches are rejected. | Caption draft, review patch, visual-treatment patch, stale-conflict test |
| C-03 | The canonical timeline remains timeline.json; caption drafts/review/approval, profile manifests, SFX cues, and render receipts reference it rather than replace it. | Schema validation and route receipt |
| C-04 | 9:16 composition decisions cover person occupancy, headroom, look-room, hand/microphone safety, layout anchors, registered zoom/jump-cut intent, and degrade behavior without embedding project brand values. | Composition policy artifact, representative-frame QA, generic skill contract |
| C-05 | Platform safe-zone decisions are profile-driven and revision-aware. Instagram, TikTok, and YouTube Shorts are represented by source/date/version metadata and screenshot fixtures, not by unverified constants in code or skills. | Profile manifest, screenshot hashes, safe-zone regression |
| C-06 | High-stimulation hooks are truth-bound, readable, accessible, policy-aware, measurable, and degradable. A stronger mode can fall back to a safer mode without inventing claims or evidence. | Retention policy audit, degradation receipt, human review |
| C-07 | Caption typography specifies line length, maximum lines, breaks, reference font sizing, hierarchy, emphasis, motion, effects, contrast, and reduced-motion behavior. Values are delivery/profile data, not universal generic prose. | Typography profile, caption validation, mute/readability review |
| C-08 | The shared SFX pack has rights, provenance, hash, scope, and version evidence. Cue selection, semantic synchronization, gain, tails, and anti-overuse are wired through the existing runtime and skill contracts. | SFX manifest, solver decision, audio render plan, mix report |
| C-09 | Platform audio delivery profiles cover processing, voice intelligibility, loudness, true peak, codec/downmix/mobile-speaker checks, and normalization assumptions without claiming one universal target. | Profile source record, measured reports, mono/mobile fixture |
| C-10 | Studio can loop video and waveform, edit timing and graphical treatment in separate surfaces, show safe zones, drag/resize within policy, apply presets, undo, reject stale changes, and match the canonical preview. | Studio contract fixture, integration test, parity receipt |
| C-11 | Speech caption text/timing/approval remain owned by the caption runtime, Review Core, and Studio; speech caption burn/render remains owned by FFmpeg/libass; content elements remain owned by Remotion/HyperFrames. No unregistered renderer is introduced. | Caption approval and render-route receipts, plus renderer capability test |
| C-12 | DAY1 external ASS/alpha work is represented as an explicit external/NLE route and is not misreported as a Remotion/HyperFrames canonical render. | External route receipt, supplied-final or NLE handoff evidence |
| C-13 | Private pilot evidence separates agent QA, human visual/audio approval, NLE handoff, and platform preview. | Four separate gate artifacts and approval records |
| C-14 | The skill surface passes npm run verify:skill-contracts and refers only to real CLIs and artifacts. | Skill-contract verification output |

### 1.2 In scope

- Blueprint v2 integration for hook/body/shot-anchor intent and references to composition, retention, caption, platform, audio, and SFX policies.
- Timeline Offset Engine and source-word-to-final-timeline caption projection.
- Stable caption identity and caption lineage.
- Versioned 9:16 composition and platform delivery profiles.
- Generic skills for vertical composition and social platform delivery, plus focused updates to existing creator, render, audio, review, and re-edit skills.
- Measurable and degradable retention/hook policy.
- Typography/readability policy and a separate caption visual-treatment patch.
- Studio graphical treatment review surface after timing stabilization.
- Verified common SFX pack promotion and existing semantic-first solver wiring.
- Platform-aware audio delivery profiles and delivery evidence.
- Canonical preview/export/NLE handoff receipts and the private pilot.

### 1.3 Explicit non-goals

- No code implementation, media copying, external repository change, or generated output is part of this planning-worker change.
- No PCL or project-control-loop invocation. The repository instruction says that harness is paused.
- No new renderer. Do not introduce a new caption graphics engine, an alternate timeline compiler, or a project-local FFmpeg wrapper that competes with the current route resolver.
- No second source of truth for clip placement, caption text/timing, audio cues, or content elements.
- No universal platform safe-zone, loudness, true-peak, cut-rate, caption-length, zoom, or stimulation constant asserted without a versioned source and measurement record.
- No automatic clickbait, fabricated result, invented quotation, invented evidence, or emotional trough when the source does not support it.
- No generic skill containing a project name, person name, brand color, brand copy, or a value observed in one project as if it were a universal rule.
- No assumption that a social platform's eventual server-side normalization, UI chrome, or policy is stable. The profile and fixture must be revisable.

## 2. 現在の証拠と現行システム

### 2.1 Canonical project path

The repository's artifact-driven path is:

    creative_brief.yaml
      -> selects_candidates.yaml
      -> edit_blueprint.yaml
      -> timeline.json
      -> preview/render/export receipts
      -> QA and human approval artifacts

The artifact is authoritative; logs, a preview filename, or a Studio screen are not authoritative by themselves. Optional local models remain fail-open as required by AGENTS.md.

Current implementation evidence relevant to this plan:

- runtime/caption/word-remap.ts and the caption command path already carry source-word timing and remap concepts.
- runtime/caption/review-core.ts already supports text, line-break, split/merge, timing, review state, stale base-hash checks, risk queues, and derived previews.
- Studio already provides caption text editing, line-break/split/merge, waveform loop, timing handles, preview, autosave/IME handling, undo, and stale-conflict handling. It does not yet provide per-caption graphical position, size, style, emphasis, animation, or safe-zone editing.
- runtime/content/template-registry.ts and runtime/content/render-plan.ts already constrain content elements to registered IDs and renderer ownership.
- runtime/render/route-resolver.ts, runtime/render/pipeline.ts, and runtime/render/final-visual-compositor.ts already express capability-based routing, FFmpeg/libass caption burning, and a final composite path.
- runtime/audio/sfx-cues.ts, runtime/audio/sound-design-solver.ts, and runtime/audio/render-plan.ts already express rights/provenance/hash pins, semantic roles, congestion/density decisions, A1/A2/A3 ownership, and single final mastering.
- Existing skills already define the artifact order for caption review, render, and semantic-first SFX. This plan composes and tightens those contracts; it does not replace them.

### 2.2 DAY1 evidence and route boundary

The current DAY1 evidence at /Users/operator/Biz/なるなるgram/handoff/day1_ott is a supplied external handoff, not a Video OS canonical output:

- captions_day1.ass contains ASS style, override, and \t animation directives.
- reference_preview.mp4 and captions_overlay_transparent.mov report Lavf62.12.102.
- captions_overlay_transparent.mov is 1080x1920, 30 fps, ProRes yuva444p12le with alpha.
- The route is FFmpeg/libass-based external manual finishing. It is not the current Remotion/HyperFrames canonical route.

The plan must record this boundary explicitly:

| Concern | Video OS owner | DAY1 external evidence |
| --- | --- | --- |
| Speech caption text/timing/approval | Caption runtime, Review Core, and Studio | Supplied ASS and external manual review may be evidence, but not canonical approval |
| Speech caption burn/render | FFmpeg/libass through the canonical route | Supplied ASS and external manual render |
| Registered graphical/content element | Remotion or HyperFrames according to content registry and route capability | External alpha overlay may be supplied as NLE material |
| Timeline truth | timeline.json | External timeline/handwork is not silently imported as truth |
| Authoring/review | Studio and shared Review Core | Human external/NLE work is a separate handoff |
| Final route claim | Render-route receipt | Explicit external/NLE receipt, never a false canonical-render claim |

The first compatible handoff is an import/receipt and parity fixture, not a renderer rewrite. If an ASS animation cannot be represented by the registered libass capability, the resolver must degrade to a registered treatment, route to explicit NLE handoff, or block with a reason.

### 2.3 Existing contract overlap and ownership

The following boundaries prevent duplicate implementation.

| Existing document/code | It already owns | This plan adds or consumes |
| --- | --- | --- |
| docs/design-caption-human-review-workflow.md and runtime/caption/review-core.ts | caption source/draft/review/approval layers, text/timing patch operations, queue, stale handling, human approval | stable identity lineage and a separate visual-treatment patch; do not duplicate the Review Core or put visual operations in timeline review_patch |
| docs/short-form-retention-planning.md and runtime/editorial/short-form-retention.ts | explicit social mode, narrative-mode guard, beat labels, payoff/open-loop concepts, social QA | truth/readability/accessibility/fatigue/policy gates and degradable stimulation; do not redefine arc YAML or force an arc when brief is silent |
| docs/improvement-plan-creator-short-20260820.md | creator-short arc/entry/skill-contract work, project STYLE.md separation, alpha/NLE handoff direction | vertical composition/profile/Studio/audio integration; consume its skill-contract and project-entry handoffs rather than create a second entry pipeline |
| .agents/skills/short-sound-design and runtime/audio/sound-design-solver.ts | request -> decision -> pinned cues -> A3 -> AudioRenderPlan, semantic selection, congestion/density checks, human audition | verified common-pack promotion and platform delivery profile references; do not create another cue solver |
| .agents/skills/render-video, runtime/render/route-resolver.ts, and final compositor | capability routing, FFmpeg assembly, libass speech captions, registered Remotion/HyperFrames layers, parity receipts | profile-driven route inputs and explicit external/NLE receipt; do not add a third renderer |
| Studio caption review surface | text, line-break, split/merge, timing, waveform, preview, undo, stale conflict | graphical treatment pane and safe-zone overlay after timing identity is stable |
| Studio clip transform patch | clip-level video change_visual_transform | not a caption visual patch; caption treatment must remain keyed by stable caption identity |

## 3. Responsibilities and artifact contracts

### 3.1 Blueprint references, not copied policy

edit_blueprint.yaml remains the authoring contract for editorial intent. The v2 schema may add references such as:

    composition_policy_ref
    retention_policy_ref
    caption_policy_ref
    platform_safe_zone_profile_ref
    audio_delivery_profile_ref
    sfx_library_ref

The blueprint carries intent, mode, evidence references, and policy/profile identifiers. It does not copy profile values into every scene. A scene may carry a scene-level override only when it includes a reason, source/profile version, and fallback. Current Hook/Body/Shot Anchor and lock semantics remain compatible with v1; v1 must not silently acquire a locked Hook.

The existing project-specific example in the previous plan is replaced by generic fixtures. A future project may keep names, colors, copy, and brand measurements in its project STYLE.md; generic skills and shared schemas must not contain them.

### 3.2 Timeline Offset Engine

The proposed implementation is runtime/compiler/timeline-offset-engine.ts. It is the first implementation milestone.

Inputs:

- source clip intervals and source word timestamps;
- final timeline clip placement from timeline.json;
- source-to-timeline map, speed changes, trims, gaps, and rational FPS;
- caption identity seed and source word references.

Output:

- an in-memory deterministic TimelineOffsetMap;
- caption draft timing and source references;
- a derived timing report for diagnostics, never a competing timeline;
- explicit fallback/confidence status when source evidence is missing or invalid.

The mapping is rational and frame-safe. For a source time u inside a clip with source start s, timeline start t, and speed r:

    timeline_time = t + (u - s) / r

Convert to output frames only at the final boundary using the pinned rational FPS and one rounding rule. Do not recompute source timing from rendered frames. A/V source clips must share the same source geometry and PTS policy; filter trim plus PTS reset remains the drift defense where applicable.

Required invariants:

- no caption starts before the projected source onset unless an explicit policy permits a review-visible lead;
- no caption survives beyond the projected speech/clip boundary without a review reason;
- source word refs and clip-map refs survive recompile;
- identical inputs and profile hashes produce identical output;
- low-confidence or fallback timing is visible in the review queue;
- a visual-treatment patch never changes timing.

### 3.3 Stable caption identity and lineage

Stable identity is generated from source and semantic lineage, not from the current output frame. The identity contract must include:

- caption_id;
- root_id and parent_ids when split or merge occurs;
- source transcript/word references;
- source asset and segment references;
- deterministic text/timing lineage hash;
- current draft/timeline/profile hashes.

Text/timing operations continue to use the existing caption review patch operations. A split produces deterministic child identities with lineage; a merge records all parents. A visual-treatment operation addresses one existing caption_id or an explicitly declared inherited group and cannot silently create a new caption. Approval binds the caption draft, timing patch, visual-treatment patch, timeline hash, and profile hashes.

### 3.4 Caption visual-treatment patch

Add a separate versioned artifact, proposed as caption-visual-treatment-patch/v1. It is derived from the stable caption draft and is not folded into timeline review_patch.

Minimum contract:

    version
    project_id
    base_caption_draft_hash
    base_timeline_hash
    base_profile_hashes
    operations[]
    session_id
    created_at
    author

Each operation contains:

    caption_id
    base_visual_treatment_hash
    position/anchor
    size/reference-scale
    style_ref
    hierarchy/emphasis
    animation_ref
    effect_ref
    accessibility overrides

Position and size use the delivery coordinate system and registered safe-area anchors. Arbitrary renderer-specific filter text is not accepted. A treatment that the selected renderer cannot represent must resolve to a registered fallback, explicit NLE handoff, or a blocker.

The patch is non-destructive:

- it does not mutate caption text, line breaks, source word refs, or timing;
- it can be regenerated or discarded without losing the caption draft;
- it is applied only after base hash and profile hash validation;
- undo restores the prior patch state and canonical preview receipt;
- stale conflict identifies the changed caption/profile/hash and never auto-merges an ambiguous visual edit.

### 3.5 Platform safe-zone profile

Add a versioned profile schema, proposed as platform-safe-zone-profile/v1, and store checked-in profile data under:

    delivery_profiles/platform-safe-zone/<platform>/<profile-version>.yaml

The schema contains:

- platform and delivery variant;
- profile ID and semantic version;
- source references, publication dates, measured-at date, and verification owner;
- viewport/output coordinate system and pixel-density assumptions;
- measured UI regions and safe regions, each with method, confidence, and unknown status;
- representative device/app-version metadata;
- screenshot fixture paths and hashes;
- profile supersession/deprecation state;
- fallback behavior when the profile is stale or incomplete.

The initial profile set should cover Instagram, TikTok, and YouTube Shorts only after current UI evidence is collected. A profile may include multiple device/app variants. The generic skill must never paste the measured values into prose or code. A value without source/date/version is not an accepted safe-zone value.

Safe-zone regression renders a fixture containing known anchors, captions, content elements, and a profile overlay, then checks geometry and produces representative screenshots. It must report unknown/stale regions rather than silently treating them as clear. The profile is advisory for platform chrome; a human platform preview remains a separate gate.

### 3.6 Typography and readability policy

The baseline caption style remains the existing caption style/font contract. Add a versioned typography policy/profile reference rather than a new font system.

The policy must specify, per delivery/profile variant:

- maximum line count;
- line-length measurement method, including Japanese full-width and mixed-script handling;
- break priorities, protected terms, punctuation, orphan rules, and manual override rules;
- reference font size and scale relationship to output dimensions;
- line height, tracking, outline/shadow/panel treatment, and contrast requirements;
- hierarchy for speech, keyword emphasis, annotation, speaker, and CTA;
- allowed emphasis/animation/effect presets and their fallback;
- reduced-motion, high-contrast, audio-off, and small-screen behavior;
- whether the caption mode is full transcript, keyword telop, or registered content element.

The machine line breaker and human set_line_break operation remain in the text/timing layer. The visual patch changes style/position/emphasis/animation only. A registered effect cannot be used to hide an overlong or unreadable caption. Generic documentation should describe the decision procedure; fixture values belong to a profile with evidence.

### 3.7 Retention and high-stimulation policy

The existing short-form mode remains explicit: off, standard, aggressive, or credibility_first. Improve the existing runtime/editorial/short-form-retention.ts and creator-short/build-blueprint contracts instead of adding a second narrative planner.

An aggressive opening is valid only when the brief and source support:

- a clear promise or question;
- a source-grounded claim or observable action;
- proportional evidence or a declared evidence gap;
- a payoff path that does not require a false spoiler;
- a readable, audible, and accessible first beat.

The policy measures events rather than imposing a universal cut count:

- hook onset and promise binding;
- source/evidence binding;
- semantic screen-change events;
- caption reading load and overlap;
- voice intelligibility and audio-event congestion;
- visual novelty and fatigue signals;
- rehook/payoff continuity;
- policy/accessibility violations;
- review confidence and degradation reason.

The policy must support a deterministic degradation chain, for example aggressive -> standard -> credibility_first -> off, with the actual allowed modes declared by the brief/profile. On a failed truth, evidence, readability, accessibility, or platform-policy gate, the stronger treatment is removed or reduced and the reason is recorded. No mode may invent a result, use clickbait unrelated to the content, or treat stimulation as a fixed numeric recipe.

Editing grammar:

- cut speech at semantic boundaries and preserve phonemes, word onset, conjunctions, and causal bridges;
- use the same source timing map for speech, captions, and any dialogue-linked visual event;
- place a zoom jump cut at an evidence-backed emphasis or semantic transition, not at an arbitrary interval;
- use meaningful reaction, action, registered reframe, evidence, or emphasis as visual refresh;
- reserve a pause or silence when it supports comprehension and the source intent;
- avoid adding an SFX to every cut; silence is an allowed state;
- measure tempo as a beat/event envelope, not a global average;
- keep the best payoff and any vulnerability/CTA proportionate to the source and brief.

### 3.8 Generic 9:16 composition and zoom policy

Create a generic skill named .agents/skills/vertical-social-composition/SKILL.md. It owns method and inspection order for 9:16 delivery:

- define output coordinate space and safe-zone profile reference;
- measure person occupancy, headroom, look-room, hands, microphone, and important evidence;
- select a registered layout anchor and reframe policy;
- distinguish a continuous transform from a discrete jump cut;
- preserve source A/V geometry and clip identity;
- specify a zoom intent such as emphasis, reaction, evidence, or reset;
- test the first, representative, and last frames;
- degrade to a safer crop/scale or hold for human review when face/hand/look-room or text safety fails.

The skill must not contain a project name, person name, brand color, copy, or one-project zoom value. It must reference only actual repository commands and artifacts, including edit_blueprint.yaml, timeline.json, the render route, the preview/review artifacts, and the existing visual-transform/reframe contracts. If a new command is needed later, it must be implemented and registered before the skill can reference it.

Existing clip-level visual-transform and InterviewAutoReframe behavior is reused. The new policy generalizes it to 9:16; it does not turn every talking head into a forced punch-in sequence. A jump cut is a registered intent with source evidence, start/end transform, safe-zone check, and QA result.

### 3.9 SFX common pack and runtime wiring

The existing semantic-first order remains authoritative:

    sound-design-request/v1
      -> sound-design-decision/v1
      -> pinned sfx-cues/v1
      -> A3 projection in timeline.json
      -> audio-render-plan/v1
      -> audio-mix-report

Promote the SFX used by the Narunaru work into a repo-common pack only when each asset has:

- rights status, license/evidence, usage scope, and verification date;
- provenance origin/source reference and acquisition record;
- content hash, byte size, duration, sample rate, channel layout, and decode result;
- stable asset ID and common-pack version;
- removal/supersession policy.

The source project remains untouched. Promotion is a future implementation task with an explicit rights decision hold; this planning change does not copy media.

Selection, timing, gain, fades, tail, ducking, and anti-overuse use the existing sfx-cues.ts and sound-design-solver.ts contracts. Semantic role and evidence are prerequisites; congestion/density rejection happens before snapping; cue timing never moves picture, dialogue, or caption timing. The allowed density/spacing/gain constraints are policy/profile data and decision evidence, not fixed generic skill prose. Human audition remains required for timbre and feel.

### 3.10 Platform audio delivery profile

Add a versioned audio delivery profile, proposed as audio-delivery-profile/v1, under:

    delivery_profiles/audio/<platform>/<profile-version>.yaml

It must describe:

- platform/variant, source/date/version, verification owner, and supersession;
- dialogue processing stages and optionality;
- measurement method for integrated/short-term loudness, loudness range, voice intelligibility, and true peak;
- target/range or acceptance policy with provenance, not a universal hard-coded target;
- codec/encode preview, sample-rate/channel assumptions, and true-peak margin policy;
- stereo, downmix-to-mono, and mobile-speaker fixture procedure;
- platform normalization assumption: not applied, simulated, observed, or unknown;
- degradation behavior when a target is unavailable or evidence is stale.

The runtime continues to own one final mastering stage. A1 dialogue, A2 BGM, and A3 SFX remain separate until the shared AudioRenderPlan joins them. Each platform preview measures the encoded result again. Current code defaults such as historical LUFS or true-peak values are migration inputs, not universal claims; they must be represented as a named, sourced profile or explicitly marked legacy.

## 4. Renderer ownership and canonical preview

### 4.1 Ownership matrix

| Layer | Owner | Required rule |
| --- | --- | --- |
| Speech caption text/timing/approval | Caption runtime, Review Core, and Studio | resolve the approved caption artifact and visual-treatment patch; Studio is authoring/review, not the renderer |
| Speech caption burn/render | FFmpeg/libass | use bundled font contract and canonical ASS generation; no Remotion ownership of full speech captions |
| Registered content element | Remotion or HyperFrames | use template registry, declared capability, layer mode, and render receipt |
| Native assembly/audio mux | FFmpeg route already used by Video OS | preserve rational FPS, source map, A/V identity, and one final encode boundary |
| Caption review and visual authoring | Studio plus shared Review Core | Studio is not a new renderer and is not the canonical artifact |
| Supplied external alpha/NLE material | explicit external/NLE handoff | carry route receipt, codec/geometry metadata, hashes, and human approval |

### 4.2 Preview and export

The baseline canonical preview path owned by RFA-007 compiles the resolved timeline, caption draft, content elements, SFX/audio plan, and profile hashes that export will use. RFA-020 is the additional owner that resolves caption visual treatment into the same preview/render input path and closes final visual parity; it does not replace RFA-007's baseline preview ownership. Preview may use a faster encoding or shorter review range, but it must not change frame geometry, caption timing, ownership, or profile interpretation.

The route resolver must return:

- selected assembly engine;
- caption layer engine;
- content renderer ownership;
- profile IDs and hashes;
- external/NLE status if applicable;
- degradation and unsupported-capability reasons;
- canonical input/timeline/caption/audio hashes.

The existing FFmpeg/libass route is the speech-caption owner. Remotion/HyperFrames are selected only for registered content elements requiring them. A DAY1-style alpha overlay is supplied material or an explicit future registered layer; it is not evidence that the canonical route already supports every ASS animation.

## 5. Studio UX contract

### 5.1 Sequencing

Studio work has two gates:

1. Timing gate: Offset Engine output, stable caption identities, text/line/split/merge/timing review, waveform loop, and canonical preview parity.
2. Visual gate: per-caption position/size/style/emphasis/animation patch, safe-zone overlay, and parity after the timing gate passes.

The visual gate cannot become a workaround for timing uncertainty. The user can still open the visual pane for inspection, but apply is blocked or marked degraded when the caption identity/timing/profile base is stale.

### 5.2 Visual treatment surface

The Studio caption workspace adds:

- video plus waveform loop with independent timing and visual-treatment modes;
- profile selector showing platform, version, source date, and stale/unknown state;
- safe-zone overlay with legend and profile hash;
- queue filters for unreviewed, flagged, stale, profile-risk, and visual-treatment risk;
- per-caption inspector for registered position anchors, size/reference scale, style token, hierarchy/emphasis, animation/effect preset, and accessibility fallback;
- drag and resize constrained by the selected safe-zone and typography policy;
- presets that resolve to registered style/treatment IDs, with a before/after preview;
- explicit separation between timing handles and visual controls;
- canonical preview freshness indicator and route/renderer receipt;
- undo/redo through the visual patch history, base hash, and result hash;
- stale-conflict screen that names the changed caption/profile/timeline and requires deliberate rebase or discard;
- reduced-motion and audio-off preview modes.

The viewer must use the same resolved caption style and renderer capability contract as canonical preview. The existing fixed-size viewer overlay is a diagnostic fallback only; it cannot be accepted as parity evidence.

### 5.3 DAY1 human adjustment

For DAY1-like graphical captions, Studio first adjusts the stable caption timing through the existing caption workflow. After timing approval, the user adjusts visual treatment as a separate patch. The final preview/export route then either:

- compiles supported speech treatment through FFmpeg/libass;
- renders a registered content layer through Remotion/HyperFrames; or
- records an explicit NLE handoff when the supplied ASS/alpha behavior is outside the canonical capability.

Studio must not silently import an external ASS file as canonical truth or claim that its preview is the same as an external manual composite without a route receipt.

## 6. Roadmap and dependency gates

### Phase 0 — contract baseline

Inventory current schemas, route ownership, skill invocations, existing dirty/untracked boundaries, and golden fixtures. Freeze the no-duplicate-truth rules and the DAY1 external-route evidence.

Exit: RFA-001/RFA-002 inputs are agreed; no project-specific value is promoted into a generic skill; existing caption/audio/SFX contracts remain green.

### Phase 1 — Timeline Offset Engine and caption identity

Implement the Offset Engine before graphical Studio work. Integrate source word refs, speed/gap mapping, rational FPS rounding, fallback confidence, and stable identity lineage into caption draft/review artifacts.

Exit: RFA-005/RFA-006 tests pass across source/timeline transforms; timing errors are review-visible; visual patch is not yet required.

### Phase 2 — Hook lock, canonical preview, and existing framing

Complete existing Hook/Body/Shot Anchor and lock behavior, then align preview with canonical route. Keep reframe/jump-cut implementation after timing identity is stable and execute the dependency chain RFA-008 -> RFA-009 -> RFA-010; policy/schema work may proceed in parallel.

Exit: RFA-003/RFA-004 and the RFA-008 -> RFA-009 -> RFA-010 framing chain have explicit tests; RFA-007 has the baseline canonical preview receipt. RFA-020 later adds visual-treatment input and closes final visual parity without replacing the baseline owner. Preview does not become a new source of truth.

### Phase 3 — Generic vertical policy, safe zones, retention, and typography

Add RFA-017 through RFA-019 and the typography/approval portion of RFA-020. The framing chain remains RFA-008 -> RFA-009 -> RFA-010. Create profile fixtures with source/date/version metadata, source-grounded high-stimulation degradation, and composition/readability QA. Update existing skills only after their CLI/artifact references are real.

Exit: profile schema validation, safe-zone regression, accessibility/degradation tests, caption approval plus visual-treatment input resolution, and generic skill-contract checks are available; RFA-020 can augment the RFA-007 baseline input and own final visual parity.

### Phase 4 — Caption visual treatment and Studio

Implement RFA-020 then RFA-021. Start from the stable caption identity and timing approval. Keep visual patch and text/timing patch independent, with safe-zone and typography validation.

Exit: Studio loop/overlay/drag/resize/preset/undo/stale/parity contract passes; canonical preview can reproduce the Studio-resolved artifact.

### Phase 5 — Audio delivery and verified SFX

Implement RFA-011 -> RFA-012 -> RFA-023 -> rights confirmation -> RFA-022. Reuse A1/A2/A3 and semantic-first solver contracts. Promote the common pack only after the rights decision hold is cleared.

Exit: platform audio profiles and encoded/mono/mobile evidence exist; every adopted SFX has a manifest/hash/provenance pin; mastering remains single.

### Phase 6 — Export and external/NLE bridge

Complete RFA-013/RFA-014 and RFA-024. Export Premiere XML/alpha material only from a canonical or explicitly supplied route. DAY1 external material is tested as a receipt/hand-off fixture, not used to justify a new renderer.

Exit: preview/export/NLE route receipts distinguish canonical, supplied-final, and external manual paths; parity and source identity are recorded.

### Phase 7 — private pilot

RFA-016 runs a small private pilot with four separate gates:

1. Agent QA: deterministic schema, timing, caption, safe-zone, audio, SFX, route, and accessibility checks.
2. Human visual/audio approval: Studio visual review, mute readability, speaker/mobile/mono audition, and artistic accept/reject.
3. NLE handoff: supplied assets, ASS/alpha or XML, hashes, codec/geometry, and handoff confirmation.
4. Platform preview: current app/UI fixture, safe-zone overlay, platform delivery profile, and human final preview.

No gate implies the others. Public promotion/upload remains outside this plan and requires its own approval.

## 7. Task breakdown

The IDs below are the implementation units. Owned files are the intended change surface; a task may add a file when the contract does not yet exist. Every task must preserve unrelated dirty/untracked work and stage only its own files.

| ID | Task | Dependencies | Owned files | Done |
| --- | --- | --- | --- | --- |
| RFA-001 | Blueprint v2 schema and policy/profile references | none | schemas/edit-blueprint.schema.json; schemas/tests; fixture edit_blueprint.yaml | v1 compatibility, explicit Hook/Body/Shot Anchor, references validate, no copied project brand values |
| RFA-002 | Blueprint runtime types and sanitizers | RFA-001 | runtime/types; runtime/blueprint sanitizers; tests | invalid modes/references fail clearly, optional model fields remain fail-open, source/profile hashes survive normalization |
| RFA-003 | Shot Anchor resolver | RFA-001,RFA-002 | runtime/compiler/shot-anchor-resolver; runtime/compiler tests | source-grounded anchor resolves with evidence and deterministic fingerprint; missing anchor is explicit |
| RFA-004 | Hook lock and approval semantics | RFA-003 | runtime/compiler/hook-lock; schemas/approval; tests | lock is explicit, fingerprinted, reviewable, and never inferred for v1 |
| RFA-005 | Timeline Offset Engine | RFA-001,RFA-002 | runtime/compiler/timeline-offset-engine.ts; runtime/compiler timeline tests | rational mapping handles speed, trim, gap, J/L, clip crossing, FPS rounding, and fallback without changing timeline truth |
| RFA-006 | Caption draft integration and stable identity | RFA-005 | runtime/commands/caption.ts; runtime/caption/word-remap.ts; runtime/caption/segmenter.ts; runtime/caption/editorial.ts; runtime/caption/review-core.ts; runtime/caption/review-service.ts; schemas/caption artifacts; tests | A1 dialogue is the caption timing authority for J/L cuts and captions use the same Offset Map; source refs, confidence, root/split/merge lineage, stable IDs, stale migration, and projected timing are deterministic |
| RFA-007 | Baseline canonical fast preview and receipt | RFA-006 | runtime/preview; scripts/preview-segment.ts; runtime/render route receipt; tests | baseline preview resolves the canonical timeline/caption draft/content/audio inputs, reports hashes/route, and never claims final approval; RFA-020 is the additional owner for visual-treatment input and final parity |
| RFA-008 | Generic framing/reframe policy | RFA-001,RFA-002 | runtime/visual/framing-policy; existing Studio framing contract; tests | person/head/hand/look-room/headroom checks and safe degrade are artifact-driven |
| RFA-009 | Vision-assisted reframe adapter | RFA-008 | runtime/visual/reframe; local model adapter; tests | optional vision is fail-open, candidate evidence is pinned, and manual fallback is explicit |
| RFA-010 | Registered jump-cut/climax policy | RFA-008,RFA-009 | runtime/visual/jump-cut-policy; blueprint/timeline projection; tests | continuous transform versus discrete cut is explicit, source A/V is preserved, and no arbitrary interval rule is introduced |
| RFA-011 | Scene audio policy projection | RFA-001,RFA-002 | runtime/audio/render-plan.ts; compiler audio projection; schemas/tests | A1/A2/A3, dialogue-first, BGM conflict, SFX permission, and single-mastering semantics are validated |
| RFA-012 | Audio QA and delivery measurements | RFA-011 | runtime/audio/mastering.ts; runtime/audio/dialogue-finishing.ts; audio reports; tests | encoded result has measured loudness/true peak/format/A/V evidence and human audition fields |
| RFA-013 | Canonical export and Premiere handoff | RFA-007,RFA-011,RFA-012,RFA-020 | scripts/export-premiere-xml.ts; export schemas; tests | XML/export identity matches the approved caption and visual-treatment inputs, and reports unsupported effects instead of silently dropping them |
| RFA-014 | Alpha overlay/export receipt | RFA-007,RFA-013,RFA-020 | alpha route receipt; tests | alpha geometry/codec/fps/hash are explicit, existing final compositor visual treatment is represented, and supplied external alpha is not mislabeled as canonical |
| RFA-015 | Skill contract and generic-skill migration | RFA-001,RFA-005,RFA-006,RFA-017,RFA-018,RFA-019,RFA-020,RFA-022,RFA-023 | .agents/skills/finish-creator-short; .agents/skills/build-blueprint; .agents/skills/render-video; .agents/skills/evaluate-edit; .agents/skills/short-sound-design; .agents/skills/vertical-social-composition/SKILL.md; .agents/skills/vertical-social-platform-delivery/SKILL.md; runtime/skill-contracts/verify.ts only when contract changes | all executable references resolve to real CLI/artifacts; npm run verify:skill-contracts passes; generic skills contain no project-specific values |
| RFA-016 | Phase 7 private pilot gate separation | RFA-007,RFA-010,RFA-012,RFA-013,RFA-014,RFA-015,RFA-020,RFA-021,RFA-022,RFA-023,RFA-024 | pilot manifest/receipts; tests/fixtures; no external project edits | agent QA, human visual/audio approval, NLE handoff, and platform preview are four separate evidence records |
| RFA-017 | 9:16 vertical composition skill and policy | RFA-001,RFA-002 | .agents/skills/vertical-social-composition/SKILL.md; schemas/vertical-composition-policy.schema.json; runtime/visual/vertical-composition.ts; tests | composition, person size, layout, safe anchors, zoom intent, jump-cut/degrade method is generic and executable |
| RFA-018 | Platform safe-zone profile and theory skill | RFA-001,RFA-002 | .agents/skills/vertical-social-platform-delivery/SKILL.md; schemas/platform-safe-zone-profile.schema.json; delivery_profiles/platform-safe-zone; fixtures/platform-preview; tests | platform profiles carry source/date/version/device screenshots/hashes; safe-zone regression detects stale/unknown regions |
| RFA-019 | Truth-bound retention and stimulation policy | RFA-005,RFA-006 | runtime/editorial/short-form-retention.ts; runtime/editorial/social-retention-qa.ts; runtime/compiler/trim.ts; runtime/compiler/dialogue-semantic-repair.ts; existing runtime/editorial cadence path; schemas/retention-policy; .agents/skills/finish-creator-short and build-blueprint; tests | reuses or minimally repairs trim, dialogue-semantic-repair, and cadence paths; cuts do not break phonemes, conjunctions, or causal bridges; A1 and captions reference the same Offset Map; tempo is verified as a beat/event envelope; hook promise/evidence/readability/fatigue/accessibility/policy are measured; aggressive treatment degrades safely and never invents claims |
| RFA-020 | Typography contract and caption visual-treatment patch | RFA-005,RFA-006,RFA-018,RFA-019 | schemas/caption-approval.schema.json; schemas/caption-visual-treatment-patch.schema.json; runtime/caption/visual-treatment.ts; runtime/caption/caption-finalize.ts; runtime/caption/review-core.ts; consumes runtime/caption/review-service.ts; runtime/render/canonical-render-input.ts; runtime/render/final-visual-compositor.ts; editor/shared/caption-style-tokens.ts; tests | additional owner for visual-treatment input and final parity after RFA-007 baseline preview; caption approval/review service and preview/render input resolver carry the approved caption plus visual treatment; existing final compositor applies the visual treatment through its capability path; visual patch is keyed by stable identity, non-destructive, renderer-capability checked, and independent of timing/text patch |
| RFA-021 | Studio graphical caption treatment | RFA-007,RFA-018,RFA-020 | apps/macos-studio/Sources/VideoOSStudio/CaptionFinishingView.swift; apps/macos-studio/Sources/VideoOSStudioCore/CaptionReviewSession.swift; apps/macos-studio/Sources/VideoOSStudioCore/CaptionReviewDocument.swift; apps/macos-studio/Sources/VideoOSStudio/ViewerViews.swift; consumes schemas/caption-approval.schema.json, runtime/caption/review-service.ts, and runtime/render/canonical-render-input.ts; editor/tests and contract fixture | video/waveform loop, separate timing/visual modes, safe overlay, drag/resize, presets, undo/stale conflict, caption approval wiring, and canonical parity work without a new renderer |
| RFA-022 | Common SFX pack promotion and runtime wiring | RFA-011,RFA-012,RFA-023 | existing sfx-library/v1 manifest root; runtime/audio/sfx-cues.ts; runtime/audio/sound-design-solver.ts; .agents/skills/short-sound-design; tests | after audio-profile and rights confirmation, rights/provenance/hash/scope gate is complete; cues use semantic selection, sync, gain, tails, and anti-overuse decisions |
| RFA-023 | Platform audio delivery profiles | RFA-011,RFA-012,RFA-018 | schemas/audio-delivery-profile.schema.json; delivery_profiles/audio; runtime/audio/dialogue-finishing.ts; runtime/audio/mastering.ts; runtime/audio/render-plan.ts; tests | source/date/versioned profiles cover voice intelligibility, loudness, true peak, codec, mono/mobile, and normalization assumptions |
| RFA-024 | DAY1 external route and NLE handoff receipt | RFA-007,RFA-013,RFA-014,RFA-020 | runtime/render/route-resolver.ts; schemas/render-route-receipt.schema.json; scripts/render-route.ts; tests/fixtures external-route metadata | ASS/libass external evidence, caption approval versus burn/render ownership, alpha codec/geometry, canonical versus external ownership, and unsupported animation behavior are explicit |

RFA-017 through RFA-024 do not authorize changing the external Narunaru repository. RFA-022's media promotion remains blocked until the rights/provenance decision is recorded. RFA-015 is a consumer and, only where necessary, a small extension of the existing skill-contract verifier; it must not fork the existing improvement-plan creator-short entry pipeline.

## 8. Schema, API, and artifact summary

| Contract | Canonical owner | Mutable by | Derived consumers |
| --- | --- | --- | --- |
| creative_brief.yaml | brief/design-intent | brief author | blueprint planner |
| edit_blueprint.yaml | editorial/compiler | blueprint workflow | timeline compiler, policy resolvers |
| timeline.json | timeline compiler | approved timeline/re-edit patch | preview, render, audio projection, export |
| caption_source.json | transcript/source map | source ingest | caption draft |
| caption_draft.json | Offset Engine/caption compiler | deterministic regeneration | Review Core, Studio, renderer |
| caption_review_patch.json | Review Core/human | text/timing review only | caption draft projection and approval |
| caption_visual_treatment_patch.json | Review Core/Studio | visual treatment review only | resolved caption render input |
| caption_approval.json | human approval | human gate | final render/package |
| platform-safe-zone-profile/v1 | profile registry | profile maintainer | Studio overlay, layout QA, render receipt |
| audio-delivery-profile/v1 | profile registry | profile maintainer | audio plan, measurement, platform preview |
| sfx-library/v1 | shared asset registry | rights-cleared asset maintainer | sound-design request/solver |
| sound-design-decision/v1 | semantic solver | solver/re-run | pinned sfx-cues |
| sfx-cues/v1 | sound-design workflow | decision-pinned workflow | timeline A3 projection |
| audio-render-plan/v1 | audio resolver | compiler | preview/export/mix report |
| render-route receipt | route resolver | render/export | parity, NLE handoff, pilot gates |

Proposed API boundaries:

- resolveTimelineOffset(sourceMap, timeline, fps) returns a deterministic offset map and confidence/fallback report.
- buildCaptionDraft(offsetMap, captionSource) returns stable identities, source refs, projected timing, and draft hash.
- applyCaptionReviewPatch(draft, patch) remains the existing text/timing path.
- applyCaptionVisualTreatmentPatch(draft, visualPatch, profiles, rendererCapabilities) returns a resolved visual layer without changing timing/text.
- resolveVerticalComposition(blueprint, timeline, safeZoneProfile) returns registered transform/jump-cut intents and QA findings.
- resolveAudioDeliveryPlan(timeline, audioProfile, sfxCues) returns the existing shared AudioRenderPlan with profile hashes and measurement requirements.
- resolveRenderRoute(resolvedInputs) returns renderer/caption ownership, route status, and canonical hashes.

These APIs are contracts for future implementation. They do not authorize a new parallel implementation before the existing owner is checked.

## 9. Test and verification matrix

| Area | Test | Acceptance |
| --- | --- | --- |
| Schema | edit blueprint, caption draft/review/approval, visual patch, profile, SFX, audio, route receipt schema tests | invalid refs, stale hashes, unsupported fields, missing source/version, and duplicate ownership fail closed |
| Offset | deterministic unit/property fixtures with trims, speed, gaps, clip crossings, rational/non-integer FPS, long source ranges, and missing words | same input/hash gives same frames; no drift; fallback/confidence is visible; timeline.json is unchanged |
| Caption identity | split, merge, text correction, timing correction, recompile, visual-only patch | lineage is deterministic; visual patch cannot move timing; stale base is rejected |
| Typography | Japanese/mixed-script wrapping, protected terms, punctuation, orphan checks, line count, reference scaling, contrast, reduced motion | policy/profile values are applied; no universal hidden constant; mute and small-screen review is possible |
| Safe zone | render anchor fixture for each profile/device variant; screenshot hash and profile revision checks | no unreported overlap; stale/unknown profile is visible; profile update changes fixture receipt |
| Composition | face/head/hand/look-room/headroom representative frames; wide/punch/hold and jump-cut transitions | registered intent, safe crop, source A/V identity, and degrade reason are present |
| Retention | truth/evidence binding, no spoiler beyond evidence, readability/fatigue, visual refresh event audit, accessibility and platform-policy failure fixtures | aggressive -> safer mode degradation is deterministic and recorded; clickbait/fabricated claim is rejected |
| Audio cutting/sync | speech cuts at word/semantic boundaries; caption/voice/visual/SFX cue timeline comparison | no phoneme/causal bridge damage; cue snapping stays inside its declared semantic window; no picture timing mutation |
| SFX | manifest rights/provenance/hash, decode, semantic candidate, congestion/density, gain/fade/tail/ducking, silence gap | adopted cue has exactly one matching decision and asset pin; overuse is rejected or degraded |
| Audio delivery | profile-driven processing, encoded loudness/true peak, speech intelligibility review, stereo/downmix, mobile speaker fixture | measurements are attached to profile/version; normalization assumption is explicit; final mastering runs once |
| Renderer | route capability, libass speech caption, registered Remotion/HyperFrames element, unsupported animation, one final composite | renderer receipt matches ownership; no unregistered or duplicate speech caption renderer |
| DAY1 bridge | ASS style/override/\t fixture metadata, alpha 1080x1920/30fps ProRes yuva444p12le metadata, external route | external/manual and canonical routes are distinguishable; unsupported effects become handoff/blocker |
| Studio | timing loop, waveform, separate visual mode, safe overlay, drag/resize, preset, undo, stale conflict, preview parity | UI actions produce the correct patch/hash; canonical preview reproduces it |
| Skill contract | npm run verify:skill-contracts; npm run validate:all-local; any changed skill fixture | every command/flag/artifact is real and verified; generic skill contains no project-specific values |
| Repository | npm run verify:repo; git diff --check; status/diff scope checks | no source media/generated output/unrelated dirty or untracked item is changed or staged |
| Pilot | agent QA, human visual/audio approval, NLE handoff, platform preview separately | each gate has its own receipt and decision; no gate is inferred from another |

For policy/profile fixtures, numeric values are fixture inputs with source/date/version metadata. They are not promoted to generic product rules merely because a test passes.

## 10. Risks, decision holds, and degradation

| Risk/hold | Decision rule |
| --- | --- |
| Platform UI chrome changes | do not update a hidden constant; add a new profile revision, source/date/device screenshot/hash, run safe-zone regression, and mark old profile superseded |
| Platform loudness/normalization is opaque | report the local encoded measurement and the normalization assumption separately; do not claim platform playback equivalence |
| ASS/libass cannot express a requested graphical effect | use a registered supported treatment, explicit NLE handoff, or blocker; never add an implicit renderer |
| Stable identity after split/merge is ambiguous | keep parent lineage and reject a visual patch until the identity migration is explicit |
| Caption readability conflicts with safe zone or visual emphasis | prioritize source truth, readable text, accessibility, and platform-safe placement; degrade effect/size/position and record the reason |
| High-stimulation hook lacks proportional evidence | degrade to a source-grounded hook or credibility-first/off; do not create a teaser that promises an unsupported result |
| N=1 observation or provisional reference number is mistaken for a formula | retain it as evidence/fixture metadata only; calibrate with pilot data before changing a profile |
| SFX rights or provenance cannot be proved | do not promote or adopt the asset; keep the cue unresolved or use silence |
| SFX congestion or fatigue is high | reject/degrade the cue through the existing solver; never shift dialogue/caption/picture timing to fit it |
| Optional local model/cache is unavailable | retain deterministic/manual fallback and expose degraded confidence; do not make the model mandatory |
| Studio preview and canonical render diverge | invalidate freshness, show the route/profile/hash mismatch, and block approval until parity is restored |
| External DAY1 handoff is mistaken for Video OS output | require explicit external route receipt with codec, geometry, fps, hash, and human handoff status |
| Generic skill gains an invented command or artifact | fail npm run verify:skill-contracts and remove the reference until a real producer/CLI exists |

Decision holds that require an explicit owner before implementation:

1. Approve the profile-maintainer/source policy for platform UI screenshots and audio measurement evidence.
2. Decide whether the rights evidence for each Narunaru SFX permits repo-common promotion and what repository storage scope is allowed.
3. Approve the initial renderer capability list for ASS/libass animation and the exact external/NLE fallback receipt.
4. Approve accessibility policy defaults for reduced motion, high contrast, audio-off, and small-screen readability.
5. Approve the pilot reviewer roles and the evidence retention location for device screenshots/audio audition notes.

## 11. Implementation start order

The first coding session starts with:

1. Read-only repository/status preflight and fixture inventory; preserve existing untracked .DS_Store, reports/eval suites, and scratch content.
2. RFA-001 and RFA-002 contract/reference groundwork.
3. RFA-005 Timeline Offset Engine.
4. RFA-006 caption integration and stable identity.
5. RFA-003/RFA-004 Hook/Shot Anchor lock and RFA-007 baseline canonical preview.
6. RFA-017/RFA-018/RFA-019 policy/profile work, with no Studio graphical implementation yet.
7. RFA-008/RFA-009/RFA-010 framing/reframe/jump-cut implementation.
8. RFA-020 caption typography, visual-treatment input, and final parity for the RFA-007 baseline.
9. RFA-021 Studio graphical treatment.
10. RFA-011/RFA-012 and RFA-023 audio delivery; then RFA-022 only after the SFX rights hold.
11. RFA-013/RFA-014/RFA-024 export, alpha, and external/NLE receipts.
12. RFA-015 skill-contract verification and generic-skill cleanup.
13. RFA-016 separated private pilot.

At every milestone, run the narrow contract tests first, then the documented repository verification commands. A milestone is not complete because a preview looks plausible; it needs the canonical artifact/hash/route evidence described above.

## 12. This planning change

This update is intentionally limited to docs/specs/video-os-v2-refinement-plan.md. It does not implement RFA tasks, alter code, alter other docs, copy SFX, touch the external Narunaru repository, stage user-owned untracked files, push, or invoke PCL.
