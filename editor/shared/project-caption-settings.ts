import * as fs from "node:fs";
import * as path from "node:path";
import {
  resolveCaptionStylePreset,
  type CaptionStylePreset,
} from "./caption-style-tokens.js";

export function resolveCaptionApprovalPath(projectDir: string): string | undefined {
  const canonicalPath = path.join(projectDir, "07_package", "caption_approval.json");
  if (fs.existsSync(canonicalPath)) return canonicalPath;

  const legacyPath = path.join(projectDir, "caption_approval.json");
  return fs.existsSync(legacyPath) ? legacyPath : undefined;
}

export function readProjectCaptionStylingClass(projectDir: string): string | undefined {
  const blueprintPath = path.join(projectDir, "04_plan", "edit_blueprint.yaml");
  if (!fs.existsSync(blueprintPath)) return undefined;
  try {
    const stylingClass = readNestedScalar(
      fs.readFileSync(blueprintPath, "utf-8"),
      "caption_policy",
      "styling_class",
    );
    return stylingClass || undefined;
  } catch {
    return undefined;
  }
}

export function resolveProjectCaptionStylePreset(projectDir: string): CaptionStylePreset {
  return resolveCaptionStylePreset(readProjectCaptionStylingClass(projectDir));
}

/**
 * Read one scalar from a schema-owned YAML mapping without loading the editor
 * server or adding a second YAML runtime to the root test package.
 */
function readNestedScalar(source: string, parentKey: string, childKey: string): string | undefined {
  const lines = source.split(/\r?\n/);
  let parentIndent: number | null = null;
  for (const line of lines) {
    const content = line.trim();
    if (!content || content.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (parentIndent === null) {
      if (content === `${parentKey}:`) parentIndent = indent;
      continue;
    }
    if (indent <= parentIndent) break;
    const match = content.match(new RegExp(`^${escapeRegExp(childKey)}:\\s*(.+?)\\s*$`));
    if (!match) continue;
    return unquoteYamlScalar(stripInlineComment(match[1]).trim());
  }
  return undefined;
}

function stripInlineComment(value: string): string {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if ((character === "'" || character === '"') && (index === 0 || value[index - 1] !== "\\")) {
      quote = quote === character ? null : quote ?? character;
    }
    if (character === "#" && quote === null && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index);
    }
  }
  return value;
}

function unquoteYamlScalar(value: string): string | undefined {
  if (!value) return undefined;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
