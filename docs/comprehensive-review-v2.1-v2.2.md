# Comprehensive Code Review: Video OS v2.1 + v2.2 + Phase 1 NLE

**Review date**: 2026-03-24
**Scope**: 17 commits from `0c3c1e3` to `7fc51b5` (Dev branch)
**Reviewer**: Claude Opus 4.6 (automated)

---

## Executive Summary

The reviewed commits implement three major initiatives:
1. **v2.1 Roadmap** (M4–M5): BGM beat analysis, Premiere roundtrip E2E, real QA measurement
2. **v2.2 Roadmap** (V22-01–V22-09): FCP7 regression fixes, atomic state writes, pipeline decomposition, canonical artifact types, CLI smoke tests
3. **Phase 1 NLE Improvement**: FCP7 XML parameter coverage expanded from 50% → 85%+ (audio gain, fade keyframes, transitions, markers)

**Overall Quality Grade: B+**

The code demonstrates strong architectural decisions (pipeline decomposition, atomic writes, revision guard), comprehensive test coverage for critical paths, and careful handling of NLE interchange format quirks. The primary concerns are command injection risks in `bgm-analyzer.ts` and some missing edge case handling.

---

## Findings

### CRITICAL — Must Fix

---

#### C-01: Command Injection in bgm-analyzer.ts via `execSync` shell strings

**Files**: `runtime/media/bgm-analyzer.ts:78-79`, `:106-107`, `:269-270`, `:461-462`, `:751-752`

**Issue**: Multiple `execSync` calls interpolate `audioPath` directly into shell command strings without sanitization. An audio file path containing shell metacharacters (`;`, `$()`, backticks, `|`) could execute arbitrary commands.

```typescript
// Line 78-79 — VULNERABLE
const raw = execSync(
  `aubiotrack -i "${audioPath}" -B 1024 -H 512`,
  { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 120_000 },
);

// Line 106-107 — VULNERABLE
const raw = execSync(
  `ffmpeg -i "${audioPath}" -af "ebur128=peak=true:framelog=verbose" -f null - 2>&1`,
  { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, timeout: 120_000 },
);

// Line 269-270 — VULNERABLE (Python script + audioPath)
const raw = execSync(
  `python3 -c ${JSON.stringify(script)} "${audioPath}"`,
  { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, timeout: 300_000 },
);

// Line 461-462 — VULNERABLE
const raw = execSync(
  `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${audioPath}"`,
  { encoding: "utf-8", timeout: 30_000 },
);

// Line 751-752 — VULNERABLE
const probe = execSync(
  `ffprobe -v quiet -show_streams -select_streams v -of csv=p=0 "${f}"`,
  { encoding: "utf-8", timeout: 10_000 },
);
```

**Impact**: High — file paths come from user-provided source folders. A crafted filename could execute arbitrary commands.

**Risk in practice**: Medium — file paths originate from local filesystem scans, but could come from shared drives, downloaded archives, or other untrusted sources.

**Fix**: Replace `execSync` with `execFileSync` (array-based arguments, no shell interpretation):

```typescript
import { execFileSync } from "node:child_process";

// detectBeatsViaAubio — fixed
const raw = execFileSync(
  "aubiotrack",
  ["-i", audioPath, "-B", "1024", "-H", "512"],
  { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 120_000 },
);

// extractEbur128Profile — fixed
const raw = execFileSync(
  "ffmpeg",
  ["-i", audioPath, "-af", "ebur128=peak=true:framelog=verbose", "-f", "null", "-"],
  { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, timeout: 120_000 },
);
// Note: ebur128 output goes to stderr; capture via stdio option:
// stdio: ["pipe", "pipe", "pipe"] and read stderr separately

// getAudioDuration — fixed
const raw = execFileSync(
  "ffprobe",
  ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", audioPath],
  { encoding: "utf-8", timeout: 30_000 },
);

// analyzeViaLibrosa — fixed
const raw = execFileSync(
  "python3",
  ["-c", script, audioPath],
  { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, timeout: 300_000 },
);

