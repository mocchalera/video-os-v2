import * as fs from "node:fs";
import * as path from "node:path";
import { findProjectLocalLoudnormDuplicates } from "../audio/project-local-mastering-guard.js";

export type SkillContractSeverity = "error" | "warn";

export const SKILL_CONTRACT_SEVERITIES = {
  missing_npm_script: "error",
  missing_script_file: "error",
  unresolved_template_id: "error",
  unknown_command_flag: "error",
  flag_contract_missing: "error",
  flag_contract_parser_mismatch: "error",
  artifact_unverified: "error",
  artifact_zero_verified: "error",
  manifest_stale: "error",
  unresolved_local_reference: "error",
  unresolved_skill_reference: "error",
  generic_skill_contamination: "error",
  ownership_contradiction: "error",
  project_local_mastering_duplicate: "error",
} as const satisfies Record<string, SkillContractSeverity>;

export type SkillContractIssueCode = keyof typeof SKILL_CONTRACT_SEVERITIES;

export interface SkillContractIssue {
  severity: SkillContractSeverity;
  code: SkillContractIssueCode;
  file: string;
  line: number;
  reference: string;
  message: string;
}

export interface SkillContractAuditOptions {
  rootDir: string;
  flagContracts?: Readonly<Record<string, readonly string[]>>;
  severities?: Readonly<Record<SkillContractIssueCode, SkillContractSeverity>>;
  skillRoot?: string;
  producerRoots?: readonly string[];
}

export interface SkillContractAuditResult {
  documents: string[];
  issues: SkillContractIssue[];
  artifactDeclarations: number;
  verifiedArtifacts: number;
}

// Phase 1 uses an explicit public-flag contract. Each declared flag is also
// required to occur in a comparison or switch branch in the target parser
// source, so help text alone cannot mask parser or contract drift.
export const CLI_FLAG_CONTRACTS: Readonly<Record<string, readonly string[]>> = {
  "scripts/analyze.ts": [
    "--clear-cache", "--concurrency", "--content-hint", "--help", "--language",
    "--no-cache", "--project", "--skip-appraiser", "--skip-diarize", "--skip-marlin",
    "--skip-media-link", "--skip-peak", "--skip-preflight", "--skip-stt", "--skip-vlm",
    "--stt-provider", "--stt-strategy", "--vlm-only",
  ],
  "scripts/audio-finish-remux.ts": [
    "--created-at", "--finalize", "--help", "--json", "--output-root", "--project",
    "--source-receipt",
  ],
  "scripts/compile-timeline.ts": [
    "--fps", "--patch", "--repo-sfx-root", "--skip-confirmations", "--skip-preview", "--source-map",
  ],
  "scripts/editorial-agent-task.ts": [
    "--fine-response", "--help", "--mode", "--project", "--rough-response", "--skip-fine",
    "--skip-qa", "--skip-render",
  ],
  "scripts/eval.ts": [
    "--all", "--baseline-report", "--baseline-report-sha256", "--candidate",
    "--candidate-commit", "--divergence-threshold", "--golden", "--help", "--judge",
    "--labels", "--list", "--manifest", "--marlin", "--min-score", "--no-write", "--out",
    "--output-root", "--projects", "--results", "--self", "--suite",
  ],
  "scripts/export-premiere-xml.ts": [
    "--auto-titles", "--bake-visual-effects", "--expected-timeline-identity-json",
    "--expected-timeline-sha256", "--help", "--json", "--preflight", "--source-map",
    "--titles",
  ],
  "scripts/final-render-checklist.ts": [
    "--approved-at", "--approved-by", "--audio", "--audio-preview", "--audio-preview-sha256",
    "--bgm", "--captions", "--help", "--json", "--output-spec", "--project", "--sections",
    "--typography", "--visual-preview",
  ],
  "scripts/final-render-review-pack.ts": [
    "--help", "--json", "--manifest", "--output-dir", "--project", "--sample-duration",
    "--source",
  ],
  "scripts/full-pipeline.ts": [
    "--content-hint", "--from", "--help", "--no-clap-audio", "--no-qwen3vl", "--project",
    "--skip-analyze", "--skip-footage-db", "--skip-qa", "--skip-render", "--source-dir",
  ],
  "scripts/import-premiere-xml.ts": [
    "--apply", "--dry-run", "--help", "--json", "--receipt", "--xml",
  ],
  "scripts/package.ts": [
    "--assembly", "--assembly-engine", "--assembly-path", "--autonomy", "--autonomy-mode",
    "--created-at", "--final", "--help", "--json", "--no-assembly", "--preflight-only",
    "--project", "--repo-sfx-root", "--skip-render", "--source-of-truth",
    "--supplied-final", "--supplied-final-path", "--verify-existing",
  ],
  "scripts/plan-sound-design.ts": [
    "--cues-output", "--decision-output", "--dry-run", "--help", "--project", "--request",
    "--repo-sfx-root", "--timeline",
  ],
  "scripts/project-sfx-cues.ts": [
    "--cues", "--dry-run", "--help", "--output", "--project", "--repo-sfx-root", "--timeline",
  ],
  "scripts/promote-sfx-asset.ts": [
    "--asset-id", "--destination", "--dry-run", "--help", "--json", "--manifest",
    "--output-manifest", "--permitted-derivatives", "--project", "--provenance-origin", "--provenance-ref",
    "--repo-sfx-root", "--rights-status", "--scope", "--source", "--usage-scope", "--verified-at",
    "--repo-root", "--review-status", "--rights-evidence", "--validate-only",
  ],
  "scripts/audio-finish-preview.ts": [
    "--duration", "--help", "--input", "--json", "--output-dir", "--preset", "--project",
  ],
  "scripts/caption-review.ts": [
    "--audio-off", "--base-caption-draft-hash", "--base-text-hash", "--caption-id",
    "--caption-text-hash", "--canonical", "--category", "--end-frame", "--expected-patch-hash",
    "--expected-approval-hash", "--first-text", "--format", "--help", "--high-contrast", "--limit", "--next-base-text-hash",
    "--next-caption-id", "--note", "--output", "--patch", "--preapproval-receipt", "--project",
    "--reduced-motion", "--reviewer", "--safe-zone-profile", "--second-text", "--severity",
    "--small-screen", "--split-frame", "--start-frame", "--state", "--text", "--typography-policy",
    "--variant", "--visual-operation-json",
  ],
  "scripts/caption-edit-router.ts": [
    "--help", "--instruction", "--project", "--reviewer", "--subject-evidence", "--write-receipt",
  ],
  "scripts/project-output-writer.ts": [
    "--degraded-route-receipt", "--help", "--output", "--project", "--source",
  ],
  "scripts/publication-preflight.ts": ["--platform", "--visibility"],
  "scripts/render-audio-plan.ts": [
    "--dry-run", "--help", "--keep-work", "--music-cues", "--output", "--project", "--repo-sfx-root", "--route",
    "--sfx-cues", "--timeline",
  ],
  "scripts/render-route.ts": [
    "--assembly-engine", "--help", "--json", "--metadata", "--route-kind", "--write-receipt",
  ],
  "scripts/render-social-review.ts": [
    "--captions", "--help", "--music-cues", "--output", "--project", "--repo-sfx-root", "--sfx-cues",
    "--timeline", "--work-dir",
  ],
};

