/**
 * Multi-session concurrency tests for project_state.yaml
 *
 * V22-05: Atomic writes + revision guard
 */

import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import {
  readProjectState,
  readProjectStateWithRevision,
  writeProjectState,
  computeRevision,
  ConflictError,
  type ProjectStateDoc,
} from "../runtime/state/reconcile.js";
import {
  initCommand,
  isCommandError,
  transitionState,
} from "../runtime/commands/shared.js";

// ── Temp dir management ────────────────────────────────────────────

const SAMPLE_PROJECT = "projects/sample";
const tempDirs: string[] = [];

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function removeDirSync(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function createTempProject(name: string): string {
  const tmpDir = path.resolve(`test-fixtures-concurrency-${name}-${Date.now()}`);
  copyDirSync(path.resolve(SAMPLE_PROJECT), tmpDir);
  tempDirs.push(tmpDir);
  return tmpDir;
}

afterAll(() => tempDirs.forEach(removeDirSync));

// ══════════════════════════════════════════════════════════════════
// 1. Atomic write (temp + rename)
// ══════════════════════════════════════════════════════════════════

describe("atomic writeProjectState", () => {
  it("writes via temp file and rename — no partial writes", () => {
    const dir = createTempProject("atomic-basic");
    const doc: ProjectStateDoc = {
      version: 1,
      project_id: "test",
      current_state: "intent_pending",
      history: [],
    };

    writeProjectState(dir, doc);

    // File should exist and be valid YAML
    const stateFile = path.join(dir, "project_state.yaml");
    expect(fs.existsSync(stateFile)).toBe(true);
    const parsed = parseYaml(fs.readFileSync(stateFile, "utf-8")) as ProjectStateDoc;
    expect(parsed.current_state).toBe("intent_pending");
    expect(parsed.last_updated).toBeDefined();

    // No leftover .tmp files
    const tmpFiles = fs.readdirSync(dir).filter((f) => f.includes(".tmp."));
    expect(tmpFiles).toHaveLength(0);
  });

  it("overwrites existing file atomically", () => {
    const dir = createTempProject("atomic-overwrite");
    const doc1: ProjectStateDoc = {
      version: 1,
      project_id: "test",
      current_state: "intent_pending",
      history: [],
    };
    writeProjectState(dir, doc1);

    const doc2: ProjectStateDoc = {
      version: 1,
      project_id: "test",
      current_state: "intent_locked",
      history: [],
    };
    writeProjectState(dir, doc2);

    const parsed = readProjectState(dir);
    expect(parsed?.current_state).toBe("intent_locked");
  });
});

// ══════════════════════════════════════════════════════════════════
// 2. Revision hash computation
// ══════════════════════════════════════════════════════════════════

describe("readProjectStateWithRevision", () => {
  it("returns null for missing file", () => {
    const dir = createTempProject("rev-missing");
    // Remove project_state.yaml if it exists
    const stateFile = path.join(dir, "project_state.yaml");
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);

    expect(readProjectStateWithRevision(dir)).toBeNull();
  });

  it("returns doc + revision for existing file", () => {
    const dir = createTempProject("rev-exists");
    const doc: ProjectStateDoc = {
      version: 1,
      project_id: "test",
      current_state: "intent_pending",
      history: [],
    };
    writeProjectState(dir, doc);

    const result = readProjectStateWithRevision(dir);
    expect(result).not.toBeNull();
    expect(result!.doc.current_state).toBe("intent_pending");
    expect(result!.revision).toMatch(/^[0-9a-f]{16}$/);
  });

  it("revision changes when file content changes", () => {
    const dir = createTempProject("rev-change");
    const doc: ProjectStateDoc = {
      version: 1,
      project_id: "test",
      current_state: "intent_pending",
      history: [],
    };
    writeProjectState(dir, doc);
    const rev1 = readProjectStateWithRevision(dir)!.revision;

    doc.current_state = "intent_locked";
    writeProjectState(dir, doc);
    const rev2 = readProjectStateWithRevision(dir)!.revision;

    expect(rev1).not.toBe(rev2);
  });

  it("revision is stable for identical content", () => {
    const content = stringifyYaml({
      version: 1,
      project_id: "test",
      current_state: "intent_pending",
    });
    expect(computeRevision(content)).toBe(computeRevision(content));
  });
});

// ══════════════════════════════════════════════════════════════════
// 3. ConflictError on concurrent modification
// ══════════════════════════════════════════════════════════════════

