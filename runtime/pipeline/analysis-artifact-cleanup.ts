import * as fs from "node:fs";
import * as path from "node:path";

export interface CleanupAnalysisSourceArtifactsOptions {
  projectDir: string;
  currentStillAssetIds: ReadonlySet<string>;
  currentImageSequenceGroupIds: ReadonlySet<string>;
}

/**
 * Removes stale source-derived directories after the current successful source
 * set is known. Plain files and symlinks are deliberately left untouched.
 */
export function cleanupAnalysisSourceArtifacts(
  options: CleanupAnalysisSourceArtifactsOptions,
): void {
  cleanupDirectorySet(
    path.join(options.projectDir, "03_analysis", "still_frames"),
    options.currentStillAssetIds,
  );
  cleanupDirectorySet(
    path.join(options.projectDir, "03_analysis", "image_sequences"),
    options.currentImageSequenceGroupIds,
  );
}

function cleanupDirectorySet(root: string, currentNames: ReadonlySet<string>): void {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || currentNames.has(entry.name)) continue;
    fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
  }
}