/** RFA-015's generic surface is intentionally explicit and small. */
export const RFA_015_GENERIC_SKILL_PATHS = [
  ".agents/skills/finish-creator-short",
  ".agents/skills/build-blueprint",
  ".agents/skills/render-video",
  ".agents/skills/evaluate-edit",
  ".agents/skills/short-sound-design",
  ".agents/skills/vertical-social-composition",
  ".agents/skills/vertical-social-platform-delivery",
] as const;

const RFA_015_ROUTE_ENTRYPOINTS: Readonly<Record<string, string>> = {
  blueprint: "runtime/commands/blueprint.ts",
  compile: "runtime/commands/compile.ts",
  triage: "runtime/commands/triage.ts",
};

interface CommandInvocation {
  line: number;
  text: string;
  packageScript?: string;
  entrypoint?: string;
  flags: string[];
}

interface ArtifactDeclaration {
  sectionLine: number;
  line: number;
  value: string;
  /**
   * "code" — checked-in code must write this path. A missing producer is the
   * export-premiere failure mode: the skill promises a file nobody creates.
   * "agent" — the skill has no producer by design and the agent writes the
   * path itself, so the section is an output-layout instruction, not a claim
   * about this repository. Opt in per section with AGENT_AUTHORED_MARKER.
   */
  authoredBy: "code" | "agent";
}

/**
 * Marks an output section whose paths are written by the agent following the
 * skill rather than by checked-in code. Required as an explicit comment so a
 * skill cannot silently escape producer verification.
 */
const AGENT_AUTHORED_MARKER = /^<!--\s*artifact-producer:\s*agent\s*-->\s*$/;

function walkFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function relativePath(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

function discoverDocuments(rootDir: string, skillRoot: string): string[] {
  const absoluteSkillRoot = path.resolve(rootDir, skillRoot);
  return walkFiles(absoluteSkillRoot)
    .filter((filePath) => {
      const relative = relativePath(absoluteSkillRoot, filePath);
      return path.basename(filePath) === "SKILL.md"
        || (relative.includes("/references/") && filePath.endsWith(".md"));
    })
    .sort((left, right) => left.localeCompare(right));
}

function quotedIds(block: string): Set<string> {
  return new Set(
    [...block.matchAll(/["'](vos:(?:content|overlay)\.[^"']+)["']/g)]
      .map((match) => match[1]),
  );
}

function declarationBlock(source: string, name: string): string {
  const declarationIndex = source.search(new RegExp(`(?:export\\s+)?const\\s+${name}\\b`));
  if (declarationIndex < 0) return "";
  const start = source.slice(declarationIndex).search(/[\[{]/);
  if (start < 0) return "";
  const absoluteStart = declarationIndex + start;
  const opening = source[absoluteStart];
  const closing = opening === "[" ? "]" : "}";
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = absoluteStart; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === opening) depth += 1;
    else if (character === closing) {
      depth -= 1;
      if (depth === 0) return source.slice(absoluteStart, index + 1);
    }
  }
  return "";
}

function loadResolvableTemplateIds(rootDir: string): Set<string> {
  const registryPath = path.join(rootDir, "runtime/content/template-registry.ts");
  const normalizePath = path.join(rootDir, "runtime/content/normalize.ts");
  const registry = fs.existsSync(registryPath) ? fs.readFileSync(registryPath, "utf8") : "";
  const normalize = fs.existsSync(normalizePath) ? fs.readFileSync(normalizePath, "utf8") : "";
  const ids = quotedIds(declarationBlock(registry, "CONTENT_TEMPLATE_IDS"));
  for (const declarationName of [
    "LEGACY_HYPERFRAMES_MAP",
    "LEGACY_REMOTION_ONLY",
    "LEGACY_STYLE_ALIASES",
  ]) {
    for (const id of quotedIds(declarationBlock(normalize, declarationName))) ids.add(id);
  }
  return ids;
}

function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function isRfa015GenericSkillDocument(rootDir: string, documentPath: string): boolean {
  const file = relativePath(rootDir, documentPath);
  return RFA_015_GENERIC_SKILL_PATHS.some((skillPath) =>
    file === `${skillPath}/SKILL.md` || file.startsWith(`${skillPath}/references/`));
}

function hasPlaceholder(reference: string): boolean {
  return /<[^>]+>|\*|\{[^}]+\}/.test(reference);
}

function cleanReference(reference: string): string {
  return reference
    .split("#", 1)[0]
    .split("?", 1)[0]
    .replace(/[.,);:]+$/, "");
}

const URI_SUBSTRING_PATTERN = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'\x60)\]}]+/g;

function removeUriSubstrings(value: string): string {
  return value.replace(URI_SUBSTRING_PATTERN, "");
}

function markdownLinkReferences(markdown: string): Array<{ line: number; reference: string }> {
  return [...markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)]
    .map((match) => ({
      line: lineNumberAt(markdown, match.index ?? 0),
      reference: cleanReference(match[1]),
    }));
}

function staticPathReferences(markdown: string): Array<{ line: number; reference: string }> {
  const references: Array<{ line: number; reference: string }> = [];
  const lines = markdown.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = removeUriSubstrings(lines[index]);
    for (const match of line.matchAll(
      /(?<![A-Za-z0-9._-])((?:\.agents\/skills|apps|delivery_profiles|docs|python|runtime|schemas|scripts)\/[A-Za-z0-9_./-]+)/g,
    )) {
      references.push({ line: index + 1, reference: cleanReference(match[1]) });
    }
  }
  return references;
}

function discoverSkillNames(rootDir: string, skillRoot: string): Set<string> {
  const absoluteSkillRoot = path.resolve(rootDir, skillRoot);
  return new Set(
    walkFiles(absoluteSkillRoot)
      .filter((filePath) => path.basename(filePath) === "SKILL.md")
      .map((filePath) => path.basename(path.dirname(filePath))),
  );
}