describe("revision guard — ConflictError", () => {
  it("succeeds when revision matches", () => {
    const dir = createTempProject("guard-match");
    const doc: ProjectStateDoc = {
      version: 1,
      project_id: "test",
      current_state: "intent_pending",
      history: [],
    };
    writeProjectState(dir, doc);

    const { revision } = readProjectStateWithRevision(dir)!;

    // Write with correct revision — should not throw
    doc.current_state = "intent_locked";
    expect(() => {
      writeProjectState(dir, doc, { expectedRevision: revision });
    }).not.toThrow();
  });

  it("throws ConflictError when file was modified by another session", () => {
    const dir = createTempProject("guard-conflict");
    const doc: ProjectStateDoc = {
      version: 1,
      project_id: "test",
      current_state: "intent_pending",
      history: [],
    };
    writeProjectState(dir, doc);

    // Session A reads revision
    const revA = readProjectStateWithRevision(dir)!.revision;

    // Session B modifies the file behind A's back
    const docB: ProjectStateDoc = {
      version: 1,
      project_id: "test",
      current_state: "media_analyzed",
      history: [],
    };
    writeProjectState(dir, docB);

    // Session A tries to write with stale revision — should throw
    doc.current_state = "intent_locked";
    expect(() => {
      writeProjectState(dir, doc, { expectedRevision: revA });
    }).toThrow(ConflictError);
  });

  it("ConflictError contains expected and actual revisions", () => {
    const dir = createTempProject("guard-details");
    const doc: ProjectStateDoc = {
      version: 1,
      project_id: "test",
      current_state: "intent_pending",
      history: [],
    };
    writeProjectState(dir, doc);
    const revA = readProjectStateWithRevision(dir)!.revision;

    // Mutate behind A's back
    const docB = { ...doc, current_state: "media_analyzed" as const };
    writeProjectState(dir, docB);
    const revB = readProjectStateWithRevision(dir)!.revision;

    try {
      writeProjectState(dir, doc, { expectedRevision: revA });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError);
      const conflict = err as ConflictError;
      expect(conflict.expectedRevision).toBe(revA);
      expect(conflict.actualRevision).toBe(revB);
      expect(conflict.code).toBe("STATE_CONFLICT");
    }
  });

  it("no revision guard when expectedRevision is omitted", () => {
    const dir = createTempProject("guard-none");
    const doc: ProjectStateDoc = {
      version: 1,
      project_id: "test",
      current_state: "intent_pending",
      history: [],
    };
    writeProjectState(dir, doc);

    // Mutate
    const doc2 = { ...doc, current_state: "media_analyzed" as const };
    writeProjectState(dir, doc2);

    // Write without revision guard — should succeed
    doc.current_state = "intent_locked";
    expect(() => {
      writeProjectState(dir, doc);
    }).not.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════
// 4. Parallel initCommand + transitionState
// ══════════════════════════════════════════════════════════════════

describe("parallel initCommand + transitionState", () => {
  it("initCommand returns stateRevision in CommandContext", () => {
    const dir = createTempProject("init-rev");
    const ctx = initCommand(dir, "test-cmd", []);
    if (isCommandError(ctx)) {
      expect.unreachable(`initCommand failed: ${ctx.message}`);
      return;
    }
    expect(ctx.stateRevision).toMatch(/^[0-9a-f]{16}$/);
  });

  it("transitionState with valid revision succeeds", () => {
    const dir = createTempProject("transition-ok");
    const ctx = initCommand(dir, "test-cmd", []);
    if (isCommandError(ctx)) {
      expect.unreachable(`initCommand failed: ${ctx.message}`);
      return;
    }

    // Transition with the revision from initCommand
    expect(() => {
      transitionState(
        ctx.projectDir,
        ctx.doc,
        "intent_locked",
        "test-transition",
        "test-actor",
        "test note",
        { expectedRevision: ctx.stateRevision },
      );
    }).not.toThrow();
  });

  it("transitionState detects conflict from parallel session", () => {
    const dir = createTempProject("transition-conflict");

    // Session A: init
    const ctxA = initCommand(dir, "session-a", []);
    if (isCommandError(ctxA)) {
      expect.unreachable(`initCommand A failed: ${ctxA.message}`);
      return;
    }

    // Session B: init (overwrites state file)
    const ctxB = initCommand(dir, "session-b", []);
    if (isCommandError(ctxB)) {
      expect.unreachable(`initCommand B failed: ${ctxB.message}`);
      return;
    }

    // Session A tries to transition with its stale revision
    expect(() => {
      transitionState(
        ctxA.projectDir,
        ctxA.doc,
        "intent_locked",
        "session-a-transition",
        "session-a",
        undefined,
        { expectedRevision: ctxA.stateRevision },
      );
    }).toThrow(ConflictError);
  });

  it("concurrent initCommand calls both get distinct revisions", () => {
    const dir = createTempProject("init-distinct");

    const ctxA = initCommand(dir, "session-a", []);
    if (isCommandError(ctxA)) {
      expect.unreachable(`initCommand A failed: ${ctxA.message}`);
      return;
    }
    const revA = ctxA.stateRevision;

    const ctxB = initCommand(dir, "session-b", []);
    if (isCommandError(ctxB)) {
      expect.unreachable(`initCommand B failed: ${ctxB.message}`);
      return;
    }
    const revB = ctxB.stateRevision;

    // They should differ because last_agent / last_command differ
    expect(revA).not.toBe(revB);
  });
});
