# Design: Studio Feedback Loop — Human-AI Collaborative Editing UI

Version: 2.0
Date: 2026-06-22
Status: Draft (post-review revision — addresses all P0/P1 findings from review-studio-feedback-loop.md)

## 1. Problem Statement

The macOS Studio app (`apps/macos-studio/`) is mature for **monitoring and agent delegation** — it can load timelines, play back clips, inspect editorial metadata, and drive Codex agent sessions. However, the **human → pipeline feedback path** is weak:

- **No inline clip judgment**: The user can view a clip but cannot mark it "approve" / "reject" / "swap" without writing a text note or running an agent turn.
- **No candidate browser**: `selects_candidates.yaml` lists fallback alternatives with scores, trim hints, and evidence — but the UI only shows fallback segment IDs as a comma-separated string in the Clip Inspector.
- **No visual/audio search from the app**: Qwen3-VL visual and CLAP audio embeddings are built into the footage DB, but the only way to search is via the Node.js pipeline CLI.
- **No QA dashboard**: QA scores (76→84), brief alignment radar (intent_message_alignment=0.25), and per-issue fix proposals exist in JSON — but are not visualized.
- **No instant feedback cycle**: After a human judgment (reject clip X, prefer clip Y), the user must manually invoke "Compile Rough Cut" from the command palette. There is no "apply my changes and preview instantly" flow.

**North star**: A human reviewer opens a rough cut, spots a weak clip, taps "swap," browses scored alternatives with thumbnails, picks one, and sees the re-compiled timeline within seconds — without leaving the app or typing a command.

## 2. Architecture: Review Patch as the Feedback Contract

The app already has "Apply Review Patch" in the command palette, which reads `review_patch.json` and recompiles. We formalize this as the **universal feedback contract**:

```
Human judgment in UI
    ↓ generates
review_patch.json  (deterministic, auditable)
    ↓ feeds
Deterministic compiler (existing)
    ↓ produces
timeline.json + preview-manifest.json
    ↓ triggers
Viewer auto-reload
```

Every UI gesture (reject, swap, reorder, trim adjust) produces a patch operation. The compiler is the single source of truth — the UI never mutates `timeline.json` directly.

### 2.1 Review Patch Schema (aligned with existing `schemas/review-patch.schema.json`)

The existing compiler patch contract uses `timeline_version` + typed operations. Studio patches **must** use this exact schema so the existing "Apply Review Patch" path (`scripts/compile-timeline.ts --patch`) accepts them without modification.

```typescript
// Current compiler contract (schemas/review-patch.schema.json + runtime/compiler/patch.ts)
interface ReviewPatch {
  timeline_version: string;          // must match timeline.json version
  operations: PatchOperation[];
}

type PatchOperation =
  | { op: "replace_segment"; target_clip_id: string; with_segment_id: string; with_candidate_ref?: string; reason: string }
  | { op: "trim_segment";    target_clip_id: string; new_src_in_us: number; new_src_out_us: number; reason: string }
  | { op: "move_segment";    target_clip_id: string; new_timeline_in_frame: number; reason: string }
  | { op: "insert_segment";  beat_id: string; segment_id: string; role: string; new_timeline_in_frame: number; new_duration_frames: number; reason: string }
  | { op: "remove_segment";  target_clip_id: string; reason: string }
  | { op: "change_audio_policy"; target_clip_id: string; audio_policy: object; reason: string }
  | { op: "add_marker";      frame: number; label: string; kind: string }
  | { op: "add_note";        target_clip_id: string; text: string };
```

#### 2.1.1 UI Gesture → Compiler Op Mapping (Phase 1)