// detectBgmFiles — fixed
const probe = execFileSync(
  "ffprobe",
  ["-v", "quiet", "-show_streams", "-select_streams", "v", "-of", "csv=p=0", f],
  { encoding: "utf-8", timeout: 10_000 },
);
```

**Note**: The `extractEbur128Profile` call uses `2>&1` shell redirection to capture stderr. With `execFileSync`, you need `stdio: ["pipe", "pipe", "pipe"]` and read the result from the stderr buffer. Alternatively, use the async `execFile` pattern already established in `qa-measure.ts`.

---

#### C-02: Fade-out keyframe may produce negative `when` value

**File**: `runtime/handoff/fcp7-xml-export.ts:743`

**Issue**: When `fadeOutFrames >= clipDur`, `fadeOutStart` becomes negative or zero, which can produce a keyframe with `<when>` at a negative frame position or create overlapping keyframes with fade-in.

```typescript
// Line 743
const fadeOutStart = clipDur - fadeOutFrames!;
// If fadeOutFrames > clipDur, fadeOutStart < 0
```

**Impact**: Invalid XML that Premiere Pro may reject or misinterpret.

**Fix**:

```typescript
const fadeOutStart = Math.max(0, clipDur - fadeOutFrames!);
// Also guard against overlap with fade-in
const effectiveFadeOutStart = Math.max(
  hasFadeIn ? fadeInFrames! : 0,
  fadeOutStart,
);
```

---

#### C-03: `extractEbur128Profile` silently captures stderr via `2>&1` but `execSync` only returns stdout

**File**: `runtime/media/bgm-analyzer.ts:106-108`

**Issue**: The command `ffmpeg ... 2>&1` redirects stderr to stdout, which works with `execSync` (shell=true). However, if this is fixed to use `execFileSync` (per C-01), the `2>&1` pattern won't work since `execFileSync` doesn't use a shell.

Additionally, on the current code path, if ffmpeg writes very large ebur128 output, the 50MB maxBuffer may be insufficient for very long audio files (>2 hours at 100ms resolution = ~72000 lines of output).

**Impact**: Silent data loss for long audio files.

**Fix**: Use `execFile` (async, like `qa-measure.ts` already does) and capture stderr separately:

```typescript
import { execFile } from "node:child_process";

