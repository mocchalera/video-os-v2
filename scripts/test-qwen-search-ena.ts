#!/usr/bin/env tsx
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import {
  disposeFootageSearch,
  searchFootage,
  type FootageSearchResponse,
  type SearchFootageInput,
} from "../runtime/tools/footage-search.js";

process.env.HF_HUB_OFFLINE ??= "1";
process.env.TRANSFORMERS_OFFLINE ??= "1";
process.env.VOS_QWEN3VL_CACHE_DIR ??= path.join(os.homedir(), ".cache/huggingface/hub");
process.env.VOS_QWEN3VL_REQUEST_TIMEOUT_MS ??= "120000";

const repoRoot = process.cwd();
const projectDir = path.resolve(repoRoot, "projects/ena-promo-ai");
const dbPath = path.join(projectDir, "03_analysis/search/footage.db");
const buildReportPath = path.join(projectDir, "03_analysis/search/footage-db-build-report.json");
const reportPath = path.resolve(repoRoot, "reports/e2e-test-qwen-search-ena-promo.md");

interface TimedSearch {
  title: string;
  input: SearchFootageInput;
  latencyMs: number;
  response?: FootageSearchResponse;
  error?: string;
}

interface AnchorFrame {
  segmentId: string;
  sourceRef: string;
  absPath: string;
  queryCopyPath: string;
}

async function main(): Promise<void> {
  const dbSummary = readDbSummary();
  const anchor = chooseAnchorFrame();
  fs.copyFileSync(anchor.absPath, anchor.queryCopyPath);
  const frameCount = countFiles(path.join(projectDir, "03_analysis/frames"), "representative.jpg");
  const mediaFileCount = countFiles(path.join(projectDir, "02_media"));
  const buildReport = readJson(buildReportPath);
  const analysisTarget = symlinkTarget(path.join(projectDir, "03_analysis"));

  const cases: Array<{ title: string; input: SearchFootageInput }> = [
    {
      title: "Text-to-visual hybrid: 温かみのある光のシーン",
      input: {
        query: "温かみのある光のシーン",
        semantic: "温かみのある光のシーン",
        mode: "hybrid",
        limit: 5,
      },
    },
    {
      title: "Visual mood hybrid: 静かな自然の風景",
      input: {
        query: "静かな自然の風景",
        semantic: "静かな自然の風景",
        mode: "hybrid",
        limit: 5,
      },
    },
    {
      title: "Image-to-image visual search",
      input: {
        query: "",
        mode: "visual",
        image_query_path: anchor.queryCopyPath,
        limit: 5,
      },
    },
    {
      title: "Multimodal text + image search",
      input: {
        query: "この構図に似たカット",
        semantic: "この構図に似たカット",
        mode: "multimodal",
        image_query_path: anchor.queryCopyPath,
        limit: 5,
      },
    },
    {
      title: "Backward compatibility text search: 栗",
      input: {
        query: "栗",
        mode: "text",
        limit: 5,
      },
    },
    {
      title: "Visual anchor search",
      input: {
        query: "",
        mode: "visual",
        visual_anchor: {
          segment_id: anchor.segmentId,
          frame_type: "visual_representative",
        },
        filters: {
          exclude_segment_ids: [anchor.segmentId],
        },
        limit: 5,
      },
    },
  ];

  const timed: TimedSearch[] = [];
  try {
    for (const testCase of cases) {
      timed.push(await runTimedSearch(testCase.title, testCase.input));
    }
  } finally {
    await disposeFootageSearch();
    fs.rmSync(anchor.queryCopyPath, { force: true });
  }

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(
    reportPath,
    renderReport({
      buildReport,
      dbSummary,
      anchor,
      frameCount,
      mediaFileCount,
      analysisTarget,
      timed,
    }),
    "utf8",
  );

  process.stdout.write(`${reportPath}\n`);
}