function genericSkillContamination(line: string): string | null {
  const content = removeUriSubstrings(line);
  const projectPath = content.match(/\bprojects\/([A-Za-z0-9][A-Za-z0-9_<>-]*)/i);
  if (projectPath && !projectPath[1].includes("<")) {
    return "project-path";
  }
  const patterns: RegExp[] = [
    /(?:^|[\s("'=:\x60])(?:~\/|\/(?!\/)[^\/\s"'<>(),;:\x60]+\/[^\s"'<>(),;:\x60]+|[A-Za-z]:[\\/][^\s"'<>(),;:\x60]+)/,
    /\b(?:fumoto-growth|togakushi-camp|ena-promo(?:-ai)?|ax1-[a-z0-9-]+|narunaru|rokutaro)\b/i,
    /#[0-9a-f]{3,8}\b/i,
    /(?:brand\s*colou?rs?|ブランドカラー)\s*[:：=]\s*\S+/i,
    /(?:slogan|tagline|決め台詞)\s*[:：=]\s*["「]/i,
    /\b(?:safe[- ]?zone|safe[- ]?area|ui region|inset|coordinate|viewport)\b[^\n]*(?:\d+(?:\.\d+)?\s*(?:%|px|dp)|\b[xy]\s*[:=]\s*\d)/i,
    /\b(?:cut(?:s|ting)?(?: rate| interval)?|zoom|hook(?: onset)?|identity|loudness|true peak|caption|sfx|silence)\b[^\n]*(?:\d+(?:\.\d+)?\s*(?:%|秒|s|frames?|frame|LUFS|dB(?:TP|FS)?|px)|\d+\s*[〜–-]\s*\d+)/i,
  ];
  return patterns.find((pattern) => pattern.test(content))?.source ?? null;
}

function ownershipContradiction(line: string): string | null {
  const patterns: RegExp[] = [
    /\b(?:remotion|hyperframes)\b[^.;\n]{0,80}(?:speech|dialogue|caption|字幕)/i,
    /(?:speech|dialogue|caption|字幕)[^.;\n]{0,80}(?:rendered|owned|handled|担当|描画)[^.;\n]{0,80}\b(?:remotion|hyperframes)\b/i,
    /(?:agent|machine|automated)[^\n]*(?:qa|check|receipt)[^\n]*(?:is|counts as|equals|constitutes)[^\n]*(?:human|final|publication)\s*approval/i,
    /(?:platform preview|platform\s+preview)[^\n]*(?:is|counts as|equals|constitutes)[^\n]*(?:final|render|human)\s*(?:approval|output|render)/i,
  ];
  const contradiction = patterns.find((pattern) => pattern.test(line));
  if (contradiction) return contradiction.source;
  // Accepted FFmpeg/libass/ASS ownership is not itself a contradiction. It is
  // checked only after the contradiction patterns so an explicit negation such
  // as "Remotion renders speech captions, not FFmpeg/libass" cannot be hidden.
  if (/(?:ffmpeg|libass|\bASS\b)/i.test(line)) return null;
  return null;
}

function contextualCodeSpanSkillReferences(
  markdown: string,
  skillNames: ReadonlySet<string>,
): Array<{ line: number; reference: string }> {
  const references: Array<{ line: number; reference: string }> = [];
  for (const match of markdown.matchAll(/`([a-z][a-z0-9-]*)`/g)) {
    const reference = match[1];
    if (skillNames.has(reference)) continue;
    const matchIndex = match.index ?? 0;
    const lineStart = markdown.lastIndexOf("\n", matchIndex - 1) + 1;
    const lineEnd = markdown.indexOf("\n", matchIndex);
    const line = markdown.slice(lineStart, lineEnd < 0 ? markdown.length : lineEnd);
    const inLineIndex = matchIndex - lineStart;
    const before = line.slice(0, inLineIndex).trimEnd();
    const after = line.slice(inLineIndex + match[0].length).trimStart();
    const skillContext = /(?:\breturn\s+to|\bgo\s+back\s+to|\bfall\s+back\s+to|\brefer\s+to|\b(?:skill|skills|スキル)\s*[:：]?)\s*$/i.test(before)
      || /^(?:skill|skills|スキル)\b/i.test(after);
    if (skillContext) references.push({ line: lineNumberAt(markdown, matchIndex), reference });
  }
  return references;
}

function rfa015SurfaceIssues(
  rootDir: string,
  documentPath: string,
  markdown: string,
  skillNames: ReadonlySet<string>,
): Array<Omit<SkillContractIssue, "severity">> {
  if (!isRfa015GenericSkillDocument(rootDir, documentPath)) return [];
  const file = relativePath(rootDir, documentPath);
  const issues: Array<Omit<SkillContractIssue, "severity">> = [];
  const add = (
    code: SkillContractIssueCode,
    line: number,
    reference: string,
    message: string,
  ): void => {
    issues.push({ code, file, line, reference, message });
  };

  for (const link of markdownLinkReferences(markdown)) {
    const reference = link.reference;
    if (!reference || reference.startsWith("#") || /^(?:https?|mailto|file):/i.test(reference)) continue;
    if (hasPlaceholder(reference)) continue;
    const resolved = path.resolve(path.dirname(documentPath), reference);
    if (isInsideRoot(rootDir, resolved) && fs.existsSync(resolved)) continue;
    add(
      "unresolved_local_reference",
      link.line,
      reference,
      `Local Markdown reference does not resolve to a repository file: ${reference}`,
    );
  }

  for (const reference of staticPathReferences(markdown)) {
    if (hasPlaceholder(reference.reference)) continue;
    const resolved = path.resolve(rootDir, reference.reference);
    if (isInsideRoot(rootDir, resolved) && fs.existsSync(resolved)) continue;
    add(
      "unresolved_local_reference",
      reference.line,
      reference.reference,
      `Referenced repository path does not exist: ${reference.reference}`,
    );
  }

  for (const match of markdown.matchAll(/`(\$[a-z][a-z0-9-]*)`/gi)) {
    const reference = match[1].slice(1);
    if (skillNames.has(reference)) continue;
    add(
      "unresolved_skill_reference",
      lineNumberAt(markdown, match.index ?? 0),
      reference,
      `Referenced skill does not have a SKILL.md entry: ${reference}`,
    );
  }
  for (const reference of contextualCodeSpanSkillReferences(markdown, skillNames)) {
    add(
      "unresolved_skill_reference",
      reference.line,
      reference.reference,
      `Referenced skill does not have a SKILL.md entry: ${reference.reference}`,
    );
  }
  for (const match of markdown.matchAll(/\b([a-z][a-z0-9-]*)\s+(?:skill|スキル)\b/gi)) {
    const reference = match[1];
    if (["a", "an", "current", "generic", "the", "this"].includes(reference.toLowerCase())) continue;
    if (skillNames.has(reference)) continue;
    add(
      "unresolved_skill_reference",
      lineNumberAt(markdown, match.index ?? 0),
      reference,
      `Referenced skill does not have a SKILL.md entry: ${reference}`,
    );
  }

  for (const match of markdown.matchAll(/\/(triage|blueprint|compile)\b/g)) {
    const route = match[1];
    const entrypoint = RFA_015_ROUTE_ENTRYPOINTS[route];
    if (entrypoint && fs.existsSync(path.join(rootDir, entrypoint))) continue;
    add(
      "unresolved_local_reference",
      lineNumberAt(markdown, match.index ?? 0),
      entrypoint ?? route,
      `Referenced workflow route has no runtime command entrypoint: /${route}`,
    );
  }

  const lines = markdown.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const contamination = genericSkillContamination(lines[index]);
    if (contamination) {
      add(
        "generic_skill_contamination",
        index + 1,
        lines[index].trim(),
        "Generic skill contains a project-specific value, external path, fixed brand/style value, or universal numeric/platform target",
      );
    }
    const contradiction = ownershipContradiction(lines[index]);
    if (contradiction) {
      add(
        "ownership_contradiction",
        index + 1,
        lines[index].trim(),
        "Generic skill contradicts an accepted renderer, caption, audio, or approval ownership boundary",
      );
    }
  }
  return issues;
}

function flagsFromCommand(command: string): string[] {
  return [...new Set([...command.matchAll(/(?<![A-Za-z0-9_-])(--[A-Za-z][A-Za-z0-9-]*)\b/g)]
    .map((match) => match[1]))].sort();
}

function parserAcceptedFlags(source: string): Set<string> {
  const flags = new Set<string>();
  for (const pattern of [
    /(?:===|==)\s*["'`](--[A-Za-z][A-Za-z0-9-]*)["'`]/g,
    /["'`](--[A-Za-z][A-Za-z0-9-]*)["'`]\s*(?:===|==)/g,
    /\bcase\s+["'`](--[A-Za-z][A-Za-z0-9-]*)["'`]\s*:/g,
  ]) {
    for (const match of source.matchAll(pattern)) flags.add(match[1]);
  }
  return flags;
}

function commandInvocation(text: string, line: number): CommandInvocation | null {
  const npmMatch = text.match(/\bnpm\s+run\s+([A-Za-z0-9:_-]+)/);
  const scriptMatch = text.match(
    /(?:\bnpx\s+tsx\s+|\btsx\s+|\bnode_modules\/\.bin\/tsx\s+|\bpython3?\s+)?((?:scripts|runtime|python|\.agents\/skills)\/[A-Za-z0-9_./-]+\.(?:ts|py))\b/,
  );
  if (!npmMatch && !scriptMatch) return null;
  return {
    line,
    text: text.trim(),
    packageScript: npmMatch?.[1],
    entrypoint: scriptMatch?.[1],
    flags: flagsFromCommand(text),
  };
}

function extractCommandInvocations(markdown: string): CommandInvocation[] {
  const invocations: CommandInvocation[] = [];
  const lines = markdown.split("\n");
  let inFence = false;
  let pending = "";
  let pendingLine = 0;
  const flush = (): void => {
    if (!pending) return;
    const invocation = commandInvocation(pending, pendingLine);
    if (invocation) invocations.push(invocation);
    pending = "";
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      if (inFence) flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      const trimmed = line.trim();
      if (pending) {
        pending += ` ${trimmed.replace(/\\$/, "").trim()}`;
        if (!trimmed.endsWith("\\")) flush();
      } else if (commandInvocation(trimmed, index + 1)) {
        pending = trimmed.replace(/\\$/, "").trim();
        pendingLine = index + 1;
        if (!trimmed.endsWith("\\")) flush();
      }
    }
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      const invocation = commandInvocation(match[1], index + 1);
      if (invocation) invocations.push(invocation);
    }
  }
  flush();
  const unique = new Map<string, CommandInvocation>();
  for (const invocation of invocations) {
    unique.set(`${invocation.line}:${invocation.text}`, invocation);
  }
  return [...unique.values()];
}

/** Output-section start lines whose body carries the agent-authored marker. */
function agentAuthoredSectionLines(lines: readonly string[]): Set<number> {
  const marked = new Set<number>();
  let sectionLine = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      sectionLine = index + 1;
      continue;
    }
    if (sectionLine > 0 && AGENT_AUTHORED_MARKER.test(lines[index])) marked.add(sectionLine);
  }
  return marked;
}

function extractArtifactDeclarations(markdown: string): ArtifactDeclaration[] {
  const declarations: ArtifactDeclaration[] = [];
  const lines = markdown.split("\n");
  const agentAuthored = agentAuthoredSectionLines(lines);
  let inOutputSection = false;
  let inFence = false;
  let sectionLine = 0;
  let treeStack: string[] = [];
  const authorship = (): "code" | "agent" => agentAuthored.has(sectionLine) ? "agent" : "code";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^##\s+/.test(line)) {
      inOutputSection = /^##\s+(?:出力 artifact|推奨出力(?:構成)?|outputs?|output artifacts?)\s*$/i
        .test(line);
      inFence = false;
      sectionLine = inOutputSection ? index + 1 : 0;
      treeStack = [];
      continue;
    }
    if (!inOutputSection) continue;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      treeStack = [];
      continue;
    }
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      const value = match[1].trim();
      if (value.startsWith("--")) continue;
      if (!/[/.]|\*/.test(value)) continue;
      declarations.push({ sectionLine, line: index + 1, value, authoredBy: authorship() });
    }
    if (inFence) {
      const treeMatch = line.match(/^((?:[│ ]{4})*)[├└]──\s+([^\s#]+)/);
      const treeValue = treeMatch?.[2]?.trim();
      if (
        treeMatch && treeValue
        && /[A-Za-z0-9_]/.test(treeValue.replaceAll(/<[^>]+>/g, ""))
      ) {
        const depth = treeMatch[1].length / 4;
        treeStack.length = depth;
        treeStack[depth] = treeValue;
        declarations.push({
          sectionLine,
          line: index + 1,
          value: treeStack.join(""),
          authoredBy: authorship(),
        });
      }
    }
  }
  const unique = new Map<string, ArtifactDeclaration>();
  for (const declaration of declarations) {
    unique.set(`${declaration.sectionLine}:${declaration.line}:${declaration.value}`, declaration);
  }
  return [...unique.values()];
}

function artifactFragments(value: string): string[] {
  return value
    .split(/<[^>]+>|\*/g)
    .flatMap((literal) => literal.split("/"))
    .map((fragment) => fragment.trim())
    .flatMap((fragment) => {
      const compoundExtension = fragment.match(/^(.+\.[A-Za-z0-9]+)(\.[A-Za-z0-9]+)$/);
      return compoundExtension ? [compoundExtension[1], compoundExtension[2]] : [fragment];
    })
    .map((fragment) => fragment.replace(/[-_]+$/, ""))
    .filter((fragment) => /[A-Za-z0-9_]/.test(fragment));
}

function artifactHasProducer(
  declaration: ArtifactDeclaration,
  producerSources: readonly string[],
): boolean {
  const fragments = artifactFragments(declaration.value);
  if (fragments.length === 0) return false;
  return producerSources.some((source) => fragments.every((fragment) => source.includes(fragment)));
}

function packageEntrypoint(packageCommand: string | undefined): string | undefined {
  return packageCommand?.match(/\b(scripts\/[A-Za-z0-9_./-]+\.ts)\b/)?.[1];
}

const PRODUCER_EXTENSIONS = [".ts", ".py", ".swift"] as const;

function isProducerSource(filePath: string, rootDir: string): boolean {
  const relative = relativePath(rootDir, filePath);
  return PRODUCER_EXTENSIONS.some((extension) => filePath.endsWith(extension))
    && !filePath.endsWith(".test.ts")
    && !relative.includes("/tests/")
    && !relative.includes("/skill-contracts/")
    && !/(?:^|[-_.])contracts?\.ts$/.test(path.basename(filePath));
}

function resolveLocalImport(rootDir: string, importerPath: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(importerPath), specifier);
  const candidates = [
    base,
    ...PRODUCER_EXTENSIONS.map((extension) => `${base.replace(/\.js$/, "")}${extension}`),
    ...PRODUCER_EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
  ];
  for (const candidate of candidates) {
    if (!isInsideRoot(rootDir, candidate) || !fs.existsSync(candidate)) continue;
    if (fs.statSync(candidate).isFile() && isProducerSource(candidate, rootDir)) return candidate;
  }
  return null;
}