function execFilePromise(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 100 * 1024 * 1024 }, (err, stdout, stderr) => {
      // ffmpeg exits non-zero for -f null, so check stderr content instead
      if (err && !stderr) { reject(err); return; }
      resolve({ stdout, stderr });
    });
  });
}
```

---

### WARNING — Recommended Fix

---

#### W-01: Atomic write temp file cleanup not guaranteed on process crash

**Files**: `runtime/state/reconcile.ts:556-558`, `runtime/pipeline/stages/_util.ts:15-17`

**Issue**: Atomic write uses temp file + rename, but if the process crashes between `writeFileSync` and `renameSync`, orphaned `.tmp.<pid>` files persist.

```typescript
// reconcile.ts:556-558
const tmp = stateFile + ".tmp." + process.pid;
fs.writeFileSync(tmp, content, "utf-8");
fs.renameSync(tmp, stateFile);
```

**Impact**: Low — stale temp files accumulate but don't corrupt state. On recovery, `readProjectState` ignores them.

**Recommendation**: Add a cleanup sweep in `reconcile()` to remove stale `.tmp.*` files:

```typescript
// At the start of reconcile()
const stateDir = path.dirname(stateFile);
for (const entry of fs.readdirSync(stateDir)) {
  if (entry.startsWith("project_state.yaml.tmp.")) {
    try { fs.unlinkSync(path.join(stateDir, entry)); } catch { /* ignore */ }
  }
}
```

---

#### W-02: Revision guard has TOCTOU race window

**File**: `runtime/state/reconcile.ts:541-558`

**Issue**: Between reading the file to check the revision (line 543-544) and writing the new content (line 557-558), another process could modify the file. The revision check is not atomic.

```typescript
if (options?.expectedRevision) {
  if (fs.existsSync(stateFile)) {
    const currentRaw = fs.readFileSync(stateFile, "utf-8");  // T1: read
    const currentRevision = computeRevision(currentRaw);
    if (currentRevision !== options.expectedRevision) {
      throw new ConflictError(options.expectedRevision, currentRevision);
    }
  }
  // GAP: another process writes here
}
// T2: write happens below
const tmp = stateFile + ".tmp." + process.pid;
fs.writeFileSync(tmp, content, "utf-8");
fs.renameSync(tmp, stateFile);
```

**Impact**: Low for single-user CLI, but could lose writes if multiple agent sessions reconcile simultaneously.

**Recommendation**: Use OS-level file locking (e.g., `proper-lockfile` package) or accept the current best-effort approach with a comment documenting the known limitation.

---

#### W-03: XML parser does not handle CDATA sections

**File**: `runtime/handoff/fcp7-xml-import.ts:148-171`

**Issue**: The custom XML parser explicitly documents "No CDATA", but some NLE plugins (e.g., After Effects Export) may produce `<![CDATA[...]]>` sections in FCP7 XML. The parser would throw an error on encountering these.

**Impact**: Import failure for XML from certain NLE tools (not Premiere Pro core, but plugin-generated).

**Recommendation**: Add a pre-strip for CDATA sections, converting them to text content:

```typescript
// Add after comment stripping (line 162)
cleaned = cleaned.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, content) => escapeXmlChars(content));
```

---

#### W-04: `linearGainToDb` returns `-Infinity` which serializes to `null` in JSON

**File**: `runtime/handoff/fcp7-xml-export.ts:106`

**Issue**: When gain ≤ 0, `linearGainToDb` returns `-Infinity`. If this value is ever serialized to JSON (e.g., in the import's `buildAudioPolicy`), `JSON.stringify(-Infinity)` produces `null`.

```typescript
export function linearGainToDb(gain: number): number {
  if (gain <= 0) return -Infinity;  // JSON.stringify(-Infinity) === "null"
  return 20 * Math.log10(gain);
}
```

**Impact**: Loss of audio gain information during roundtrip for muted clips.

**Recommendation**: Return a sentinel like `-96` (practical silence threshold) instead:

```typescript
if (gain <= 0) return -96; // practical silence floor
```

---

#### W-05: `any` type usage in `music-cues.ts` and `caption/approval.ts`

**Files**: `runtime/audio/music-cues.ts:183,217`, `runtime/caption/approval.ts:108,111`

**Issue**: Several functions accept `any` typed parameters instead of proper `TimelineIR` types:

```typescript
// music-cues.ts:183
export function projectMusicToTimeline(timeline: any, doc: MusicCuesDoc, fps: number): any {
// caption/approval.ts:108
timeline: any,
```

**Impact**: Type errors not caught at compile time; refactoring is more fragile.

**Recommendation**: Import and use `TimelineIR` type from `runtime/compiler/types.ts`.

---

#### W-06: `usToFrames` rounding may produce 1-frame drift across roundtrip

**File**: `runtime/handoff/fcp7-xml-export.ts:194-196`

**Issue**: `Math.round((us / 1_000_000) * fps)` introduces floating-point rounding error. For NTSC timebases (29.97fps), this can produce ±1 frame drift that accumulates across clips.

```typescript
private usToFrames(us: number): number {
  return Math.round((us / 1_000_000) * this.fps);
}
```

The import side uses a tolerance of 1 frame (line 1059), which partially compensates, but the drift is not fully bidirectional.

**Impact**: Minor visual mismatch (1 frame at cuts) after Premiere roundtrip.

**Recommendation**: Use exact rational arithmetic for NTSC:

```typescript
private usToFrames(us: number): number {
  // For NTSC: frames = us * fps_num / (1_000_000 * fps_den)
  return Math.round((us * this.fpsNum) / (1_000_000 * this.fpsDen));
}
```

---

#### W-07: `parsedSequenceToTimelineIR` assumes NTSC flag means `fps_den=1001` but doesn't set it

**File**: `runtime/handoff/fcp7-xml-import.ts:884-886`

**Issue**: When constructing the base timeline from an imported sequence, `fps_den` is always set to `1`:

```typescript
sequence: {
  name: parsed.name,
  fps_num: parsed.timebase,
  fps_den: 1,  // Always 1, even for NTSC
```

But for NTSC content (ntsc=TRUE, timebase=30), the actual FPS is 29.97 = 30000/1001, meaning `fps_num` should be `30000` and `fps_den` should be `1001`.

**Impact**: NTSC roundtrip produces incorrect frame calculations if no reference timeline is provided.

**Recommendation**:

```typescript
fps_num: parsed.ntsc ? parsed.timebase * 1000 : parsed.timebase,
fps_den: parsed.ntsc ? 1001 : 1,
```

---

#### W-08: `mergeDetectedWithGrid` has O(n×m) complexity

**File**: `runtime/media/bgm-analyzer.ts:646-666`

**Issue**: For each grid beat, the function iterates all detected beats to find the closest match. For a 5-minute song at 120 BPM (600 beats × 600 detected), this is 360K iterations.

```typescript
function mergeDetectedWithGrid(
  detected: BeatEvent[],
  grid: BeatEvent[],
  toleranceSec: number = 0.1,
): BeatEvent[] {
  return grid.map((g) => {
    let bestMatch: BeatEvent | undefined;
    let bestDist = Infinity;
    for (const d of detected) {  // O(m) per grid beat
      const dist = Math.abs(d.time_sec - g.time_sec);
      // ...
    }
  });
}
```

**Impact**: Low for typical use (sub-second for 10-minute tracks), but could be slow for very long audio.

**Recommendation**: Since both arrays are sorted by time, use a sliding-window approach:

```typescript
function mergeDetectedWithGrid(...): BeatEvent[] {
  let dIdx = 0;
  return grid.map((g) => {
    let bestMatch: BeatEvent | undefined;
    let bestDist = Infinity;
    // Only look at detected beats near the current grid position
    while (dIdx > 0 && detected[dIdx - 1].time_sec >= g.time_sec - toleranceSec) dIdx--;
    for (let j = dIdx; j < detected.length; j++) {
      const dist = Math.abs(detected[j].time_sec - g.time_sec);
      if (dist > toleranceSec && detected[j].time_sec > g.time_sec) break;
      if (dist < bestDist) { bestDist = dist; bestMatch = detected[j]; }
    }
    return { time_sec: g.time_sec, strength: bestMatch ? bestMatch.strength : g.strength * 0.5 };
  });
}
```

---

#### W-09: `computeSourceHash` leaks file descriptor on error

**File**: `runtime/media/bgm-analyzer.ts:473-479`

**Issue**: If `fs.readSync` or `fs.fstatSync` throws, the file descriptor opened by `fs.openSync` is never closed.

```typescript
function computeSourceHash(audioPath: string): string {
  const fd = fs.openSync(audioPath, "r");
  const chunkSize = 16 * 1024 * 1024;
  const buf = Buffer.alloc(Math.min(chunkSize, fs.fstatSync(fd).size));
  fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);  // Not reached if readSync throws
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}
```

**Recommendation**: Use try/finally:

```typescript
function computeSourceHash(audioPath: string): string {
  const fd = fs.openSync(audioPath, "r");
  try {
    const chunkSize = 16 * 1024 * 1024;
    const buf = Buffer.alloc(Math.min(chunkSize, fs.fstatSync(fd).size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return createHash("sha256").update(buf).digest("hex").slice(0, 16);
  } finally {
    fs.closeSync(fd);
  }
}
```

---

#### W-10: Re-export barrel files don't re-export all symbols from decomposed modules

**Files**: `runtime/commands/blueprint/index-reexports.ts`, `runtime/handoff/import/index-reexports.ts`

**Issue**: The `index-reexports.ts` files export a curated subset of symbols, but the parent barrel files (`blueprint.ts`, `import.ts`) use `export * from "./blueprint/index.js"` / `export * from "./import/index.js"`. If any consumer was importing from the old monolithic module path, they would lose access to symbols not re-exported.

The `index-reexports.ts` for blueprint exports only 4 functions:
```typescript
export { buildDefaultPhases, runNarrativeLoop } from "./narrative.js";
export { recordAutonomousConfirmedPreferences, validateConfirmedPreferences } from "./preferences.js";
export { buildDefaultStubBlueprint } from "./stub.js";
```

While `index.ts` likely exports the main `runBlueprintCommand` function.

**Impact**: Any consumer importing `buildDefaultPhases` from `runtime/commands/blueprint.ts` would still work, but the split between `index.ts` and `index-reexports.ts` is unusual and could cause confusion.

**Recommendation**: Verify that all previously public symbols are re-exported. Consider using a single `index.ts` that re-exports everything.

---

### NOTE — Improvement Suggestions

---

#### N-01: `TextEncoder` instantiation in hot loop

**File**: `runtime/handoff/fcp7-xml-export.ts:259`

**Issue**: `new TextEncoder()` is created for every character of every path segment during percent-encoding. TextEncoder is stateless and should be instantiated once.

```typescript
// Inside the inner map callback, called per character
const bytes = new TextEncoder().encode(ch);
```

**Recommendation**: Move to module scope or class field:

```typescript
private readonly textEncoder = new TextEncoder();
```

---

#### N-02: Pipeline stage files lack unified error reporting

**Files**: `runtime/pipeline/stages/*.ts`

**Issue**: Stage files use `console.log` / `console.warn` directly for progress reporting. There's no unified error reporter interface, making it hard to redirect output in testing or integrate with structured logging.

**Recommendation**: The VLM stage already has a `VlmProgressReporter` interface (vlm.ts:70-73). Consider extending this pattern to all stages.

---

#### N-03: `reconcile()` doesn't persist its result

**File**: `runtime/state/reconcile.ts:563-682`

**Issue**: `reconcile()` computes the reconciled state and returns it, but never calls `writeProjectState()`. The caller is responsible for persisting. This is by design (separation of concerns), but it means reconcile can produce stale results if called multiple times without writing.

**Recommendation**: Document this contract explicitly, or add an optional `persist: boolean` parameter.

---

#### N-04: FCP7 XML exporter doesn't emit sequence-level markers for `extraMarkers`

**File**: `runtime/handoff/fcp7-xml-export.ts:145-189`

**Issue**: The `extraMarkers` option is declared in `Fcp7ExportOptions` (line 45) but never consumed in the `build()` method. The markers defined in the interface are never emitted into the XML.

**Recommendation**: Add marker emission after the sequence `<timecode>` block:

```typescript
// After appendTimecode(lines, 4, totalFrames);
if (this.opts.extraMarkers && this.opts.extraMarkers.length > 0) {
  for (const marker of this.opts.extraMarkers) {
    this.appendExtraMarker(lines, 4, marker);
  }
}
```

---

#### N-05: `writeTimeline` in `compiler/export.ts` does not use atomic write

**File**: `runtime/compiler/export.ts:131-138`

**Issue**: `writeTimeline` uses plain `writeFileSync` instead of the atomic temp+rename pattern established in `_util.ts`. A crash during write could produce a truncated `timeline.json`.

```typescript
export function writeTimeline(timeline: TimelineIR, projectPath: string): string {
  // ...
  fs.writeFileSync(outPath, JSON.stringify(timeline, null, 2), "utf-8");
  return outPath;
}
```

**Recommendation**: Use `atomicWriteJson` from `runtime/pipeline/stages/_util.ts`.

---

#### N-06: Test coverage gaps

**Observations**:
- `tests/fcp7-xml-export.test.ts` (431 lines) and `tests/fcp7-roundtrip.test.ts` (200+ lines) provide excellent coverage for the FCP7 path.
- `tests/state-concurrency.test.ts` (356 lines) thoroughly tests the atomic write + ConflictError.
- `tests/bgm-analyzer.test.ts` (106 lines) covers basic happy paths.
- **Missing**: No negative test for malformed XML in the FCP7 parser (e.g., unterminated tags, invalid UTF-8, extremely deep nesting).
- **Missing**: No test for `extraMarkers` (which is currently a dead code path — see N-04).
- **Missing**: No boundary test for `fadeOutFrames >= clipDur` (related to C-02).
- **Missing**: No test for NTSC roundtrip without a reference timeline (related to W-07).

---

#### N-07: `makeFailed` discards the `_reason` parameter

**File**: `runtime/media/bgm-analyzer.ts:703-708`

**Issue**: The `_reason` parameter is prefixed with underscore (unused) but could be valuable for debugging:

```typescript
function makeFailed(
  opts: BgmAnalyzerOptions,
  meter: string,
  sampleRate: number,
  _reason: string,  // never used
): BgmAnalysisResult {
```

**Recommendation**: Store the reason in a `failure_reason` field on the result (or in `provenance`).

---

#### N-08: Pipeline stage decomposition is well-executed

**File**: `runtime/pipeline/stages/*.ts`

**Positive note**: The refactor from `4731bf8` decomposed 6 large monolithic modules (ingest.ts at 1574 lines, vlm-analysis.ts at 441 lines, etc.) into focused stage modules averaging ~100-250 lines each. The shared `_util.ts` provides consistent atomic write helpers. The `pipeline-types.ts` shared types maintain type safety across stages.

---

#### N-09: Schema validation in artifact loaders is a strong pattern

**File**: `runtime/artifacts/loaders.ts`

**Positive note**: The typed loaders with JSON Schema validation provide excellent defense-in-depth. The `ArtifactValidationError` class with structured errors is well-designed for debugging. The AJV-based validation with `allErrors: true` gives comprehensive error messages.

---

#### N-10: State reconcile engine is well-designed

**File**: `runtime/state/reconcile.ts`

**Positive note**: The invalidation matrix, state reconstruction from filesystem truth, and self-healing pattern form a robust state machine. The separation of concern between hash detection, state inference, and gate computation is clean. The `ConflictError` class and revision guard add meaningful concurrency safety for the CLI use case.

---

## Summary by Review Dimension

### 1. Security

| Rating | Details |
|--------|---------|
| **C** | `bgm-analyzer.ts` uses shell-interpolated `execSync` with user-provided paths (C-01). Other modules (`qa-measure.ts`, `assembler.ts`, `ffmpeg-segmenter.ts`) correctly use `execFile` — the issue is limited to one module. No path traversal issues found; no network-facing attack surface. |

### 2. Robustness

| Rating | Details |
|--------|---------|
| **B+** | Good error handling throughout — most external calls (`ffmpeg`, `ffprobe`, `python3`) are wrapped in try/catch. Revision guard provides conflict detection. Edge cases around NTSC rounding (W-06, W-07) and negative keyframe values (C-02) need attention. File descriptor leak (W-09) is a minor concern. |

### 3. Type Safety

| Rating | Details |
|--------|---------|
| **A-** | Very low `any` usage (only 5 occurrences across the entire runtime, all in `music-cues.ts` and `caption/approval.ts`). The canonical `runtime/artifacts/types.ts` provides a clean re-export surface. Schema validation in loaders adds runtime type safety. |

### 4. Test Coverage

| Rating | Details |
|--------|---------|
| **B+** | 58 test files covering all major subsystems. Strong FCP7 roundtrip tests (431+200+ lines), state concurrency tests (356 lines), and CLI smoke tests (322 lines). Missing edge case tests for malformed XML, NTSC without reference, and keyframe boundary conditions. |

### 5. Performance

| Rating | Details |
|--------|---------|
| **B** | `mergeDetectedWithGrid` O(n×m) is acceptable for typical use but could be improved (W-08). `TextEncoder` per-character instantiation is wasteful (N-01). No N+1 file I/O issues found. Pipeline stages use appropriate concurrency controls (`DEFAULT_VLM_CONCURRENCY = 3`). |

### 6. Design

| Rating | Details |
|--------|---------|
| **A** | Excellent pipeline decomposition (4731bf8). Clean separation of concerns in state reconcile engine. Well-designed artifact loading with schema validation. Consistent atomic write pattern. The barrel re-export structure cleanly preserves backward compatibility. |

### 7. Compatibility

| Rating | Details |
|--------|---------|
| **A-** | Barrel re-exports (`blueprint.ts → blueprint/index.js`, `import.ts → import/index.js`) maintain backward compatibility. New fields in `TimelineIR` (transitions, audio_policy) are optional. The `ExportContext` correctly handles NTSC detection and timecode formats. The `extraMarkers` API is declared but not yet implemented (N-04). |

---

## Priority Action Items

| Priority | ID | Action | Effort |
|----------|----|--------|--------|
| 🔴 P0 | C-01 | Replace `execSync` with `execFileSync`/`execFile` in bgm-analyzer.ts | 1-2 hours |
| 🔴 P0 | C-02 | Guard against negative `fadeOutStart` in keyframe generation | 15 min |
| 🔴 P0 | C-03 | Fix `extractEbur128Profile` to properly capture stderr | 30 min |
| 🟡 P1 | W-07 | Fix NTSC fps_den in import without reference timeline | 15 min |
| 🟡 P1 | W-04 | Return `-96` instead of `-Infinity` from `linearGainToDb` | 5 min |
| 🟡 P1 | W-05 | Replace `any` types in music-cues.ts and approval.ts | 30 min |
| 🟡 P1 | W-06 | Use rational arithmetic for NTSC frame conversion | 15 min |
| 🟡 P1 | W-09 | Add try/finally to `computeSourceHash` | 5 min |
| 🟢 P2 | N-01 | Cache TextEncoder instance | 5 min |
| 🟢 P2 | N-04 | Implement `extraMarkers` emission or remove from interface | 30 min |
| 🟢 P2 | N-05 | Use atomic write in `writeTimeline` | 10 min |
| 🟢 P2 | N-06 | Add edge case tests (malformed XML, NTSC, keyframe bounds) | 2 hours |

---

## Appendix: Files Reviewed

| File | Lines | Verdict |
|------|-------|---------|
| `runtime/handoff/fcp7-xml-export.ts` | 882 | Good — well-structured ExportContext class, clean separation of format concerns |
| `runtime/handoff/fcp7-xml-import.ts` | 1182 | Good — robust parser with roundtrip marker support, comprehensive diff detection |
| `runtime/pipeline/stages/_util.ts` | 34 | Clean — focused atomic write utilities |
| `runtime/pipeline/pipeline-types.ts` | 35 | Clean — shared types |
| `runtime/pipeline/stages/vlm.ts` | ~537 | Good — proper concurrency control, retry policy |
| `runtime/pipeline/stages/peak.ts` | ~236 | Good — multi-pass peak detection |
| `runtime/pipeline/stages/stt.ts` | ~263 | Good — provider resolution, diarization integration |
| `runtime/packaging/qa-measure.ts` | 295 | Good — proper `execFile` usage, structured measurement output |
| `runtime/media/bgm-analyzer.ts` | 836 | Needs work — command injection risk, FD leak, but good algorithmic design |
| `runtime/artifacts/types.ts` | 64 | Clean — canonical re-export surface |
| `runtime/artifacts/loaders.ts` | 143 | Excellent — schema-validated typed loading |
| `runtime/state/reconcile.ts` | 839 | Very good — comprehensive state machine, atomic writes, revision guard |
| `runtime/compiler/export.ts` | 243 | Good — clean timeline IR construction |
| `runtime/compiler/types.ts` | ~250+ | Good — comprehensive type definitions |
| `runtime/commands/blueprint.ts` | 1 line | Clean barrel re-export |
| `runtime/handoff/import.ts` | 1 line | Clean barrel re-export |
| `runtime/commands/blueprint/index-reexports.ts` | 9 | Clean — curated re-exports |
| `runtime/handoff/import/index-reexports.ts` | 9 | Clean — curated re-exports |
| `runtime/preflight.ts` | ~316 | Good — API key checks, filesystem validation |
| `runtime/validation/schema-validator.ts` | ~668 | Good — AJV-based validation with profile support |
| `runtime/commands/package.ts` | ~242 | Good — proper gate checking, state transition |

---

*Generated by Claude Opus 4.6 — automated code review. All line references verified against commit `7fc51b5`.*
