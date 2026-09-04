/**
 * Isolated hostile tests for the active-render cleanup registry (Issue 33
 * audit follow-up): path validation, kind honoring, idempotency, listener
 * lifecycle. Real-signal behavior is covered by the subprocess evidence
 * tests in still-camera-motion-render.test.ts and the coexistence fixture.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, afterEach, describe, expect, it } from "vitest";
import { bundleFixture } from "./helpers/fixture-bundle.js";
import {
  expectNoSurvivors,
  fixtureProcessRows,
  OwnedRenderChild,
  TeardownScope,
} from "./helpers/owned-render-child.js";
import {
  cleanupRegisteredRenderPathsSync,
  registerRenderCleanupPath,
  registeredRenderCleanupCount,
  renderCleanupHasSignalListeners,
  unregisterRenderCleanupPath,
} from "../runtime/render/render-cleanup-registry.js";

const created: string[] = [];
const originalTmpdir = process.env.TMPDIR;
// Per-file PRIVATE TMPDIR: every validation fixture lives under this exact
// root (the registry's allowed root honors TMPDIR dynamically), so no test
// state is created in the global temp area.
let filePrivateRoot = "";
beforeAll(() => {
  filePrivateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-regtests-"));
  process.env.TMPDIR = filePrivateRoot;
});
afterAll(() => {
  process.env.TMPDIR = originalTmpdir;
  fs.rmSync(filePrivateRoot, { recursive: true, force: true });
});
afterEach(() => {
  for (const target of created.splice(0)) {
    // only per-test fixtures — never the file-owned private root itself
    if (target !== filePrivateRoot) fs.rmSync(target, { recursive: true, force: true });
  }
  // Never leak listeners between tests.
  cleanupRegisteredRenderPathsSync();
});

function makeTaskTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function makeWorkFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-filehost-"));
  created.push(dir);
  const file = path.join(dir, "partial.mp4");
  fs.writeFileSync(file, "x");
  created.push(file);
  return file;
}

describe("render cleanup registry validation", () => {
  it("rejects raw relative paths before resolving", () => {
    expect(() => registerRenderCleanupPath("vos-still-base-rel")).toThrow(/render_cleanup_target_relative/);
    expect(() => registerRenderCleanupPath("./vos-still-base-rel")).toThrow(/render_cleanup_target_relative/);
  });

  it("rejects empty and dot targets", () => {
    expect(() => registerRenderCleanupPath("")).toThrow(/render_cleanup_target_empty/);
    expect(() => registerRenderCleanupPath("   ")).toThrow(/render_cleanup_target_empty/);
    expect(() => registerRenderCleanupPath(`${os.tmpdir()}/vos-still-base-x/..`)).toThrow(/render_cleanup_target_dot_segment/);
    expect(() => registerRenderCleanupPath(`${os.tmpdir()}/./vos-still-base-x`)).toThrow(/render_cleanup_target_dot_segment/);
  });

  it("rejects non-normalized paths", () => {
    expect(() => registerRenderCleanupPath(`${os.tmpdir()}//vos-still-base-x`)).toThrow(/render_cleanup_target_not_normalized/);
    expect(() => registerRenderCleanupPath(`${os.tmpdir()}/vos-still-base-x/`)).toThrow(/render_cleanup_target_not_normalized/);
  });

  it("rejects root, cwd, home, and the temp root as targets", () => {
    expect(() => registerRenderCleanupPath("/", "file")).toThrow(/render_cleanup/);
    expect(() => registerRenderCleanupPath(process.cwd(), "file")).toThrow(/render_cleanup_file_forbidden_root/);
    expect(() => registerRenderCleanupPath(os.homedir(), "file")).toThrow(/render_cleanup_file_forbidden_root/);
    expect(() => registerRenderCleanupPath(os.tmpdir(), "file")).toThrow(/render_cleanup_file_forbidden_root/);
    // as a claimed dir they fail the prefix/root validation
    expect(() => registerRenderCleanupPath("/", "dir")).toThrow(/render_cleanup/);
    expect(() => registerRenderCleanupPath(process.cwd(), "dir")).toThrow(/render_cleanup_dir_root_not_allowed/);
  });

  it("rejects directories outside the allowed temp root or with an unapproved prefix", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-projhost-"));
    created.push(projectDir);
    const outside = path.join(projectDir, "vos-still-base-inside");
    fs.mkdirSync(outside);
    expect(() => registerRenderCleanupPath(outside, "dir")).toThrow(/render_cleanup_dir_root_not_allowed/);

    const wrongPrefix = fs.mkdtempSync(path.join(os.tmpdir(), "not-ours-"));
    created.push(wrongPrefix);
    expect(() => registerRenderCleanupPath(wrongPrefix, "dir")).toThrow(/render_cleanup_dir_prefix_not_approved/);

    const missing = path.join(os.tmpdir(), `vos-still-base-${Date.now()}-missing`);
    expect(() => registerRenderCleanupPath(missing, "dir")).toThrow(/render_cleanup_dir_missing/);
  });

  it("rejects symlinks in either kind", () => {
    const realDir = makeTaskTempDir("vos-still-base-");
    const linkDir = path.join(os.tmpdir(), `vos-still-base-link-${Date.now()}`);
    created.push(linkDir);
    fs.symlinkSync(realDir, linkDir, "dir");
    expect(() => registerRenderCleanupPath(linkDir, "dir")).toThrow(/render_cleanup_dir_symlink/);

    const realFile = makeWorkFile();
    const linkFile = path.join(path.dirname(realFile), "partial-link.mp4");
    created.push(linkFile);
    fs.symlinkSync(realFile, linkFile, "file");
    expect(() => registerRenderCleanupPath(linkFile, "file")).toThrow(/render_cleanup_file_symlink/);
  });

  it("rejects file-as-directory and directory-as-file claims", () => {
    // a regular FILE directly under the temp root with an approved prefix:
    // the dir claim passes root/prefix checks and must fail on the lstat fact
    const fileAtTempRoot = path.join(os.tmpdir(), `vos-still-base-file-${Date.now()}-${process.pid}`);
    fs.writeFileSync(fileAtTempRoot, "x");
    created.push(fileAtTempRoot);
    expect(() => registerRenderCleanupPath(fileAtTempRoot, "dir")).toThrow(/render_cleanup_dir_not_directory/);

    const dir = makeTaskTempDir("vos-still-base-");
    expect(() => registerRenderCleanupPath(dir, "file")).toThrow(/render_cleanup_file_not_regular/);
  });

  it("rejects file targets with missing, root, or non-directory parents", () => {
    expect(() => registerRenderCleanupPath("/partial.mp4", "file")).toThrow(/render_cleanup_file_parent_is_root/);
    expect(() => registerRenderCleanupPath("/no-such-dir/partial.mp4", "file")).toThrow(/render_cleanup_file_parent_missing/);
    expect(() => registerRenderCleanupPath(`${os.tmpdir()}/vos-still-filehost-missing/partial.mp4`, "file"))
      .toThrow(/render_cleanup_file_parent_missing/);
  });

  it("accepts a valid nonexistent output file path (future partial output)", () => {
    const host = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-filehost-"));
    created.push(host);
    const target = path.join(host, "partial.mp4");
    expect(fs.existsSync(target)).toBe(false);
    registerRenderCleanupPath(target, "file");
    expect(registeredRenderCleanupCount()).toBe(1);
    // cleanup removes nothing (absent) but always clears and uninstalls
    expect(cleanupRegisteredRenderPathsSync().removed).toHaveLength(1);
    expect(registeredRenderCleanupCount()).toBe(0);
    expect(renderCleanupHasSignalListeners()).toBe(false);
  });
});

describe("render cleanup registry lifecycle", () => {
  it("is idempotent for duplicate and unknown operations", () => {
    const dir = makeTaskTempDir("vos-still-base-");
    registerRenderCleanupPath(dir, "dir");
    registerRenderCleanupPath(dir, "dir"); // duplicate no-op
    expect(registeredRenderCleanupCount()).toBe(1);
    unregisterRenderCleanupPath(dir);
    unregisterRenderCleanupPath(dir); // unknown no-op
    unregisterRenderCleanupPath("/definitely/not/registered.mp4");
    expect(registeredRenderCleanupCount()).toBe(0);
  });

  it("handles concurrent registrations and removes each path by its validated kind", () => {
    const dirA = makeTaskTempDir("vos-still-base-");
    const dirB = makeTaskTempDir("vos-still-warp-");
    fs.writeFileSync(path.join(dirA, "payload.bin"), "a");
    const file = makeWorkFile();
    registerRenderCleanupPath(dirA, "dir");
    registerRenderCleanupPath(dirB, "dir");
    registerRenderCleanupPath(file, "file");
    expect(registeredRenderCleanupCount()).toBe(3);

    expect(cleanupRegisteredRenderPathsSync().removed).toHaveLength(3);
    expect(fs.existsSync(dirA)).toBe(false);
    expect(fs.existsSync(dirB)).toBe(false);
    // file kind must be honored: the HOST directory survives, only the file goes
    expect(fs.existsSync(path.dirname(file))).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(registeredRenderCleanupCount()).toBe(0);
  });

  it("installs listeners on first registration, uninstalls on empty, and preserves unrelated listeners on direct cleanup", () => {
    const unrelated = (): void => {};
    process.on("SIGINT", unrelated);
    try {
      expect(renderCleanupHasSignalListeners()).toBe(false);
      const dir = makeTaskTempDir("vos-still-base-");
      registerRenderCleanupPath(dir, "dir");
      expect(renderCleanupHasSignalListeners()).toBe(true);
      expect(process.listenerCount("SIGINT")).toBeGreaterThanOrEqual(2);

      cleanupRegisteredRenderPathsSync();
      expect(fs.existsSync(dir)).toBe(false);
      expect(registeredRenderCleanupCount()).toBe(0);
      // our own listeners are gone, the unrelated one survives untouched
      expect(renderCleanupHasSignalListeners()).toBe(false);
      expect(process.listeners("SIGINT").includes(unrelated)).toBe(true);
    } finally {
      process.removeListener("SIGINT", unrelated);
    }
  });

  it("hostile: a retained (unremovable) entry keeps ownership, listeners, and surfaces partial outcome until a retry succeeds", () => {
    const retainedDir = path.join(process.env.TMPDIR!, `vos-still-base-retained-${Date.now()}`);
    fs.mkdirSync(retainedDir, { recursive: true });
    fs.writeFileSync(path.join(retainedDir, "occupied.bin"), "x");
    fs.chmodSync(retainedDir, 0o500); // removal of occupied.bin fails (EPERM/EACCES)
    registerRenderCleanupPath(retainedDir, "dir");
    try {
      const outcome = cleanupRegisteredRenderPathsSync();
      // honest partial outcome: the entry is RETAINED, never discarded
      expect(outcome.retained).toHaveLength(1);
      expect(outcome.removed).toEqual([]);
      expect(registeredRenderCleanupCount()).toBe(1);
      // ownership retained: listeners stay installed for retry/evidence
      expect(renderCleanupHasSignalListeners()).toBe(true);
    } finally {
      fs.chmodSync(retainedDir, 0o700); // repair so the retry can succeed
    }
    // retry: succeeds, discards the entry, retires the listeners
    const retry = cleanupRegisteredRenderPathsSync();
    expect(retry.removed).toEqual([retainedDir]);
    expect(retry.retained).toEqual([]);
    expect(registeredRenderCleanupCount()).toBe(0);
    expect(renderCleanupHasSignalListeners()).toBe(false);
    expect(fs.existsSync(retainedDir)).toBe(false);
  });

  it("hostile subprocess: a persistent deletion failure reports once and does not self-reenter", async () => {
    const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vos-registry-retained-childroot-"));
    const teardown = new TeardownScope();
    let owned: OwnedRenderChild | null = null;
    let retainedDir = "";
    let bundledScript = "";
    const stdout: string[] = [];
    const stderr: string[] = [];
    const failureContext = (): string => `child stdout: ${stdout.join("")} stderr: ${stderr.join("")}`;
    teardown.add("owned retained-entry group terminate", async () => {
      if (owned) await owned.terminate();
    });
    teardown.add("repair and remove exact retained directory", () => {
      if (!retainedDir || !fs.existsSync(retainedDir)) return;
      fs.chmodSync(retainedDir, 0o700);
      fs.rmSync(retainedDir, { recursive: true, force: true });
    });
    teardown.add("retained-entry private root removal", () => {
      fs.rmSync(privateRoot, { recursive: true, force: true });
    });

    try {
      bundledScript = bundleFixture("tests/fixtures/render-cleanup-retained-child.ts", privateRoot);
      owned = new OwnedRenderChild([bundledScript], {
        env: { ...process.env, TMPDIR: privateRoot },
      });
      owned.child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk.toString()));
      owned.child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
      const readyDeadline = Date.now() + 30_000;
      while (!stdout.join("").includes("DIR:") && !owned.exited && Date.now() < readyDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const dirLine = stdout.join("").split("\n").find((line) => line.startsWith("DIR:"));
      expect(dirLine, failureContext()).toBeDefined();
      retainedDir = dirLine!.slice(4).trim();
      expect(path.dirname(retainedDir)).toBe(privateRoot);
      expect(fs.existsSync(retainedDir)).toBe(true);

      // Exact scenario delivery: no positive-PID fallback and no broad signal.
      owned.groupSignal(owned.pgid, "SIGINT");
      const exit = await Promise.race([
        owned.onceSettled(),
        new Promise<"EXIT_TIMEOUT">((resolve) => setTimeout(() => resolve("EXIT_TIMEOUT"), 10_000)),
      ]);
      expect(exit, failureContext()).toEqual({ code: null, signal: "SIGINT" });
      expect(stderr.join(""), failureContext()).toContain("ownership retained for retry");
      expect((stderr.join("").match(/cleanup retained 1 path\(s\)/g) ?? [])).toHaveLength(1);
      // The failed target remains until the owner explicitly repairs it.
      expect(fs.existsSync(retainedDir)).toBe(true);
    } finally {
      await teardown.run();
    }

    expect(owned!.groupAlive()).toBe(false);
    expect(fixtureProcessRows(bundledScript, { pgid: owned!.pgid })).toEqual([]);
    await expectNoSurvivors(bundledScript, [owned!.pgid]);
  }, 60_000);
});

describe("render cleanup registry coexistence (real SIGINT, subprocess)", () => {
  async function readChildDirLine(owned: OwnedRenderChild, timeoutMs: number): Promise<string> {
    const stderr: string[] = [];
    owned.child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
    return Promise.race([
      new Promise<string>((resolve, reject) => {
        owned.child.stdout.on("data", (chunk: Buffer) => {
          const line = chunk.toString().split("\n").find((l) => l.startsWith("DIR:"));
          if (line) resolve(line.slice(4).trim());
        });
        owned.onceSettled().then((settle) => reject(new Error(`child exited early code=${settle.code} error=${settle.error ?? ""} stderr=${stderr.join("")}`)));
      }),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("READY timeout")), timeoutMs)),
    ]);
  }

  it("cleans up on real SIGINT with an unrelated listener present: single delivery, child survives, our listeners retire", async () => {
    const { setTimeout: sleep } = await import("node:timers/promises");
    // Private task-owned temp root via TMPDIR: the child's registered dir
    // must live INSIDE this exact root and nowhere else.
    const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-childroot-"));
    const teardown = new TeardownScope();
    let owned: OwnedRenderChild | null = null;
    let registeredDir = "";
    let bundledScript = "";
    try {
      // Construction is the first fallible operation — INSIDE the scope.
      bundledScript = bundleFixture("tests/fixtures/render-cleanup-coexist-child.ts", privateRoot);
      owned = new OwnedRenderChild([bundledScript], {
        env: { ...process.env, TMPDIR: privateRoot },
      });
      teardown.add("owned group terminate", () => owned!.terminate());
      const stdout: string[] = [];
      owned.child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk.toString()));
      registeredDir = await readChildDirLine(owned, 30_000);
      expect(path.dirname(registeredDir)).toBe(privateRoot);
      expect(fs.existsSync(registeredDir)).toBe(true);

      owned.signal("SIGINT");

      // The unrelated listener owns termination: the child must stay alive.
      await sleep(1_000);
      expect(owned.child.exitCode, `stdout: ${stdout.join("")}`).toBeNull();
      expect(owned.child.signalCode).toBeNull();

      // Registry cleaned its registered path and uninstalled its listeners;
      // the unrelated listener ran exactly once (no double delivery).
      expect(fs.existsSync(registeredDir)).toBe(false);
      expect(stdout.join("")).toContain("UNRELATED");
      expect(stdout.join("")).not.toContain("DOUBLE_DELIVERED");
      expect((stdout.join("").match(/UNRELATED/g) ?? []).length).toBe(1);
    } finally {
      // Owner-scoped teardown on every exit path: ALL steps attempted,
      // failures aggregated and surfaced — nothing skipped, nothing swallowed.
      teardown.add("private root removal", () => fs.rmSync(privateRoot, { recursive: true, force: true }));
      await teardown.run();
    }
    expect(owned!.exited).toBe(true);
    expect(owned!.groupAlive()).toBe(false);
    expect(fixtureProcessRows(bundledScript, { pgid: owned!.pgid })).toEqual([]);
  }, 60_000);

  it("hostile: an intentional mid-test assertion failure still terminates the owned child group with zero orphans", async () => {
    const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-childroot-"));
    const teardown = new TeardownScope();
    let owned: OwnedRenderChild | null = null;
    let registeredDir = "";
    let bundledScript = "";
    try {
      bundledScript = bundleFixture("tests/fixtures/render-cleanup-coexist-child.ts", privateRoot);
      owned = new OwnedRenderChild([bundledScript], {
        env: { ...process.env, TMPDIR: privateRoot },
      });
      teardown.add("owned group terminate", () => owned!.terminate());
      registeredDir = await readChildDirLine(owned, 30_000);
      expect(path.dirname(registeredDir)).toBe(privateRoot);
      expect(fs.existsSync(registeredDir)).toBe(true);
      // INTENTIONAL assertion failure — the exact shape of any mid-test
      // expect() throw. The finally must still own the child.
      expect(true).toBe(false);
    } catch {
      // swallow the intentional failure; cleanup is proven below
    } finally {
      teardown.add("private root removal", () => fs.rmSync(privateRoot, { recursive: true, force: true }));
      await teardown.run();
    }
    expect(owned!.exited).toBe(true);
    // the child's registry cleaned its own temp dir inside its private root
    expect(fs.existsSync(registeredDir)).toBe(false);
    // no orphan: the exact fixture must not appear in the process table
    // (a survivor would be reparented to PPID 1)
    expect(fixtureProcessRows(bundledScript, { pgid: owned!.pgid })).toEqual([]);
    expect(() => process.kill(owned!.pgid, 0)).toThrow();
  }, 60_000);

  it("hostile: ownership readiness timeout still terminates the group, SIGKILL escalation covers TERM-ignoring children", async () => {
    const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-childroot-"));
    const teardown = new TeardownScope();
    let owned: OwnedRenderChild | null = null;
    let bundledScript = "";
    try {
      bundledScript = bundleFixture("tests/fixtures/render-cleanup-coexist-child.ts", privateRoot);
      owned = new OwnedRenderChild([bundledScript, "--ignore-term"], {
        env: { ...process.env, TMPDIR: privateRoot } });
      teardown.add("owned group terminate (escalating)", () => owned!.terminate({ escalateAfterMs: 300 }));
      await Promise.race([
        readChildDirLine(owned, 30_000),
        // 1ms is deterministically shorter than any real child startup
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("simulated readiness timeout")), 1)),
      ]);
      throw new Error("unreachable: timeout should have fired first");
    } catch (error) {
      expect(String(error)).toContain("simulated readiness timeout");
    } finally {
      teardown.add("private root removal", () => fs.rmSync(privateRoot, { recursive: true, force: true }));
      await teardown.run();
    }
    expect(owned!.exited).toBe(true);
    expect(fixtureProcessRows(bundledScript, { pgid: owned!.pgid })).toEqual([]);
    expect(() => process.kill(owned!.pgid, 0)).toThrow();
  }, 60_000);

  it("teardown scope surfaces failures without skipping later steps (registry root cleanup failure visibility)", () => {
    const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-childroot-"));
    fs.writeFileSync(path.join(privateRoot, "doomed.bin"), "x");
    // a non-writable PARENT makes the entry genuinely unremovable (EPERM)
    fs.chmodSync(privateRoot, 0o500);
    let laterStepRan = false;
    const teardown = new TeardownScope();
    teardown.add("private root removal (failing)", () => fs.rmSync(privateRoot, { recursive: true, force: true }));
    teardown.add("later cleanup step", () => { laterStepRan = true; });
    return teardown.run().then(
      () => { throw new Error("expected teardown to fail"); },
      (error) => {
        expect(String(error)).toMatch(/teardown_failures:1/);
        // the later step was still attempted — a failing step never skips one
        expect(laterStepRan).toBe(true);
      },
    ).finally(() => {
      // repair ownership so this test's own cleanup can finish
      fs.chmodSync(privateRoot, 0o700);
      fs.rmSync(privateRoot, { recursive: true, force: true });
    });
  });
});
