# Goal

Build RoughCut Agent into a reliable, artifact-driven video editing system that can move from source footage and a short creative brief to searchable evidence, editable plans, deterministic timelines, rendered rough cuts, and QA-backed improvements while staying local-first and fail-open.

## Why This Exists

The repository exists to shorten the loop between footage review, candidate discovery, rough edit construction, NLE handoff, render verification, and editorial repair. Real artifacts, not logs alone, are the source of truth.

## Decision Rule

All implementation, design, scope, and tooling decisions should ultimately answer:

> Does this make the footage-to-roughcut loop more reliable, inspectable, reproducible, or easier for an editor to control?

## Non-Goals

- Do not make optional cloud or local model integrations mandatory for deterministic compile, search fallback, or core validation.
- Do not hide editorial state inside transient chat context when it belongs in repo artifacts.
- Do not replace human editorial judgment with uninspectable automation.
