/**
 * TimelineWatchHub — fs.watch + hash registry for artifact change detection.
 *
 * Watches project directories for changes to timeline, review, project_state,
 * and render artifacts. Uses content hashing as the source of truth for change
 * detection, with fs.watch as a trigger and periodic rescan as a repair path.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type ProjectSyncSource = "external" | "api-save" | "patch-apply" | "ai-job";

export interface ProjectSyncEvent {
  type: "timeline.changed" | "review.changed" | "project-state.changed" | "render.changed";
  project_id: string;
  revision?: string;
  review_report_revision?: string;
  review_patch_revision?: string;
  source: ProjectSyncSource;
  changed_at: string;
}

type BroadcastFn = (event: ProjectSyncEvent) => void;

interface ArtifactEntry {
  /** Relative path from project dir */
  relPath: string;
  /** Event type to emit when changed */
  eventType: ProjectSyncEvent["type"];
  /** Last known content hash (null if file doesn't exist) */
  lastHash: string | null;
}

interface ProjectWatch {
  projectId: string;
  projectDir: string;
  artifacts: ArtifactEntry[];
  watchers: fs.FSWatcher[];
  sweepTimer: ReturnType<typeof setInterval> | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

const PERIODIC_RESCAN_MS = 30_000;
const DEBOUNCE_MS = 80;

function hashFileContent(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

export class TimelineWatchHub {
  private projects = new Map<string, ProjectWatch>();
  private broadcast: BroadcastFn;

  constructor(broadcast: BroadcastFn) {
    this.broadcast = broadcast;
  }

  /**
   * Start watching a project's artifacts.
   * Idempotent — if already watching, performs a full hash sweep instead.
   */
  watchProject(projectId: string, projectDir: string): void {
    if (this.projects.has(projectId)) {
      // Already watching — just do a full sweep
      this.fullHashSweep(projectId);
      return;
    }

    const artifacts = this.buildArtifactList(projectDir);
    const pw: ProjectWatch = {
      projectId,
      projectDir,
      artifacts,
      watchers: [],
      sweepTimer: null,
      debounceTimer: null,
    };

    // Initialize hash registry
    for (const artifact of artifacts) {
      const fullPath = path.join(projectDir, artifact.relPath);
      artifact.lastHash = hashFileContent(fullPath);
    }

    // Watch directories (not individual files — survives atomic rename)
    const watchDirs = new Set<string>();
    for (const artifact of artifacts) {
      const dir = path.join(projectDir, path.dirname(artifact.relPath));
      if (fs.existsSync(dir)) {
        watchDirs.add(dir);
      }
    }
    // Also watch project root for project_state.yaml
    if (fs.existsSync(projectDir)) {
      watchDirs.add(projectDir);
    }

    for (const dir of watchDirs) {
      this.attachWatcher(pw, dir);
    }

    // Periodic rescan (repair path for missed events)
    pw.sweepTimer = setInterval(() => {
      this.fullHashSweep(projectId);
    }, PERIODIC_RESCAN_MS);

    this.projects.set(projectId, pw);
  }

  /**
   * Stop watching a project. Cleans up all watchers and timers.
   */
  unwatchProject(projectId: string): void {
    const pw = this.projects.get(projectId);
    if (!pw) return;

    for (const watcher of pw.watchers) {
      try { watcher.close(); } catch { /* ignore */ }
    }
    if (pw.sweepTimer) clearInterval(pw.sweepTimer);
    if (pw.debounceTimer) clearTimeout(pw.debounceTimer);
    this.projects.delete(projectId);
  }

  /**
   * Notify the hub that a server-side write occurred.
   * Updates the hash registry and broadcasts immediately.
   */
  notifyWrite(
    projectId: string,
    eventType: ProjectSyncEvent["type"],
    source: ProjectSyncSource,
  ): void {
    const pw = this.projects.get(projectId);
    if (!pw) return;

    // Update hash registry for affected artifacts
    const affectedArtifacts = pw.artifacts.filter((a) => a.eventType === eventType);
    let revision: string | undefined;

    for (const artifact of affectedArtifacts) {
      const fullPath = path.join(pw.projectDir, artifact.relPath);
      artifact.lastHash = hashFileContent(fullPath);
      if (artifact.relPath.includes("timeline.json") && artifact.lastHash) {
        revision = `sha256:${artifact.lastHash}`;
      }
    }

    const event: ProjectSyncEvent = {
      type: eventType,
      project_id: projectId,
      source,
      changed_at: new Date().toISOString(),
    };

    if (revision) {
      event.revision = revision;
    }

    // For review changes, add specific revisions
    if (eventType === "review.changed") {
      for (const artifact of affectedArtifacts) {
        if (artifact.relPath.includes("review_report") && artifact.lastHash) {
          event.review_report_revision = `sha256:${artifact.lastHash}`;
        }
        if (artifact.relPath.includes("review_patch") && artifact.lastHash) {
          event.review_patch_revision = `sha256:${artifact.lastHash}`;
        }
      }
    }

    this.broadcast(event);
  }

  /**
   * Full hash sweep — re-hash all tracked artifacts and broadcast changes.
   * Called on periodic rescan, post-reconnect, and on-demand.
   */
  fullHashSweep(projectId: string): void {
    const pw = this.projects.get(projectId);
    if (!pw) return;

    // Group changes by event type to avoid duplicate broadcasts
    const changedTypes = new Set<ProjectSyncEvent["type"]>();

    for (const artifact of pw.artifacts) {
      const fullPath = path.join(pw.projectDir, artifact.relPath);
      const currentHash = hashFileContent(fullPath);

      if (currentHash !== artifact.lastHash) {
        artifact.lastHash = currentHash;
        changedTypes.add(artifact.eventType);
      }
    }

    for (const eventType of changedTypes) {
      const event: ProjectSyncEvent = {
        type: eventType,
        project_id: projectId,
        source: "external",
        changed_at: new Date().toISOString(),
      };

      // Add revision for timeline changes
      if (eventType === "timeline.changed") {
        const tlArtifact = pw.artifacts.find((a) =>
          a.relPath.includes("timeline.json"),
        );
        if (tlArtifact?.lastHash) {
          event.revision = `sha256:${tlArtifact.lastHash}`;
        }
      }

      if (eventType === "review.changed") {
        for (const artifact of pw.artifacts) {
          if (artifact.relPath.includes("review_report") && artifact.lastHash) {
            event.review_report_revision = `sha256:${artifact.lastHash}`;
          }
          if (artifact.relPath.includes("review_patch") && artifact.lastHash) {
            event.review_patch_revision = `sha256:${artifact.lastHash}`;
          }
        }
      }

      this.broadcast(event);
    }
  }

  /**
   * Shut down all watchers and timers.
   */
  destroy(): void {
    for (const projectId of this.projects.keys()) {
      this.unwatchProject(projectId);
    }
  }

  // ── Private ───────────────────────────────────────────────────────

  private buildArtifactList(projectDir: string): ArtifactEntry[] {
    return [
      {
        relPath: path.join("05_timeline", "timeline.json"),
        eventType: "timeline.changed",
        lastHash: null,
      },
      {
        relPath: path.join("06_review", "review_report.yaml"),
        eventType: "review.changed",
        lastHash: null,
      },
      {
        relPath: path.join("06_review", "review_patch.json"),
        eventType: "review.changed",
        lastHash: null,
      },
      {
        relPath: "project_state.yaml",
        eventType: "project-state.changed",
        lastHash: null,
      },
      {
        relPath: path.join("07_package", "qa-report.json"),
        eventType: "render.changed",
        lastHash: null,
      },
      {
        relPath: path.join("07_package", "package_manifest.json"),
        eventType: "render.changed",
        lastHash: null,
      },
    ];
  }

  private attachWatcher(pw: ProjectWatch, dir: string): void {
    try {
      const watcher = fs.watch(dir, { persistent: false }, () => {
        this.enqueueSweep(pw.projectId);
      });
      watcher.on("error", () => {
        // Watcher died — remove it, re-attach, and run a full sweep
        console.warn(`[watch-hub] Watcher error for ${dir}, re-attaching`);
        const idx = pw.watchers.indexOf(watcher);
        if (idx >= 0) pw.watchers.splice(idx, 1);
        try { watcher.close(); } catch { /* ignore */ }
        // Re-attach after a short delay to avoid tight loops
        setTimeout(() => {
          if (this.projects.has(pw.projectId) && fs.existsSync(dir)) {
            this.attachWatcher(pw, dir);
          }
        }, 1000);
        // Full sweep to catch anything missed during the gap
        this.fullHashSweep(pw.projectId);
      });
      pw.watchers.push(watcher);
    } catch {
      console.warn(`[watch-hub] Could not watch directory: ${dir}`);
    }
  }

  private enqueueSweep(projectId: string): void {
    const pw = this.projects.get(projectId);
    if (!pw) return;

    // Debounce — collapse rapid fs.watch events
    if (pw.debounceTimer) {
      clearTimeout(pw.debounceTimer);
    }
    pw.debounceTimer = setTimeout(() => {
      pw.debounceTimer = null;
      this.fullHashSweep(projectId);
    }, DEBOUNCE_MS);
  }
}
