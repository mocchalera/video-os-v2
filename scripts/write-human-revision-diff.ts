/**
 * Canonical production route for writing an identity-bound
 * human_revision_diff.yaml (Issue #29 Phase 6).
 *
 * Usage:
 *   npx tsx scripts/write-human-revision-diff.ts <project-path> --diff <diff.json>
 *
 * The diff JSON must carry the immutable identity block (base timeline,
 * review generation, and review round). Identity-less diffs are refused —
 * they are never canonical output.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import { writeCanonicalHumanRevisionDiff, type HumanRevisionDiff } from "../runtime/handoff/diff.js";

const USAGE = "Usage: npx tsx scripts/write-human-revision-diff.ts <project-path> --diff <diff.json>";

interface Args {
  projectDir: string;
  diffPath: string;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let diffPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--diff") {
      diffPath = argv[++index];
      if (!diffPath) throw new Error(USAGE);
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown option ${arg}\n${USAGE}`);
    positional.push(arg);
  }
  if (positional.length !== 1 || !diffPath) throw new Error(USAGE);
  return { projectDir: path.resolve(positional[0]!), diffPath: path.resolve(diffPath!) };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const document = JSON.parse(fs.readFileSync(args.diffPath, "utf8")) as Record<string, unknown>;
  const validation = validateAgainstSchema(document, "human-revision-diff.schema.json");
  if (!validation.valid) {
    throw new Error(`human_revision_diff failed schema validation: ${validation.errors.join("; ")}`);
  }
  const written = writeCanonicalHumanRevisionDiff(args.projectDir, {
    handoffId: String(document.handoff_id),
    diff: document as unknown as HumanRevisionDiff,
  });
  process.stdout.write(`${JSON.stringify({ ok: true, path: written.relativePath, round_identity: written.round.round_identity }, null, 2)}\n`);
}

main();
