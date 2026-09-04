# CI workflow modes

The CI split keeps the normal pull-request signal fast while retaining a
fail-closed full product boundary for protected integration refs.

| Event and changed paths | Workflows | Product boundary |
| --- | --- | --- |
| Any pull request | `ci.yml` | One Ubuntu `product-gate`: one root `npm ci`, schema validation, fast contracts, repo checks, and build. |
| Pull request touching `Package.swift`, `Package.resolved`, `apps/macos-studio/**`, or the Studio workflow | `ci.yml` + `macos-studio.yml` | The PR fast gate plus exact Xcode/Swift, SwiftPM build/tests, and Studio CLI smoke. |
| Push to `Dev`, `main`, or `public-candidate/**` | `full-integration.yml` | Full Node suite, editor-server integration, pinned media toolchain, and real render. |
| The same protected push with a Studio/Swift path change | Above + `macos-studio.yml` | The full Ubuntu boundary plus the path-filtered Studio boundary. |
| `workflow_dispatch` on `full-integration.yml` | `full-integration.yml` | Full Ubuntu boundary and macOS Studio in the same full product gate. |
| `workflow_dispatch` on `macos-studio.yml` | `macos-studio.yml` | Studio-only check with the exact Xcode/Swift boundary. |

These cost-optimized lanes add no schedule; the separate speech-led real-media
workflow retains its existing weekly/manual operation. Concurrency cancels an
older run when a newer commit arrives on the same pull request or ref. The PR
workflow has one Ubuntu runner and one root dependency installation; the full
workflow consolidates the Node/editor/render work into one Ubuntu job. The
editor keeps its separate lockfile and therefore has one additional
`npm --prefix editor ci` only in the full lane. Studio path selection uses
GitHub's native filters and no third-party action.

The `product-gate` job in `ci.yml` is the clear required-check candidate while
branch protection is absent. `full-product-gate` runs after the full boundary:
it requires the manual-dispatch Studio job to succeed, while accepting its
intentional `skipped` result on protected pushes because path-filtered Studio
runs are reported by `macos-studio.yml`.