| UI gesture | Compiler op | Notes |
|---|---|---|
| Swap clip | `replace_segment` | `target_clip_id` + `with_segment_id`. Builder resolves segment from candidate. |
| Adjust trim | `trim_segment` | Validate `new_src_in_us < new_src_out_us` in Swift before serializing. |
| Remove clip | `remove_segment` | Destructive removal from timeline. |
| Insert clip | `insert_segment` | Builder must compute `new_timeline_in_frame` and `new_duration_frames`. |
| Reorder within beat | multiple `move_segment` | No native beat-order op; builder emits N move ops. |
| Approve clip | `add_note` (optional) | Approval is primarily **Studio UI state**, not a compiler mutation. Optionally emits `add_note` for timeline marker. |
| Reject clip | `remove_segment` or UI-only | If rejection should affect preview: `remove_segment`. If informational only: UI state + `add_note`. |
| Set transition | **Not Phase 1** | Requires compiler extension. Deferred. |

#### 2.1.2 Studio Metadata Envelope (outside compiler contract)

Studio wraps the compiler-compatible patch with metadata for audit and stale detection. This envelope is stored alongside the patch but **stripped before passing to the compiler**:

```typescript
interface StudioPatchEnvelope {
  studio_version: "1";
  project_id: string;
  created_at: string;                 // ISO 8601
  source: "studio_ui";
  base_timeline_hash: string;         // SHA-256 of timeline.json at patch creation time
  base_timeline_version: string;      // timeline.version field
  patch: ReviewPatch;                 // the actual compiler-compatible patch
  ui_state: {
    approved_clip_ids: string[];      // clips marked approved (not a compiler op)
    rejected_clip_ids: string[];      // clips marked rejected (may or may not have remove_segment)
  };
}
```

#### 2.1.3 Stale Detection

Before applying a patch:
1. **Swift side**: Compare `envelope.base_timeline_hash` against current `timeline.json` hash (reuse `ProjectPlaybackContractStatus` hash computation). If mismatch → warn user: "Timeline has changed since this patch was created."
2. **Compiler side**: Existing `timeline_version` check in `runtime/compiler/patch.ts:124-150` remains the authority. Studio sets `patch.timeline_version` from the current timeline.
3. **Per-op preconditions** (future): Each op should carry target clip's `segment_id` and `timeline_in_frame` so the compiler can detect clip-level conflicts, not just version-level.

### 2.2 Preview Mode vs. Promote Mode

Human edits applied via patch only modify `05_timeline/timeline.json`. They do **not** update `selects_candidates.yaml` or `edit_blueprint.yaml`. A subsequent full compile (without `--patch`) would discard them.

**Preview mode** (default):
- Studio writes patch to `06_review/studio_patch_{timestamp}.json`
- Compiler applies patch → writes `timeline.json` + `preview-manifest.json`
- Viewer reloads. Human sees changes immediately.
- Patch is archived in `06_review/patch_history/`.

**Promote mode** (explicit user action):
- After reviewing preview, user clicks "Promote to Planning" in the Feedback Status Bar.
- Studio updates `edit_blueprint.yaml` candidate_plan entries to reflect swaps:
  - Swap: promoted segment becomes `primary_candidate_ref`, old primary becomes first fallback.
  - Remove: candidate is marked with `role: reject` or removed from eligible_beats.
- Future full compiles will pick up promoted changes.
- Promotion is done via a dedicated CLI: `npx tsx scripts/promote-studio-patch.ts --project {id} --patch {path}`

This guarantees **zero data loss**: preview patches are always archived, and promoted changes survive recompile.

## 3. Phase 1: Clip Feedback Primitives

### 3.1 Timeline Clip Context Menu

Right-click (or long-press on trackpad) on any clip bar in the Timeline panel:

| Action | Patch Op | Visual Feedback |
|--------|----------|----------------|
| Approve | `approve_clip` | Green checkmark overlay on clip bar |
| Reject | `reject_clip` | Red X overlay, clip dims to 30% opacity |
| Swap... | Opens Candidate Browser | — |
| Adjust Trim... | Opens Trim Adjuster | — |
| Remove | `remove_clip` | Clip bar becomes dashed outline |

State is held in a dedicated `StudioFeedbackSession` ObservableObject (see Section 3.4), **not** in `StudioViewModel` directly.

### 3.2 Feedback Status Bar

Below the timeline, a horizontal bar shows:

