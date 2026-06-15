/**
 * Creative regeneration eval — CLI.
 *
 * The routine eval (scripts/eval.ts --self) recompiles a golden's APPROVED plan
 * and only measures compiler regression. This harness measures the creative core
 * instead: how close does the AI come to a human's SELECTION when it starts from
 * raw analysis, with no sight of the approved answer.
 *
 * Two phases (the regeneration itself is an LLM agent run, done between them):
 *
 *   1. Prep a blind scratch project (01_intent + 03_analysis only — no 04_plan):
 *        npx tsx scripts/eval-regenerate.ts --prep projects/fumoto-growth
 *      Then run the footage-triager agent against the scratch dir so it writes
 *      <scratch>/04_plan/selects_candidates.yaml WITHOUT seeing the golden.
 *
 *   2. Score the regenerated selection against the human golden:
 *        npx tsx scripts/eval-regenerate.ts --score \
 *          --golden projects/fumoto-growth --candidate <scratch>
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { loadSelects } from "../runtime/artifacts/loaders.js";
import {
  buildSelectsRegenerationReport,
  type SegmentEvidence,
} from "../runtime/eval/regenerate-report.js";
import { classifyTranscriptQuality } from "../runtime/analysis/transcript-quality.js";

const SELECTS_REL = "04_plan/selects_candidates.yaml";
const SEGMENTS_REL = "03_analysis/segments.json";
// Copied into the blind scratch — deliberately excludes 04_plan / 05_timeline.
const BLIND_COPY_ENTRIES = ["01_intent", "03_analysis", "STYLE.md"];

function repoRoot(): string {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
}

function loadSegmentsEvidence(projectDir: string): SegmentEvidence[] {
  const p = path.join(projectDir, SEGMENTS_REL);
  if (!fs.existsSync(p)) return [];
  const parsed = JSON.parse(fs.readFileSync(p, "utf-8")) as {
    items?: SegmentEvidence[];
    segments?: SegmentEvidence[];
  };
  return (parsed.items ?? parsed.segments ?? []).map((s) => ({
    segment_id: s.segment_id,
    summary: s.summary,
    transcript_excerpt: s.transcript_excerpt,
    tags: s.tags,
  }));
}

/**
 * Structural intervention (deterministic): mark segments whose STT is
 * unreliable (Whisper hallucination / mojibake / babble) and blank the noise so
 * the triager judges those segments on their visual summary instead of being
 * misled. This is the fix under test by the creative-regeneration loop.
 */
function cleanScratchTranscripts(scratch: string): { total: number; flagged: number } {
  const p = path.join(scratch, SEGMENTS_REL);
  if (!fs.existsSync(p)) return { total: 0, flagged: 0 };
  const data = JSON.parse(fs.readFileSync(p, "utf-8")) as {
    items?: Array<Record<string, unknown>>;
    segments?: Array<Record<string, unknown>>;
  };
  const items = data.items ?? data.segments ?? [];
  let flagged = 0;
  for (const s of items) {
    const r = classifyTranscriptQuality(s.transcript_excerpt as string | undefined);
    s.transcript_quality = r.quality;
    if (r.quality === "ok") {
      if (r.usableText) s.transcript_excerpt = r.usableText;
    } else {
      s.transcript_excerpt = "[transcript unreliable — judge this segment on its visual summary]";
      flagged += 1;
    }
  }
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  return { total: items.length, flagged };
}

function prep(goldenDir: string, outDir?: string, cleanTranscripts = false): void {
  const golden = path.resolve(goldenDir);
  const scratch = path.resolve(
    outDir ?? path.join(repoRoot(), "reports/eval/regen-scratch", path.basename(golden)),
  );
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });
  for (const entry of BLIND_COPY_ENTRIES) {
    const src = path.join(golden, entry);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(scratch, entry), { recursive: true });
  }
  // Guard against accidental answer leakage.
  fs.rmSync(path.join(scratch, "04_plan"), { recursive: true, force: true });
  fs.rmSync(path.join(scratch, "05_timeline"), { recursive: true, force: true });

  console.log(`Blind scratch ready: ${scratch}`);
  console.log(`  contains: ${BLIND_COPY_ENTRIES.filter((e) => fs.existsSync(path.join(scratch, e))).join(", ")}`);
  console.log(`  (04_plan / 05_timeline intentionally absent — the agent must not see the answer)`);
  if (cleanTranscripts) {
    const { total, flagged } = cleanScratchTranscripts(scratch);
    console.log(`  transcript-quality cleaning: ${flagged}/${total} segments had unreliable STT blanked (judge on visuals)`);
  }
  console.log("");
  console.log(`Next: run the footage-triager agent against ${scratch} so it writes`);
  console.log(`  ${path.join(scratch, SELECTS_REL)}`);
  console.log(`Then: npx tsx scripts/eval-regenerate.ts --score --golden ${goldenDir} --candidate ${scratch}`);
}

function score(goldenDir: string, candidateDir: string, now: Date): void {
  const golden = path.resolve(goldenDir);
  const candidate = path.resolve(candidateDir);
  const goldenSelectsPath = path.join(golden, SELECTS_REL);
  const candidateSelectsPath = path.join(candidate, SELECTS_REL);
  if (!fs.existsSync(goldenSelectsPath)) throw new Error(`Golden selects not found: ${goldenSelectsPath}`);
  if (!fs.existsSync(candidateSelectsPath)) {
    throw new Error(`Candidate selects not found: ${candidateSelectsPath} (run the triager agent first)`);
  }

  const report = buildSelectsRegenerationReport(
    loadSelects(goldenSelectsPath),
    loadSelects(candidateSelectsPath),
    loadSegmentsEvidence(golden),
    {
      goldenProject: path.basename(golden),
      candidateProject: path.basename(candidate),
      evaluatedAt: now.toISOString(),
    },
  );

  const outDir = path.join(repoRoot(), "reports/eval");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(outDir, `regen-${path.basename(golden)}_${stamp}.md`);
  fs.writeFileSync(outPath, report.markdown, "utf-8");

  const a = report.agreement;
  console.log(`Creative regeneration — ${path.basename(golden)}`);
  console.log(`  composite ${(a.score * 100).toFixed(1)}/100 | F1 ${(a.f1 * 100).toFixed(1)}% (P ${(a.precision * 100).toFixed(0)}/R ${(a.recall * 100).toFixed(0)})`);
  console.log(`  missed critical (must-have/hero): ${report.missedCritical.length} | missed total: ${report.missed.length} | added: ${report.extra.length}`);
  console.log(`  report: ${path.relative(repoRoot(), outPath)}`);
}

function main(argv: string[]): void {
  const args = argv.slice(2);
  const has = (flag: string): boolean => args.includes(flag);
  const val = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };

  if (has("--prep")) {
    const golden = val("--prep");
    if (!golden) throw new Error("--prep requires a golden project dir");
    prep(golden, val("--out"), has("--clean-transcripts"));
    return;
  }
  if (has("--score")) {
    const golden = val("--golden");
    const candidate = val("--candidate");
    if (!golden || !candidate) throw new Error("--score requires --golden <dir> --candidate <dir>");
    score(golden, candidate, new Date());
    return;
  }
  console.log("Usage:");
  console.log("  npx tsx scripts/eval-regenerate.ts --prep <goldenDir> [--out <scratchDir>]");
  console.log("  npx tsx scripts/eval-regenerate.ts --score --golden <goldenDir> --candidate <scratchDir>");
}

main(process.argv);
