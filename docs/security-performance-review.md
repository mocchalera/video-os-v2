# Video OS v2 Security / Performance Review

Date: 2026-03-24

Scope:
- `runtime/`
- `scripts/`
- Priority focus: external process invocation (`ffmpeg`, `ffprobe`, `python`), file I/O, project path handling, YAML/JSON parsing

Method:
- Static review of `runtime/` and `scripts/`
- Targeted validation of `yaml@^2.7.0` behavior in the local workspace
- No code changes applied

## Executive Summary

High-risk issues are concentrated in three areas:

1. Shell-string process execution via `execSync(...)` with interpolated file paths.
2. Trusting user-controlled project paths and `source_map` paths without boundary checks.
3. Prototype poisoning in `analysis_policy.yaml` merge logic.

Performance bottlenecks are concentrated in:

1. Serial per-asset processing despite configured parallelism.
2. Excessive `ffmpeg` subprocess counts for derivatives.
3. VLM retry behavior that can multiply latency under rate limits.

## CRITICAL

### CRITICAL-01: Command injection via shell-string `execSync(...)`

Risk:
- Severity: `CRITICAL`
- Likelihood: `Medium`
- Impact: `High`

Affected locations:
- `runtime/media/bgm-analyzer.ts:78-80`
- `runtime/media/bgm-analyzer.ts:106-108`
- `runtime/media/bgm-analyzer.ts:269-271`
- `runtime/media/bgm-analyzer.ts:461-463`
- `runtime/media/bgm-analyzer.ts:751-753`
- `runtime/connectors/bgm-beat-detector.ts:29-31`
- `runtime/connectors/bgm-beat-detector.ts:54-56`
- `runtime/preflight.ts:124-127`

Why this matters:
- These call sites build shell command strings with interpolated file paths such as `audioPath`, `f`, and `sourceFolderPath`.
- A path containing `"`, `` ` ``, `$()`, or other shell metacharacters can break quoting and execute unintended commands.
- This is directly relevant to the requested review points around ffmpeg/ffprobe/python invocation and “file paths with shell metacharacters”.

Concrete examples:
- `runtime/media/bgm-analyzer.ts:269-271`:
  - `python3 -c ... "${audioPath}"`
- `runtime/connectors/bgm-beat-detector.ts:29-31`:
  - `ffmpeg -i "${audioPath}" ...`
- `runtime/preflight.ts:124-127`:
  - `df -k "${sourceFolderPath}"`

Observed safe contrast:
- Most other media connectors correctly use `execFile(...)` with argument arrays, for example:
  - `runtime/connectors/ffprobe.ts:201-207`
  - `runtime/connectors/openai-stt.ts:101-127`
  - `runtime/connectors/pyannote-diarizer.ts:77-111`

Recommended fix:
- Replace all shell-string `execSync(...)` calls that include paths with `execFileSync(...)` or async `execFile(...)`.
- Pass every dynamic value as a separate argument, never through shell quoting.

Fix example:

```ts
import { execFileSync } from "node:child_process";

function getAudioDurationSafe(audioPath: string): number {
  const raw = execFileSync(
    "ffprobe",
    [
      "-v",
      "quiet",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      audioPath,
    ],
    { encoding: "utf-8", timeout: 30_000 },
  );
  return parseFloat(raw.trim()) || 0;
}
```

## WARNING

### WARNING-01: Project path traversal / arbitrary project root selection

Risk:
- Severity: `WARNING`
- Likelihood: `Medium`
- Impact: `High`

Affected locations:
- `runtime/commands/shared.ts:87-93`
- `runtime/commands/shared.ts:97-133`
- `scripts/check-progress.ts:45-56`
- `runtime/compare/timelines.ts:624-636`
- `scripts/compile-timeline.ts:84-95`
- `scripts/compile-timeline.ts:146-164`
- `scripts/analyze.ts:61-62`

Why this matters:
- The codebase generally speaks in terms of `projects/<id>`, but most entry points accept any existing path after `path.resolve(...)`.
- Inputs like `../somewhere-else` are therefore accepted if the target exists.
- For read/write commands, this breaks the intended trust boundary and allows artifacts to be read from or written to arbitrary directories.

Important contrast:
- `scripts/init-project.ts:124-133` validates project IDs correctly.
- That validation is not consistently enforced by the other entry points.

Recommended fix:
- Split “project ID” from “filesystem path”.
- If the contract is `projects/<id>`, validate the ID first, then resolve strictly under the repo’s `projects/` root.

Fix example:

```ts
const PROJECT_ID_RE = /^[A-Za-z0-9._-]+$/;