```
┌─────────────────────────────────────────────────────────────┐
│ 3 changes pending  │  ✓ 5 approved  │  ✗ 1 rejected  │  ↻ 1 swapped  │  [Apply & Preview]  [Discard]  │
└─────────────────────────────────────────────────────────────┘
```

"Apply & Preview" serializes `review_patch.json`, invokes the compiler, and auto-reloads the timeline + viewer.

### 3.3 Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `A` | Approve selected clip |
| `X` | Reject selected clip |
| `S` | Open Swap browser for selected clip |
| `T` | Open Trim adjuster for selected clip |
| `⌘⏎` | Apply pending patch & preview |
| `⌘Z` | Undo last pending operation |

### 3.4 StudioFeedbackSession (separate ObservableObject)

`StudioViewModel` is already 2,231 lines managing project scanning, playback, analysis, compile, render, proxies, Marlin, audio, annotations, RAG, and Codex. Adding patch construction, validation, conflict detection, undo, and candidate selection directly would make it unmanageable.

A dedicated `StudioFeedbackSession` ObservableObject owns:

```swift
@MainActor
final class StudioFeedbackSession: ObservableObject {
    @Published var pendingOps: [PatchOperation] = []
    @Published var approvedClipIDs: Set<String> = []
    @Published var rejectedClipIDs: Set<String> = []
    @Published var baseTimelineHash: String?
    @Published var baseTimelineVersion: String?
    @Published var patchHistory: [AppliedPatchRecord] = []
    @Published var isDirty: Bool = false

    func addOp(_ op: PatchOperation)        // validates, dedupes, sets isDirty
    func removeOp(at index: Int)            // undo single op
    func clearAll()                         // discard all pending
    func serialize() -> StudioPatchEnvelope // build envelope + compiler patch
    func detectConflicts() -> [PatchConflict] // e.g. reject + approve same clip
    func loadHistory(projectURL: URL)       // read 06_review/patch_history/index.json
}
```

`StudioViewModel` holds a reference to `StudioFeedbackSession`, passes it to timeline/inspector views, and orchestrates compile-on-apply. Timeline and inspector views interact with `StudioFeedbackSession` for feedback state, keeping them unaware of compiler internals.

## 4. Phase 2: Candidate Swap Browser

When the user clicks "Swap..." on a clip, a sheet slides up from the timeline area:

### 4.1 Layout