function producerBundle(
  rootDir: string,
  entrypoint: string,
  producerRoots: readonly string[],
  cache: Map<string, string>,
): string {
  const absolute = path.resolve(rootDir, entrypoint);
  if (!isWithinProducerRoots(rootDir, absolute, producerRoots)) return "";
  const cached = cache.get(absolute);
  if (cached !== undefined) return cached;
  const files = new Set<string>();
  const visit = (filePath: string): void => {
    if (
      files.has(filePath)
      || !isInsideRoot(rootDir, filePath)
      || !fs.existsSync(filePath)
      || !fs.statSync(filePath).isFile()
      || !isProducerSource(filePath, rootDir)
    ) return;
    files.add(filePath);
    const source = fs.readFileSync(filePath, "utf8");
    for (const pattern of [
      /\bfrom\s+["'`]([^"'`]+)["'`]/g,
      /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
      /\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    ]) {
      for (const match of source.matchAll(pattern)) {
        const resolved = resolveLocalImport(rootDir, filePath, match[1]);
        if (resolved) visit(resolved);
      }
    }
  };
  visit(absolute);
  const bundled = [...files].sort()
    .map((filePath) => fs.readFileSync(filePath, "utf8"))
    .join("\n");
  cache.set(absolute, bundled);
  return bundled;
}

function producerRootBundle(
  rootDir: string,
  producerRoot: string,
  allowedProducerRoots: readonly string[],
): string {
  const absoluteRoot = path.resolve(rootDir, producerRoot);
  if (!isWithinProducerRoots(rootDir, absoluteRoot, allowedProducerRoots)) return "";
  return walkFiles(absoluteRoot)
    .filter((filePath) => isProducerSource(filePath, rootDir))
    .sort()
    .map((filePath) => fs.readFileSync(filePath, "utf8"))
    .join("\n");
}

function isInsideRoot(rootDir: string, candidatePath: string): boolean {
  const relative = path.relative(rootDir, candidatePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isWithinProducerRoots(
  rootDir: string,
  candidatePath: string,
  producerRoots: readonly string[],
): boolean {
  return producerRoots.some((producerRoot) =>
    isInsideRoot(path.resolve(rootDir, producerRoot), candidatePath));
}

function addIssue(
  issues: SkillContractIssue[],
  severities: Readonly<Record<SkillContractIssueCode, SkillContractSeverity>>,
  issue: Omit<SkillContractIssue, "severity">,
): void {
  issues.push({ ...issue, severity: severities[issue.code] });
}

export function auditSkillContracts(options: SkillContractAuditOptions): SkillContractAuditResult {
  const rootDir = path.resolve(options.rootDir);
  const skillRoot = options.skillRoot ?? ".agents/skills";
  const severities = options.severities ?? SKILL_CONTRACT_SEVERITIES;
  const flagContracts = options.flagContracts ?? CLI_FLAG_CONTRACTS;
  const producerRoots = options.producerRoots
    ?? ["scripts", "runtime", "python", "apps", ".agents/skills"];
  const documents = discoverDocuments(rootDir, skillRoot);
  const packageJsonPath = path.join(rootDir, "package.json");
  const packageJson = fs.existsSync(packageJsonPath)
    ? JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { scripts?: Record<string, string> }
    : {};
  const packageScripts = packageJson.scripts ?? {};
  const resolvableTemplateIds = loadResolvableTemplateIds(rootDir);
  const skillNames = discoverSkillNames(rootDir, skillRoot);
  const issues: SkillContractIssue[] = [];
  const producerBundleCache = new Map<string, string>();
  let artifactDeclarations = 0;
  let verifiedArtifacts = 0;

  for (const [entrypoint, flags] of Object.entries(flagContracts).sort(([left], [right]) => left.localeCompare(right))) {
    const parserPath = path.resolve(rootDir, entrypoint);
    if (!fs.existsSync(parserPath)) {
      addIssue(issues, severities, {
        code: "flag_contract_parser_mismatch",
        file: entrypoint,
        line: 1,
        reference: entrypoint,
        message: `Explicit flag contract points to a missing parser source: ${entrypoint}`,
      });
      continue;
    }
    const parserSource = fs.readFileSync(parserPath, "utf8");
    const acceptedByParser = parserAcceptedFlags(parserSource);
    for (const flag of flags) {
      if (acceptedByParser.has(flag)) continue;
      addIssue(issues, severities, {
        code: "flag_contract_parser_mismatch",
        file: entrypoint,
        line: 1,
        reference: flag,
        message: `Declared flag is not present in the target parser source: ${flag}`,
      });
    }
  }

  for (const documentPath of documents) {
    const file = relativePath(rootDir, documentPath);
    const markdown = fs.readFileSync(documentPath, "utf8");
    for (const issue of rfa015SurfaceIssues(rootDir, documentPath, markdown, skillNames)) {
      addIssue(issues, severities, issue);
    }
    const invocations = extractCommandInvocations(markdown);
    for (const match of markdown.matchAll(/\bnpm\s+run\s+([A-Za-z0-9:_-]+)/g)) {
      const scriptName = match[1];
      if (packageScripts[scriptName] !== undefined) continue;
      addIssue(issues, severities, {
        code: "missing_npm_script",
        file,
        line: lineNumberAt(markdown, match.index ?? 0),
        reference: scriptName,
        message: `package.json does not define npm script ${scriptName}`,
      });
    }
    for (const match of markdown.matchAll(/\b(scripts\/[A-Za-z0-9_./-]+\.ts)\b/g)) {
      const reference = match[1];
      const resolved = path.resolve(rootDir, reference);
      if (isInsideRoot(rootDir, resolved) && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) continue;
      addIssue(issues, severities, {
        code: "missing_script_file",
        file,
        line: lineNumberAt(markdown, match.index ?? 0),
        reference,
        message: `Referenced TypeScript entrypoint does not exist: ${reference}`,
      });
    }
    for (const match of markdown.matchAll(/\b(vos:(?:content|overlay)\.[A-Za-z0-9_-]+(?:\/v[0-9]+)?)\b/g)) {
      const reference = match[1];
      if (resolvableTemplateIds.has(reference)) continue;
      addIssue(issues, severities, {
        code: "unresolved_template_id",
        file,
        line: lineNumberAt(markdown, match.index ?? 0),
        reference,
        message: `Template id is absent from CONTENT_TEMPLATE_IDS and the normalize aliases: ${reference}`,
      });
    }

    for (const invocation of invocations) {
      if (invocation.flags.length === 0) continue;
      const entrypoint = invocation.entrypoint
        ?? packageEntrypoint(invocation.packageScript ? packageScripts[invocation.packageScript] : undefined);
      if (!entrypoint) {
        if (
          invocation.packageScript
          && packageScripts[invocation.packageScript] === undefined
        ) continue;
        addIssue(issues, severities, {
          code: "flag_contract_missing",
          file,
          line: invocation.line,
          reference: invocation.text,
          message: invocation.packageScript
            ? `Cannot resolve npm script ${invocation.packageScript} to a TypeScript parser contract`
            : "Cannot resolve this command to a TypeScript parser contract",
        });
        continue;
      }
      if (!entrypoint.endsWith(".ts")) continue;
      const acceptedFlags = flagContracts[entrypoint];
      if (!acceptedFlags) {
        addIssue(issues, severities, {
          code: "flag_contract_missing",
          file,
          line: invocation.line,
          reference: invocation.text,
          message: `No explicit parser flag contract exists for ${entrypoint}`,
        });
        continue;
      }
      for (const flag of invocation.flags) {
        if (acceptedFlags.includes(flag)) continue;
        addIssue(issues, severities, {
          code: "unknown_command_flag",
          file,
          line: invocation.line,
          reference: `${entrypoint} ${flag}`,
          message: `Command documents a flag not accepted by the explicit parser contract: ${flag}`,
        });
      }
    }

    const documentProducerSources = [
      ...invocations.map((invocation) => {
        const entrypoint = invocation.entrypoint
          ?? packageEntrypoint(invocation.packageScript ? packageScripts[invocation.packageScript] : undefined);
        return entrypoint
          ? `${invocation.text}\n${producerBundle(rootDir, entrypoint, producerRoots, producerBundleCache)}`
          : "";
      }).filter(Boolean),
      ...[...markdown.matchAll(/\bswift\s+run\s+--package-path\s+([A-Za-z0-9_./-]+)/g)]
        .map((match) => `${match[0]}\n${producerRootBundle(rootDir, match[1], producerRoots)}`),
    ];
    const declarations = extractArtifactDeclarations(markdown)
      .filter((declaration) => declaration.authoredBy === "code");
    artifactDeclarations += declarations.length;
    const verifiedBySection = new Map<number, number>();
    for (const declaration of declarations) {
      if (!verifiedBySection.has(declaration.sectionLine)) {
        verifiedBySection.set(declaration.sectionLine, 0);
      }
      if (artifactHasProducer(declaration, documentProducerSources)) {
        verifiedArtifacts += 1;
        verifiedBySection.set(
          declaration.sectionLine,
          (verifiedBySection.get(declaration.sectionLine) ?? 0) + 1,
        );
        continue;
      }
      addIssue(issues, severities, {
        code: "artifact_unverified",
        file,
        line: declaration.line,
        reference: declaration.value,
        message: "No producer source contains every stable literal fragment of this artifact declaration",
      });
    }
    for (const [outputSectionLine, verifiedCount] of verifiedBySection) {
      if (verifiedCount > 0) continue;
      const sectionDeclarations = declarations.filter(
        (declaration) => declaration.sectionLine === outputSectionLine,
      );
      addIssue(issues, severities, {
        code: "artifact_zero_verified",
        file,
        line: outputSectionLine,
        reference: `${sectionDeclarations.length} declaration(s)`,
        message: "This output section has zero producer-code matches",
      });
    }
  }

  for (const duplicate of findProjectLocalLoudnormDuplicates(rootDir)) {
    addIssue(issues, severities, {
      code: "project_local_mastering_duplicate",
      file: duplicate.file,
      line: duplicate.line,
      reference: duplicate.evidence.join(","),
      message: "Project-local two-pass loudnorm is forbidden; use the shared audio mastering runtime",
    });
  }

  issues.sort((left, right) =>
    left.file.localeCompare(right.file)
    || left.line - right.line
    || left.code.localeCompare(right.code)
    || left.reference.localeCompare(right.reference));
  return {
    documents: documents.map((documentPath) => relativePath(rootDir, documentPath)),
    issues,
    artifactDeclarations,
    verifiedArtifacts,
  };
}

export function skillContractExitCode(
  issues: readonly SkillContractIssue[],
  check: boolean,
): number {
  return check && issues.some((issue) => issue.severity === "error") ? 1 : 0;
}
