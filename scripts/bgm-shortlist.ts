#!/usr/bin/env npx tsx

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { ArtifactValidationError } from "../runtime/artifacts/loaders.js";
import {
  BgmShortlistReviewError,
  buildBgmShortlistReviewQueue,
  updateBgmShortlistReview,
  writeBgmShortlistReviewQueue,
  type ShortlistReview,
  type ShortlistImportResult,
  type ShortlistReviewUpdateResult,
} from "../runtime/music/shortlist-import.js";

const DEFAULT_CATALOG = "docs/bgm-pack/core-v1/track-catalog.yaml";
const USAGE = [
  "Usage: npx tsx scripts/bgm-shortlist.ts verify --shortlist <file> [options]",
  "       npx tsx scripts/bgm-shortlist.ts prepare-review --shortlist <file> --output <file> [options]",
  "       npx tsx scripts/bgm-shortlist.ts review --queue <file> --candidate <id> --reviewer <name> [review options]",
  "",
  "Options:",
  `  --catalog <file>         Core track catalog (default: ${DEFAULT_CATALOG})`,
  "  --batch-root <N=path>    Override a private generation batch root; repeatable",
  "  --json                   Emit machine-readable, path-redacted output",
  "Review options:",
  "  --musical-fit <pending|approved|rejected>",
  "  --dialogue-bed <pending|passed|failed>",
  "  --artifact-quality <pending|passed|failed>",
  "  --originality <pending|passed|concern>",
  "  --rights <pending|operator_declared_ok|licensed|blocked>",
  "  --note <text>            Reviewer note; repeatable",
  "",
  "Technical ranking never counts as musical, originality, or rights approval.",
].join("\n");

export interface BgmShortlistCliArgs {
  command: "verify" | "prepare-review" | "review";
  shortlist?: string;
  catalog: string;
  output?: string;
  queue?: string;
  candidateId?: string;
  reviewer?: string;
  musicalFit?: ShortlistReview["musical_fit"];
  dialogueBed?: ShortlistReview["dialogue_bed"];
  artifactQuality?: ShortlistReview["artifact_quality"];
  originality?: ShortlistReview["originality"];
  rights?: ShortlistReview["rights"];
  notes: string[];
  batchRoots: Map<number, string>;
  json: boolean;
}

export interface BgmShortlistCliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface BgmShortlistCliDependencies {
  build: typeof buildBgmShortlistReviewQueue;
  write: typeof writeBgmShortlistReviewQueue;
  review: typeof updateBgmShortlistReview;
  now: () => Date;
}

export const BGM_SHORTLIST_CLI_EXIT = {
  ok: 0,
  usage: 2,
  notFound: 3,
  verificationFailed: 4,
  internal: 5,
} as const;

function parseBatchRoot(value: string): [number, string] {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) throw new Error(USAGE);
  const batch = Number(value.slice(0, separator));
  const root = value.slice(separator + 1);
  if (!Number.isSafeInteger(batch) || batch < 1 || root.trim().length === 0) throw new Error(USAGE);
  return [batch, root];
}

