# Per-composition local font subsetting

Date: 2026-07-16
Project Loop feature: `F-0063`

## Outcome

HyperFrames and Remotion no longer need to copy the full 9,589,900-byte Noto
Sans JP variable TTF into every browser-render project. They now:

1. collect visible authored strings;
2. add printable ASCII, NBSP, and ideographic-space safety characters;
3. sort and deduplicate Unicode code points;
4. bind them to the font id, canonical source SHA-256, and subset-contract
   version;
5. generate a standalone WOFF2 locally with `pyftsubset`;
6. reuse it through a hash-verified local cache;
7. copy the OFL license beside the staged font.

The path remains network-free. Missing or failed FontTools execution falls back
to the verified canonical full TTF. Studio and FFmpeg continue using the full
TTF deliberately.

## Correctness and cache safety

- Different authoring order with the same code-point set produces the same key.
- The cache sidecar records source hash, output hash, character count, filename,
  and contract version. A modified cache file is regenerated.
- Remotion receives the generated font descriptor through serializable
  composition props and waits for `document.fonts.ready` before capture.
- HyperFrames HTML references only the staged per-composition file.
- CSS-generated/default `QUESTION` and printable ASCII remain covered even when
  they are not explicit template props.

## Real-render evidence

The Phase 0 interview composition used 124 unique characters:

| Measurement | Full TTF baseline | Local subset |
| --- | ---: | ---: |
| Staged font bytes | 9,589,900 | 57,592 |
| Share of full font | 100% | 0.60% |
| HyperFrames render 1 | 14.936 s | 9.990 s |
| HyperFrames render 2 | 12.752 s | 9.207 s |

The subset was generated from a cold subset cache. Both HyperFrames runs had
the same decoded-frame hash as the previous full-TTF implementation:

`SHA256=ad4ba0d8e2607bf60ed7a364904480727af8bb1ab7a0dca9847f49572b1f9c4a`

The transparent composite SSIM remained `0.974321`. A real Remotion render with
the Japanese overlay `経営者本人がAIを使う意味` also passed and produced
H.264/yuv420p output while loading the WOFF2 subset.

## Verification

- root TypeScript typecheck: passed
- Remotion TypeScript/DOM typecheck: passed
- targeted Vitest: 3 files, 26 tests passed
- full Vitest: 176 files passed, 4 skipped; 2,771 tests passed, 39 skipped
- real Remotion smoke: 1 test passed
- real HyperFrames lint: 0 errors, 0 warnings
- real HyperFrames decoded determinism: passed
- root build: passed
- editor server typecheck: passed
- repository hygiene: 1,498 tracked files passed
- `git diff --check`: passed

## Residual consideration

FontTools remains an optional host tool rather than a new npm dependency. This
keeps the dependency gate closed and correctness fail-open, but machines without
`pyftsubset` retain full-font preview latency. Cache cleanup is currently left
to the normal user cache lifecycle; a bounded LRU policy can be added if real
Studio usage shows meaningful growth.
