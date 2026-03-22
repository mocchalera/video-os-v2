# RoughCut Agent

**Artifact-driven autonomous video editing agent**
Built on Claude Code / Codex, powered by deterministic compile + self-critique loop

> Give it a folder of footage and a one-line request.
> It interviews your intent, analyzes every clip, selects candidates, designs the structure, compiles an edit, critiques itself, and patches — all autonomously.
>
> 素材フォルダと一言の依頼を渡すだけで、AIが意図整理・素材分析・候補抽出・構成設計・粗編集・自己批評まで自走する映像編集エージェント

---

## Who Is This For?

- **Creators drowning in footage** — You shot 2 hours of material but need a 30-second cut by tomorrow. RoughCut Agent builds the rough cut while you sleep.
- **Teams without dedicated editors** — Marketing, docs, social — anyone with raw clips and no time to learn an NLE.
- **Editors who hate the blank timeline** — Use the agent's output as a starting point, then finish in Premiere/Resolve/FCPX via OTIO export.

---

## What Happens From a Single Request

```
You: "Make a 30-second brand film about mountain recovery. Restorative, not heroic."

  ┌─────────────────────────────────────────────────────────────────┐
  │                                                                 │
  │  /intent    → creative_brief.yaml         Intent locked         │
  │               unresolved_blockers.yaml                          │
  │                        ↓                                        │
  │  /triage    → selects_candidates.yaml     Candidates scored     │
  │                        ↓                                        │
  │  /blueprint → edit_blueprint.yaml         Beat structure set    │
  │               uncertainty_register.yaml                         │
  │                        ↓                                        │
  │  compile    → timeline.json               Deterministic build   │
  │               adjacency_analysis.json                           │
  │                        ↓                                        │
  │  /review    → review_report.yaml          Self-critique         │
  │               review_patch.json           Auto-patch proposal   │
  │                        ↓                                        │
  │  patch+recompile (loop until approved)                          │
  │                        ↓                                        │
  │  /export    → OTIO + render pipeline      NLE-ready handoff     │
  │                                                                 │
  └─────────────────────────────────────────────────────────────────┘
```

Every stage produces **canonical, schema-validated artifacts** — not throwaway intermediate state. Each artifact is human-readable and machine-parseable.

---

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/your-org/video-os-v2-spec.git
cd video-os-v2-spec
npm install
```

### 2. Run the demo (no API keys needed)

```bash
npm run demo
```

This compiles and reviews the pre-built `projects/demo/` artifacts — a 28-second "Mountain Reset" short film — using only the deterministic engine. No VLM or STT calls required.

### 3. Run on your own footage

```bash
# Set up API keys for media analysis
export GEMINI_API_KEY=your-key      # VLM analysis
export GROQ_API_KEY=your-key        # Whisper STT

# Point to your media folder and go
npx tsx runtime/commands/intent.ts --project my-project --media ./footage/
```

---

## Demo Output

The `projects/demo/` directory contains a complete artifact chain for "Mountain Reset" — a 28-second restorative brand film. Here's what each artifact looks like:

<details>
<summary><strong>creative_brief.yaml</strong> — The agent's understanding of your intent</summary>

```yaml
project:
  title: Mountain Reset
  strategy: message-first
  format: short-brand-film
  runtime_target_sec: 28

message:
  primary: Recovery is an intentional slowing down, not a performance.

emotion_curve:
  - curiosity → grounding → breath → release → warmth

must_avoid:
  - over-sportified framing
  - triumphal summit rhetoric
```
</details>

<details>
<summary><strong>edit_blueprint.yaml</strong> — Beat structure with roles and pacing</summary>

```yaml
beats:
  - id: b01
    label: hook
    purpose: establish intimate morning detail before dialogue enters
    target_duration_frames: 96
    required_roles: [hero, texture]

  - id: b02
    label: settle
    purpose: connect interior ritual to the first spoken articulation
    target_duration_frames: 216
    required_roles: [support, dialogue, texture]

  - id: b03
    label: climb
    purpose: widen the world while protecting against triumphal framing
    target_duration_frames: 240
```
</details>

<details>
<summary><strong>timeline.json</strong> — Canonical multi-track timeline</summary>

```json
{
  "sequence": { "fps_num": 24, "width": 1920, "height": 1080 },
  "tracks": {
    "video": [
      { "track_id": "V1", "clips": [
        { "clip_id": "CLP_0001", "role": "hero", "beat_id": "b01",
          "motivation": "sunrise flare provides restrained reveal of warmth",
          "confidence": 0.93 }
      ]}
    ],
    "audio": [
      { "track_id": "A1", "kind": "dialogue" },
      { "track_id": "A2", "kind": "music" }
    ]
  }
}
```
</details>

<details>
<summary><strong>review_report.yaml</strong> — Self-critique with actionable patches</summary>

```yaml
summary_judgment:
  status: needs_revision
  confidence: 0.82

strengths:
  - Beat boundaries are well-placed and pacing builds naturally
  - Dialogue selections are strong and avoid over-explanation

weaknesses:
  - CLP_0001 hook hero clip has minor highlight clipping
  - CLP_0003 texture in b02 feels passive

recommended_next_pass:
  goal: Tighten hook, strengthen b02 texture, review wind issues in b03
```
</details>

---

## Architecture

### Canonical Artifacts — The Spine of Autonomy

The system is artifact-driven: each stage reads upstream artifacts and writes downstream ones. No hidden state.

```
creative_brief.yaml                 ← What do we want to say?
    ↓
