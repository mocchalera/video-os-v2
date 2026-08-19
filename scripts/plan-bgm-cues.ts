#!/usr/bin/env npx tsx

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  BgmCuePlanningError,
  buildBgmCueDecisionReport,
  contentHashForJson,
  lockExplicitBgmSelection,
  materializeBgmCuePlan,
  planMusicCuesV2,
  resolveExplicitBgmTrack,
  validateBgmCuePlanOutputPath,
} from "../runtime/music/cue-planner.js";
import { projectMusicToTimeline } from "../runtime/audio/music-cues.js";
import {
  BgmSelectionServiceError,
  selectBgmForProject,
} from "../runtime/music/selection-service.js";
import type { PackRegistryOptions } from "../runtime/music/pack-registry.js";

const USAGE = [
  "Usage: npm run bgm:plan-cues -- --project <directory> --track-id <id> --output <new-directory> [options]",
  "",
  "Create an explicit, hash-pinned BGM selection and music-cues/v2 plan, then project it to A2.",
  "This command never chooses a top-ranked track automatically and never overwrites existing artifacts.",
  "",
  "Required:",
  "  --project <directory>          Project containing brief and blueprint inputs",
  "  --track-id <id>                Explicit human/fixture-selected verified Pack track",
  "  --timeline-range <in:out>      Timeline frame range, end-exclusive",
  "  --source-window-us <in:out>    Full-mix source window in microseconds",
  "  --anchor-frame <frame>         Semantic anchor frame inside the cue",
  "  --anchor-label <text>          Human-readable semantic anchor",
  "  --section <name>               Source music section",
  "  --phase <name>                 Editorial/music phase",
  "  --operator-ref <ref>           Explicit selector identity/evidence reference",
  "  --reason <text>                Explicit selection reason",
  "  --output <new-directory>       New generation root; existing paths are rejected",
  "",
  "Options:",
  "  --timeline <file>              Timeline input (default: <project>/05_timeline/timeline.json)",
  "  --source-onset-us <us>         Anchor onset in source (default: source window start)",
  "  --cue-id <MC_ID>               Stable cue ID (default derived from track and anchor)",
  "  --pack-root <directory>        Explicit read-only Pack Registry root",
  "  --dry-run                      Resolve, validate, and project in memory without writes",
  "  --json                         Emit machine-readable output",
  "  --help                         Show this help",
].join("\n");

interface FrameRange {
  in: number;
  out: number;
}

export interface PlanBgmCuesCliArgs {
  project: string;
  timeline: string;
  trackId: string;
  timelineRange: FrameRange;
  sourceWindowUs: FrameRange;
  anchorFrame: number;
  anchorLabel: string;
  sourceOnsetUs: number;
  section: string;
  phase: string;
  operatorRef: string;
  reason: string;
  output: string;
  cueId: string;
  packRoot?: string;
  dryRun: boolean;
  json: boolean;
  help: boolean;
}

export interface PlanBgmCuesCliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

export const PLAN_BGM_CUES_CLI_EXIT = {
  ok: 0,
  usage: 2,
  unavailable: 3,
  invalid: 4,
  internal: 5,
} as const;

function parseInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseRange(value: string | undefined): FrameRange | undefined {
  if (!value) return undefined;
  const match = /^(\d+):(\d+)$/.exec(value);
  if (!match) return undefined;
  const input = Number(match[1]);
  const output = Number(match[2]);
  return Number.isSafeInteger(input) && Number.isSafeInteger(output) && output > input
    ? { in: input, out: output }
    : undefined;
}

function stableCueId(trackId: string, anchorFrame: number): string {
  const stableTrack = trackId.normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `MC_${stableTrack}_${String(anchorFrame).padStart(6, "0")}`;
}