function resolveProjectRootStrict(repoRoot: string, projectId: string): string {
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new Error(`Invalid project id: ${projectId}`);
  }

  const projectsRoot = path.join(repoRoot, "projects");
  const projectDir = path.join(projectsRoot, projectId);
  const resolved = path.resolve(projectDir);

  if (!resolved.startsWith(projectsRoot + path.sep)) {
    throw new Error(`Project path escapes projects/: ${projectId}`);
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`Project directory does not exist: ${resolved}`);
  }
  return resolved;
}
```

### WARNING-02: `source_map` and clip metadata can point outside the project

Risk:
- Severity: `WARNING`
- Likelihood: `Medium`
- Impact: `High`

Affected locations:
- `runtime/media/source-map.ts:154-200`
- `runtime/media/source-map.ts:203-268`
- `runtime/media/source-map.ts:353-356`
- `runtime/preview/segment-renderer.ts:144-158`
- `runtime/preview/segment-renderer.ts:270-286`
- `runtime/preview/timeline-overview.ts:78-91`
- `runtime/preview/timeline-overview.ts:201-214`
- `runtime/render/assembler.ts:625-671`
- `scripts/export-premiere-xml.ts:103-116`

Why this matters:
- `loadSourceMap(...)` accepts absolute paths and resolves relative paths without verifying that they stay inside an allowed root.
- Preview/render code then trusts `local_source_path`, `source_locator`, `link_path`, and even `clip.metadata.source_path`.
- A malicious `02_media/source_map.json` or imported timeline can therefore make the pipeline read arbitrary host files and hand them to `ffmpeg`.

Specific requested concern:
- This directly covers the requested review point around validating `source_map` / `source_path`.

Recommended fix:
- Introduce a single path guard for media inputs.
- Allow only explicit safe roots, for example:
  - `<project>/00_sources`
  - `<project>/02_media`
  - optionally configured external media roots
- Reject absolute paths unless they fall under one of those roots.

Fix example:

```ts
function isWithin(root: string, candidate: string): boolean {
  const absRoot = path.resolve(root);
  const absCandidate = path.resolve(candidate);
  return absCandidate === absRoot || absCandidate.startsWith(absRoot + path.sep);
}