selects_candidates.yaml             ← Which clips could work?
    ↓
edit_blueprint.yaml                 ← How should we structure it?
    ↓
timeline.json                       ← The concrete edit (multi-track, frame-accurate)
    ↓
review_report.yaml + review_patch   ← What's wrong and how to fix it
```

All artifacts are validated against **31 JSON Schemas** at every gate transition.

### Deterministic Engine — Not Another AI Black Box

The compilation stage is **zero-AI, zero-randomness**. Given the same blueprint + candidates, you get the identical timeline every time.

| Compiler Phase | What It Does |
|---|---|
| Phase 0.5 | Duration policy resolution (strict = exact target; guide = adapt to material) |
| Phase 1 | Blueprint normalization — beat quotas for hero, support, transition, texture, dialogue |
| Phase 2 | Candidate scoring — semantic rank + duration fit + motif reuse limits |
| Phase 3 | Assembly — multi-track layout (V1 primary, V2 support, A1 dialogue, A2 music, A3 texture) |
| Phase 4 | Constraint resolution — overlaps, duplicates, invalid ranges, music timing |
| Phase 5 | Export — timeline.json canonical + OTIO handoff + preview manifest |

### Self-Critique Loop

```
compile → preview → roughcut-critic → review_patch → apply → recompile → ...
```

The `roughcut-critic` agent reads the timeline + preview, emits structured patch operations (`replace_segment`, `trim_segment`, `move_segment`, etc.), and the engine applies them deterministically. The loop continues until the critique passes or the human accepts an override.

**Patch safety**: `replace_segment` can only substitute clips from pre-approved `fallback_segment_ids`. No hallucinated clips.

### Transition Skill System (Murch Rule of Six)

Transitions are governed by **Skill Cards** — declarative JSON definitions scored against Walter Murch's six editing priorities:

```
emotion (35%) → story (25%) → rhythm (20%) → eye_trace (10%) → plane_2d (5%) → space_3d (5%)
```

Each skill card defines:
- **When/avoid predicates** — energy delta, semantic cluster change, afterglow scores
- **Beat snap** — transitions snap to the BGM beat grid
- **Fallback chain** — skill → crossfade → hard cut → skip (never crash)

Built-in skills: `smash_cut_energy`, `match_cut_bridge`, `crossfade_bridge`, `build_to_peak`, `silence_beat`

---

## Autonomy Design (How It Self-Drives)

### Gate-Controlled State Machine

```
intent_pending → intent_locked → media_analyzed → selects_ready
    → blueprint_ready → timeline_drafted → critique_ready → approved → packaged
```

**11 non-negotiable gates** prevent the system from advancing with invalid state:

1. No compile if unresolved blockers exist
2. No render if timeline schema fails
3. No render if review has fatal issues
4. Agents never write media directly — only engines render
5. Only the compiler mutates `timeline.json`
6. Agents emit `review_patch[]`, not raw ffmpeg commands

### Error Recovery

- **Schema validation failure** → compiler emits structured error, agent retries with corrections
- **Missing analysis data** → graceful degradation (confidence scores drop, never crash)
- **Blocker detected** → state machine halts, surfaces the blocker for resolution
- **Patch safety violation** → patch rejected, original timeline preserved

### Human-in-the-Loop by Design

The agent distinguishes what it **may decide** vs. what it **must ask**:

```yaml
autonomy:
  may_decide:
    - b-roll substitution within same emotional meaning
    - exact cut position within a beat
  must_ask:
    - replacing the final spoken line with silence
    - changing the message from restorative to achievement-oriented
```

---

## Tech Stack

| Component | Technology |
|---|---|
| Runtime | TypeScript (ESM) |
| Compiler | 15 deterministic modules, pure functions |
| Media Analysis | Gemini VLM (visual), Groq Whisper (STT) |
| Schema Validation | AJV + 31 JSON Schemas |
| Agent Orchestration | Claude Code subagents / Codex custom agents |
| Video Processing | FFmpeg / FFprobe |
| Timeline Export | OTIO (OpenTimelineIO) |
| Testing | Vitest, fixture-based E2E |

---

## Project Structure

```
runtime/
  commands/      9 CLI commands (intent, triage, blueprint, review, export, package, caption, status)
  compiler/      15 deterministic modules (normalize, score, assemble, trim, resolve, adjacency, patch...)
  editorial/     Transition skill cards + agent prompts
  state/         State machine, reconciliation, history
  packaging/     Gate 10, QA, manifest, render pipeline
  caption/       Caption segmentation + editorial

schemas/         31 JSON Schemas for all canonical artifacts
agent-src/       8 agent role definitions (4 product-plane + 4 dev-plane)
projects/        Fixture projects with full artifact chains
  demo/          Pre-built E2E example (no API keys needed)
  _template/     Starter template for new projects
docs/            Architecture docs + roadmap
```

---

## Limitations

- **FFmpeg + FFprobe required** for preview rendering and media probing
- **API keys needed** for live media analysis (Gemini for VLM, Groq for STT) — demo mode works without them
- **CLI-only** — no Web UI yet (planned for M3)
- **No real-time preview** — stub preview in M1, FFmpeg preview in M2+
- **Single-project scope** — no batch processing across multiple projects
- **OTIO export is one-way** — round-trip NLE handoff is planned for M4

---

## License

MIT

---

<sub>Built for the AI Agent Hackathon 2026. The rough cut is just the beginning.</sub>
