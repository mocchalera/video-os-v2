# T-0023 togakushi 24p scratch compile and live Marlin evidence

- Date: 2026-07-11 JST
- Goal / feature: G-0002 / F-0035
- Canonical project: `projects/togakushi-camp`
- Corrected scratch project: `tmp/T-0023-togakushi-camp-24p-Uwjrp8`
- Superseded 30p scratch: `tmp/T-0023-togakushi-camp-J7cWdy`
- Promotion: none

## Outcome

All 60 source-map entries and local source paths were available. The approved Togakushi intent, analysis, plan, project state, and source map were copied to an isolated scratch project. The current compiler produced a schema-valid 24p timeline, the Node 22 renderer produced a parity-valid rough cut, and cached Marlin-2B completed a non-mock offline MPS evaluation at 100/100 with zero issues.

The run also exposed a structural drift that prevents promotion: the current timeline retains all 26 approved assets but changes their order, and it is 285 frames / 11.875 seconds / 10.09% shorter than the blueprint target. Visual QA success therefore does not establish agreement with the approved edit.

## Frame-rate correction

The first scratch was compiled at 30 fps and produced 23 clips / 94.032 seconds. It was rejected as the authoritative proof because the creative brief states `4K ProRes 24p`, while the blueprint's 2,825 target frames correspond to 117.708 seconds at 24 fps. That scratch was left intact for diagnosis.

The corrected run used:

```text
Node: v22.23.1
npm:  10.9.8
compile: npx tsx scripts/compile-timeline.ts <scratch> --fps 24
render:  npx tsx scripts/render-rough-cut.ts --project <scratch>
Marlin:  VOS_MARLIN_MOCK=0, VOS_MARLIN_DEVICE=mps,
         HF_HUB_OFFLINE=1, TRANSFORMERS_OFFLINE=1
```

## Timeline

- Canonical legacy SHA-256: `313e7b8d8e3f34377f9c619b20e7bcea39f4acabeb06bd44c0808a7be0361776`
- Corrected current-schema SHA-256: `9309a0680f232a413a04b45999d4a3b4ae09c63c947fb2466a7dd7241f961391`
- Legacy order SHA-256: `84e27976cbbb54eec231b82f81678210af6dbc719f3506a73983a83a11b8e0d9`
- Corrected order SHA-256: `4bf70c1cd1f0ba9b9c0ba52fb0b035a6c60784f06f85736e3fe5074e93cc4d84`
- Video clips: 26 legacy / 26 corrected
- Target: 2,825 frames / 117.708 seconds
- Compiled: 2,540 frames / 105.833 seconds
- Underfill: 285 frames / 11.875 seconds / 10.09%
- Compiler duration status: `short`
- Compiler continuity report: zero reorders, warnings, and errors

All legacy assets are present, but ordering differs within the approved sequence. Examples include `399510B7`, `4E3BBB2A`, `C7D644B1`, `0C10D8D8`, `5D2B5B35`, `B254ED8B`, and `287B7B3F`. This conflicts with the blueprint's `human_golden_order` skill and rejection rule against breaking positions 1–29, despite the compiler reporting zero reorders.

The ordinary self-eval entrypoint cannot compare the legacy timeline directly because it predates the current Timeline IR schema (`sequence` and `provenance` are absent and `tracks` uses the legacy array form).

## Render

- Output: `tmp/T-0023-togakushi-camp-24p-Uwjrp8/09_output/rough-cut.mp4`
- SHA-256: `0d0f0453199d15f7b1d55e24627eab7698f779c1f1b7d4ad77071eb51c58c775`
- Size: 89,638,217 bytes
- Timeline/container duration: 105.833 seconds
- Actual video duration: 105.708008 seconds
- Duration parity: pass, delta -0.125 seconds
- Source clamp / gaps / crossfades: 0 / 0 / 0
- Video: H.264, 1920x1080, 24 fps, start 0
- Audio: AAC-LC, 48 kHz stereo, start 0
- BGM: none

## Live Marlin QA

- Report: `tmp/T-0023-togakushi-camp-24p-Uwjrp8/reports/eval/marlin-qa-togakushi-camp_2026-07-11T09-32-07-373Z.json`
- Report SHA-256: `54ed35426e0462dff7b8b3889877e513d0bb13119e3612ad8cbf7aa148338524`
- `visual_qa`: `verified`
- Score: 100/100
- Mock: false
- Issues: zero critical, warning, and info issues
- Continuity issues: zero
- Pacing: within expected range; 19 events averaging 3.4 seconds
- Emotion arc: follows brief
- Inference: live, offline, MPS
- Model: `NemoStation/Marlin-2B`
- Snapshot: `fd111fca4fc7897876fb0d7e9df22ca5ac8ab965`
- QA elapsed: 94.25 seconds
- Peak RSS: 2,242,887,680 bytes

## Interpretation

D-0012's calibrated continuity detector generalizes to the Togakushi render: no false continuity warning remains. However, Marlin does not detect the approved-order drift or the 10.09% duration underfill. The corrected scratch must not be promoted until a deterministic structural gate preserves or explicitly approves the human golden order and duration policy.

No generated media, scratch artifacts, or model cache should be committed or promoted from this task.
