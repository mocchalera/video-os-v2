import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  finalizeReviewReady,
  dispatchReviewAsk,
  refreshReviewFreshness,
  type ReviewAskAdapter,
  type ReviewReadyInput,
} from "../runtime/review/review-ready-transaction.js";
import {
  CockpitReviewAskAdapter,
  recordCockpitAskResolved,
  type CockpitCommandRunner,
} from "../runtime/review/cockpit-review-ask.js";

const USAGE = "Usage: npx tsx scripts/review-ready.ts prepare --project <dir> --evidence <json> | dispatch --project <dir> | record-response --project <dir> --event <json-file> | record-response --project <dir> --event-stdin | refresh --project <dir>";

export interface ReviewReadyCliDependencies {
  adapter?: ReviewAskAdapter;
  adapterFactory?: (projectDir: string, commandRunner?: CockpitCommandRunner) => ReviewAskAdapter;
  /** Test-only stdin seam; production reads file descriptor 0. */
  eventStdin?: string;
  commandRunner?: CockpitCommandRunner;
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export function runReviewReadyCli(args: string[], dependencies: ReviewReadyCliDependencies = {}): unknown | Promise<unknown> {
  const command = args[0];
  const projectValue = valueAfter(args, "--project");
  if (!projectValue) throw new Error(USAGE);
  const projectDir = path.resolve(projectValue);
  if (command === "refresh") return refreshReviewFreshness(projectDir);
  if (command === "dispatch") {
    const adapter = dependencies.adapter
      ?? dependencies.adapterFactory?.(projectDir, dependencies.commandRunner)
      ?? new CockpitReviewAskAdapter({ projectDir, runner: dependencies.commandRunner });
    return dispatchReviewAsk(projectDir, adapter);
  }
  if (command === "record-response") {
    const eventFile = valueAfter(args, "--event");
    const useStdin = args.includes("--event-stdin");
    if ((eventFile ? 1 : 0) + (useStdin ? 1 : 0) !== 1) throw new Error(USAGE);
    const bytes = useStdin
      ? dependencies.eventStdin ?? fs.readFileSync(0, "utf8")
      : fs.readFileSync(path.resolve(eventFile!), "utf8");
    let event: unknown;
    try {
      event = JSON.parse(bytes);
    } catch {
      throw new Error("review response event is malformed JSON");
    }
    return recordCockpitAskResolved(projectDir, event);
  }
  if (command !== "prepare") throw new Error(USAGE);
  const evidenceValue = valueAfter(args, "--evidence");
  if (!evidenceValue) throw new Error(USAGE);
  const evidencePath = path.resolve(evidenceValue);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as Omit<ReviewReadyInput, "projectDir">;
  return finalizeReviewReady({ ...evidence, projectDir });
}

async function main(): Promise<void> {
  try {
    process.stdout.write(`${JSON.stringify(await runReviewReadyCli(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) void main();
