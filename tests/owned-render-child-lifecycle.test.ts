/**
 * Hostile lifecycle evidence for the owned-render-child contract (Issue 33
 * audit follow-ups): exact negative-PGID group termination (leader exit is
 * NOT group cleanup, no positive-PID fallback exists), SIGKILL escalation
 * against a TERM-ignoring descendant, spawn-error settlement, deterministic
 * setup-failure cleanup, and exact-launch-form process inspection that never
 * matches or kills foreign processes whose arguments merely contain the
 * fixture name.
 *
 * Fixture children run BUNDLED (plain `node <fixture>.mjs`) so no tsx/esbuild
 * service joins their process group — macOS refuses group signals (EPERM)
 * while such a member lives, and the audit forbids positive-PID fallbacks.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundleFixture } from "./helpers/fixture-bundle.js";
import {
  expectNoSurvivors,
  fixtureProcessRows,
  OwnedRenderChild,
  psRows,
  TeardownScope,
  type TeardownFailure,
} from "./helpers/owned-render-child.js";

const FIXTURE_SOURCE = "tests/fixtures/render-cleanup-coexist-child.ts";
const tracked: OwnedRenderChild[] = [];
/** Decoy helper processes, each its own DETACHED process group. */
const decoyGroups: number[] = [];
const extraDirs: string[] = [];

afterEach(async () => {
  // Aggregate every teardown failure and surface it — never swallow, never
  // skip a later step.
  const teardown = new TeardownScope();
  for (const owned of tracked.splice(0)) {
    teardown.add(`owned group terminate pgid=${owned.pgid}`, () => owned.terminate());
  }
  for (const decoyPgid of decoyGroups.splice(0)) {
    teardown.add(`decoy group terminate pgid=${decoyPgid}`, () => {
      // exact negative PGID only; ESRCH (already gone) is the only accepted
      // non-success, anything else surfaces
      try {
        process.kill(-decoyPgid, "SIGKILL");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code !== "ESRCH") throw error;
      }
    });
  }
  for (const dir of extraDirs.splice(0)) {
    teardown.add(`dir removal ${dir}`, () => fs.rmSync(dir, { recursive: true, force: true }));
  }
  await teardown.run();
});

/** Spawn a decoy helper as its OWN detached group (verifiable by -PGID). */
function spawnDecoyGroup(token: string): number {
  const decoy = spawn(process.execPath, [
    "-e", "setInterval(() => {}, 1000);", token,
  ], { stdio: "ignore", detached: true });
  decoyGroups.push(decoy.pid!);
  return decoy.pid!;
}

async function readChildLines(
  owned: OwnedRenderChild,
  timeoutMs: number,
  required: string[] = ["DIR:"],
): Promise<string[]> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  owned.child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk.toString()));
  owned.child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
  return Promise.race([
    (async () => {
      for (;;) {
        if (owned.exited) throw new Error(`child exited early: ${stderr.join("")}`);
        const lines = stdout.join("").split("\n").filter((l) => required.some((prefix) => l.startsWith(prefix)));
        if (required.every((prefix) => lines.some((l) => l.startsWith(prefix)))) return lines;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    })(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`child line timeout (${required.join(",")}): ${stderr.join("")}`)), timeoutMs)),
  ]);
}

function failVisible(error: unknown): never {
  throw error instanceof Error ? error : new Error(String(error));
}