```
┌──────────────────────────────────────────────────────────────────┐
│  Swap: CLP_0003 / b02_discovery                          [Close] │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  Current clip                    │  Alternatives (ranked)         │
│  ┌───────────────────────┐      │  ┌─────────────────────────┐  │
│  │  [Video thumbnail]     │      │  │ 1. SEG_AST_B20ECEB1_001 │  │
│  │  SEG_AST_867607E9_001 │      │  │    score: 0.88 role:hero│  │
│  │  conf: 0.72           │      │  │    [thumbnail]           │  │
│  │  "ancient shrine path" │      │  │    "Bright landscape..." │  │
│  └───────────────────────┘      │  │    [Use This]            │  │
│                                  │  ├─────────────────────────┤  │
│  Beat: b02_discovery             │  │ 2. SEG_AST_30B96D6D_001 │  │
│  Target: 120 frames              │  │    score: 0.81 role:sup │  │
│  Trim: peak_hold → cut_on_action │  │    [thumbnail]           │  │
│                                  │  │    "River scenery..."    │  │
│                                  │  │    [Use This]            │  │
│                                  │  ├─────────────────────────┤  │
│                                  │  │ 3. (search for more...) │  │
│                                  │  └─────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### 4.2 Data Source

Swift has no YAML package dependency (`Package.swift`). Existing YAML reads are lightweight text scans, not structured decoders. Two options:

**Chosen approach: Node-side JSON reader.**
A thin CLI converts YAML planning artifacts to JSON for Swift consumption:

```bash
npx tsx scripts/read-candidates.ts --project projects/{project_id} --json
```

Output: JSON array of candidates with `candidate_id`, `segment_id`, `asset_id`, `role`, `confidence`, `eligible_beats[]`, `why_it_matches`, `evidence[]`, `trim_hint`, `editorial_signals`, plus blueprint `fallback_candidate_refs` per beat. Swift decodes this as a flat `Decodable` struct.

Data composition in `CandidateBrowserDataSource`:
1. **Primary**: Parsed candidates with `eligible_beats` matching the current beat, sorted by `confidence` descending.
2. **Fallbacks**: Blueprint `candidate_plan.fallback_candidate_refs` for the current beat (included in JSON output).
3. **Evidence enrichment**: Cross-reference with `ProjectEvidenceStore` for Marlin events, audio nodes.
4. **Search**: "Search for more..." opens the Visual/Audio Search panel (Phase 3).

`CandidateBrowserDataSource` is a separate object composing planning data + evidence + thumbnails, **not** an extension of `ProjectEvidenceStore` (which owns analysis data under `03_analysis`, not planning data under `04_plan`).

### 4.3 Thumbnail Resolution

Candidate thumbnails reuse **existing analysis artifacts first**, not `ProjectMediaProxyPlanner` (which builds full preview proxy videos, not stills):

1. `key_frame_path` from search results (`runtime/tools/footage-search.ts:161-172`) — already extracted during footage DB build
2. Representative frames under `03_analysis/frames/{asset_id}/representative.jpg`
3. `assets.json` → `poster_path` field per asset
4. **On-demand fallback only**: `ffmpeg -ss {rep_frame_sec} -i {source_path} -frames:v 1 -f image2pipe -` via a dedicated `ProjectThumbnailCache` (new), not `ProjectMediaProxyPlanner`

This avoids unnecessary ffmpeg calls for most candidates.

### 4.4 Candidate Card Content

- Representative frame thumbnail (240×135 or 16:9 scaled)
- Confidence score badge (color: green >0.8, yellow >0.6, red <0.6)
- Role chip (hero/support/texture/dialogue)
- `why_it_matches` text (first 80 chars, expandable)
- Evidence tags (Marlin event descriptions, Qwen visual retrieval scores)
- Trim hint visualization (horizontal bar showing recommended in/out within source duration)
- "Use This" button → generates `swap_clip` patch op

## 5. Phase 3: Visual & Audio Search Panel

### 5.1 Entry Points

- "Search for more..." in the Candidate Swap Browser
- Command Palette → "Search Footage"
- Keyboard shortcut `⌘F` when timeline is focused

### 5.2 Search Interface

```
┌──────────────────────────────────────────────────────────────┐
│  Search Footage                                        [Close] │
├──────────────────────────────────────────────────────────────┤
│  Mode: [Text] [Visual] [Audio] [Hybrid]                       │
│                                                                │
│  Query: [明るい自然風景、川のせせらぎ________________] [Search]  │
│                                                                │
│  ── or ──                                                      │
│  Visual anchor: [Drop image / Select from timeline clip]       │
│  Audio anchor:  [Drop audio / "環境音を含むクリップ"]           │
│                                                                │
│  Results (18 segments)                              Sort: Score │
│  ┌────────────────────────────────────────────────────────┐   │
│  │ [thumb] SEG_AST_FA1D3DB5_001  score:0.91  3.2s        │   │
│  │         "Man in landscape, river visible"               │   │
│  │         qwen_visual:0.88 e5_text:0.72 clap:0.85       │   │
│  │         [Preview] [Use in beat: ▾ b02_discovery]       │   │
│  ├────────────────────────────────────────────────────────┤   │
│  │ [thumb] SEG_AST_C2CE75D8_001  score:0.87  5.8s        │   │
│  │ ...                                                     │   │
│  └────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

### 5.3 Search Backend

A thin CLI wrapper (`runtime/tools/footage-search-cli.ts`) calls the existing `searchFootage()` library function. The wrapper is separate from `footage-search.ts` because that module is imported by QA and agent code (`runtime/eval/qa-fix-proposer.ts`).

**MVP (Phase 3): Short-lived subprocess per query.**

