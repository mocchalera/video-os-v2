# Third-Party Review Goal Setup

Date: 2026-07-09

## Goal

`G-0003`: 第三者レビュー起点のプロダクト統治強化

Completion criteria:

- Runtime owns the canonical pipeline plan/executor and scripts are CLI adapters.
- CI protects Node runtime, schema contracts, repo hygiene, macOS Studio, editor-server, and agent generated drift.
- Generated outputs, large artifacts, env files, and private media are enforced at Git/CI boundaries.
- Schema/gate claims match actual validation, with QA preview/final/package states separated.
- `source_map` and local media endpoints enforce capability boundaries.
- macOS Studio decomposition is planned and the first store/view extraction lands.
- Current/deprecated/security/pipeline/release docs become the maintained truth.

## Tasks

- `T-0001`: Finish runtime pipeline orchestration unification
- `T-0003`: Align QA and final package gate semantics
- `T-0002`: Expand CI responsibility boundaries
- `T-0004`: Harden local media and source_map security model
- `T-0005`: Strengthen semantic artifact validation
- `T-0006`: Decompose macOS Studio oversized ViewModel and Timeline views
- `T-0007`: Clarify editor legacy and preview-server ownership
- `T-0008`: Publish current architecture and operating docs

Execution order is enforced with task dependencies:

```text
T-0001
-> T-0003
-> T-0002
-> T-0004
-> T-0005
-> T-0006
-> T-0007
-> T-0008
```

## Notes

The goal intentionally references already-started review hardening features:
`F-0038`, `F-0039`, `F-0040`, `F-0041`, `F-0042`, and `F-0043`.

`G-0002` remains open and unchanged; it tracks the earlier video-quality and evaluation reliability work.
