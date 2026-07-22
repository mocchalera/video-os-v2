# Remotion / HyperFrames render routing

Final packaging selects renderers from the capabilities required by canonical
`timeline.json` content. It does not select a look merely because a project is
an SNS short, interview, event, or long-form video.

## Routing rules

| Canonical timeline content | Base assembly | Additional composite |
| --- | --- | --- |
| video/audio/captions only | FFmpeg | none |
| Remotion-owned overlay | Remotion | none |
| HyperFrames-owned content element | FFmpeg | transparent HyperFrames overlay |
| Remotion and HyperFrames elements | Remotion | transparent HyperFrames overlay |

Speech captions remain owned by the existing FFmpeg/libass finishing stage.
This prevents a Remotion preview caption from being burned twice. Explicitly
requesting FFmpeg when a Remotion-owned element exists fails closed instead of
silently dropping graphics. Unknown templates and invalid content elements also
fail before rendering.

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

Use `--assembly-engine remotion` only for explicit diagnostics or parity work.
Do not force Remotion simply to obtain a social-video style; captions and style
tokens are a separate contract.
