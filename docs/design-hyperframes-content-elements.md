# HyperFrames Content Elements implementation plan

Status: reviewed and approved for Phase 0 implementation

Date: 2026-07-16

Review: Cockpit Claude task `f9b05541` (review only). The revised plan includes
its three blocking findings: contained asset references, single-renderer
ownership, and atomic TypeScript/Schema/Swift patch-contract rollout.

## 1. Objective

Extend Video OS Studio from media-clip editing and speech-caption finishing into
a renderer-neutral content composition system. The first product proof must let
an operator edit and render these elements without hand-editing `timeline.json`:

- interview section label;
- interviewer question card;
- lower third;
- logo bug;
- one restrained section-boundary effect.

HyperFrames is the first new rendering adapter. It must not become a second
timeline, project format, or artifact authority.

## 2. Current-state findings

The repository already has more of this stack than the original proposal
assumed:

- `timeline.json` is canonical and already permits `overlay` and `caption`
  tracks in its JSON Schema.
- Authored text overlays are projected onto synthetic `__overlay__` clips.
- `editor/shared/render-spec.ts` projects overlay tracks, but only as flat text
  cues. The FFmpeg assembler and exact-preview service do not currently consume
  those cues, so overlay parity is already broken between Remotion and the
  FFmpeg/exact-preview paths.
- The Remotion assembly engine already renders five overlay presets and five
  basic transition types.
- Studio can display overlay tracks but has no general content-element
  inspector or patch operation for their payload.
- The root package already depends on Remotion. HyperFrames must therefore be
  justified by deterministic HTML authoring, agent-friendly templates, shader
  effects, and Apache-2.0 portability rather than by duplicating basic fades.

The published HyperFrames package checked on 2026-07-16 is `0.7.60`, requires
Node 22 or newer, and is Apache-2.0. The repository requires Node 22.x. The full
`hyperframes` CLI has a substantially larger dependency surface than
`@hyperframes/core`, `@hyperframes/engine`, and
`@hyperframes/shader-transitions`, so the implementation must measure install,
browser, and render costs before making the CLI a required production
dependency.

## 3. Architecture decision

```text
creative brief / agent / operator
               |
               v
     timeline.json overlay tracks
       + content_element/v1 data
               |
               v
       Content Template Registry
               |
               v
           RenderSpec vNext
          /       |        \
     FFmpeg   Remotion   HyperFrames
       |          |           |
       +----------+-----------+
                  |
          preview / final QA
```

### 3.1 Authority boundary

`timeline.json` remains the only timeline authority. HTML, React components,
HyperFrames compositions, transparent WebM intermediates, shader programs, and
Studio preview state are derived artifacts or renderer implementations.

The canonical payload is renderer-neutral `content_element/v1`; it does not
store arbitrary HTML or JSX.

### 3.2 Captions remain separate

Speech captions remain on `caption` tracks and retain transcript bindings,
review state, SRT/VTT projection, and accessibility semantics. Section labels,
question cards, titles, logos, charts, and decorative motion live on `overlay`
tracks as content elements.

### 3.3 Hybrid rendering

- FFmpeg remains responsible for source cuts, dialogue MA, ordinary fades,
  color filters, audio mixing, final muxing, and fallback rendering.
- Remotion remains a supported assembly engine during migration.
- HyperFrames initially renders graphic overlays and approved shader effects.
  It may render a transparent intermediate for FFmpeg compositing or a complete
  assembly after parity and performance evidence justify that path.
- Unknown templates and unavailable HyperFrames tooling fail closed for final
  render, while ordinary projects without HyperFrames content remain usable.
- Renderer ownership is resolved once per content element during
  normalization. Exactly one renderer draws an element. Remotion, FFmpeg, and
  HyperFrames adapters must skip elements owned by another adapter so a
  HyperFrames intermediate cannot duplicate a Remotion overlay.

## 4. Canonical contract

Add an optional `content_element` property to overlay clips. Existing
`metadata.overlay` payloads remain readable and are normalized into the new
contract at the renderer boundary.

