# HyperFrames Phase 0 dependency and renderer spike

Date: 2026-07-16

Status: **GO for renderer-neutral contract work; CLI remains a development-only
dependency until the remaining production gates are closed.**

The implementation plan was reviewed without file edits by Claude through
Cockpit task `f9b05541`. The revised plan closes its blocking findings around
asset containment, single-renderer ownership, and atomic
Schema/TypeScript/Swift patch rollout.

## Dependency decision

- Runtime: Node `v22.23.1`, npm `10.9.8`, FFmpeg `8.0.1`.
- Added exact development dependency: `hyperframes@0.7.60`.
- The full CLI is used for `doctor`, lint, and render measurements. It is not
  wired into final packaging or ordinary FFmpeg-only projects.
- The install used `--ignore-scripts` after inspecting package metadata. The
  HyperFrames package itself has no install script; relevant transitive native
  packages do.
- Install result on the reference Mac: 77 added packages, 7.77 seconds, about
  298 MB maximum resident memory. `node_modules` grew from 981,616 KB to
  1,346,856 KB (365,240 KB).
- A dry-run of the full CLI resolved 216 additions from a clean dependency
  view. A core+engine dry-run still resolved 206 and includes Puppeteer, so the
  smaller package names did not materially remove the browser/runtime surface
  needed by the spike.

Current `npm audit` reports 9 findings overall and 6 with dev dependencies
omitted. No current finding is attributed directly to the HyperFrames package,
but a pre-install audit baseline was not captured, so this spike does not claim
that the dependency added zero transitive risk.

## Environment preflight

`hyperframes doctor --json` passed Node, CPU, memory, disk, FFmpeg, FFprobe, and
the cached Chrome headless shell. Docker is not installed, so the Docker render
path is unavailable. Optional transcription/TTS checks do not block overlay
rendering.

The `hyperframes telemetry disable` command printed success but a subsequent
status command still reported enabled. Every repository invocation therefore
sets `HYPERFRAMES_NO_TELEMETRY=1`; the config command is not trusted as the
control.

## Deterministic render evidence

Command:

```sh
PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" \
KEEP_HYPERFRAMES_SPIKE=1 HYPERFRAMES_NO_TELEMETRY=1 \
npm run spike:hyperframes
```

The five-second 1920x1080, 30 fps Japanese composition contains one section
label and one interviewer question card generated from typed content elements.

| Check | Result |
| --- | --- |
| HyperFrames lint | 0 errors, 0 warnings |
| First WebM render | 9.093 s |
| Second WebM render | 8.630 s |
| Output size | 104,403 bytes |
| Decoded frame hash, run 1 | `SHA256=47bad72acfa08f2bc308bbe8822484c585906ee2fb7476b1fccb931ae5e33907` |
| Decoded frame hash, run 2 | same |
| Decoded-frame determinism | pass |
| WebM stream | VP9, 1920x1080, 30 fps, `ALPHA_MODE=1` |

The WebM container byte hashes differed while decoded frames matched. Render
receipts must therefore use decoded-frame or composition hashes for visual
determinism and keep the file hash only as artifact identity.

## Alpha compositing findings

Two non-obvious FFmpeg requirements were found and encoded in the reusable
spike:

1. FFmpeg's native VP9 decoder exposed the transparent WebM as opaque black.
   The overlay input must be decoded with `libvpx-vp9`.
2. `overlay=format=auto` produced missing portions of Japanese glyphs on some
   intermediate frames. Converting the base and overlay streams explicitly to
   RGBA before the overlay filter removed the corruption.

The accepted graph shape is:

```text
base -> format=rgba -----\
                         overlay=format=rgb -> format=yuv420p
VP9 via libvpx -> rgba --/
```

The unaffected background-region SSIM after H.264 re-encoding was `0.974199`
and the representative composite frame passed visual inspection without a
black matte, missing glyphs, or obvious alpha halos. PNG sequence remains the
fallback if this WebM contract fails on another supported machine.

Snapshots requested in reverse order (`4s,1s`) and forward order (`1s,4s`)
produced identical per-time PNG hashes. The 4-second frame hash was
`2b43eac8a7dd3147ab51e54abfa631456ab1bd5074b02496542193819487626e`
in both orders; the 1-second frame hash was
`687c1ef20a5505e5146d102a67b19ed1bb473a74a1380c8bd24c1883bf4cbb1e`
in both orders. Backward seeking therefore passes on the reference machine.

Generic `system-ui` produced different decoded hashes between consecutive
renders. A controlled-machine `@font-face local("Arial Unicode MS")`
declaration initially restored stable hashes, but that development-only
workaround was superseded later the same day by the bundled-font addendum
below.

### Bundled-font rerun

The renderer now stages Google Fonts Noto Sans JP locally as
`font_id: noto-sans-jp`. The 9,589,900-byte variable TTF is pinned to SHA-256
`c2f3b4d463500a2ddcd3849cded1fceeb9fd6d1c32e6cbecd568453ba50fc68f`
and ships with `OFL.txt`. No runtime Google Fonts request is used.

| Check | Bundled-font rerun |
| --- | --- |
| HyperFrames lint | 0 errors, 0 warnings |
| First WebM render | 44.652 s |
| Second WebM render | 16.673 s |
| Decoded frame hash, run 1 | `SHA256=ad4ba0d8e2607bf60ed7a364904480727af8bb1ab7a0dca9847f49572b1f9c4a` |
| Decoded frame hash, run 2 | same |
| Decoded-frame determinism | pass |
| Alpha/background SSIM | `0.974321` |

The first uncached bundled-font run took 44.652 seconds and 16.673 seconds.
After browser/font caches were populated, the final self-contained project
writer rerun took 14.936 seconds and 12.752 seconds while retaining the same
decoded hash.

### Per-composition subset rerun

The browser renderers now derive a deterministic code-point set and use a
hash-verified local WOFF2 cache. The full TTF remains the fallback and the
Studio/FFmpeg font.

| Check | Local WOFF2 subset |
| --- | --- |
| Unique characters | 124 |
| Staged font size | 57,592 bytes (0.60% of full TTF) |
| First WebM render | 9.990 s |
| Second WebM render | 9.207 s |
| Decoded frame hash | `SHA256=ad4ba0d8e2607bf60ed7a364904480727af8bb1ab7a0dca9847f49572b1f9c4a` |
| Alpha/background SSIM | `0.974321` |

This closes the font-copy latency optimization without changing decoded output
or reintroducing runtime network access. Details are in
`reports/project-control-loop/2026-07-16-local-font-subsetting.md`.

## Contract implementation started

The same slice adds:

- standalone `content-element/v1` TypeScript types and JSON Schema;
- four allow-listed template manifests;
- validation that rejects absolute paths, file URLs, remote URLs, parent
  traversal, unknown props, and unsupported renderers;
- one resolved renderer owner per element;
- explicit legacy mapping for `chapter-kicker` and `lower-third`, with the
  remaining three existing presets kept on Remotion;
- deterministic, escaped, local-only HTML generation for section labels and
  question cards;
- restrictive CSP and a pinned local Noto Sans JP declaration;
- targeted tests for validation, escaping, ordering, legacy normalization, and
  renderer ownership.

## Remaining promotion gates

- Add browser request interception and a zero-external-request render receipt;
  CSP and static lint alone are not sufficient proof.
- Integrate the explicit libvpx/RGBA graph into the shared preview/final path
  and measure SSIM parity there.
- Extend the timeline, review-patch schema, TypeScript compiler, and Swift
  decoder together. This spike intentionally does not mutate those contracts.
- Prove warm exact-preview latency before using HyperFrames interactively in
  Studio.