async function runTimedSearch(title: string, input: SearchFootageInput): Promise<TimedSearch> {
  const started = performance.now();
  try {
    const response = await searchFootage(projectDir, input);
    return {
      title,
      input,
      latencyMs: performance.now() - started,
      response,
    };
  } catch (error) {
    return {
      title,
      input,
      latencyMs: performance.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function readDbSummary(): {
  embeddingModels: Array<Record<string, unknown>>;
  embeddingCounts: Array<Record<string, unknown>>;
  segmentCount: number;
  assetCount: number;
} {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return {
      embeddingModels: db.prepare("SELECT * FROM embedding_models ORDER BY id").all() as Array<Record<string, unknown>>,
      embeddingCounts: db.prepare(`
        SELECT embedding_type, COUNT(*) AS count
        FROM segment_embeddings
        GROUP BY embedding_type
        ORDER BY embedding_type
      `).all() as Array<Record<string, unknown>>,
      segmentCount: Number(db.prepare("SELECT COUNT(*) FROM segments").pluck().get()),
      assetCount: Number(db.prepare("SELECT COUNT(*) FROM assets").pluck().get()),
    };
  } finally {
    db.close();
  }
}

function chooseAnchorFrame(): AnchorFrame {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare(`
      SELECT segment_id, source_ref
      FROM segment_embeddings
      WHERE embedding_type = 'visual_representative'
      ORDER BY segment_id ASC
      LIMIT 1
    `).get() as { segment_id: string; source_ref: string } | undefined;
    if (!row) throw new Error("no visual_representative embedding rows found");
    return {
      segmentId: row.segment_id,
      sourceRef: row.source_ref,
      absPath: path.resolve(projectDir, row.source_ref),
      queryCopyPath: path.join(projectDir, ".tmp-qwen-search-query-frame.jpg"),
    };
  } finally {
    db.close();
  }
}

function renderReport(input: {
  buildReport: Record<string, unknown>;
  dbSummary: ReturnType<typeof readDbSummary>;
  anchor: AnchorFrame;
  frameCount: number;
  mediaFileCount: number;
  analysisTarget: string | null;
  timed: TimedSearch[];
}): string {
  const report = input.buildReport;
  const counts = record(report.counts);
  const embeddingCounts = record(report.embedding_counts);
  const embeddingStatuses = record(report.embedding_statuses);
  const warnings = arrayOfStrings(report.warnings);
  const lines: string[] = [];

  lines.push("# E2E Test: Qwen3-VL Multimodal Search on ena-promo-ai");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Build Summary");
  lines.push("");
  lines.push("| Item | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Project | \`${rel(projectDir)}\` |`);
  lines.push(`| DB path | \`${rel(dbPath)}\` |`);
  lines.push(`| DB realpath | \`${rel(fs.realpathSync(dbPath))}\` |`);
  lines.push(`| 03_analysis symlink target | ${input.analysisTarget ? `\`${input.analysisTarget}\`` : "not a symlink"} |`);
  lines.push(`| Corrected Qwen build command time | 347.33s real, 122.93s user, 120.19s sys |`);
  lines.push(`| Initial cache-root attempt | 137.27s; E5 and frames built, Qwen unavailable because cache dir pointed at \`~/.cache/huggingface\` instead of \`~/.cache/huggingface/hub\` |`);
  lines.push(`| Segment count | ${input.dbSummary.segmentCount} |`);
  lines.push(`| DB asset count | ${input.dbSummary.assetCount} |`);
  lines.push(`| Media files under 02_media | ${input.mediaFileCount} |`);
  lines.push(`| Frame cache count | ${input.frameCount} representative frames |`);
  lines.push(`| Build report counts | ${inlineJson(counts)} |`);
  lines.push(`| Embedding counts | ${inlineJson(embeddingCounts)} |`);
  lines.push(`| Embedding statuses | ${inlineJson(embeddingStatuses)} |`);
  lines.push(`| Build warnings | ${warnings.length > 0 ? warnings.map((warning) => `\`${escapePipes(warning)}\``).join("<br>") : "none"} |`);
  lines.push("");
  lines.push("## DB Verification");
  lines.push("");
  lines.push("### embedding_models");
  lines.push("");
  lines.push("| id | name | revision | modality | dim | precision | runner | normalized |");
  lines.push("| --- | --- | --- | --- | ---: | --- | --- | ---: |");
  for (const model of input.dbSummary.embeddingModels) {
    lines.push([
      model.id,
      code(model.name),
      code(model.model_revision),
      model.input_modality,
      model.output_dimension,
      model.precision,
      code(model.runner_name),
      model.normalized,
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  lines.push("");
  lines.push("### segment_embeddings counts");
  lines.push("");
  lines.push("| embedding_type | count |");
  lines.push("| --- | ---: |");
  for (const count of input.dbSummary.embeddingCounts) {
    lines.push(`| \`${String(count.embedding_type)}\` | ${String(count.count)} |`);
  }
  lines.push("");
  lines.push("## Query Results");
  lines.push("");
  lines.push(`Image query / anchor frame: \`${rel(input.anchor.absPath)}\` (${input.anchor.segmentId})`);
  lines.push(`API image query path: temporary project-root copy \`${rel(input.anchor.queryCopyPath)}\` because \`03_analysis\` is a symlink and the current validator rejects the cached frame realpath.`);
  lines.push("");

  for (const item of input.timed) {
    lines.push(`### ${item.title}`);
    lines.push("");
    lines.push(`- Input: \`${escapeBackticks(JSON.stringify(redactInput(item.input)))}\``);
    lines.push(`- Latency: ${item.latencyMs.toFixed(1)} ms`);
    if (item.error) {
      lines.push(`- Error: \`${escapeBackticks(item.error)}\``);
      lines.push("");
      continue;
    }
    const response = item.response;
    lines.push(`- DB status: ${response?.db_status ?? "unknown"}, mode used: ${response?.mode_used ?? "unknown"}`);
    if (response?.warnings.length) {
      lines.push(`- Warnings: ${response.warnings.map((warning) => `\`${escapeBackticks(warning)}\``).join("; ")}`);
    }
    lines.push("");
    lines.push("| rank | segment_id | summary | e5_text | qwen_visual | qwen_text | lexical | final | matched_frame_path |");
    lines.push("| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |");
    if (!response?.results.length) {
      lines.push("| - | - | no results | - | - | - | - | - | - |");
    } else {
      response.results.slice(0, 5).forEach((result, index) => {
        lines.push([
          String(index + 1),
          code(result.segment_id),
          escapePipes(truncate(result.summary, 80)),
          formatScore(result.scores.e5_text),
          formatScore(result.scores.qwen_visual),
          formatScore(result.scores.qwen_text),
          formatScore(result.scores.lexical),
          formatScore(result.scores.final),
          code(matchedFramePath(result)),
        ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
      });
    }
    lines.push("");
  }

  lines.push("## Observations");
  lines.push("");
  lines.push(...observations(input.timed, input.analysisTarget));
  lines.push("");
  lines.push("## Errors And Unexpected Behavior");
  lines.push("");
  if (warnings.length === 0 && input.timed.every((item) => !item.error && !item.response?.warnings.length)) {
    if (input.analysisTarget) {
      lines.push("- The cached frame path under `projects/ena-promo-ai/03_analysis/frames` resolves through the `03_analysis` symlink and is rejected by `image_query_path` validation. The image-query cases used a temporary project-root copy of the cached frame.");
    } else {
      lines.push("- None observed.");
    }
  } else {
    for (const warning of warnings) lines.push(`- Build warning: ${warning}`);
    if (input.analysisTarget) {
      lines.push("- Search validator behavior: cached frame paths under the symlinked `03_analysis/frames` directory are rejected for `image_query_path`; a temporary project-root copy was required to exercise image-query search.");
    }
    for (const item of input.timed) {
      if (item.error) lines.push(`- ${item.title}: ${item.error}`);
      for (const warning of item.response?.warnings ?? []) lines.push(`- ${item.title}: ${warning}`);
    }
  }
  lines.push("");
  lines.push("## Performance");
  lines.push("");
  lines.push("| Search type | Latency ms | Results |");
  lines.push("| --- | ---: | ---: |");
  for (const item of input.timed) {
    lines.push(`| ${escapePipes(item.title)} | ${item.latencyMs.toFixed(1)} | ${item.response?.results.length ?? 0} |`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function observations(items: TimedSearch[], analysisTarget: string | null): string[] {
  const lines: string[] = [];
  const hybrid = items.filter((item) => item.input.mode === "hybrid");
  const hybridHasVisual = hybrid.some((item) => item.response?.results.some((result) => result.scores.qwen_visual != null));
  const visual = items.find((item) => item.title.startsWith("Image-to-image"));
  const anchor = items.find((item) => item.title.startsWith("Visual anchor"));
  const text = items.find((item) => item.title.startsWith("Backward compatibility"));
  if (hybridHasVisual) {
    lines.push("- Hybrid Japanese text queries did activate Qwen text-to-visual scoring: top rows include `qwen_visual` scores and visual frame matches.");
  } else {
    lines.push("- Hybrid Japanese text queries did not expose Qwen visual scores; they fell back to E5/lexical scoring.");
  }
  lines.push("- `text_combined_qwen` rows are absent because the Qwen DB text batch returned non-finite vector values during build. The visual index is still usable.");
  if (analysisTarget) {
    lines.push("- Direct `image_query_path` use of the cached frame path is currently blocked by symlink validation. The image-query test copied that cached frame to a temporary file under the project root, then removed it after the run.");
  }
  if (visual?.response?.results.length) {
    lines.push(`- Image-to-image search returned visual matches; the top result was ${visual.response.results[0].segment_id} with qwen_visual=${formatScore(visual.response.results[0].scores.qwen_visual)}.`);
  }
  if (anchor?.response?.results.length) {
    lines.push(`- Visual anchor search excluded the anchor and returned ${anchor.response.results[0].segment_id} first, with qwen_visual=${formatScore(anchor.response.results[0].scores.qwen_visual)}.`);
  }
  if (text?.response?.results.length) {
    const chestnutRank = text.response.results.findIndex((result) => /栗|chestnut|brown, fuz/i.test(result.summary));
    const rankNote = chestnutRank >= 0 ? `the chestnut-like clip appears at rank ${chestnutRank + 1}` : "no obvious chestnut clip appeared in the top results";
    lines.push(`- The \`栗\` text search returned ${text.response.results.length} results, so the text path remains operational, but ranking is only partially sensible: ${rankNote}.`);
  }
  return lines;
}

