# T-0022 fumoto live Marlin evidence

- Date: 2026-07-11 JST
- Goal / feature: G-0002 / F-0035
- Canonical project: `projects/fumoto-growth`
- Scratch project: `tmp/T-0022-fumoto-growth-T6nZ7P`
- Promotion: none

## Outcome

The approved fumoto timeline was copied byte-for-byte to an isolated scratch project, rendered under the repository's Node 22/npm 10 toolchain, and evaluated by the cached Marlin-2B model in live MPS mode. The canonical project and git worktree remained unchanged.

## Integrity

```text
canonical timeline sha256: d7b6e46737ca8e53711746d0d414cfa9871bfc79012782d750d5931687a67e84
scratch timeline sha256:   d7b6e46737ca8e53711746d0d414cfa9871bfc79012782d750d5931687a67e84
```

Validation checked 43 artifacts with zero errors and zero warnings.

## Render

- Output: `tmp/T-0022-fumoto-growth-T6nZ7P/09_output/rough-cut.mp4`
- SHA-256: `7ac087c2ccbf52204423034f8cb3f9487195baeba5bf3dc12e9bdfc91758551a`
- Duration: 261.466667 seconds
- Size: 795,233,256 bytes
- Video: H.264, 1920x1080, 30 fps
- Audio: AAC
- A/V start: 0.000000 / 0.000000
- Duration parity: pass, delta -0.033 seconds

## Live Marlin QA

- Report: `tmp/T-0022-fumoto-growth-T6nZ7P/reports/eval/marlin-qa-fumoto-growth_2026-07-11T08-18-54-830Z.json`
- `visual_qa`: `verified`
- Score: 12/100
- Mock: false (`VOS_MARLIN_MOCK=0`; worker ran without `--mock`)
- Issues: 11 continuity warnings, zero critical issues
- Pacing: within expected range
- Emotion arc: follows brief
- Inference: live, offline, MPS
- Model: `NemoStation/Marlin-2B`
- Snapshot: `fd111fca4fc7897876fb0d7e9df22ca5ac8ab965`
- QA elapsed: 230.26 seconds
- Peak RSS: 2,387,509,248 bytes

## Interpretation

This closes the missing non-mock execution proof for one configured golden project. It does not prove that the 12/100 score is editorially correct.

The current continuity detector creates a key for every individual description token of six or more characters. A single repeated subject, action, color, or location word can therefore produce an 8-point continuity deduction. The 11 warnings reduce the report from 100 to 12 even though there are no critical, pacing, or emotion-arc failures. Because this report evaluates a human-approved chronological growth edit, the continuity findings require calibration review before Marlin score is used as approval authority.

No generated media or model cache should be committed or promoted from this task.
