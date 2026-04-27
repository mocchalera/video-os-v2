# Remotion Integration Feasibility Survey

## 1. Executive summary

Verdict: Caution. Adding Remotion as an alternate assembly engine is feasible without disturbing the canonical ffmpeg assembler, because `runRenderPipeline()` already accepts a prebuilt `assemblyPath` and treats assembly as an upstream contract. The main caution is not the pipeline handoff; it is parity. The current final path applies clip transforms/effects through shared ffmpeg filtergraph code, while the existing Remotion stub is quarantined and not capable of rendering real timeline media. Phase B should therefore keep Remotion behind an explicit alternate-engine flag, preserve ffmpeg `caption_burn` as canonical SpeechCaption burn-in, and prove output-contract compatibility before touching canonical demo behavior.

## 2. Existing assembly path I/O contract

`runtime/render/pipeline.ts` orchestrates five phases after assembly: demux, caption sidecar/burn, audio mix, and final mux. It does not build an assembly itself. `RenderPipelineOptions` requires `projectDir`, `timelinePath`, `outputDir`, `fps`, caption policy, and optionally `captionApprovalPath`, `musicCuesPath`, and `assemblyPath`. If `assemblyPath` is absent, the pipeline throws with the explicit message that Remotion rendering is not available and a prebuilt `assembly.mp4` must be supplied.

The already-existing alternate-engine handoff is `opts.assemblyPath`. Any Remotion renderer can write a compatible MP4 and call `runRenderPipeline({ assemblyPath })` without adding a new handoff field. If Phase B wants the pipeline to select the engine itself, add a thin wrapper outside `pipeline.ts` first, for example `runtime/render/render.ts` or `runtime/render/remotion/render-remotion.ts`, that produces `assemblyPath` and then invokes the unchanged pipeline. Only add a pipeline-level `assemblyEngine` option if the wrapper proves insufficient.

Assembly handoff contract:

- Input to pipeline: an existing `assemblyPath` file plus `timelinePath`.
- Demux output: `outputDir/video/raw_video.mp4` via stream-copy video and `outputDir/audio/raw_dialogue.wav` as PCM s16le.
- Video normalization: `raw_video.mp4` is re-encoded through `buildAspectRatioFitFilter()` to the timeline sequence width/height and written back to the same path.
- Caption sidecars: `outputDir/captions/speech.approved.srt` and `outputDir/captions/speech.vtt` when caption policy requests `sidecar` or `both`.
- Caption burn-in: `outputDir/video/captioned_video.mp4` when policy requests `burn_in` or `both`; this remains the canonical SpeechCaption final burn path.
- Audio master placeholder: `outputDir/audio/final_mix.wav`, either copied from raw dialogue or produced by `runtime/audio/mixer.js` when music cues are available.
- Final mux: `outputDir/video/final.mp4`, video copied from the current video path and audio encoded AAC 192k.

`runtime/render/assembler.ts` is the canonical ffmpeg assembler. Defaults are:

- Input timeline: `opts.timelinePath` or `<projectDir>/05_timeline/timeline.json`.
- Output assembly: `opts.outputPath` or `<projectDir>/05_timeline/assembly.mp4`.
- Temporary workdir: `os.tmpdir()/vos-assembler-*`, removed by default.
- Source resolution: source-map, preview manifest, analysis assets, and metadata source hints.
- Video fields read: `timeline.sequence.fps_num/fps_den/width/height`, `timeline.tracks.video[*].clips[*]`, and clip metadata keys `zoom`, `crop`, `position`, `render.effects`, plus source-path hints.
- Audio fields read: `timeline.tracks.audio[*].clips[*]`, `audio_policy`, and source hints.
- Ignored by canonical assembly today: root `transitions`, overlay tracks, caption tracks, markers, and most metadata outside transform/effects/source hints.
- Video segment encoding: libx264, yuv420p, timeline fps, with shared preview/final fit filter.
- Gap encoding: black lavfi color at sequence dimensions/fps, libx264, yuv420p.
- Video concat: concat demuxer into libx264/yuv420p.
- Audio segment encoding: PCM s16le WAV at 48 kHz stereo by default.
- Assembly audio mix: AAC 192k in `assembly.audio.m4a`.
- Final assembly mux: stream-copy video and audio into MP4.

