# Render fix verification

Date: 2026-06-20

Commands:

```bash
DOTENV_CONFIG_PATH=.env.local NODE_OPTIONS="-r dotenv/config" npx tsx scripts/render-rough-cut.ts --project projects/lively-talk-pv
DOTENV_CONFIG_PATH=.env.local NODE_OPTIONS="-r dotenv/config" npx tsx scripts/render-rough-cut.ts --project projects/ena-promo-ai
```

## lively-talk-pv

Result: pass. The re-rendered output is no longer truncated to the prior 39.875s duration.

| Metric | Before fix | After fix |
|---|---:|---:|
| Rendered duration | 39.875s | 46.250s |
| Expected duration | 46.250s | 46.302s |
| Parity delta | -6.375s | -0.052s |
| Parity pass | false | true |
| File size | 30,723,858 bytes | 34,255,205 bytes |
| Video frames | 957 | 1110 |

Render stdout:

```text
Rendered rough cut: /Users/operator/Dev/video-os-v2-spec/projects/lively-talk-pv/09_output/rough-cut.mp4
  Clips: 21
  Crossfades: 1
  Duration: 46.3s
  File size: 32.67 MB
```

`projects/lively-talk-pv/09_output/render-report.json`:

```json
{
  "timeline_span_sec": 57.333,
  "timeline_content_sec": 47,
  "gap_sec": 10.333,
  "gap_count": 3,
  "crossfade_overlap_sec": 0.5,
  "source_clamp_sec": 0.198,
  "expected_rendered_sec": 46.302,
  "actual_rendered_sec": 46.25,
  "parity_delta_sec": -0.052,
  "parity_pass": true
}
```

`ffprobe` after re-render:

```json
{
  "streams": [
    {
      "duration": "46.250000",
      "nb_frames": "1110"
    }
  ],
  "format": {
    "duration": "46.250000",
    "size": "34255205"
  }
}
```

## ena-promo-ai regression check

Result: pass. The re-render stayed close to expected duration and passed parity.

Pre-run file on disk in this verification pass:

```json
{
  "streams": [
    {
      "duration": "57.291667",
      "nb_frames": "1375"
    }
  ],
  "format": {
    "duration": "57.291667",
    "size": "35990457"
  }
}
```

Render stdout:

```text
Rendered rough cut: /Users/operator/Dev/video-os-v2-spec/projects/ena-promo-ai/09_output/rough-cut.mp4
  Clips: 19
  Crossfades: 15
  Duration: 57.1s
  File size: 34.14 MB
```

`projects/ena-promo-ai/09_output/render-report.json`:

```json
{
  "timeline_span_sec": 87.083,
  "timeline_content_sec": 64.833,
  "gap_sec": 22.25,
  "gap_count": 4,
  "crossfade_overlap_sec": 7.5,
  "source_clamp_sec": 0,
  "expected_rendered_sec": 57.333,
  "actual_rendered_sec": 57.125,
  "parity_delta_sec": -0.208,
  "parity_pass": true
}
```

`ffprobe` after re-render:

```json
{
  "streams": [
    {
      "duration": "57.125000",
      "nb_frames": "1371"
    }
  ],
  "format": {
    "duration": "57.125000",
    "size": "35802448"
  }
}
```

## Remaining issues

- No duration regression found in either render.
- Both renders emitted the existing Node warning: `NO_COLOR` is ignored because `FORCE_COLOR` is set. It did not affect render success or duration accounting.
- `projects/*/09_output` artifacts appear to be Git-ignored, so the persistent checked-in evidence from this run is this report.