function assertAllowedMediaPath(projectDir: string, candidate: string): string {
  const allowedRoots = [
    path.join(projectDir, "00_sources"),
    path.join(projectDir, "02_media"),
  ];
  const resolved = path.resolve(candidate);

  if (!allowedRoots.some((root) => isWithin(root, resolved))) {
    throw new Error(`Media path escapes allowed roots: ${resolved}`);
  }
  return resolved;
}
```

### WARNING-03: Prototype poisoning in `analysis_policy.yaml` merge path

Risk:
- Severity: `WARNING`
- Likelihood: `Medium`
- Impact: `Medium`

Affected locations:
- `package.json:15-20`
- `runtime/policy-resolver.ts:18-40`
- `runtime/policy-resolver.ts:88-90`

Why this matters:
- `yaml.parse(...)` from `yaml@^2.7.0` preserves keys like `__proto__`.
- The custom `deepMerge(...)` then writes those keys into `{ ...base }`.
- In JavaScript, assigning `result["__proto__"] = ...` mutates the prototype of `result`.
- I verified this behavior locally in this workspace: a parsed YAML override containing `__proto__` produced a merged policy object with attacker-controlled prototype properties.

Important nuance:
- This is not global `Object.prototype` pollution in the current code path.
- It is still dangerous object-level prototype poisoning on the resolved policy object.

Recommended fix:
- Reject dangerous keys during parse/merge:
  - `__proto__`
  - `constructor`
  - `prototype`
- Prefer null-prototype records for config objects.

Fix example:

```ts
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function deepMergeSafe(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);

  for (const [key, value] of Object.entries(base)) {
    if (!DANGEROUS_KEYS.has(key)) result[key] = value;
  }

  for (const [key, value] of Object.entries(override)) {
    if (DANGEROUS_KEYS.has(key)) {
      throw new Error(`Dangerous config key rejected: ${key}`);
    }

    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      result[key] &&
      typeof result[key] === "object" &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMergeSafe(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}
```

### WARNING-04: Per-asset processing is largely serial, and configured parallelism is unused

Risk:
- Severity: `WARNING`
- Likelihood: `High`
- Impact: `High`

Affected locations:
- `runtime/pipeline/stages/ingest-map.ts:29-37`
- `runtime/pipeline/stages/stt.ts:99-120`
- `runtime/pipeline/stages/derivatives.ts:29-38`
- `runtime/analysis-defaults.yaml:70-73`

Why this matters:
- `ingestMap`, `sttMap`, and `derivativesMap` each iterate assets with `for ... of` and `await` inside the loop.
- The policy already defines `parallelism.ffmpeg_jobs`, `stt_jobs`, and `vlm_jobs`, but those values are not consumed anywhere.
- On projects with many assets, wall-clock time scales linearly even when the host has spare CPU/network capacity.

Recommended fix:
- Introduce bounded concurrency per stage.
- Reuse a shared helper similar to `mapWithConcurrency(...)` already present in `runtime/pipeline/stages/vlm.ts:116-139`.

Fix example:

```ts
const jobs = policy.parallelism?.ffmpeg_jobs ?? 4;

await mapWithConcurrency(assets, jobs, async (asset) => {
  const file = sourceFileMap.get(asset.asset_id);
  if (!file) return;
  const derivs = await generateAllDerivatives(file, asset, segmentShards.get(asset.asset_id) ?? [], outputDir);
  results.set(asset.asset_id, derivs);
});
```

### WARNING-05: Derivative generation creates too many `ffmpeg` subprocesses

Risk:
- Severity: `WARNING`
- Likelihood: `High`
- Impact: `High`

Affected locations:
- `runtime/connectors/ffmpeg-derivatives.ts:83-96`
- `runtime/connectors/ffmpeg-derivatives.ts:118-154`
- `runtime/connectors/ffmpeg-derivatives.ts:231-243`
- `runtime/connectors/ffmpeg-derivatives.ts:252-287`
- `runtime/connectors/ffmpeg-derivatives.ts:437-450`
- `runtime/connectors/ffmpeg-derivatives.ts:462-468`
- `runtime/connectors/ffmpeg-derivatives.ts:529-558`
- `runtime/connectors/ffmpeg-segmenter.ts:717-741`

Why this matters:
- Contact sheets extract each tile with a separate `ffmpeg` run, then run another `ffmpeg` to tile them.
- Filmstrips extract six frames per segment, then run another `ffmpeg` to stitch them.
- `segmentAsset(...)` also performs six full-file `ffmpeg` passes per asset.
- The resulting subprocess count becomes very high on long videos or projects with many segments.

Practical impact:
- CPU oversubscription
- Disk I/O amplification
- Large startup overhead from repeated `ffmpeg` process creation

Recommended fix:
- Short term: add bounded concurrency and reuse shared probes/results where possible.
- Medium term: convert frame extraction workflows to single-pass `ffmpeg` invocations using `select`, `fps`, `tile`, or sprite-sheet generation.

Fix example:

```ts
await execFilePromise("ffmpeg", [
  "-y",
  "-i",
  filePath,
  "-vf",
  "fps=1/2,scale=320:-1,tile=4x4",
  "-frames:v",
  "1",
  absImagePath,
]);
```

### WARNING-06: VLM retry logic can amplify latency and stall runs

Risk:
- Severity: `WARNING`
- Likelihood: `Medium`
- Impact: `Medium`

Affected locations:
- `runtime/pipeline/stages/vlm.ts:141-160`
- `runtime/pipeline/stages/vlm.ts:284-325`
- `runtime/pipeline/stages/vlm.ts:456-498`
- `runtime/connectors/gemini-vlm.ts:461-495`
- `runtime/connectors/gemini-vlm.ts:554-607`
- `runtime/analysis-defaults.yaml:30-40`

Why this matters:
- Retry is triggered only for rate-limit style errors.
- Each VLM call may retry up to 5 times, and `enrichSegment(...)` may also do parse-repair retries (`parse_retry_max: 1` by default).
- This makes the worst-case request count multiplicative.
- There is no explicit fetch timeout or abort controller on the Gemini API call.
- Per-asset VLM work is parallelized across assets, but segments within an asset are still processed serially.

Recommended fix:
- Add request timeouts.
- Add jitter to backoff.
- Add a total retry budget per asset/job, not only per request.
- Consider segment-level bounded concurrency where cost controls allow it.

Fix example:

```ts
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const jitterMs = Math.random() * delayMs * 0.25;
await sleepFn(Math.min(delayMs + jitterMs, policy.maxDelayMs));
```

## NOTE

### NOTE-01: `--content-hint` is not a local command injection vector

Affected locations:
- `scripts/analyze.ts:79-80`
- `scripts/analyze.ts:215-230`
- `runtime/pipeline/stages/vlm.ts:490-498`
- `runtime/connectors/gemini-vlm.ts:431-438`

Observation:
- `--content-hint` is carried into the VLM prompt only.
- I did not find any local `execFile`, `spawn`, or shell invocation that interpolates `contentHint`.
- This is a prompt-injection / model-steering concern, not a shell command injection concern.

Assessment:
- No local OS command injection issue found for `--content-hint`.

### NOTE-02: JSON parse handling is inconsistent; some paths fail safely, others hard-crash

Affected locations:
- Safe pattern:
  - `runtime/validation/schema-validator.ts:154-172`
- Hard-crash patterns:
  - `runtime/media/source-map.ts:141-143`
  - `runtime/media/source-map.ts:217-218`
  - `runtime/artifacts/loaders.ts:75-85`
  - `scripts/compile-timeline.ts:156-164`
  - `runtime/render/assembler.ts:565-568`
  - `runtime/mcp/repository.ts:214-240`

Why this matters:
- Some callers wrap parse errors and surface useful validation messages.
- Many others call `JSON.parse(...)` directly on user-editable project artifacts and will throw raw exceptions.
- This is mostly a robustness issue rather than a direct exploit, but it will produce brittle operator behavior.

Recommended fix:
- Centralize a `safeReadJson(...)` helper and reuse it everywhere user-edited artifacts are loaded.

Fix example:

```ts
function safeReadJson<T>(filePath: string, label: string): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${label} parse failed (${filePath}): ${message}`);
  }
}
```

### NOTE-03: `ffprobe` is not wildly duplicated in the main ingest path, but BGM detection adds extra probe passes

Affected locations:
- Main ingest:
  - `runtime/pipeline/stages/ingest-map.ts:29-37`
  - `runtime/connectors/ffprobe.ts:199-208`
- BGM detection:
  - `runtime/media/bgm-analyzer.ts:459-466`
  - `runtime/media/bgm-analyzer.ts:744-761`

Observation:
- Main ingest performs one `ffprobe` pass per asset, which is reasonable.
- Audio-only BGM candidates incur extra probe-like work:
  - one ingest `ffprobe`
  - one `detectBgmFiles(...)` `ffprobe`
  - one `getAudioDuration(...)` `ffprobe`

Assessment:
- This is a `NOTE`, not a top-tier bottleneck.
- It is still worth collapsing into a reused metadata object for audio-only assets.

### NOTE-04: Contact sheet / filmstrip generation uses temp files, so JS heap pressure is lower than process-count pressure

Affected locations:
- `runtime/connectors/ffmpeg-derivatives.ts:82-96`
- `runtime/connectors/ffmpeg-derivatives.ts:164-167`
- `runtime/connectors/ffmpeg-derivatives.ts:230-243`
- `runtime/connectors/ffmpeg-derivatives.ts:297-298`
- `runtime/connectors/ffmpeg-derivatives.ts:437-450`
- `runtime/connectors/ffmpeg-derivatives.ts:474-477`

Observation:
- The current implementation writes intermediate frames to temp files and deletes them after assembly.
- I did not find a pattern where large image buffers are retained in JS memory for contact sheet / filmstrip assembly.

Assessment:
- The primary risk here is subprocess explosion and temp-file churn, not JS heap retention.

### NOTE-05: Legacy BGM detector reads full audio files into memory; newer analyzer is better

Affected locations:
- Full-file reads:
  - `runtime/connectors/bgm-beat-detector.ts:226-227`
  - `runtime/connectors/bgm-beat-detector.ts:260-261`
- Better bounded read:
  - `runtime/media/bgm-analyzer.ts:473-479`

Observation:
- `runtime/connectors/bgm-beat-detector.ts` hashes the full file buffer, and does so twice on the happy path.
- `runtime/media/bgm-analyzer.ts` only hashes the first 16 MB, which is much cheaper.

Assessment:
- If the legacy detector remains in use, switch it to a streaming hash or a bounded prefix hash.

## Risk Matrix

| ID | Severity | Likelihood | Impact | Priority |
| --- | --- | --- | --- | --- |
| CRITICAL-01 | CRITICAL | Medium | High | P0 |
| WARNING-01 | WARNING | Medium | High | P1 |
| WARNING-02 | WARNING | Medium | High | P1 |
| WARNING-03 | WARNING | Medium | Medium | P1 |
| WARNING-04 | WARNING | High | High | P1 |
| WARNING-05 | WARNING | High | High | P1 |
| WARNING-06 | WARNING | Medium | Medium | P2 |
| NOTE-02 | NOTE | High | Low | P2 |
| NOTE-03 | NOTE | Medium | Low | P3 |
| NOTE-05 | NOTE | Medium | Low | P3 |

## Recommended Remediation Order

1. Eliminate shell-string `execSync(...)` for all path-bearing external process calls.
2. Enforce strict project-root and media-path boundary checks.
3. Harden YAML config merge against dangerous keys and null-prototype issues.
4. Apply bounded concurrency to ingest/STT/derivatives and start consuming `parallelism.*`.
5. Reduce `ffmpeg` process counts in derivative generation.
6. Add timeout + jitter + retry budgeting to Gemini VLM calls.
7. Normalize JSON parse error handling across user-edited artifacts.