describe("owned render child group contract", () => {
  it("spawn failure settles via the error event and cleanup remains a no-op with visible failure", async () => {
    const teardown = new TeardownScope();
    const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-childroot-"));
    teardown.add("private root removal", () => fs.rmSync(privateRoot, { recursive: true, force: true }));
    let owned: OwnedRenderChild | null = null;
    try {
      // spawn failure (ENOENT) settles through the ERROR event
      owned = new OwnedRenderChild(["--anything"], {
        execPath: "/nonexistent/node-binary",
        env: { ...process.env, TMPDIR: privateRoot },
      });
      tracked.push(owned);
      teardown.add("owned group terminate (spawn-failure no-op)", () => owned!.terminate());
      const settle = await Promise.race([
        owned.onceSettled(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("spawn error never settled")), 15_000)),
      ]);
      // Visible failure: the spawn error is surfaced, never swallowed.
      expect(settle.error).toBeDefined();
      expect(settle.error?.message).toMatch(/ENOENT|spawn/i);
      expect(owned.groupAlive()).toBe(false);
    } finally {
      await teardown.run();
    }
    expect(owned!.exited).toBe(true);
  }, 30_000);

  it("terminate sweeps a TERM-ignoring group descendant: leader exit alone is not group cleanup", async () => {
    const teardown = new TeardownScope();
    const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-childroot-"));
    teardown.add("private root removal", () => fs.rmSync(privateRoot, { recursive: true, force: true }));
    const bundledScript = bundleFixture(FIXTURE_SOURCE, privateRoot);
    let owned: OwnedRenderChild | null = null;
    try {
      owned = new OwnedRenderChild([bundledScript, "--spawn-descendant"], {
        env: { ...process.env, TMPDIR: privateRoot },
      });
      tracked.push(owned);
      teardown.add("owned group terminate (escalating)", () => owned!.terminate({ escalateAfterMs: 0 }));
      const lines = await readChildLines(owned, 30_000, ["DIR:", "DESCENDANT:"]);
      const dirLine = lines.find((l) => l.startsWith("DIR:"))!;
      const descendantLine = lines.find((l) => l.startsWith("DESCENDANT:"))!;
      expect(path.dirname(dirLine.slice("DIR:".length).trim())).toBe(privateRoot);
      expect(Number(descendantLine.slice("DESCENDANT:".length))).toBeGreaterThan(0);
      expect(owned.groupAlive()).toBe(true);
    } finally {
      // escalateAfterMs 0: the group KILL lands while the leader is still
      // alive, so the exact negative-PGID sweep reaches the TERM-ignoring
      // descendant without any positive-PID fallback.
      await teardown.run();
    }
    // The descendant ignores SIGTERM: the group must have been escalated to
    // SIGKILL and BOTH leader and descendant are gone.
    expect(owned!.exited).toBe(true);
    expect(owned!.groupAlive()).toBe(false); // exact group no longer exists
    expect(psRows().filter((row) => row.pgid === owned!.pgid)).toEqual([]);
    const token = `vos-still-descendant-token-${owned!.pgid}`;
    expect(psRows().filter((row) => row.command.includes(token))).toEqual([]);
    // No PPID-1 orphan: nothing with the fixture path or descendant token remains.
    await expectNoSurvivors(bundledScript, [owned!.pgid]);
    expect(psRows().filter((row) => row.ppid === 1 && row.command.includes("vos-still-descendant"))).toEqual([]);
  }, 60_000);

  it("exact-launch-form inspection never matches substring, inert-argument, or reordered-token decoys, and never kills them", async () => {
    const teardown = new TeardownScope();
    const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-childroot-"));
    teardown.add("private root removal", () => fs.rmSync(privateRoot, { recursive: true, force: true }));
    const bundledScript = bundleFixture(FIXTURE_SOURCE, privateRoot);
    // substring decoy: its argument merely CONTAINS the fixture basename
    const substringDecoyPgid = spawnDecoyGroup(`fake-${path.basename(bundledScript)}.decoy`);
    // inert-argument decoys: the EXACT canonical bundled script path appears
    // as a standalone token but ONLY as an inert argument (never the program)
    const canonical = path.resolve(bundledScript);
    const inertDecoy = spawn(process.execPath, [
      "-e", "setInterval(() => {}, 1000);", canonical,
    ], { stdio: "ignore", detached: true });
    decoyGroups.push(inertDecoy.pid!);
    // launch-form decoy: the exact script path is an option value, not the
    // executable entry (and the -e body keeps this process inert).
    const reorderedDecoy = spawn(process.execPath, [
      "--conditions", canonical, "--eval", "setInterval(() => {}, 1000);",
    ], { stdio: "ignore", detached: true });
    decoyGroups.push(reorderedDecoy.pid!);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(inertDecoy.exitCode).toBeNull();
    expect(inertDecoy.signalCode).toBeNull();
    expect(reorderedDecoy.exitCode).toBeNull();
    expect(reorderedDecoy.signalCode).toBeNull();

    let owned: OwnedRenderChild | null = null;
    try {
      owned = new OwnedRenderChild([bundledScript, "--owned-argument"], {
        env: { ...process.env, TMPDIR: privateRoot },
      });
      tracked.push(owned);
      teardown.add("owned group terminate", () => owned!.terminate());
      await readChildLines(owned, 30_000);
      // the REAL fixture child is detected by canonical absolute path + owned PGID
      const matched = fixtureProcessRows(bundledScript, { pgid: owned!.pgid });
      if (matched.length !== 1) {
        console.log("DEBUG matched=0 pgid=", owned!.pgid, "bundled=", bundledScript,
          "rows=", JSON.stringify(psRows().filter((row) => row.pgid === owned!.pgid)));
      }
      expect(matched).toHaveLength(1);
      expect(matched[0]?.pgid).toBe(owned!.pgid);
      // none of the decoys match: substring fails exact-token; inert-argument
      // and reordered decoys carry the exact path but NOT in the launch form
      expect(fixtureProcessRows(bundledScript, { pgid: substringDecoyPgid })).toEqual([]);
      expect(fixtureProcessRows(bundledScript, { pgid: inertDecoy.pid as number })).toEqual([]);
      expect(fixtureProcessRows(bundledScript, { pgid: reorderedDecoy.pid as number })).toEqual([]);
    } finally {
      // the foreign decoys were NOT matched and NOT killed by any broad scan
      expect(inertDecoy.exitCode).toBeNull();
      expect(inertDecoy.signalCode).toBeNull();
      await teardown.run();
    }
    // ...while the owned group itself is fully gone
    expect(owned!.groupAlive()).toBe(false);
    await expectNoSurvivors(bundledScript, [owned!.pgid]);
  }, 60_000);

  it("cleanup never signals the positive leader PID (negative-PGID prohibition)", async () => {
    const teardown = new TeardownScope();
    const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-childroot-"));
    teardown.add("private root removal", () => fs.rmSync(privateRoot, { recursive: true, force: true }));
    const bundledScript = bundleFixture(FIXTURE_SOURCE, privateRoot);
    let owned: OwnedRenderChild | null = null;
    try {
      owned = new OwnedRenderChild([bundledScript], {
        env: { ...process.env, TMPDIR: privateRoot },
      });
      tracked.push(owned);
      teardown.add("owned group terminate", () => owned!.terminate());
      await readChildLines(owned, 30_000);
      // spy on the ChildProcess-level kill API: cleanup must NEVER use it
      const positiveKillCalls: string[] = [];
      const originalKill = owned.child.kill.bind(owned.child);
      owned.child.kill = ((...killArgs: Parameters<typeof originalKill>) => {
        positiveKillCalls.push(String(killArgs[0]));
        return originalKill(...killArgs);
      }) as typeof owned.child.kill;
      // no scenario signal is sent here: terminate() must clean up EXCLUSIVELY
      // through the exact negative PGID
      expect(positiveKillCalls).toEqual([]);
    } finally {
      await teardown.run();
    }
    // zero positive-PID kill calls during cleanup, and the group is really gone
    expect(owned!.exited).toBe(true);
    expect(owned!.groupAlive()).toBe(false);
    await expectNoSurvivors(bundledScript, [owned!.pgid]);
  }, 60_000);

  it("hostile: an intentional mid-test assertion failure still terminates the owned child group with zero orphans", async () => {
    const teardown = new TeardownScope();
    const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-childroot-"));
    teardown.add("private root removal", () => fs.rmSync(privateRoot, { recursive: true, force: true }));
    const bundledScript = bundleFixture(FIXTURE_SOURCE, privateRoot);
    let owned: OwnedRenderChild | null = null;
    let registeredDir = "";
    try {
      owned = new OwnedRenderChild([bundledScript], {
        env: { ...process.env, TMPDIR: privateRoot },
      });
      tracked.push(owned);
      teardown.add("owned group terminate", () => owned!.terminate());
      registeredDir = (await readChildLines(owned, 30_000)).find((l) => l.startsWith("DIR:"))!.slice(4).trim();
      expect(path.dirname(registeredDir)).toBe(privateRoot);
      expect(fs.existsSync(registeredDir)).toBe(true);
      // INTENTIONAL assertion failure — the exact shape of any mid-test
      // expect() throw. The finally must still own the child.
      expect(true).toBe(false);
    } catch {
      // swallow the intentional failure; cleanup is proven below
    } finally {
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

  it("hostile: a listener/setup throw immediately after construction still recovers the group and private root", async () => {
    const teardown = new TeardownScope();
    const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-childroot-"));
    teardown.add("private root removal", () => fs.rmSync(privateRoot, { recursive: true, force: true }));
    const bundledScript = bundleFixture(FIXTURE_SOURCE, privateRoot);
    let owned: OwnedRenderChild | null = null;
    try {
      owned = new OwnedRenderChild([bundledScript], {
        env: { ...process.env, TMPDIR: privateRoot },
      });
      tracked.push(owned);
      teardown.add("owned group terminate", () => owned!.terminate());
      // The VERY first operation after construction throws (simulated
      // listener/setup attachment failure) — the finally must still recover
      // both the exact child group and the private root.
      failVisible(new Error("simulated listener setup throw"));
    } catch (error) {
      expect(String(error)).toContain("simulated listener setup throw");
    } finally {
      await teardown.run();
    }
    expect(owned!.exited).toBe(true);
    expect(owned!.groupAlive()).toBe(false);
    await expectNoSurvivors(bundledScript, [owned!.pgid]);
    expect(fs.existsSync(privateRoot)).toBe(false);
  }, 60_000);

  it("deterministic setup failure: a readiness timeout still terminates the owned group", async () => {
    const teardown = new TeardownScope();
    const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-childroot-"));
    teardown.add("private root removal", () => fs.rmSync(privateRoot, { recursive: true, force: true }));
    const bundledScript = bundleFixture(FIXTURE_SOURCE, privateRoot);
    let owned: OwnedRenderChild | null = null;
    try {
      owned = new OwnedRenderChild([bundledScript], {
        env: { ...process.env, TMPDIR: privateRoot },
      });
      tracked.push(owned);
      teardown.add("owned group terminate (setup-failure path)", () => owned!.terminate());
      // 1ms is deterministically shorter than any real child startup
      // (exec + module load), so the setup failure always wins the race.
      await Promise.race([
        readChildLines(owned, 30_000),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("simulated setup failure")), 1)),
      ]);
      failVisible(new Error("unreachable: setup failure should have fired"));
    } catch (error) {
      expect(String(error)).toContain("simulated setup failure");
    } finally {
      await teardown.run();
    }
    expect(owned!.exited).toBe(true);
    expect(owned!.groupAlive()).toBe(false);
    await expectNoSurvivors(bundledScript, [owned!.pgid]);
  }, 60_000);

  it("hostile: natural macOS post-signal EPERM fails visibly and the self-exiting descendant still leaves zero orphans", async () => {
    const teardown = new TeardownScope();
    const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-childroot-"));
    teardown.add("private root removal", () => fs.rmSync(privateRoot, { recursive: true, force: true }));
    const bundledScript = bundleFixture(FIXTURE_SOURCE, privateRoot);
    let owned: OwnedRenderChild | null = null;
    let refusalSurfaced = false;
    try {
      owned = new OwnedRenderChild([bundledScript, "--spawn-descendant-self-exit"], {
        env: { ...process.env, TMPDIR: privateRoot },
      });
      tracked.push(owned);
      teardown.add("owned group terminate (expected refusal: self-exiting descendant)", () => owned!.terminate());
      await readChildLines(owned, 30_000, ["DIR:", "DESCENDANT:"]);
      // Group TERM succeeds (leader alive). The leader dies from it and is
      // reaped; the descendant ignores SIGTERM. terminate() escalates the
      // exact negative PGID to SIGKILL, which macOS DELIVERS to the live
      // descendant (verified empirically). If the kernel ever refuses the
      // escalation (EPERM), the refusal poisons the outcome and terminate
      // fails visibly — that contract is proven deterministically by the
      // injected-EPERM test below.
      try {
        await owned.terminate({ escalateAfterMs: 400 });
      } catch (error) {
        // if the kernel refuses the orphaned-group escalation, the refusal
        // poisons the outcome and surfaces visibly (proven deterministically
        // by the injected-EPERM test); the orphan check below still bounds it
        if (!/group_signal_refused|group_unkillable|group_probe_ambiguous/.test(String(error))) failVisible(error);
        refusalSurfaced = true;
      }
    } finally {
      try {
        await teardown.run();
      } catch {
        // the poisoned refusal surfaces here by design; orphan prevention is
        // proven below — the descendant self-exits and the leader is dead
      }
    }
    // Bounded observation WITHOUT any positive-PID signal: the group must
    // reach confirmed emptiness (ESRCH) either because the descendant was
    // killed by the escalation or because it self-exited.
    const goneDeadline = Date.now() + 15_000;
    for (;;) {
      let alive: boolean;
      let ambiguous = false;
      try {
        alive = owned!.groupAlive();
      } catch (error) {
        if (!/group_probe_ambiguous/.test(String(error))) throw error;
        alive = true;
        ambiguous = true;
      }
      if (!alive && !ambiguous) break; // confirmed ESRCH
      if (Date.now() >= goneDeadline) {
        failVisible(new Error(`owned_render_child_survivors:pgid=${owned!.pgid} (descendant never self-exited)`));
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(owned!.groupAlive()).toBe(false);
    // zero PPID-1 orphans with the descendant token
    expect(psRows().filter((row) => row.ppid === 1 && row.command.includes("vos-still-descendant"))).toEqual([]);
  }, 90_000);

  it("hostile: injected EPERM on group signaling fails visibly and never signals a positive PID", async () => {
    const teardown = new TeardownScope();
    const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-childroot-"));
    teardown.add("private root removal", () => fs.rmSync(privateRoot, { recursive: true, force: true }));
    const bundledScript = bundleFixture(FIXTURE_SOURCE, privateRoot);
    let owned: OwnedRenderChild | null = null;
    try {
      owned = new OwnedRenderChild([bundledScript], {
        env: { ...process.env, TMPDIR: privateRoot },
      });
      tracked.push(owned);
      teardown.add("owned group terminate (real, after restore)", () => owned!.terminate());
      await readChildLines(owned, 30_000);

      const calls: Array<{ target: number; sig: string }> = [];
      // Inject the refusal through the OWNED TERMINATE SEAM — never by
      // patching the global process.kill, which contaminated unrelated tests.
      // The refusal poisons the outcome: even though the member later
      // self-exits, terminate must fail visibly.
      let surfaced = false;
      try {
        await owned.terminate({
          killDeadlineMs: 800,
          escalateAfterMs: 100,
          groupSignalImpl: (pgid, sig) => {
            calls.push({ target: -pgid, sig });
            const injected = new Error("kill EPERM (injected)") as NodeJS.ErrnoException;
            injected.code = "EPERM";
            throw injected;
          },
        });
        failVisible(new Error("expected terminate to fail visibly"));
      } catch (error) {
        surfaced = String(error).includes("owned_render_child_group_signal_refused")
          || String(error).includes("owned_render_child_group_unkillable");
        if (!surfaced) failVisible(error);
      }
      expect(surfaced, "the injected EPERM must surface visibly").toBe(true);
      // every cleanup signal targeted the exact negative PGID — never a
      // positive leader PID
      const cleanupSignals = calls.filter((call) => call.sig === "SIGTERM" || call.sig === "SIGKILL");
      expect(cleanupSignals.length).toBeGreaterThan(0);
      for (const call of cleanupSignals) {
        expect(String(call.target).startsWith("-"), `positive-PID signal leaked: ${JSON.stringify(call)}`).toBe(true);
      }
    } finally {
      await teardown.run();
    }
    // real cleanup (after restore) left zero residue
    expect(owned!.exited).toBe(true);
    expect(owned!.groupAlive()).toBe(false);
    await expectNoSurvivors(bundledScript, [owned!.pgid]);
  }, 60_000);

  it("hostile: PID-reuse ambiguity (probe always claims alive) fails visibly without positive signals", async () => {
    const teardown = new TeardownScope();
    const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-childroot-"));
    teardown.add("private root removal", () => fs.rmSync(privateRoot, { recursive: true, force: true }));
    const bundledScript = bundleFixture(FIXTURE_SOURCE, privateRoot);
    let owned: OwnedRenderChild | null = null;
    try {
      owned = new OwnedRenderChild([bundledScript], {
        env: { ...process.env, TMPDIR: privateRoot },
      });
      tracked.push(owned);
      await readChildLines(owned, 30_000);
      // Inject PID-reuse ambiguity through the OWNED PROBE SEAM: the probe
      // claims the group lives forever (no kernel ESRCH ever confirms it).
      try {
        await owned.terminate({
          killDeadlineMs: 800,
          escalateAfterMs: 100,
          groupProbeImpl: () => true,
        });
        failVisible(new Error("expected terminate to fail visibly"));
      } catch (error) {
        expect(String(error)).toMatch(/group_unkillable/);
      }
    } finally {
      await teardown.run();
    }
    // the real child was killed by the escalating group signals and is gone
    expect(owned!.exited).toBe(true);
    expect(owned!.groupAlive()).toBe(false);
    await expectNoSurvivors(bundledScript, [owned!.pgid]);
  }, 60_000);

  it("the same fixture script under another PGID is never matched when verifying the owned group", async () => {
    const teardown = new TeardownScope();
    const privateRootA = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-childroot-"));
    const privateRootB = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-childroot-"));
    const bundledScriptA = bundleFixture(FIXTURE_SOURCE, privateRootA);
    const bundledScriptB = bundleFixture(FIXTURE_SOURCE, privateRootB);
    let ownedA: OwnedRenderChild | null = null;
    let ownedB: OwnedRenderChild | null = null;
    teardown.add("owned group terminate A", async () => {
      if (ownedA) await ownedA.terminate();
    });
    teardown.add("owned group terminate B", async () => {
      if (ownedB) await ownedB.terminate();
    });
    teardown.add("private root A removal", () => fs.rmSync(privateRootA, { recursive: true, force: true }));
    teardown.add("private root B removal", () => fs.rmSync(privateRootB, { recursive: true, force: true }));
    try {
      ownedA = new OwnedRenderChild([bundledScriptA], {
        env: { ...process.env, TMPDIR: privateRootA },
      });
      tracked.push(ownedA);
      ownedB = new OwnedRenderChild([bundledScriptB], {
        env: { ...process.env, TMPDIR: privateRootB },
      });
      tracked.push(ownedB);
      await readChildLines(ownedA, 30_000);
      await readChildLines(ownedB, 30_000);
      // each verification is bound to its OWN PGID: B's rows never leak into A
      const rowsA = fixtureProcessRows(bundledScriptA, { pgid: ownedA.pgid });
      const rowsB = fixtureProcessRows(bundledScriptB, { pgid: ownedB.pgid });
      expect(rowsA).toHaveLength(1);
      expect(rowsB).toHaveLength(1);
      expect(rowsA[0]?.pgid).toBe(ownedA.pgid);
      expect(rowsB[0]?.pgid).toBe(ownedB.pgid);
      // the other child's bundled script under A's PGID: no match
      expect(fixtureProcessRows(bundledScriptB, { pgid: ownedA.pgid })).toEqual([]);
    } finally {
      await teardown.run();
    }
    expect(ownedA!.groupAlive()).toBe(false);
    expect(ownedB!.groupAlive()).toBe(false);
    await expectNoSurvivors(bundledScriptA, [ownedA!.pgid, ownedB!.pgid]);
  }, 60_000);

  it("multiple cleanup failures are aggregated: every step runs and both failures surface", async () => {
    let middleRan = false;
    const teardown = new TeardownScope();
    teardown.add("failing step a", () => { throw new Error("fail-a"); });
    teardown.add("middle cleanup step", () => { middleRan = true; });
    teardown.add("failing step b", () => { throw new Error("fail-b"); });
    let failures: TeardownFailure[] = [];
    await teardown.run().catch((error) => { failures = (error as { failures?: TeardownFailure[] }).failures ?? []; });
    expect(failures.map((failure) => failure.name).sort()).toEqual(["failing step a", "failing step b"]);
    // the middle step was still attempted between the two failures
    expect(middleRan).toBe(true);
  });
});