```bash
npx tsx runtime/tools/footage-search-cli.ts \
  --project "$(pwd)/projects/{project_id}" \
  --mode hybrid \
  --query "明るい自然風景" \
  --limit 20 \
  --json
```

For visual anchor search — **all paths must be absolute** (current `footage-search.ts` validates realpath under approved roots):
```bash
npx tsx runtime/tools/footage-search-cli.ts \
  --project "$(pwd)/projects/{project_id}" \
  --mode visual \
  --image-query-path "$(pwd)/projects/{project_id}/03_analysis/posters/AST_FA1D3DB5.jpg" \
  --limit 20 \
  --json
```

**Lifecycle tradeoff**: Qwen and CLAP clients are cached in-process (`footage-search.ts:459`, `:1768-1794`) and disposed via `disposeFootageSearch()`. Short-lived subprocess means every search pays process + model startup (~3-5s). Acceptable for initial use but not for rapid browsing.

**Future (post-MVP): Persistent JSONL search worker.**
Same pattern as `qwen3vl_embedding_worker.py` / `clap_audio_worker.py`: a long-lived Node process communicating via JSONL over stdin/stdout. Swift spawns it once per project session, sends search requests, receives JSON responses. Shutdown via `disposeFootageSearch()` when project closes. This brings interactive search latency to ~200ms per query.

The design explicitly leaves this path open. The CLI wrapper and the persistent worker share the same `searchFootage()` library call — only the transport differs.

**Security**: Search query paths in CLI args are resolved and validated by existing realpath checks in `footage-search.ts:660-696`. Paths are **never** copied into `review_patch.json` — patches reference only clip/segment IDs.

### 5.4 Score Channel Breakdown

Each result shows per-channel scores as small horizontal bars:
- `e5_text` (blue)
- `qwen_visual` (purple)
- `qwen_text` (teal)
- `clap_audio` (orange)
- `lexical` (gray)

This helps the human understand *why* a result ranked high — visual match? text match? audio similarity?

## 6. Phase 4: QA Dashboard

### 6.1 Dashboard Tab

Add a fifth tab to the InspectorPanel: **"QA"**

```swift
TabView {
    AgentPanel(...)  .tabItem { Label("Agent", ...) }
    ProjectPanel(...).tabItem { Label("Project", ...) }
    ClipInspectorPanel(...).tabItem { Label("Clip", ...) }
    MediaPanel(...)  .tabItem { Label("Media", ...) }
    QADashboardPanel(...).tabItem { Label("QA", systemImage: "checkmark.diamond") }
}
```

### 6.2 QA Dashboard Content

**A. Overall Score Card**
```
QA Score: 84/100  (+8 from baseline)
Brief Alignment: 0.533 composite
Iterations: 3 completed, 4 fixes applied
```

**B. Brief Alignment Radar Chart**
Six axes from the QA report, displayed as **two separate stage overlays** (not merged):
- intent_message_alignment
- must_have_coverage
- emotion_curve_alignment
- narrative_structure
- pacing_coherence
- visual_variety_and_focus

Selects scores (blue overlay) and blueprint scores (green overlay) are drawn independently. The evaluator computes these per-stage (`runtime/eval/brief-alignment.ts:259-324`). The report also emits unqualified aliases for the first stage — the UI must **not** treat these as a third series.

Displayed as a radar/spider chart (SwiftUI Canvas or Charts framework).

**C. Issue List**

**Prerequisite**: Current `QAImprovementReport` stores only `fixes` and counts, not the full issue list. Fixed/proposed issues are nested in fixes, but open/unfixed issues are lost except as counts (`runtime/eval/qa-improvement-report.ts:8-17`).

Before building the Issue List UI, extend the QA report model:
- Add `issues: QAIssue[]` to `QAImprovementReport` — preserves all detected issues, not just fixable ones.
- Add `06_review/qa-improvement-index.json` — manifest with ordered report paths, run_id, base/result timeline hashes, convergence reason. This makes the Swift loader deterministic and avoids fragile glob over stale iteration files.

