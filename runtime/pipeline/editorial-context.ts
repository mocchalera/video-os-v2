import * as fs from "node:fs";
import * as path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { loadCreativeBrief, validateArtifact } from "../artifacts/loaders.js";
import {
  assertProjectPlanningMediaKindsSupported,
} from "../artifacts/source-media-capabilities.js";
import { assertStillImageSegmentGrounding } from "../artifacts/still-image-grounding.js";
import type { CreativeBrief } from "../artifacts/types.js";
import type { SegmentItem } from "../connectors/ffmpeg-segmenter.js";
import type { MarlinEventsArtifact } from "../connectors/marlin-types.js";
import { readProjectState } from "../state/reconcile.js";
import {
  loadSourceMap,
  type MediaSourceMapEntry,
} from "../media/source-map.js";

interface SegmentsDoc {
  items?: SegmentItem[];
}

export interface EditorialPlanningContext {
  projectDir: string;
  brief: CreativeBrief;
  marlinEvents: MarlinEventsArtifact;
  segments: SegmentItem[];
  sourceMap: Map<string, MediaSourceMapEntry>;
}

export interface LoadEditorialPlanningContextOptions {
  warn?: (message: string) => void;
}

export function loadEditorialPlanningContext(
  projectDir: string,
  options: LoadEditorialPlanningContextOptions = {},
): EditorialPlanningContext {
  const resolvedProjectDir = path.resolve(projectDir);
  assertProjectPlanningMediaKindsSupported(resolvedProjectDir);
  assertStillImageSegmentGrounding(resolvedProjectDir);
  const brief = loadCreativeBrief(path.join(resolvedProjectDir, "01_intent", "creative_brief.yaml"));
  assertCreativeBriefProjectIdentity(resolvedProjectDir, brief);

  return {
    projectDir: resolvedProjectDir,
    brief,
    marlinEvents: loadMarlinEvents(resolvedProjectDir, options.warn),
    segments: loadSegments(resolvedProjectDir),
    sourceMap: loadSourceMap(resolvedProjectDir).entryMap,
  };
}

function assertCreativeBriefProjectIdentity(projectDir: string, brief: CreativeBrief): void {
  const expectedProjectId = readProjectState(projectDir)?.project_id;
  if (!expectedProjectId) return;

  const declaredProjectIds = [brief.project_id, brief.project?.id]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const mismatch = declaredProjectIds.find((value) => value !== expectedProjectId);
  if (mismatch) {
    throw new Error(
      `creative_brief.yaml project_id mismatch: expected ${expectedProjectId}, got ${mismatch}`,
    );
  }
}

export function loadSegments(projectDir: string): SegmentItem[] {
  const filePath = path.join(projectDir, "03_analysis", "segments.json");
  if (!fs.existsSync(filePath)) throw new Error(`segments.json not found: ${filePath}`);
  const doc = readJson<SegmentsDoc>(filePath);
  if (!Array.isArray(doc.items)) {
    throw new Error(`segments.json must contain an items array: ${filePath}`);
  }
  return doc.items;
}

export function loadMarlinEvents(
  projectDir: string,
  warn: (message: string) => void = (message) => console.warn(message),
): MarlinEventsArtifact {
  const filePath = path.join(projectDir, "03_analysis", "marlin_events.json");
  if (!fs.existsSync(filePath)) {
    warn(`[editorial] optional Marlin evidence missing; continuing text-first: ${filePath}`);
    return {
      project_id: path.basename(projectDir),
      artifact_version: "1.0.0",
      model: {
        provider: "marlin",
        model_alias: "optional-unavailable",
        model_snapshot: "not-generated",
      },
      items: [],
    };
  }
  return readJson<MarlinEventsArtifact>(filePath);
}

export function writeValidatedYamlArtifact(
  projectDir: string,
  relativePath: string,
  data: unknown,
  schemaFile: string,
): void {
  validateArtifact(data, schemaFile);
  atomicWrite(
    path.join(projectDir, relativePath),
    stringifyYaml(data),
  );
}

export function writeJsonArtifact(
  projectDir: string,
  relativePath: string,
  data: unknown,
): void {
  atomicWrite(
    path.join(projectDir, relativePath),
    `${JSON.stringify(data, null, 2)}\n`,
  );
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, filePath);
}
