import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

const MAX_TRACKED_FILE_BYTES = 2 * 1024 * 1024;
const PINNED_BUNDLED_FONT_PATHS = new Set([
  "apps/macos-studio/Sources/VideoOSStudio/Resources/Fonts/NotoSansJP-Variable.ttf",
  "apps/macos-studio/Sources/VideoOSStudio/Resources/Fonts/VideoOSNotoSansJPBlack.ttf",
  "apps/macos-studio/Sources/VideoOSStudio/Resources/Fonts/VideoOSNotoSansJPBold.ttf",
]);

type Violation = {
  path: string;
  reason: string;
};

const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
  encoding: "buffer",
})
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

const violations: Violation[] = [];

function add(path: string, reason: string): void {
  violations.push({ path, reason });
}

function isGeneratedOutput(path: string): boolean {
  return path === "outputs" || path.startsWith("outputs/");
}

function isGeneratedReport(path: string): boolean {
  return path === "reports/generated" || path.startsWith("reports/generated/");
}

function isEnvFile(path: string): boolean {
  if (path === ".env" || path === ".env.local") return true;
  if (path === ".env.example") return false;
  return /^\.env\./.test(path);
}

function isGeneratedArtifact(path: string): boolean {
  return (
    path.endsWith(".inspect.ndjson") ||
    path.endsWith(".render.json") ||
    path.endsWith(".qa.json")
  );
}

function isProjectGeneratedOutput(path: string): boolean {
  return /^projects\/[^/]+\/09_output\//.test(path);
}

function isPrivateProviderState(path: string): boolean {
  return /(^|\/)\.video-os\/private-cache(?:\/|$)/.test(path);
}

function isLargeFileAllowed(path: string): boolean {
  return (
    path.startsWith("docs/ux/screenshots/") ||
    path.startsWith("docs/ux/approved/") ||
    /^reports\/native-editor-visual-qa.*\.png$/.test(path) ||
    PINNED_BUNDLED_FONT_PATHS.has(path)
  );
}

for (const filePath of trackedFiles) {
  if (isGeneratedOutput(filePath)) {
    add(filePath, "tracked generated outputs are not allowed");
  }
  if (isGeneratedReport(filePath)) {
    add(filePath, "tracked generated reports are not allowed");
  }
  if (isEnvFile(filePath)) {
    add(filePath, "tracked env files are not allowed");
  }
  if (isGeneratedArtifact(filePath)) {
    add(filePath, "tracked generated inspection/render/QA artifacts are not allowed");
  }
  if (isProjectGeneratedOutput(filePath)) {
    add(filePath, "tracked project render outputs are not allowed");
  }
  if (isPrivateProviderState(filePath)) {
    add(filePath, "tracked private provider state is not allowed");
  }

  const stat = fs.statSync(filePath);
  if (stat.isFile() && stat.size > MAX_TRACKED_FILE_BYTES && !isLargeFileAllowed(filePath)) {
    add(
      filePath,
      `tracked file is ${stat.size} bytes; limit is ${MAX_TRACKED_FILE_BYTES}`,
    );
  }
}

if (violations.length > 0) {
  console.error(`Repo hygiene failed with ${violations.length} violation(s):`);
  for (const violation of violations) {
    console.error(`- ${violation.path}: ${violation.reason}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Repo hygiene passed for ${trackedFiles.length} tracked file(s).`);
}