With this data available, the UI shows issues across iterations:

| Issue | Type | Severity | Beat | Status | Fix |
|-------|------|----------|------|--------|-----|
| "Scene repeats at 69.5s" | continuity | 0.7 | b03 | Open | — |
| "Monotone pacing" | pacing | 0.5 | b02 | Fixed (iter2) | insert SEG_AST_B20E... |

Click an issue → playhead jumps to that timestamp. Click "Fix" → opens Candidate Swap pre-filtered.

**D. Iteration History**
Timeline showing score progression: 76 → 84 → 84 (converged).
Per-iteration: clips changed, duration delta, fixes applied.

### 6.3 Data Loading

```swift
// New in VideoOSStudioCore
public struct QADashboardDocument: Decodable, Sendable {
    public let iterations: [QAIterationReport]

    public static func load(projectURL: URL) -> QADashboardDocument {
        // Load all qa-improvement-report-iter*.json files
        // Merge into unified document
    }
}
```

## 7. Phase 5: Instant Feedback Cycle

### 7.1 Auto-Compile on Patch Apply

When the user clicks "Apply & Preview":

1. `StudioFeedbackSession.serialize()` → writes `06_review/studio_patch_{timestamp}.json`
2. Show progress overlay: "Applying patch..."
3. Invoke compiler: `npx tsx scripts/compile-timeline.ts projects/{id} --patch 06_review/studio_patch_{timestamp}.json`
   - **Skip index rebuild** for speed: pass `rebuildIndex: false` (runner already supports this). RAG/search index refreshes asynchronously after viewer updates.
4. On success: auto-reload `timeline.json` + `preview-manifest.json`
5. Playhead jumps to the first changed clip
6. Toast notification: "Timeline updated. 2 clips changed."
7. Archive patch in `06_review/patch_history/`

**Latency budget** (small project, ~15 clips):
- Subprocess spawn + tsx startup: ~1.5s
- Patch application + timeline write + preview-manifest: ~0.5s
- Swift artifact reload (timeline, evidence, playback contract): ~1s
- Async audio waveform reload: ~2s (non-blocking)
- **Total blocking**: ~3-4s (not ~2s as originally estimated)
- **With index rebuild (skipped)**: would add ~2-3s

For larger projects, the blocking path may reach 5-8s. The 10-second success metric remains achievable.

### 7.2 Diff Visualization

After recompile, changed clips get a blue glow outline in the timeline for 5 seconds, then fade to normal. This helps the user see what changed.

### 7.3 Undo Stack & Patch History

Each patch application is a commit point, tracked in `06_review/patch_history/index.json`:

```typescript
interface PatchHistoryIndex {
  version: "1";
  project_id: string;
  records: PatchHistoryRecord[];
}

interface PatchHistoryRecord {
  patch_path: string;              // relative: "06_review/studio_patch_2026-06-22T01-30-00.json"
  base_timeline_hash: string;
  result_timeline_hash: string;
  timeline_backup_path: string;    // relative: "06_review/patch_history/timeline_backup_{n}.json"
  created_at: string;
  source: "studio_ui" | "agent";
  changed_clip_ids: string[];
  op_count: number;
}
```

**Retention policy**: Latest 20 timeline backups. When count exceeds 20, oldest backup file is deleted and record is marked `purged: true` (metadata kept for audit, file removed).

**Undo**:
- `⌘Z`: Restores `timeline.json` from the most recent backup, refreshes playback contract, removes the last record from active history.
- Command Palette → "Patch History" → list of applied patches with timestamps, changed clips, source.
- Atomic restore: write backup → refresh playback contract → reload viewer. If restore fails, original timeline is preserved (write to temp first, rename on success).

**Boundary with `editor_annotations.json`**: Annotations store human notes and handoff instructions (`07_handoff/editor_annotations.json`). Review patches store deterministic compiler mutations. Studio UI approval/rejection marks are ephemeral UI state. These three are distinct:

| Artifact | Purpose | Survives recompile? |
|---|---|---|
| `editor_annotations.json` | Human notes for handoff | Yes (separate file) |
| `review_patch.json` | Compiler mutations | Only if re-applied or promoted |
| UI approval/rejection marks | Visual feedback in Studio | No (session state) |

Agent-generated `06_review/review_patch.json` is never overwritten by Studio. Studio patches use timestamped filenames and are passed explicitly to the compiler.

## 8. Implementation Plan

### Phase 1: Clip Feedback Primitives + Feedback Session (Week 1)

**Prerequisite (TS side)**: Verify `scripts/compile-timeline.ts --patch` accepts all ops needed (replace_segment, trim_segment, remove_segment, insert_segment, move_segment, add_note). No new CLI needed — existing path works.

**Swift — new files:**
- `VideoOSStudioCore/StudioFeedbackSession.swift` — ObservableObject owning pending ops, approval/rejection marks, conflict detection, serialization to compiler patch schema, undo of pending ops, patch history loading
- `VideoOSStudioCore/ReviewPatchDocument.swift` — Codable model matching `schemas/review-patch.schema.json` exactly (timeline_version + operations)
- `VideoOSStudioCore/StudioPatchEnvelope.swift` — Codable model for Studio metadata envelope (wraps ReviewPatch + UI state + base hash)
- `VideoOSStudioCore/PatchHistoryIndex.swift` — Codable model for `06_review/patch_history/index.json`
- `VideoOSStudio/FeedbackStatusBar.swift` — pending count, applied count, Apply & Preview / Promote / Discard buttons

**Swift — modified files:**
- `StudioViewModel.swift` — hold `@Published var feedbackSession: StudioFeedbackSession`, wire apply-patch to existing `ProjectRoughCutCompileRunner` with `rebuildIndex: false`, add `promoteStudioPatch()`
- `TimelineViews.swift` — clip bar context menu (Swap/Remove/Approve/Reject), approval/rejection overlays (green check / red X / dashed outline)
- `ContentView.swift` — insert FeedbackStatusBar between timeline and workspace

### Phase 2: Candidate Swap Browser (Week 2)

**TS side — new file:**
- `scripts/read-candidates.ts` — thin CLI: reads `selects_candidates.yaml` + `edit_blueprint.yaml`, outputs JSON for Swift

**TS side — new file (optional, for Promote):**
- `scripts/promote-studio-patch.ts` — reads patch + blueprint, updates `candidate_plan` entries in `edit_blueprint.yaml`

**Swift — new files:**
- `VideoOSStudio/CandidateSwapView.swift` — sheet UI: current clip vs ranked alternatives, "Use This" button
- `VideoOSStudioCore/CandidateBrowserDataSource.swift` — composes JSON from `read-candidates.ts` + `ProjectEvidenceStore` analysis data + thumbnail paths
- `VideoOSStudioCore/ProjectThumbnailCache.swift` — resolves thumbnails: key_frame_path → analysis frames → poster_path → on-demand ffmpeg fallback

### Phase 3: Visual & Audio Search (Week 3)

**TS side — new file:**
- `runtime/tools/footage-search-cli.ts` — thin CLI wrapper: parses args, calls `searchFootage()`, outputs JSON. Validates absolute paths via existing realpath checks.

**Swift — new files:**
- `VideoOSStudio/FootageSearchView.swift` — search panel: mode picker, text/image/audio query, results list with score breakdown bars
- `VideoOSStudioCore/FootageSearchRunner.swift` — spawns `footage-search-cli.ts` subprocess, decodes `FootageSearchResponse` JSON

### Phase 4: QA Dashboard (Week 3-4)

**TS side — modifications:**
- `runtime/eval/qa-improvement-report.ts` — add `issues: QAIssue[]` to `QAImprovementReport` (all detected issues, not just fixable)
- `runtime/eval/qa-loop.ts` — emit `06_review/qa-improvement-index.json` manifest with ordered report paths, run_id, base/result hashes, convergence reason