```ts
type ContentElementV1 = {
  version: "content-element/v1";
  element_id: string;
  kind:
    | "text"
    | "image"
    | "shape"
    | "svg"
    | "template"
    | "group";
  template_ref?: string;
  template_version?: string;
  props: Record<string, JSONValue>;
  layout: {
    anchor: Anchor;
    x: number; // normalized 0..1 offset from anchor
    y: number; // normalized 0..1 offset from anchor
    width?: number; // normalized 0..1
    height?: number; // normalized 0..1
    scale: number;
    rotation_deg: number;
    opacity: number;
    safe_area: boolean;
    z_index: number;
  };
  animation?: {
    in?: AnimationRef;
    loop?: AnimationRef;
    out?: AnimationRef;
  };
  renderer_hint?: "auto" | "ffmpeg" | "remotion" | "hyperframes";
};
```

Frame range remains owned by the containing timeline clip. The element does not
duplicate `timeline_in_frame` or `timeline_duration_frames`.

`props` must not contain an absolute path, `file:` URL, parent traversal, or an
unregistered relative file reference. Project media is referenced only through
an `asset_id` resolved by the existing source-map containment path. Assets
shipped with a template use an allow-listed registry-relative reference whose
resolved real path must remain inside that template package.

Content elements continue the existing authored-overlay synthetic clip
convention:

- `asset_id: "__overlay__"` when no project media asset is required;
- `segment_id: "TXT_<element_id>"`;
- `role: "title"` for v1 compatibility;
- `src_in_us: 0` and `src_out_us` derived from the clip duration;
- a real source-map `asset_id` remains on the clip when the template displays a
  project image or video asset.

The timeline validator must distinguish synthetic registered content from real
media without exempting nested props from path containment.

## 5. Template registry

Introduce a versioned registry under `runtime/content/templates/`. Each
template declares:

- stable id and semantic role;
- JSON props schema;
- supported aspect ratios;
- safe-area defaults;
- preferred and fallback renderers;
- preview capability;
- required local assets and font policy;
- deterministic animation presets;
- accessibility label derivation;
- maximum text and layout constraints.

Initial templates:

1. `vos:content.section-label/v1`
2. `vos:content.question-card/v1`
3. `vos:content.lower-third/v1`
4. `vos:content.logo-bug/v1`

Templates are allow-listed. Agent-authored arbitrary HTML is not accepted by
the first production path.

### 5.1 Bundled font contract

Authored artifacts use `font_id`, not a system font name, file path, or remote
Google Fonts URL. The initial registry entry is `noto-sans-jp`, backed by the
Google Fonts Noto Sans JP variable TTF and its SIL OFL 1.1 license. The pinned
binary is shared by HyperFrames, Remotion, FFmpeg/libass, FFmpeg drawtext, and
the Studio app bundle.

- runtime rendering performs no font network requests;
- the binary SHA-256 is part of the registry contract;
- browser renderers stage the font into their contained local project;
- browser renderers derive a sorted Unicode set from the strings they actually
  display, add a small printable-ASCII baseline for CSS-generated labels, and
  stage a per-composition WOFF2 subset when local FontTools is available;
- the subset cache key binds the subset contract version, canonical source-font
  hash, font id, and code points; a hash-verified sidecar prevents reuse of a
  truncated or stale cache entry;
- `pyftsubset` is an optional local accelerator. If it is absent or fails, the
  renderer uses the verified full TTF without changing text or contacting the
  network;
- Remotion blocks frame capture until `document.fonts.ready`;
- Studio registers the bundled resource with CoreText before opening a window;
- FFmpeg paths use `fontsdir` or `fontfile` rather than Fontconfig discovery;
- unknown `font_id` values fail validation instead of falling back silently.

The WOFF2 optimization is limited to browser renderers. Studio, CoreText,
FFmpeg/libass, drawtext, and final-render fallback continue to use the pinned
full TTF so subsetting cannot change their glyph availability.

Legacy mapping:

| Existing `styling_class` | v1 behavior |
| --- | --- |
| `vos:overlay.chapter-kicker` | normalize to `vos:content.section-label/v1` |
| `vos:overlay.lower-third` | normalize to `vos:content.lower-third/v1` |
| `vos:overlay.title-card` | keep on the existing Remotion renderer until a title-card content template is approved |
| `vos:overlay.location-tag` | keep on the existing Remotion renderer |
| `vos:overlay.credit` | keep on the existing Remotion renderer |

An unknown legacy `styling_class` produces an actionable preflight error. It is
not silently mapped to a visually different template.

## 6. Patch and Studio editing model

Add narrowly typed patch operations:

- `insert_content_element`
- `change_content_element`
- `remove_content_element`

The patch compiler validates the element and template props before changing the
timeline. Patch apply adds failure-atomic source/result timeline hash recording
for undo and stale-input detection.

