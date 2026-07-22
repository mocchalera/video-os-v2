# Capability-based Remotion / HyperFrames routing verification

Date: 2026-07-17

Feature: `F-0065` / `US-0037`

## Outcome

Final packaging now derives its render route from renderer ownership in the
canonical timeline instead of from genre alone:

- no programmable overlays: FFmpeg assembly remains unchanged;
- Remotion-owned overlays: Remotion assembly;
- HyperFrames-owned elements: transparent HyperFrames composite;
- mixed ownership: Remotion assembly plus HyperFrames composite;
- speech captions: FFmpeg/libass finishing remains the sole owner.

The decision is recorded in `07_package/logs/render-route.json`. Explicit
FFmpeg or a prebuilt assembly fails closed when it could omit Remotion-owned
content. Unknown templates also fail before final rendering.

Project-local JSX/HTML is not part of the supported reproduction path.
Registered `content-element/v1` templates now cover Remotion title cards and
emphasis words plus the existing HyperFrames section/question/lower-third
elements. The full-pipeline and render-video skills require a route preflight
and canonical timeline authoring before review/package.

The accepted Japanese dialogue-short caption style is isolated to
`single-layer-speaker-separated-safe-area-ja`: it uses large outline-only text,
separate top/offscreen and bottom/onscreen colors, and no nested background
panels. Other caption presets are unchanged.

## Verification

All commands ran with Node `v22.23.1` / npm `10.9.8`.

### Static and full regression

```text
npm run build
PASS

npm test
Test Files 183 passed | 6 skipped (189)
Tests      2886 passed | 41 skipped (2927)
```

### Real renderer smoke tests

```text
VOS_REMOTION_RENDER=1 VOS_HYPERFRAMES_RENDER=1 VOS_HYBRID_RENDER=1 \
  npx vitest run \
  tests/remotion-render-smoke.test.ts \
  tests/hyperframes-renderer-smoke.test.ts \
  tests/hybrid-render-route-smoke.test.ts

Test Files 3 passed (3)
Tests      3 passed (3)
```

The hybrid smoke renders a canonical Remotion title and HyperFrames section
through one production pipeline, retains AAC source audio, completes dialogue
mastering/fallback and final mux, and verifies the route receipt.

### Cross-genre edit regression

```text
npm run eval -- --suite golden --no-write

fumoto-growth                     52.0
togakushi-camp                   100.0
ena-promo                        100.0
operator-testimonial-a    100.0
operator-testimonial-b     100.0
```

These scores are identical to the pre-change baseline. Marlin divergence was
skipped because no Marlin QA scores were available; the structure/alignment
regression is verified.

## Residual boundary

The engine selector does not invent graphics from genre. An agent or operator
must author requested registered content elements into the canonical timeline;
otherwise an ordinary project intentionally remains on FFmpeg. This prevents
the accepted SNS treatment from leaking into interviews, events, long-form, or
cinematic projects.