export function parseBgmShortlistArgs(argv: string[]): BgmShortlistCliArgs {
  const args = argv.slice(2);
  const command = args.shift();
  if (command !== "verify" && command !== "prepare-review" && command !== "review") throw new Error(USAGE);
  let shortlist: string | undefined;
  let catalog = DEFAULT_CATALOG;
  let output: string | undefined;
  let queue: string | undefined;
  let candidateId: string | undefined;
  let reviewer: string | undefined;
  let musicalFit: ShortlistReview["musical_fit"] | undefined;
  let dialogueBed: ShortlistReview["dialogue_bed"] | undefined;
  let artifactQuality: ShortlistReview["artifact_quality"] | undefined;
  let originality: ShortlistReview["originality"] | undefined;
  let rights: ShortlistReview["rights"] | undefined;
  const notes: string[] = [];
  let json = false;
  const batchRoots = new Map<number, string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--shortlist" && args[index + 1]) shortlist = args[++index];
    else if (arg === "--catalog" && args[index + 1]) catalog = args[++index];
    else if (arg === "--output" && args[index + 1]) output = args[++index];
    else if (arg === "--queue" && args[index + 1]) queue = args[++index];
    else if (arg === "--candidate" && args[index + 1]) candidateId = args[++index];
    else if (arg === "--reviewer" && args[index + 1]) reviewer = args[++index];
    else if (arg === "--musical-fit" && ["pending", "approved", "rejected"].includes(args[index + 1])) {
      musicalFit = args[++index] as ShortlistReview["musical_fit"];
    } else if (arg === "--dialogue-bed" && ["pending", "passed", "failed"].includes(args[index + 1])) {
      dialogueBed = args[++index] as ShortlistReview["dialogue_bed"];
    } else if (arg === "--artifact-quality" && ["pending", "passed", "failed"].includes(args[index + 1])) {
      artifactQuality = args[++index] as ShortlistReview["artifact_quality"];
    } else if (arg === "--originality" && ["pending", "passed", "concern"].includes(args[index + 1])) {
      originality = args[++index] as ShortlistReview["originality"];
    } else if (arg === "--rights" && ["pending", "operator_declared_ok", "licensed", "blocked"].includes(args[index + 1])) {
      rights = args[++index] as ShortlistReview["rights"];
    } else if (arg === "--note" && args[index + 1]) {
      const note = args[++index].trim();
      if (!note) throw new Error(USAGE);
      notes.push(note);
    }
    else if (arg === "--batch-root" && args[index + 1]) {
      const [batch, root] = parseBatchRoot(args[++index]);
      batchRoots.set(batch, root);
    } else if (arg === "--json") json = true;
    else throw new Error(USAGE);
  }

  if (command === "review") {
    if (!queue || !candidateId || !reviewer?.trim() || !musicalFit || !dialogueBed
      || !artifactQuality || !originality || !rights || shortlist || output) throw new Error(USAGE);
  } else {
    if (!shortlist || queue || candidateId || reviewer || musicalFit || dialogueBed
      || artifactQuality || originality || rights || notes.length > 0
      || (command === "prepare-review" && !output) || (command === "verify" && output)) throw new Error(USAGE);
  }
  return {
    command,
    ...(shortlist ? { shortlist } : {}),
    catalog,
    ...(output ? { output } : {}),
    ...(queue ? { queue } : {}),
    ...(candidateId ? { candidateId } : {}),
    ...(reviewer ? { reviewer: reviewer.trim() } : {}),
    ...(musicalFit ? { musicalFit } : {}),
    ...(dialogueBed ? { dialogueBed } : {}),
    ...(artifactQuality ? { artifactQuality } : {}),
    ...(originality ? { originality } : {}),
    ...(rights ? { rights } : {}),
    notes: [...new Set(notes)],
    batchRoots,
    json,
  };
}