`runtime/render/__experimental/composition.ts` contains a Remotion-shaped stub only. It builds a `RenderConfig` with `compositionId: "VideoTimeline"`, `codec: "h264"`, `imageFormat: "jpeg"`, and output `<outputDir>/assembly.mp4`, but `renderAssembly()` always throws. There is no real Remotion renderer in the repo.

## 3. Timeline IR status and additive extension room

`schemas/timeline-ir.schema.json` root has `additionalProperties: false`. The allowed root properties already include `version`, `project_id`, `created_at`, `sequence`, `tracks`, `markers`, `transitions`, `audio_mix`, and `provenance`. This means a new root surface cannot be used until schema is updated, but root `transitions` already exists and should be reused rather than reintroduced.

`sequence` is also closed with `additionalProperties: false`. It allows `name`, `fps_num`, `fps_den`, `width`, `height`, `start_frame`, `sample_rate`, `timecode_format`, `output_aspect_ratio`, and `letterbox_policy`. Adding `sequence.transitions` would require a schema change and would duplicate the existing root surface.

`tracks` is an object, not an array. It requires `video` and `audio` arrays, and optionally allows `overlay` and `caption` arrays. Each track is closed and contains `track_id`, `kind`, and `clips`; `kind` is one of `video`, `audio`, `overlay`, or `caption`.

Clips are mostly closed, but `clip.metadata` is a free-form object. This is the safest place for engine-specific or UI-only hints that should not affect canonical contracts. Markers are closed except `marker.metadata`, which is also free-form.

The existing root `transitions` schema requires `transition_id`, `from_clip_id`, `to_clip_id`, `track_id`, and `transition_type`. It allows `transition_type` values `cut`, `crossfade`, `j_cut`, `l_cut`, `match_cut`, and `fade_to_black`, plus `transition_frames`, `transition_params`, `applied_skill_id`, `degraded_from_skill_id`, and `confidence`. `transition_params` is closed and currently allows crossfade/audio overlap/snap/hold/zoom/beat fields.

`projects/demo/05_timeline/timeline.json` currently has root keys `created_at`, `markers`, `project_id`, `provenance`, `sequence`, `tracks`, and `version`. It does not contain a `transitions` field, overlay track, caption track, or clip metadata in the demo fixture. Its tracks are two video tracks and three audio tracks. The canonical created_at-excluded hash was verified with `JSON.stringify()` after deleting `created_at` and matches `68c8d701302aa5150f8afd183de1a52711349834f4c9e267cb3544e26e01b100`.

## 4. Remotion integration point and directory tree proposal

Recommended new tree:

```text
runtime/render/remotion/
  CompositionRoot.tsx
  VideoTimeline.tsx
  render-remotion.ts
  types.ts
  components/
    VideoClip.tsx
    TextOverlay.tsx
    PreviewSpeechCaption.tsx
    TransitionLayer.tsx
  styles/
    overlay-presets.ts
```

Responsibilities:

- `render-remotion.ts`: Node entrypoint. Read `timeline.json`, resolve sources with the same resolver strategy as the assembler, bundle/render Remotion, write an MP4 assembly, and return `assemblyPath`.
- `CompositionRoot.tsx`: register the Remotion composition and map input props into `VideoTimeline`.
- `VideoTimeline.tsx`: deterministic frame composition from Timeline IR or a render-specific projection.
- `components/VideoClip.tsx`: visual clip rendering only; no final SpeechCaption burn-in.
- `components/TransitionLayer.tsx`: visual transitions backed by root `transitions`.
- `components/TextOverlay.tsx`: authored text overlays only.
- `components/PreviewSpeechCaption.tsx`: optional preview/debug layer only, gated separately from final caption burn.
- `styles/overlay-presets.ts`: registry mapping reserved `vos:*` styling classes to Remotion style objects.

Do not import `runtime/render/remotion/*` from `runtime/render/assembler.ts`. Keep both engines siblings. The safest Phase B shape is a command/wrapper that chooses engine and hands the resulting `assemblyPath` into the existing pipeline.

## 5. Package dependency list and version proposal

Root `package.json` currently has no React dependency. `editor/client/package.json` uses `react` and `react-dom` `^19.1.0`, but that is an editor-local package and should not be assumed available to the root runtime.

Observed npm metadata on 2026-04-27:

- `remotion` latest observed: `4.0.452`, peer deps `react >=16.8.0`, `react-dom >=16.8.0`.
- `@remotion/renderer` latest observed: `4.0.452`, peer deps `react >=16.8.0`, `react-dom >=16.8.0`.
- `@remotion/cli` latest observed: `4.0.452`, depends on aligned Remotion packages.
- `@remotion/bundler` latest observed: `4.0.452`, peer deps `react >=16.8.0`, `react-dom >=16.8.0`.

Proposed root additions for Phase B:

```json
{
  "dependencies": {
    "react": "^19.1.0",
    "react-dom": "^19.1.0",
    "remotion": "4.0.452",
    "@remotion/renderer": "4.0.452",
    "@remotion/bundler": "4.0.452"
  },
  "devDependencies": {
    "@types/react": "^19.1.8",
    "@types/react-dom": "^19.1.6"
  }
}
```

`@remotion/cli` is optional unless Phase B adds a CLI script. Prefer programmatic `@remotion/renderer` plus `@remotion/bundler` for the runtime path, and keep Remotion package versions pinned together.

`tsconfig.json` currently has no `jsx` compiler option and only includes `runtime/**/*.ts`, not `runtime/**/*.tsx`. Phase B must add TSX support before Remotion components can compile. A minimal compatible change would be to include `runtime/**/*.tsx` and set `jsx` to `react-jsx` or use a separate `tsconfig.remotion.json` to keep root `npm run build` conservative.

`npm run build` is plain `tsc`. With TSX files added and no tsconfig update, build will not include them. With tsconfig updated but React types missing, build will fail. No current build-script conflict was observed beyond this missing TSX/React setup.

## 6. Transition surface recommendation

Recommended: reuse and extend the existing root `transitions` array.

Why:

- It already exists in the closed root schema.
- `runtime/compiler/index.ts` already emits root transitions from adjacency decisions.
- `editor/shared/render-spec.ts` already maps root transitions into `RenderTransition`.
- `editor/server/services/preview-job-service.ts` already has transition-aware ffmpeg preview logic.
- Existing demo timeline omits the field, so canonical hash remains unchanged if Phase B only adds optional schema fields.

Recommended additive schema shape:

```json
{
  "transition_id": "TR_0001",
  "from_clip_id": "CLP_0001",
  "to_clip_id": "CLP_0002",
  "track_id": "V1",
  "transition_type": "crossfade",
  "start_frame": 120,
  "duration_frames": 12,
  "transition_frames": 12,
  "transition_params": {
    "crossfade_sec": 0.5,
    "easing": "ease_in_out",
    "remotion_preset_id": "vos:crossfade.soft",
    "fallback": {
      "type": "cut",
      "reason": "unsupported_by_engine"
    }
  },
  "metadata": {
    "degraded_reason": null
  }
}
```

For D1 compatibility, Phase B should add optional fields to the existing `$defs.transition`: `start_frame`, `duration_frames`, `fallback`, and `metadata`. Prefer `duration_frames` as the public name while preserving existing `transition_frames` for backward compatibility until all runtime/editor code reads the same field.

Alternative: add `sequence.transitions`.

Pros: groups timing decisions near fps/geometry settings. Cons: `sequence` is closed, this duplicates root `transitions`, existing compiler/editor/preview code already targets root `transitions`, and it raises migration risk without adding capability.

Rejected for Phase B: transition tracks or `tracks[*].kind = "transition"`. Track kind enum is closed, transition semantics are adjacency-based rather than media clips, and this would force editor lane behavior changes.

## 7. TextOverlay preset registry boundary

Current state:

- Schema permits `tracks.overlay`, but the demo fixture has no overlay track.
- `runtime/caption/approval.ts` can project approved `text_overlays` into an overlay track with `metadata.overlay`.
- `runtime/caption/overlay.ts` defaults text overlay `styling_class` to `title-card`.
- `editor/shared/render-spec.ts` currently extracts overlay text from `clip.metadata.text` or `clip.metadata.overlay_text`, not from `clip.metadata.overlay.text`; this is a mismatch with caption approval projection.
- Editor v3 lanes currently surface caption tracks, not overlay tracks, although thumbnails include overlay/caption tracks and RenderSpec has `text.overlays`.

Boundary proposal:

- Remotion TextOverlay should read `clip.metadata.overlay` first, then legacy flat `metadata.text` / `metadata.overlay_text`.
- Treat overlay presets as Remotion-only visual presets unless/until ffmpeg final render supports them.
- Use a reserved namespace for new registry IDs: `vos:overlay.title-card`, `vos:overlay.lower-third`, `vos:overlay.vertical-title`, `vos:overlay.location-tag`, `vos:overlay.credit`.
- Avoid unqualified names already present in fixtures or policies: `default`, `minimal`, `minimal_date`, `none`, `clean-lower-third`, `gentle-lower-third`, `title-card`.

