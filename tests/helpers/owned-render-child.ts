import { execFileSync, spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import * as path from "node:path";

/**
 * Ownership wrapper for spawned render-cleanup fixture children (Issue 33
 * audit: test lifecycle repair).
 *
 * Group contract:
 * - Every fixture child is spawned DETACHED so it leads its own process
 *   group. ALL cleanup signals go to the EXACT NEGATIVE PGID — never a
 *   positive leader PID — so descendants (ffmpeg, spawned grandchildren)
 *   are swept without touching the runner's group or unrelated processes.
 *   `signal()` exists ONLY for scenario delivery (the deliberate leader
 *   signal a test sends to exercise the registry handler) and is
 *   documented as never being a cleanup path.
 * - Termination waits for BOTH the leader settling (exit OR error event)
 *   AND the exact process group to disappear (probe kill(-pgid, 0)),
 *   escalating the owned group SIGTERM -> SIGKILL on a deadline, and throws
 *   if the group still remains. Leader exit alone is NEVER treated as
 *   group cleanup.
 * - The owning test MUST run every path from the instant the child exists
 *   inside an owner-scoped try/finally whose TeardownScope attempts ALL
 *   registered cleanup steps, aggregates their failures, and surfaces the
 *   aggregate — a failing step never skips a later one, and no failure is
 *   swallowed.
 */

export interface PsRow {
  pid: number;
  ppid: number;
  pgid: number;
  /** ps state letter: Z = zombie/defunct. */
  stat: string;
  command: string;
}

/** Structured process-table rows (macOS/Linux ps), including process state. */
export function psRows(): PsRow[] {
  const table = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,stat=,command="], { encoding: "utf8" });
  const rows: PsRow[] = [];
  for (const line of table.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (match) {
      rows.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        stat: match[4],
        command: match[5],
      });
    }
  }
  return rows;
}

/** A group member that can still receive signals (not a zombie/corpse). */
function isLiveMember(row: PsRow): boolean {
  return !row.stat.includes("Z");
}

/** Rows belonging to the EXACT owned process group — the preferred
 * membership verification: ownership is proven by the known PGID, never
 * discovered from arbitrary command text. */