function writeJson(io: BgmShortlistCliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function summaryPayload(
  args: BgmShortlistCliArgs,
  result: ShortlistImportResult,
  wroteArtifact: boolean,
): Record<string, unknown> {
  return {
    ok: result.ok,
    command: args.command,
    status: result.artifact.status,
    counts: result.artifact.counts,
    shortlist_hash: result.artifact.source.shortlist_hash,
    catalog_hash: result.artifact.catalog.content_hash,
    wrote_artifact: wroteArtifact,
    ...(wroteArtifact && args.output ? { output_ref: path.basename(args.output) } : {}),
    issues: result.artifact.issues,
  };
}

function reviewPayload(result: ShortlistReviewUpdateResult): Record<string, unknown> {
  return {
    ok: true,
    command: "review",
    status: result.artifact.status,
    candidate_id: result.candidate.candidate_id,
    promotion_eligible: result.candidate.promotion_eligible,
    counts: result.artifact.counts,
    wrote_artifact: true,
    issues: result.artifact.issues,
  };
}

function isMissingInput(error: unknown): boolean {
  return error instanceof Error
    && (("code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")
      || error.message.includes("file not found"));
}

export async function runBgmShortlistCli(
  argv: string[] = process.argv,
  io: BgmShortlistCliIo = { stdout: process.stdout, stderr: process.stderr },
  dependencies: BgmShortlistCliDependencies = {
    build: buildBgmShortlistReviewQueue,
    write: writeBgmShortlistReviewQueue,
    review: updateBgmShortlistReview,
    now: () => new Date(),
  },
): Promise<number> {
  const jsonRequested = argv.includes("--json");
  let args: BgmShortlistCliArgs;
  try {
    args = parseBgmShortlistArgs(argv);
  } catch {
    if (jsonRequested) {
      writeJson(io, {
        ok: false,
        command: "usage",
        issues: [{ code: "BGM_SHORTLIST_USAGE", message: "Invalid BGM shortlist arguments." }],
      });
    } else {
      io.stderr.write(`${USAGE}\n`);
    }
    return BGM_SHORTLIST_CLI_EXIT.usage;
  }

  try {
    if (args.command === "review") {
      if (!args.queue || !fs.existsSync(args.queue)) {
        throw Object.assign(new Error("Required review queue is unavailable."), { code: "ENOENT" });
      }
      const result = dependencies.review({
        reviewPath: args.queue,
        candidateId: args.candidateId!,
        review: {
          musical_fit: args.musicalFit!,
          dialogue_bed: args.dialogueBed!,
          artifact_quality: args.artifactQuality!,
          originality: args.originality!,
          rights: args.rights!,
          reviewer_ref: args.reviewer!,
          reviewed_at: dependencies.now().toISOString(),
          notes: args.notes,
        },
      });
      const payload = reviewPayload(result);
      if (args.json) writeJson(io, payload);
      else io.stdout.write(
        `BGM review saved: ${result.candidate.candidate_id}; `
        + `${result.candidate.promotion_eligible ? "promotion-eligible" : "human gates remain"}.\n`,
      );
      return BGM_SHORTLIST_CLI_EXIT.ok;
    }

    if (!args.shortlist || !fs.existsSync(args.shortlist) || !fs.existsSync(args.catalog)) {
      throw Object.assign(new Error("Required shortlist input is unavailable."), { code: "ENOENT" });
    }
    const result = dependencies.build({
      shortlistPath: args.shortlist,
      catalogPath: args.catalog,
      batchRoots: args.batchRoots,
      ...(args.command === "prepare-review" && args.output ? { existingReviewPath: args.output } : {}),
    });
    const wroteArtifact = args.command === "prepare-review" && result.ok && Boolean(args.output);
    if (wroteArtifact && args.output) dependencies.write(args.output, result.artifact);
    const payload = summaryPayload(args, result, wroteArtifact);
    if (args.json) writeJson(io, payload);
    else {
      const counts = result.artifact.counts;
      io.stdout.write(
        `BGM shortlist ${result.artifact.status}: ${counts.source_verified}/${counts.shortlisted_candidates} source files verified; `
        + `${counts.promotion_eligible} promotion-eligible.\n`,
      );
      if (wroteArtifact) io.stdout.write("Musical review queue written.\n");
    }
    return result.ok ? BGM_SHORTLIST_CLI_EXIT.ok : BGM_SHORTLIST_CLI_EXIT.verificationFailed;
  } catch (error) {
    const notFound = isMissingInput(error);
    const reviewError = error instanceof BgmShortlistReviewError ? error : undefined;
    const invalid = error instanceof ArtifactValidationError
      || error instanceof SyntaxError
      || (error instanceof Error && error.message.includes("malformed"));
    const payload = {
      ok: false,
      command: args.command,
      issues: [{
        code: reviewError?.code ?? (notFound ? "BGM_SHORTLIST_INPUT_MISSING" : invalid ? "BGM_SHORTLIST_INVALID" : "BGM_SHORTLIST_INTERNAL"),
        message: notFound
          ? "A required shortlist, catalog, or private batch input is unavailable."
          : reviewError
            ? reviewError.message
          : invalid
            ? "The shortlist or review artifact does not satisfy its versioned contract."
            : "BGM shortlist preparation failed unexpectedly.",
      }],
    };
    if (args.json) writeJson(io, payload);
    else io.stderr.write(`${payload.issues[0].message}\n`);
    if (notFound) return BGM_SHORTLIST_CLI_EXIT.notFound;
    if (invalid || reviewError) return BGM_SHORTLIST_CLI_EXIT.verificationFailed;
    return BGM_SHORTLIST_CLI_EXIT.internal;
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) process.exitCode = await runBgmShortlistCli(process.argv);
