# M3 Operator Checklist — Real-Material Smoke

Pre-flight checklist for running the M3 editorial loop on real footage.
Two target projects: `rokutaro-bicycle` and `AX-1 D4887`.

## Prerequisites

- [ ] Node.js 20+ installed
- [ ] `npm install` completed in repo root
- [ ] `npx tsc --noEmit` passes (no type errors)
- [ ] `npx vitest run` passes (all CI tests green)
- [ ] FFmpeg and FFprobe available on PATH
- [ ] Target footage accessible at expected paths

## Per-Project Steps

### 1. Ingest (M2 Pipeline)

```bash
# Create project directory structure
mkdir -p projects/<project-id>/{01_intent,02_source,03_analysis,04_plan,05_timeline,06_review,07_export}

# Copy source media to 02_source/
cp /path/to/footage/*.mp4 projects/<project-id>/02_source/

# Run M2 ingest pipeline (generates assets.json, segments.json, transcripts/)
# NOTE: Requires live FFprobe, FFmpeg. STT/VLM require API keys.
npx tsx scripts/analyze.ts projects/<project-id>
```

- [ ] `03_analysis/assets.json` generated and non-empty
- [ ] `03_analysis/segments.json` generated with segments
- [ ] Transcripts generated (if STT configured)
- [ ] `qc_status` per asset reviewed

### 2. Initialize Project State

```bash
# Create project_state.yaml (or copy from template)
cp projects/_template/project_state.yaml projects/<project-id>/project_state.yaml
# Edit project_id field
```

- [ ] `project_state.yaml` has correct `project_id`

### 3. /intent — Creative Brief

Run the intent interview interactively:
- Provide purpose, constraints, audience, emotion curve
- Review the readback and confirm

- [ ] `01_intent/creative_brief.yaml` generated
- [ ] `01_intent/unresolved_blockers.yaml` generated
- [ ] Blockers reviewed (hypothesis vs blocker status)
- [ ] `project_state.yaml` shows `intent_locked`

### 4. /status — Verify Analysis Gate

```bash
# Check analysis gate status
```

- [ ] `analysis_gate: ready` — all analysis artifacts present
- [ ] If `analysis_gate: blocked` — run analysis or record `analysis_override`
- [ ] `project_state.yaml` shows `media_analyzed` (after reconcile)

### 5. /triage — Footage Selection

Run the triage agent interactively:
- Agent accesses `03_analysis/` via media-mcp tools
- Review candidate board and confirm

- [ ] `04_plan/selects_candidates.yaml` generated
- [ ] All candidates have `segment_id`, `role`, `confidence`, `eligible_beats`
- [ ] Candidate count is sufficient for planned beats
- [ ] `project_state.yaml` shows `selects_ready`

### 6. /blueprint — Edit Planning

Run the blueprint planner interactively:
- If `autonomy.mode: collaborative`, preference interview occurs
- Review beat proposal readback and confirm

- [ ] `04_plan/edit_blueprint.yaml` generated
- [ ] `04_plan/uncertainty_register.yaml` generated
- [ ] Beat count and duration sum plausible for `runtime_target_sec`
- [ ] If `collaborative` mode: `pacing.confirmed_preferences` present
- [ ] No `status: blocker` uncertainties (or resolve before proceeding)
- [ ] `project_state.yaml` shows `blueprint_ready`

### 7. /review — Compile + Critique

Run the review command:
- Compile preflight generates `05_timeline/timeline.json`
- Roughcut critic produces report and patch
- Patch safety guard filters unsafe operations

- [ ] `05_timeline/timeline.json` generated (valid IR)
- [ ] `06_review/review_report.yaml` generated
- [ ] `06_review/review_patch.json` generated
- [ ] Review `fatal_issues` — if any, state is `critique_ready`
- [ ] Review `warnings` — note any audio/quality flags
- [ ] Patch operations are reasonable (trim, marker, not unsafe replaces)
- [ ] `project_state.yaml` shows `critique_ready` or `approved`

Optional: Add `06_review/human_notes.yaml` with operator observations,
then re-run `/review` to incorporate human evidence.

### 8. /export — Bundle Generation

```bash
# Generate export bundle
```

- [ ] `07_export/export_manifest.yaml` generated
- [ ] `approval_status` is correct (`clean`, `creative_override`, or `pending`)
- [ ] `analysis_override_status` is correct (`clean`, `override`, or `degraded`)
- [ ] `included_files` lists timeline, report, patch (and STYLE.md if present)
- [ ] `artifact_hashes` present for all included files
- [ ] State unchanged after export

## Success Criteria

### rokutaro-bicycle
- [ ] Reaches `critique_ready` or higher
- [ ] Export manifest functions as M3.5 handoff inventory
- [ ] No schema validation errors in any artifact

### AX-1 D4887
- [ ] Reaches `critique_ready` or higher
- [ ] Export manifest functions as M3.5 handoff inventory
- [ ] No schema validation errors in any artifact

## Troubleshooting

| Symptom | Check |
|---------|-------|
| `/triage` fails with STATE_CHECK_FAILED | Verify analysis artifacts exist in `03_analysis/` |
| `/review` fails with GATE_CHECK_FAILED | Check `compile_gate` and `planning_gate` in `/status` |
| Compile error during `/review` | Verify blueprint beats reference roles present in selects |
| Export missing files | Confirm `/review` ran successfully before `/export` |
| Stale artifacts detected | Re-run the command indicated by `/status` |
