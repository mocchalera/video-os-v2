# Remotion / HyperFrames render routing

Final packaging selects renderers from the capabilities required by canonical
`timeline.json` content. It does not select a look merely because a project is
an SNS short, interview, event, or long-form video.

## Routing rules

| Canonical timeline content | Base assembly | Additional composite |
| --- | --- | --- |
| video/audio/captions only | FFmpeg | none |
| separate Remotion-owned overlay | FFmpeg | transparent Remotion layer |
| base-frame-dependent Remotion treatment | Remotion | none for that treatment |
| HyperFrames-owned content element | FFmpeg | transparent HyperFrames overlay |
| separate Remotion and HyperFrames elements | FFmpeg | transparent renderer-owned layers |

Speech captions remain owned by the existing FFmpeg/libass finishing stage.
Production package assembly rejects any legacy `clip.captions`; only an
explicit `preview_burn` compatibility path may use FFmpeg drawtext. This
prevents legacy clip captions or a Remotion preview caption from being burned
again underneath approved ASS. Unknown caption styles, generic-family heavy
weights, and missing/mismatched font assets fail closed for every captioned
genre; `caption_policy.source: none` remains valid. Explicitly
requesting FFmpeg when a Remotion-owned element exists fails closed instead of
silently dropping graphics. Unknown templates and invalid content elements also
fail before rendering.

Renderer-owned alpha artifacts are grouped only when that grouping preserves
the global z-order. A sequence such as HyperFrames 100 / Remotion 200 /
HyperFrames 300 cannot be represented by the current one-artifact-per-renderer
model, so shared route preflight and the render boundary reject it with
`renderer_z_order_interleaving_unsupported` instead of silently reordering it.
Cross-renderer z-index ties are rejected for the same reason: the artifact
model cannot preserve the element-level tie-break after grouping.

The approved dialogue-short style
`single-layer-speaker-separated-safe-area-ja` remains genre-scoped. Its ASS
output uses large outline-only text with separate top/offscreen and
bottom/onscreen speaker colors; it does not add nested background panels.
Other caption styles keep their existing single-style behavior.

Genre classification controls the style family, not the renderer. An ordinary
project with no programmable overlays therefore stays on the proven FFmpeg
path. Conversely, an interview, event, cinematic, or long-form project may use
Remotion or HyperFrames when its canonical timeline contains a registered
element that needs that renderer.

## Authoring boundary

Project artifacts may contain only registered `content-element/v1` templates or
the supported legacy overlay metadata. Agents must not generate project-local
HTML or JSX as a hidden second timeline.

Current production-renderable programmable templates are:

- Remotion: `vos:content.title-card/v1`, `vos:content.hook-title/v1`,
  `vos:content.emphasis-word/v1`
- HyperFrames: `vos:content.section-label/v1`,
  `vos:content.question-card/v1`, `vos:content.lower-third/v1`

`vos:content.logo-bug/v1` is registered with HyperFrames as its preferred
renderer, but the production HyperFrames adapter does not support it yet.
Using it therefore fails render-route preflight instead of silently dropping
the element.

The containing overlay clip owns timing. The template registry owns props,
supported aspect ratios, the preferred renderer, and the font policy.

## Preflight and receipts

Inspect a project without changing it:

```bash
npm run render-route -- projects/<project-id>
npm run render-route -- projects/<project-id> --json
```

`npm run package` uses the same resolver with `--assembly-engine auto` by
default. After a completed package render, the exact decision and effective
assembly paths are recorded in:

```text
07_package/logs/render-route.json
```

The receipt records pinned renderer versions, hash-bound timeline/caption
inputs, layer and font receipts, the final-video hash, and an execution-derived
delivery operation list. `lossy_video_encode_passes` means sequential H.264
generations carried by the delivered picture. It includes the H.264 base
assembly, a conditional fit re-encode, and the final visual composite when
they actually execute. Stream copies, decodes, VP9 alpha intermediates, and
lossless audio intermediates are listed separately and do not increment it.

HyperFrames and Remotion alpha cache hits require both receipt/hash identity
and a live ffprobe match for codec, pixel format/alpha, dimensions, rational
FPS, duration frames, WebM timebase `1/1000`, and absence of audio. Missing or
drifted media is a cache miss and is regenerated safely.

For `engine_render`, `package_manifest.json.provenance.render` binds this route
receipt and its layer/font receipts. `scripts/package.ts --verify-existing
--json` re-resolves the route and rejects missing/tampered artifacts, renderer
version drift, encode-count drift, input/output hash drift, and live alpha
media drift.

Use `--assembly-engine remotion` only for explicit diagnostics or parity work.
Do not force Remotion simply to obtain a social-video style; captions and style
tokens are a separate contract.