**Swift — new files:**
- `VideoOSStudio/QADashboardViews.swift` — dashboard tab: score card, radar chart (two overlays: selects blue + blueprint green), issue list with playhead-jump, iteration history
- `VideoOSStudioCore/QADashboardDocument.swift` — loads `qa-improvement-index.json`, then individual reports; merges into unified view

### Phase 5: Instant Feedback Cycle & Polish (Week 4)

**Swift — modifications:**
- `StudioViewModel.swift` — auto-compile trigger on Apply & Preview, async index rebuild after viewer reload, diff visualization state (changed clip IDs + fade timer)
- `TimelineViews.swift` — blue glow overlay on changed clips (5s fade)
- `StudioFeedbackSession.swift` — patch history retention (prune oldest beyond 20 backups)

**Integration testing:**
- ena-promo-ai: reject clip → swap → apply → verify timeline changed
- rokutaro-v4: search → swap → promote → full recompile → verify promoted candidate persists

## 9. Testing Strategy

### Unit Tests (Swift)
- `StudioFeedbackSessionTests` — add/remove ops, conflict detection (reject + approve same clip), serialize to compiler schema, undo
- `ReviewPatchDocumentTests` — encode/decode round-trip against `schemas/review-patch.schema.json`
- `StudioPatchEnvelopeTests` — envelope wrapping, hash capture, UI state serialization
- `PatchHistoryIndexTests` — load/save, retention pruning (>20 backups)
- `CandidateBrowserDataSourceTests` — JSON loading from `read-candidates.ts`, ranking, beat filtering, thumbnail resolution chain
- `QADashboardDocumentTests` — load from index manifest, multi-iteration merge, two-overlay score extraction

### Unit Tests (TypeScript)
- `read-candidates.test.ts` — YAML→JSON conversion, beat plan inclusion, edge cases (empty candidates, missing blueprint)
- `footage-search-cli.test.ts` — arg parsing, absolute path validation, JSON output shape
- `qa-improvement-report.test.ts` — verify `issues[]` field is populated for all detected issues

### Integration Tests (E2E)
- Open project → reject clip → apply patch → verify timeline.json changed → verify playback contract refreshed
- Open project → swap clip via Candidate Browser → apply → verify `replace_segment` op in patch → verify segment replaced in timeline
- Search footage → select result → swap into beat → apply → recompile → verify clip replaced
- Apply patch → Promote → full recompile (without --patch) → verify promoted candidate persists in timeline
- QA dashboard loads index manifest → displays correct score progression → click issue → playhead jumps

### Golden Tests
- Existing golden projects (ena-promo-ai, rokutaro-v4) serve as fixtures
- Studio patch + compile must produce deterministic output matching expected timeline
- Patch history index round-trip: write → prune → read → verify record integrity

## 10. Non-Goals (This Design)

- **Real-time collaborative editing** (multi-user) — single-operator model for now
- **Direct timeline drag-and-drop reordering** — too complex for Phase 1; use `move_segment` ops instead
- **In-app video rendering** — rendering stays in the Node.js pipeline; the app previews source clips
- **FCPX/Premiere round-trip from the app** — handled by existing handoff export, not this feedback loop
- **LLM integration in-app** — agent reasoning stays in Codex; the app is the human feedback surface
- **`set_transition` UI** — requires compiler extension; deferred beyond Phase 1
- **Persistent JSONL search worker** — designed for but not implemented in MVP; short-lived subprocess is Phase 3 scope

## 11. Success Metrics

1. **Feedback cycle time**: From "I don't like this clip" to "I see the new version" < 10 seconds (blocking path ~3-4s for small projects)
2. **Gesture count**: Swap a clip in ≤ 3 clicks (right-click → Swap → Use This)
3. **Search-to-swap**: Find a better clip via visual search and place it in ≤ 5 clicks
4. **QA visibility**: All QA scores and issues visible without opening JSON files; two-overlay radar chart for selects/blueprint
5. **Zero data loss**: Every human judgment serialized in timestamped patch files under `06_review/patch_history/`; promoted changes survive recompile
6. **Schema compatibility**: All Studio patches pass `schemas/review-patch.schema.json` validation without modification