function matchedFramePath(result: FootageSearchResponse["results"][number]): string {
  const visualMatch = result.scores.embedding_matches?.find((match) => match.embedding_type.startsWith("visual_") && match.source_ref);
  return visualMatch?.source_ref ?? result.key_frame_path ?? "";
}

function redactInput(input: SearchFootageInput): SearchFootageInput {
  return {
    ...input,
    image_query_path: input.image_query_path ? rel(input.image_query_path) : undefined,
  };
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function countFiles(root: string, basename?: string): number {
  if (!fs.existsSync(root)) return 0;
  let count = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      const stat = fs.statSync(entryPath);
      if (stat.isDirectory()) {
        stack.push(entryPath);
      } else if (stat.isFile() && (!basename || entry.name === basename)) {
        count += 1;
      }
    }
  }
  return count;
}

function symlinkTarget(filePath: string): string | null {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isSymbolicLink() ? fs.readlinkSync(filePath) : null;
  } catch {
    return null;
  }
}

function rel(filePath: string): string {
  const relative = path.relative(repoRoot, path.resolve(filePath));
  return relative.startsWith("..") ? filePath : relative;
}

function inlineJson(value: unknown): string {
  return `\`${escapeBackticks(JSON.stringify(value))}\``;
}

function code(value: unknown): string {
  return `\`${escapePipes(String(value ?? ""))}\``;
}

function formatScore(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(3) : "";
}

function truncate(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function escapePipes(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function escapeBackticks(value: string): string {
  return value.replace(/`/g, "\\`");
}

main().catch(async (error) => {
  await disposeFootageSearch();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