export function parsePlanBgmCuesArgs(argv: string[]): PlanBgmCuesCliArgs {
  const values = argv.slice(2);
  const parsed = new Map<string, string>();
  let dryRun = false;
  let json = false;
  let help = false;
  const valued = new Set([
    "--project",
    "--timeline",
    "--track-id",
    "--timeline-range",
    "--source-window-us",
    "--anchor-frame",
    "--anchor-label",
    "--source-onset-us",
    "--section",
    "--phase",
    "--operator-ref",
    "--reason",
    "--output",
    "--cue-id",
    "--pack-root",
  ]);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (valued.has(value) && values[index + 1] && !values[index + 1].startsWith("--")) {
      parsed.set(value, values[++index]);
    } else if (value === "--dry-run") {
      dryRun = true;
    } else if (value === "--json") {
      json = true;
    } else if (value === "--help" || value === "-h") {
      help = true;
    } else {
      throw new Error("usage");
    }
  }
  if (help) {
    return {
      project: "",
      timeline: "",
      trackId: "",
      timelineRange: { in: 0, out: 1 },
      sourceWindowUs: { in: 0, out: 1 },
      anchorFrame: 0,
      anchorLabel: "",
      sourceOnsetUs: 0,
      section: "",
      phase: "",
      operatorRef: "",
      reason: "",
      output: "",
      cueId: "MC_HELP",
      dryRun,
      json,
      help,
    };
  }
  const project = parsed.get("--project");
  const trackId = parsed.get("--track-id");
  const timelineRange = parseRange(parsed.get("--timeline-range"));
  const sourceWindowUs = parseRange(parsed.get("--source-window-us"));
  const anchorFrame = parseInteger(parsed.get("--anchor-frame"));
  const sourceOnsetUs = parseInteger(parsed.get("--source-onset-us")) ?? sourceWindowUs?.in;
  const anchorLabel = parsed.get("--anchor-label");
  const section = parsed.get("--section");
  const phase = parsed.get("--phase");
  const operatorRef = parsed.get("--operator-ref");
  const reason = parsed.get("--reason");
  const output = parsed.get("--output");
  if (
    !project
    || !trackId
    || !timelineRange
    || !sourceWindowUs
    || anchorFrame === undefined
    || sourceOnsetUs === undefined
    || !anchorLabel
    || !section
    || !phase
    || !operatorRef
    || !reason
    || !output
  ) {
    throw new Error("usage");
  }
  const cueId = parsed.get("--cue-id") ?? stableCueId(trackId, anchorFrame);
  if (!/^MC_[A-Z0-9_]+$/.test(cueId)) throw new Error("usage");
  return {
    project,
    timeline: parsed.get("--timeline") ?? path.join(project, "05_timeline", "timeline.json"),
    trackId,
    timelineRange,
    sourceWindowUs,
    anchorFrame,
    anchorLabel,
    sourceOnsetUs,
    section,
    phase,
    operatorRef,
    reason,
    output,
    cueId,
    ...(parsed.get("--pack-root") ? { packRoot: parsed.get("--pack-root") } : {}),
    dryRun,
    json,
    help,
  };
}

function registryOptions(project: string, packRoot?: string): PackRegistryOptions {
  return packRoot
    ? { searchRoots: [{ source: "environment", priority: 1, path: packRoot }] }
    : { projectPackDir: path.join(path.resolve(project), "02_media", "bgm-packs") };
}