The JSON Schema, TypeScript compiler switch, and Swift
`ReviewPatchDocument` decoder must gain the new operations in the same phase.
The Swift decoder compatibility lands before the Content Inspector UI so a new
operation cannot make the whole patch document unreadable in Studio.

Studio exposes a Content Inspector when an overlay clip is selected:

- template picker;
- template-defined text/asset fields;
- start, duration, and z-order;
- anchor and safe-area position;
- scale, opacity, and rotation;
- entrance and exit animation preset;
- reset and remove;
- fast proxy preview plus explicit exact-preview status.

The first Studio slice edits existing elements. Freeform canvas manipulation,
group nesting, arbitrary keyframes, and rich vector editing are deferred.

## 7. Render adapters

Define a renderer-neutral adapter interface:

```ts
interface ContentRendererAdapter {
  id: "ffmpeg" | "remotion" | "hyperframes";
  preflight(input: ContentRenderInput): ContentRenderPreflight;
  render(input: ContentRenderInput): Promise<ContentRenderResult>;
}
```

Every result records renderer version, template hashes, composition hash,
output hash, frame range, warnings, and degraded features.

### 7.1 HyperFrames adapter

The adapter:

1. normalizes approved overlay clips into `content-element/v1`;
2. resolves allow-listed templates;
3. writes deterministic local HTML with no remote asset URLs;
4. applies a restrictive CSP and blocks/records browser network requests;
5. runs HyperFrames lint in JSON mode;
6. renders a frame range or transparent WebM/PNG sequence;
7. composites it with the existing FFmpeg assembly;
8. writes a render receipt, including zero external requests, and cleans
   temporary media.

Initial effects are limited to CSS/GSAP entrance motion and one reviewed
section-boundary effect. Shader transitions remain opt-in until backward seek,
alpha, handle, and preview/final parity tests pass.

### 7.2 Security and reproducibility

- no remote scripts, fonts, stock media, or runtime network access;
- escape all text and attribute values;
- add a restrictive local-only CSP to generated documents and abort on any
  intercepted network request;
- resolve assets through the existing source-map containment rules;
- pin HyperFrames package versions;
- record browser, FFmpeg, and template versions;
- use a temporary directory outside canonical project artifacts;
- enforce execution timeout, output size, and frame-count limits;
- keep a deterministic fallback for non-HyperFrames projects.

## 8. Implementation phases

### Phase 0: dependency and renderer spike

- Record the operator's 2026-07-16 approval to evaluate and add the pinned
  HyperFrames dependency, satisfying the repository dependency-addition gate.
- Pin Node 22 before installing or testing native dependencies.
- Compare the full CLI with the minimum core/engine/shader package set.
- Inspect install scripts with an `--ignore-scripts` resolution/install pass and
  pin the chosen pre-1.0 packages to exact `0.7.60` versions.
- Run `doctor`, lint, and a five-second local render.
- Verify transparent output, backward frame seeking, and cleanup.
- Composite the transparent result back over test video with FFmpeg and inspect
  alpha edges for halos. If transparent WebM is unreliable, record PNG sequence
  as the selected intermediate before Phase 2.
- Bundle the redistribution-safe Noto Sans JP variable font through local
  `@font-face`, pin its SHA-256, and retain its SIL OFL 1.1 license. This is
  implemented as `font_id: noto-sans-jp`; unpinned system fonts are not part of
  the production contract.
- Record cold/warm render time, peak RSS, disk growth, and output hash stability.
- Do not wire HyperFrames into final packaging if the spike fails.

Exit criteria:

- a deterministic five-second 1920x1080 composition renders twice with matching
  decoded-frame hashes;
- Japanese text is present and layout-stable;
- FFmpeg round-trip compositing preserves transparent edges;
- all assets are local;
- intercepted external request count is zero;
- the dependency decision is recorded with measured costs.

### Phase 1: contract, registry, and patch engine

- Add `content-element/v1` types and schema.
- Extend Timeline IR additively for optional overlay/caption tracks and
  `content_element`.
- Implement template registry and four initial template manifests.
- Normalize legacy `metadata.overlay` without rewriting golden artifacts.
- Add content patch operations and tests.
- Extend RenderSpec to carry typed content elements rather than flat text only.
- Bump `rendererContractVersion` when the RenderSpec contract changes.
- Extend `schemas/review-patch.schema.json`, `runtime/compiler/patch.ts`, and
  Swift `ReviewPatchDocument` together; native editing UI remains deferred.