export function rowsWithPgid(pgid: number): PsRow[] {
  if (!Number.isInteger(pgid) || pgid <= 0) return [];
  return psRows().filter((row) => row.pgid === pgid);
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Rows that ARE the fixture process: the exact canonical (absolute,
 * resolved) script path appears as a standalone command token in EXECUTABLE
 * POSITION — directly after the tsx loader token or directly after the node
 * executable — intersected with the exact owned PGID when one is known.
 * Relative path inputs are canonicalized before matching. A command that
 * carries the script path only as an inert argument (preceded by any other
 * token), a basename, or a substring must NOT match. Verification evidence
 * only — kill decisions use the owned PGID exclusively.
 */
export function fixtureProcessRows(
  fixtureScriptPath: string,
  opts: { execPath?: string; pgid: number },
): PsRow[] {
  const script = path.resolve(fixtureScriptPath); // canonicalize relative inputs
  const executable = path.resolve(opts.execPath ?? process.execPath);
  const pgid = opts.pgid;
  if (!Number.isInteger(pgid) || pgid <= 0) return []; // no PGID -> no ownership claim
  return psRows().filter((row) => {
    if (row.pgid !== pgid) return false; // EXACT owned PGID membership required
    const tokens = row.command.split(/\s+/);
    // the EXACT supported launch forms at the executable position:
    //   <node executable> <canonical script> ...                (bundled)
    //   <node executable> --import tsx <canonical script> ...   (tsx)
    // inert arguments (node -e payloads, shell wrappers), reordered tokens,
    // basename/substring lookalikes, and other PGIDs never match
    if (tokens[0] !== executable) return false;
    // bundled form: the node executable starts the canonical script; all
    // following tokens are ordinary script arguments.
    if (tokens[1] === script) return true;
    // tsx form: node --import tsx <script> [...]
    return tokens.length >= 4
      && tokens[1] === "--import"
      && tokens[2] === "tsx"
      && tokens[3] === script;
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface OwnedSpawnOptions {
  execPath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface OwnedTerminateOptions {
  /** ms before the owned group SIGTERM escalates to SIGKILL. */
  escalateAfterMs?: number;
  /** ms before terminate() gives up and throws (never silently leaks). */
  killDeadlineMs?: number;
  /** Test seam: inject a group-signal failure without patching globals. */
  groupSignalImpl?: (pgid: number, sig: "SIGTERM" | "SIGKILL") => void;
  /** Test seam: inject a probe result without patching globals. */
  groupProbeImpl?: (pgid: number) => boolean;
}

export interface OwnedSettle {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Set when the child errored (e.g. spawn ENOENT) instead of exiting. */
  error?: Error;
}

export class OwnedRenderChild {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  /** 0 when the process never spawned (spawn error); group probes no-op. */
  readonly pgid: number;
  private settled: OwnedSettle | null = null;
  private readonly settledPromise: Promise<OwnedSettle>;
  /** Test seams: the ONLY places that touch the kernel for group signals.
   * Defaults target the exact negative PGID exclusively — never a positive
   * leader PID. Tests may inject failures via these seams without patching
   * the global process.kill (which contaminated unrelated tests). */
  groupSignal: (pgid: number, sig: "SIGINT" | "SIGTERM" | "SIGKILL") => void = (pgid, sig) => {
    process.kill(-pgid, sig);
  };
  groupProbe: (pgid: number) => boolean = (pgid) => {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ESRCH") return false;
      throw error; // the caller disambiguates EPERM via exact PGID membership
    }
  };
  constructor(args: string[], opts: OwnedSpawnOptions = {}) {
    this.child = spawn(opts.execPath ?? process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group: pgid === pid
      env: opts.env,
    });
    this.pgid = this.child.pid ?? 0;
    this.settledPromise = new Promise<OwnedSettle>((resolve) => {
      this.child.once("exit", (code, signal) => {
        if (!this.settled) {
          this.settled = { code, signal };
          resolve(this.settled);
        }
      });
      // Spawn failures (ENOENT etc.) emit "error" and may never "exit" —
      // the ownership contract must settle on both.
      this.child.once("error", (error) => {
        if (!this.settled) {
          this.settled = { code: null, signal: null, error };
          resolve(this.settled);
        }
      });
    });
  }

  get exited(): boolean {
    return this.settled !== null;
  }

  get settle(): OwnedSettle | null {
    return this.settled;
  }

  onceSettled(): Promise<OwnedSettle> {
    return this.settledPromise;
  }

  /**
   * SCENARIO-ONLY delivery to the leader process (the deliberate signal a
   * test sends to exercise the registry handler). NEVER a cleanup path —
   * all cleanup goes through terminate()'s exact negative PGID.
   */
  signal(sig: NodeJS.Signals): void {
    if (this.pgid !== 0) this.child.kill(sig);
  }

  /**
   * Exact group existence probe: kill(-pgid, 0).
   * - true  -> the group still has members.
   * - false -> CONFIRMED disappearance (ESRCH).
   * - EPERM -> macOS returns EPERM for a group whose members are ALL gone
   *   (leader reaped) instead of ESRCH; the ambiguity is resolved
   *   DEFINITIVELY by structured ps membership for the exact owned PGID:
   *   zero rows means the group is gone, any row means it lives. No
   *   positive PID is ever signaled for this.
   * - anything else -> genuine ambiguity: throws visibly.
   */
  private probeGroup(probe: (pgid: number) => boolean): boolean {
    if (this.pgid === 0) return false;
    try {
      return probe(this.pgid);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ESRCH") return false; // confirmed disappearance
      if (code === "EPERM") {
        // macOS refuses probes on groups whose members are all gone/corpses;
        // exact membership decides without ever probing or signaling a PID.
        const members = psRows().filter((row) => row.pgid === this.pgid);
        return members.length > 0;
      }
      throw new Error(
        `owned_render_child_group_probe_ambiguous:pgid=${this.pgid} code=${code ?? String(error)}`,
      );
    }
  }

  groupAlive(): boolean {
    return this.probeGroup(this.groupProbe);
  }

  /**
   * Cleanup signals target ONLY the exact negative owned PGID. ESRCH means
   * the group is already gone (acceptable); EPERM — including the natural
   * macOS post-leader-reap refusal — is DISAMBIGUATED by structured ps
   * membership for the exact owned PGID: zero members means the group is
   * gone (acceptable); live members means the refusal is recorded and the
   * caller keeps observing (transient members such as an orphaned ffmpeg
   * may self-terminate). No positive PID is ever signaled. A refusal that
   * persists to the deadline surfaces through terminate()'s aggregate.
   */
  private signalGroup(
    sig: "SIGTERM" | "SIGKILL",
    signalImpl: (pgid: number, sig: "SIGTERM" | "SIGKILL") => void = this.groupSignal,
  ): boolean {
    if (this.pgid === 0) return false;
    const members = psRows().filter((row) => row.pgid === this.pgid);
    if (members.length === 0) return false; // membership already empty — nothing to signal
    if (!members.some(isLiveMember)) return false; // only corpses remain — observe, never signal
    if (members.some((row) => /^\(.*\)$/.test(row.command))) {
      // macOS can briefly hide argv while a freshly spawned node is in exec.
      // Defer the exact group signal until a later observation; treating this
      // transient EPERM as a cleanup failure would make immediate teardown
      // nondeterministic.
      return false;
    }
    try {
      signalImpl(this.pgid, sig); // NEGATIVE PGID — the exact owned group
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      const detail = `sig=${sig} code=${code ?? String(error)} members=${JSON.stringify(members)}`;
      if (code === "ESRCH") return true; // group vanished between membership and signal
      // ANY refusal with live members is a genuine, visible failure. It is
      // scoped to this terminate() call so a later real cleanup retry can
      // succeed after a test seam or transient kernel failure is removed.
      throw new Error(`owned_render_child_group_signal_refused:${detail}`);
    }
  }

  private closeStdio(): void {
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }

  /**
   * Terminate the exact owned process group and wait for BOTH the leader
   * settling AND the group's disappearance. Escalates SIGTERM -> SIGKILL on
   * the group. Idempotent; safe on the happy path and from finally on any
   * failure path. Throws if the leader or the group survives — never
   * abandons a fixture process.
   */
  async terminate(opts: OwnedTerminateOptions = {}): Promise<void> {
    const escalateAfterMs = opts.escalateAfterMs ?? 1_500;
    const killDeadlineMs = opts.killDeadlineMs ?? 20_000;
    const signalImpl = opts.groupSignalImpl ?? this.groupSignal;
    const probeImpl = opts.groupProbeImpl ?? this.groupProbe;
    const start = Date.now();
    const signalFailures: unknown[] = [];
    let observationFailure: unknown;
    const attemptSignal = (sig: "SIGTERM" | "SIGKILL"): boolean => {
      try {
        return this.signalGroup(sig, signalImpl);
      } catch (error) {
        signalFailures.push(error);
        return true; // the attempt was made; do not busy-retry a refusal
      }
    };
    const groupIsGone = (): boolean => {
      try {
        return !this.probeGroup(probeImpl);
      } catch (error) {
        observationFailure ??= error;
        return false;
      }
    };

    // A group signal that fails is retained as an operation failure, while
    // the exact group is still observed and escalated. There is never a
    // positive-PID fallback.
    let termAttempted = attemptSignal("SIGTERM");
    let killAttempted = false;
    let gone = groupIsGone();
    while (!(this.exited && gone) && Date.now() - start < killDeadlineMs) {
      if (!termAttempted) termAttempted = attemptSignal("SIGTERM");
      if (!killAttempted && Date.now() - start >= escalateAfterMs) {
        killAttempted = attemptSignal("SIGKILL");
      }
      await Promise.race([this.settledPromise, sleep(25)]);
      gone = groupIsGone();
    }
    this.closeStdio();

    const failures = [...signalFailures, ...(observationFailure === undefined ? [] : [observationFailure])];
    if (failures.length > 0) {
      throw new Error(
        `owned_render_child_cleanup_failed:pgid=${this.pgid}`
          + ` failures=[${failures.map((failure) => String(failure)).join(" | ")}]`,
      );
    }
    // Both remaining conditions are mandatory: the leader settled AND the
    // exact group is confirmed gone (ESRCH or refusal-free membership
    // emptiness). Leader exit alone is not cleanup.
    if (!this.exited || !gone) {
      throw new Error(
        `owned_render_child_group_unkillable:pgid=${this.pgid} leaderExited=${String(this.exited)}`,
      );
    }
  }
}

/** A named teardown step failure, aggregated — never swallowed. */
export interface TeardownFailure {
  name: string;
  error: unknown;
}

export class TeardownError extends Error {
  readonly failures: TeardownFailure[];

  constructor(failures: TeardownFailure[]) {
    super(
      `teardown_failures:${failures.length}`
        + ` [${failures.map((failure) => `${failure.name}: ${String(failure.error)}`).join(" | ")}]`,
    );
    this.name = "TeardownError";
    this.failures = failures;
  }
}

/**
 * Owner-scoped teardown: register every task-owned cleanup step (group
 * termination, private root removal, decoy teardown, partial output and
 * metadata removal, registry unregistration) in the order it must run;
 * run() attempts ALL of them, aggregates every failure, and throws the
 * aggregate after the last step — a failing step never skips a later one
 * and no failure is swallowed.
 */
export class TeardownScope {
  private readonly steps: Array<{ name: string; run: () => void | Promise<void> }> = [];

  add(name: string, run: () => void | Promise<void>): void {
    this.steps.push({ name, run });
  }

  async run(): Promise<void> {
    const failures: TeardownFailure[] = [];
    for (const step of this.steps) {
      try {
        await step.run();
      } catch (error) {
        failures.push({ name: step.name, error });
      }
    }
    if (failures.length > 0) throw new TeardownError(failures);
  }
}

const verifySleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Verify zero survivors with a bounded retry: a group member killed after
 * its parent died becomes a ZOMBIE until the system reaper collects it, so
 * an immediate scan can still see it. A PERSISTENT survivor (real leak)
 * keeps appearing and fails the check once the deadline passes.
 */
export async function expectNoSurvivors(
  fixtureScriptPath: string,
  pgids: number[],
  deadlineMs = 15_000,
): Promise<void> {
  const canonical = path.resolve(fixtureScriptPath);
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const survivors = [
      ...pgids.flatMap((pgid) => fixtureProcessRows(canonical, { pgid })),
      ...pgids.flatMap((pgid) => rowsWithPgid(pgid)),
    ];
    if (survivors.length === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `owned_render_child_survivors:pgids=[${pgids.join(",")}]`
        + ` survivors=${JSON.stringify(survivors)}`,
      );
    }
    await verifySleep(100);
  }
}