function writeJson(io: PlanBgmCuesCliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runPlanBgmCuesCli(
  argv: string[] = process.argv,
  io: PlanBgmCuesCliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  const jsonRequested = argv.includes("--json");
  let args: PlanBgmCuesCliArgs;
  try {
    args = parsePlanBgmCuesArgs(argv);
  } catch {
    if (jsonRequested) {
      writeJson(io, {
        ok: false,
        command: "plan-bgm-cues",
        issues: [{ code: "BGM_CUE_USAGE", message: "Invalid BGM cue planning arguments." }],
      });
    } else {
      io.stderr.write(`${USAGE}\n`);
    }
    return PLAN_BGM_CUES_CLI_EXIT.usage;
  }
  if (args.help) {
    io.stdout.write(`${USAGE}\n`);
    return PLAN_BGM_CUES_CLI_EXIT.ok;
  }

  try {
    const projectPath = path.resolve(args.project);
    const timelinePath = path.resolve(args.timeline);
    const outputPath = validateBgmCuePlanOutputPath(args.output, projectPath);
    const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8")) as Record<string, unknown>;
    const createdAt = typeof timeline.created_at === "string" && !Number.isNaN(Date.parse(timeline.created_at))
      ? new Date(timeline.created_at).toISOString()
      : "1970-01-01T00:00:00.000Z";
    const suggestion = await selectBgmForProject({
      projectPath,
      timelinePath,
      requestedMode: "suggest",
      outputScope: "preview_internal",
      ...(args.packRoot ? { packRoot: args.packRoot } : {}),
      writeArtifact: false,
      createdAt,
    });
    const candidate = suggestion.artifact.candidates.find((entry) =>
      entry.track_id === args.trackId && entry.status === "ranked");
    if (!candidate) {
      throw new BgmCuePlanningError(
        "BGM_SELECTION_INCONCLUSIVE",
        "The explicit track_id is not a ranked candidate for this project/timeline.",
        args.trackId,
        true,
      );
    }
    const resolved = resolveExplicitBgmTrack(
      args.trackId,
      candidate.content_hash,
      registryOptions(projectPath, args.packRoot),
    );
    const selection = lockExplicitBgmSelection(suggestion.artifact, resolved, {
      trackId: args.trackId,
      operatorRef: args.operatorRef,
      reason: args.reason,
      decidedAt: createdAt,
    });
    const selectionHash = contentHashForJson(selection);
    const planned = planMusicCuesV2({
      selection,
      resolvedTrack: resolved,
      timeline,
      selectionRef: "04_plan/bgm_selection.json",
      selectionHash,
      cues: [{
        cueId: args.cueId,
        timelineInFrame: args.timelineRange.in,
        timelineOutFrame: args.timelineRange.out,
        sourceInUs: args.sourceWindowUs.in,
        sourceOutUs: args.sourceWindowUs.out,
        section: args.section,
        phase: args.phase,
        semanticAnchor: {
          label: args.anchorLabel,
          timelineFrame: args.anchorFrame,
          sourceOnsetUs: args.sourceOnsetUs,
        },
      }],
    });
    const fps = planned.music_cues.timeline_fps!;
    const projectedTimeline = projectMusicToTimeline(timeline, planned.music_cues, {
      fpsNum: fps.num,
      fpsDen: fps.den,
    });
    const report = buildBgmCueDecisionReport({
      selection,
      musicCues: planned.music_cues,
      inputTimeline: timeline,
      projectedTimeline,
    });
    const materialized = args.dryRun
      ? undefined
      : materializeBgmCuePlan({
        projectPath,
        outputPath,
        selection,
        musicCues: planned.music_cues,
        decisionReport: report,
        projectedTimeline,
      });
    const a2 = projectedTimeline.tracks?.audio?.find((track: { track_id?: string }) => track.track_id === "A2");
    const payload = {
      ok: true,
      command: "plan-bgm-cues",
      dry_run: args.dryRun,
      wrote_artifacts: !args.dryRun,
      output_path: outputPath,
      project_id: suggestion.artifact.project_id,
      explicit_track_id: args.trackId,
      selected_track_pin: selection.selected_track_pin,
      selection_hash: selectionHash,
      music_cues_hash: contentHashForJson(planned.music_cues),
      projected_timeline_hash: contentHashForJson(projectedTimeline),
      cue_ids: planned.music_cues.cues.map((cue) => cue.cue_id),
      a2_clip_count: a2?.clips?.length ?? 0,
      semantic_anchor: planned.music_cues.cues[0]?.semantic_anchor,
      beat_alignment: planned.music_cues.cues[0]?.beat_alignment,
      warnings: report.warnings,
      release_status: report.release_status,
      ...(materialized ? { files: materialized.files, hashes: materialized.hashes } : {}),
    };
    if (args.json) writeJson(io, payload);
    else {
      io.stdout.write(
        `${args.dryRun ? "Validated" : "Created"} explicit cue ${args.cueId} for ${args.trackId}; A2 clips=${payload.a2_clip_count}.\n`,
      );
    }
    return PLAN_BGM_CUES_CLI_EXIT.ok;
  } catch (error) {
    const issue = error instanceof BgmCuePlanningError
      ? {
        code: error.code,
        message: error.message,
        affected_ref: error.affected_ref,
        recoverable: error.recoverable,
      }
      : error instanceof BgmSelectionServiceError
        ? error.issue
        : {
          code: "BGM_CUE_INTERNAL",
          message: error instanceof Error ? error.message : "BGM cue planning failed unexpectedly.",
        };
    if (args.json) writeJson(io, { ok: false, command: "plan-bgm-cues", issues: [issue] });
    else io.stderr.write(`${issue.message}\n`);
    return issue.code === "BGM_PACK_NOT_FOUND"
      ? PLAN_BGM_CUES_CLI_EXIT.unavailable
      : error instanceof BgmCuePlanningError || error instanceof BgmSelectionServiceError
        ? PLAN_BGM_CUES_CLI_EXIT.invalid
        : PLAN_BGM_CUES_CLI_EXIT.internal;
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) process.exitCode = await runPlanBgmCuesCli(process.argv);