## 8. SpeechCaption role split

Canonical final SpeechCaption burn-in should stay in ffmpeg:

- `runtime/render/pipeline.ts` loads `captionApprovalPath`, reads `speech_captions`, generates SRT/VTT via `generateSrt()` and `generateVtt()`, and burns via ffmpeg `subtitles=...` in `burnCaptions()`.
- `editor/server/services/preview-job-service.ts` has its own exact-preview burn-in path using RenderSpec speech captions and shared caption style tokens, but that is editor preview, not the package pipeline.

Remotion boundary:

- Remotion may render SpeechCaption only as `PreviewSpeechCaption`, enabled by an explicit preview/debug prop.
- Remotion assembly intended for final pipeline should not bake SpeechCaption into pixels, because `caption_burn` would double-burn.
- TextOverlay is different: authored overlay/title graphics can be part of Remotion assembly if explicitly sourced from overlay tracks or overlay metadata.
- Final package acceptance should compare Remotion assembly with `captionPolicy.source = none` or with preview captions disabled, then let the existing pipeline own sidecar and burn-in generation.

## 9. Risks and mitigation

Risk: duplicate caption rendering. Mitigation: default Remotion SpeechCaption off for final assembly and add a test that `render-remotion.ts` does not consume `speech_captions` unless preview-only mode is set.

Risk: transform/effect parity drift. The ffmpeg assembler and preview currently share `editor/shared/filtergraph.ts`; Remotion would need a separate CSS/React implementation. Mitigation: Phase B starts with cuts and text overlay only, then adds transform/effect parity in gated increments.

Risk: transition schema assumption drift. Root `transitions` already exists; adding another surface would fragment compiler/editor/runtime behavior. Mitigation: extend root `$defs.transition` only, with optional fields and no fixture rewrite.

Risk: overlay metadata mismatch. Caption approval writes `metadata.overlay`, while RenderSpec reads flat `metadata.text` / `metadata.overlay_text`. Mitigation: Phase B should define one read order and add tests before using overlays in Remotion.

Risk: build break from TSX/React. Root tsconfig does not compile TSX and root package has no React deps. Mitigation: add a separate Remotion tsconfig or update root build and dependencies atomically.

Risk: canonical hash drift. Existing demo has no `transitions`, overlay, caption, or clip metadata fields. Mitigation: Phase B must verify the created_at-excluded hash remains `68c8d701302aa5150f8afd183de1a52711349834f4c9e267cb3544e26e01b100` after schema/dependency changes and must not rewrite `projects/demo/05_timeline/timeline.json`.

Risk: tests count and acceptance target. The request references 1884 existing tests, but this survey did not rerun the suite because only documentation was written. Mitigation: Phase B should run `npm run build`, `npm test`, schema validation, and the canonical hash check after additive schema/code changes.

## 10. Recommended Phase B-G order

Phase B: schema and contract only. Extend existing root transition schema optionally, define overlay metadata read order, add Remotion package/tsconfig plan, and add no runtime behavior by default.

Phase C: Remotion skeleton. Add `runtime/render/remotion/` with a minimal composition that can render a deterministic cuts-only MP4 to an `assemblyPath`, behind an explicit alternate-engine command or flag.

Phase D: pipeline handoff. Wire the Remotion command/wrapper to call `runRenderPipeline()` with the generated `assemblyPath`; keep `runtime/render/assembler.ts` untouched.

Phase E: TextOverlay registry. Implement namespaced `vos:overlay.*` presets, read `metadata.overlay`, and keep SpeechCaption disabled for final assembly.

Phase F: transitions. Implement only root `transitions` with a small supported set, plus fallback/degraded metadata. Confirm unsupported transitions degrade deterministically.

Phase G: parity and acceptance. Run full build/test/schema validation, compare Remotion and ffmpeg acceptance outputs at the contract level, and recheck the demo canonical hash with `created_at` excluded.

Change to the apparent B-G plan: move dependency/tsconfig work into the same phase as the first TSX file, not earlier, unless the master wants a package-lock-only dependency landing. This keeps Phase B schema-only and avoids root build churn before the runtime shape is proven.