- Add source/result timeline hashes to content patch history.

Exit criteria:

- old timelines validate unchanged;
- invalid template props fail before mutation;
- raw/nested path references in props fail validation;
- insert/change/remove are failure-atomic and undoable;
- Studio can decode a patch containing the new operations before the Content
  Inspector UI exists;
- captions and graphic elements remain distinct.

### Phase 2: HyperFrames overlay rendering

- Generate local HyperFrames HTML from typed elements.
- Render transparent graphic intermediates.
- Composite through the shared preview/final FFmpeg path.
- Implement section label, question card, lower third, and logo bug.
- Add exact-preview cache keys from timeline, template, font, and renderer
  hashes.

Exit criteria:

- preview and final sample frames meet SSIM >= 0.999;
- no subtitle or overlay duplication;
- transparent edges and Japanese glyphs pass visual QA;
- HyperFrames absence gives an actionable preflight failure, not a crash.
- warm exact preview for one changed text element completes within 5 seconds on
  the reference development machine and records peak RSS; exceeding that budget
  blocks promotion into the interactive preview path.

### Phase 3: Studio Content Inspector

- Load content elements into the native Timeline document.
- Add typed content-element/overlay metadata decoding to `TimelineClip` rather
  than relying only on track structure.
- Add inspector editing for text, timing, template, anchor, position, scale,
  opacity, and animation presets.
- Add patch-backed save, undo, stale-hash conflict handling, and exact-preview
  refresh.
- Make the current AX-1 section labels editable without entering the speech
  caption finisher.
- Reuse `IMEAwareTextEditor` and its `hasMarkedText()` composition guard for all
  editable Japanese text props.

Exit criteria:

- an operator can change a section label and render the result using only
  Studio;
- IME composition does not autosave prematurely;
- undo restores both content and exact preview;
- overlay edits cannot mutate speech-caption approval artifacts.

### Phase 4: transition and effect expansion

- Map approved Video OS transition semantics to HyperFrames shaders.
- Add effect capability negotiation and deterministic degradation.
- Add `flash-through-white`, `whip-pan`, and `light-leak` only after restrained
  editorial-use rules and parity tests exist.
- Keep most cuts as hard cuts and ordinary fades on the existing engine.

Exit criteria:

- transition handles and source motion remain continuous;
- backward scrub and frame stepping are reliable;
- unsupported effects degrade explicitly;
- effect choice is recorded as an editorial decision, not renderer magic.

## 9. First implementation slice after review

The first code slice is Phase 0 plus the non-mutating portion of Phase 1:

1. add the renderer spike and measured report;
2. add `ContentElementV1` runtime types, validator, and template manifests;
3. add deterministic HyperFrames HTML generation for `section-label` and
   `question-card`;
4. add unit tests for validation, HTML escaping, stable output, and legacy
   overlay normalization;
5. do not yet change AX-1 canonical artifacts or Studio UI.

This slice proves the external runtime and the renderer-neutral contract before
expanding the patch schema or native UI.

## 10. Verification matrix

| Surface | Required verification |
| --- | --- |
| Contract | schema tests, legacy timeline validation, stable serialization |
| Security | HTML escaping, path containment, restrictive CSP, zero intercepted external requests |
| HyperFrames | doctor/lint/render, two-run frame hashes, timeout/cleanup |
| Visual | Japanese glyphs, alpha edges, safe area, 16:9 and 9:16 samples |
| Parity | shared preview/final samples and render receipts |
| Studio | Swift unit tests, IME behavior, patch undo/conflict handling |
| Product | AX-1 section label and question card edited and rendered in Studio |

Full repository checks remain Node 22 `npm test`, `npx tsc --noEmit`,
`npm run build`, editor typecheck/parity tests, Swift build/tests, schema
validation, and Project Loop validation/render.

## 11. Stop conditions

Stop and revise the design if any of these occur:

- HyperFrames requires remote runtime assets for the chosen path;
- transparent rendering or backward seek is nondeterministic;
- the minimum dependency set materially destabilizes Node 22 CI;
- preview and final cannot share the same template/version inputs;
- a second canonical timeline or hidden HTML authority becomes necessary;
- a renderer failure can invalidate ordinary FFmpeg-only projects.
- CI cannot run the pinned headless-browser preflight without downloading or
  reaching an unapproved remote runtime;
- warm exact preview exceeds the Phase 2 latency or memory budget.
