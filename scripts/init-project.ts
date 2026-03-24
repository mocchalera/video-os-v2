#!/usr/bin/env npx tsx

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_PROJECTS_DIR = path.join(REPO_ROOT, "projects");
const DEFAULT_TEMPLATE_DIR = path.join(DEFAULT_PROJECTS_DIR, "_template");
const DEFAULT_SOURCE_LINK_NAME = "source";
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DIRECTORIES_TO_ENSURE = [
  "02_media",
  "03_analysis",
  "07_export",
  "07_package",
];

export interface InitProjectCliArgs {
  projectId: string;
  sourceDir?: string;
}

export interface InitProjectOptions {
  projectsDir?: string;
  templateDir?: string;
  sourceDir?: string;
  sourceLinkName?: string;
}

export interface InitProjectResult {
  projectId: string;
  projectDir: string;
  sourceLinkPath?: string;
  nextStepCommand: string;
}

export function parseArgs(argv: string[]): InitProjectCliArgs {
  const args = argv.slice(2);
  let projectId = "";
  let sourceDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--source-dir") {
      sourceDir = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: npx tsx scripts/init-project.ts <project-id> [--source-dir /path/to/footage]",
      );
      process.exit(0);
    } else if (!arg.startsWith("-") && !projectId) {
      projectId = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!projectId) {
    throw new Error("Error: <project-id> is required");
  }

  if (sourceDir === "") {
    throw new Error("Error: --source-dir requires a directory path");
  }

  return { projectId, sourceDir };
}

export function initProject(
  projectId: string,
  options: InitProjectOptions = {},
): InitProjectResult {
  validateProjectId(projectId);

  const projectsDir = path.resolve(options.projectsDir ?? DEFAULT_PROJECTS_DIR);
  const templateDir = path.resolve(options.templateDir ?? DEFAULT_TEMPLATE_DIR);
  const projectDir = path.join(projectsDir, projectId);
  const sourceDir = options.sourceDir ? path.resolve(options.sourceDir) : undefined;

  if (!fs.existsSync(templateDir)) {
    throw new Error(`Template directory not found: ${templateDir}`);
  }

  if (fs.existsSync(projectDir)) {
    throw new Error(`Project already exists: ${projectDir}`);
  }

  if (sourceDir) {
    const stat = safeStat(sourceDir);
    if (!stat?.isDirectory()) {
      throw new Error(`Source directory not found: ${sourceDir}`);
    }
  }

  fs.mkdirSync(projectsDir, { recursive: true });
  fs.cpSync(templateDir, projectDir, { recursive: true });

  for (const relativeDir of DIRECTORIES_TO_ENSURE) {
    fs.mkdirSync(path.join(projectDir, relativeDir), { recursive: true });
  }

  hydrateTemplatePlaceholders(projectDir, projectId);

  let sourceLinkPath: string | undefined;
  if (sourceDir) {
    sourceLinkPath = path.join(
      projectDir,
      "02_media",
      options.sourceLinkName ?? DEFAULT_SOURCE_LINK_NAME,
    );
    fs.symlinkSync(sourceDir, sourceLinkPath, process.platform === "win32" ? "junction" : "dir");
  }

  return {
    projectId,
    projectDir,
    sourceLinkPath,
    nextStepCommand: buildNextStepCommand(projectId, Boolean(sourceLinkPath)),
  };
}

function validateProjectId(projectId: string): void {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new Error(
      "Invalid project id. Use letters, numbers, dots, underscores, or hyphens only.",
    );
  }

  if (projectId === "_template") {
    throw new Error('Project id "_template" is reserved');
  }
}

function safeStat(filePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(filePath);
  } catch {
    return null;
  }
}

function hydrateTemplatePlaceholders(projectDir: string, projectId: string): void {
  const placeholderReplacements = [
    { from: /project_id:\s*""/g, to: `project_id: "${projectId}"` },
    { from: /project_id:\s*example-project/g, to: `project_id: ${projectId}` },
    { from: /"project_id":\s*"example-project"/g, to: `"project_id": "${projectId}"` },
    { from: /projects\/_template\//g, to: `projects/${projectId}/` },
  ];

  const filesToPatch = [
    "project_state.yaml",
    "01_intent/unresolved_blockers.yaml",
    "05_timeline/v001.timeline.json",
    "06_review/human_notes.yaml",
  ];

  for (const relativePath of filesToPatch) {
    const filePath = path.join(projectDir, relativePath);
    if (!fs.existsSync(filePath)) continue;

    let text = fs.readFileSync(filePath, "utf-8");
    for (const replacement of placeholderReplacements) {
      text = text.replace(replacement.from, replacement.to);
    }
    fs.writeFileSync(filePath, text, "utf-8");
  }
}

function buildNextStepCommand(projectId: string, hasSourceLink: boolean): string {
  const sourceArg = hasSourceLink
    ? `projects/${projectId}/02_media/${DEFAULT_SOURCE_LINK_NAME}/*`
    : "/path/to/footage/*";
  return `npx tsx scripts/analyze.ts ${sourceArg} --project projects/${projectId}`;
}

function main(): void {
  try {
    const args = parseArgs(process.argv);
    const result = initProject(args.projectId, { sourceDir: args.sourceDir });

    console.log(`[init-project] Created ${path.relative(REPO_ROOT, result.projectDir)}`);
    if (result.sourceLinkPath) {
      console.log(
        `[init-project] Linked source dir -> ${path.relative(result.projectDir, result.sourceLinkPath)}`,
      );
    }
    console.log("");
    console.log("Next step:");
    console.log(`  ${result.nextStepCommand}`);
    console.log("  # Narrow the glob if the folder contains non-video files.");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[init-project] ${message}`);
    process.exit(1);
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  main();
}
