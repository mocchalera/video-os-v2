import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import {
  buildProductOutcomeMetrics,
  computeProductOutcomeMetricsHash,
  type ProductOutcomeMetrics,
} from "../runtime/eval/product-outcome-metrics.js";
import { deriveReviewRoundsMetric } from "../runtime/eval/review-rounds.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import { hashCanonical } from "../runtime/review/social-review-generation.js";
import {
  appendReviewRoundEventInternal,
  sweepReviewRoundTemporaries,
  REVIEW_ROUNDS_DIR,
  appendReviewRoundEvent,
  buildReviewRoundResponseEvent,
  buildReviewRoundSupersededEvent,
  readReviewRoundLedger,
  reviewRoundEventIdentity,
  reviewRoundIdentity,
  reviewRoundResponseHash,
  processLstartOf,
  tryReclaimStaleHealClaim,
  type ReviewRoundAskEvent,
  type ReviewRoundResponseEvent,
  type ReviewRoundSupersededEvent,
} from "../runtime/review/review-rounds-ledger.js";
import {
  dispatchReviewAsk,
  finalizeReviewReady,
  recordReviewResponse,
  refreshReviewFreshness,
} from "../runtime/review/review-ready-transaction.js";
import {
  createReviewRoundProject,
  runReviewRound,
  sha,
  type RoundProject,
  type RoundResult,
} from "./helpers/review-round-project.js";

const tempDirs: string[] = [];
const realCreateReviewRoundProject = createReviewRoundProject;
function trackedProject(options?: { projectId?: string }): RoundProject {
  const project = realCreateReviewRoundProject(options);
  tempDirs.push(project.root);
  return project;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fakePythonBinary(
  outputs: Record<string, string> | string,
  options: { exitCode?: number; stderr?: string; signal?: string; sleepSeconds?: number } = {},
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-round-fake-python-"));
  tempDirs.push(root);
  const binary = path.join(root, "python3");
  const outputFor = (value: string): string => value.replaceAll("'", "'\"'\"'");
  const cases = typeof outputs === "string"
    ? `printf '%s\\n' '${outputFor(outputs)}'`
    : Object.entries(outputs).map(([action, output]) => `case "$3" in *${action}*) printf '%s\\n' '${outputFor(output)}' ;; esac`).join("\n");
  const signal = options.signal ? `kill -${options.signal} $$` : "";
  const stderr = options.stderr === undefined ? "" : `printf '%s' '${outputFor(options.stderr)}' >&2`;
  const sleep = options.sleepSeconds === undefined ? "" : `exec /bin/sleep ${options.sleepSeconds}`;
  fs.writeFileSync(binary, `#!/bin/sh\ncat >/dev/null\n${sleep}\n${cases}\n${stderr}\n${signal}\nexit ${options.exitCode ?? 0}\n`);
  fs.chmodSync(binary, 0o755);
  return root;
}

function withPythonPath<T>(binaryRoot: string, fn: () => T): T {
  const previousPath = process.env.PATH;
  process.env.PATH = `${binaryRoot}${path.delimiter}${previousPath ?? ""}`;
  try {
    return fn();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
}

type FakePsMode = "error" | "hang" | "malformed" | "stderr" | "empty" | "oversize" | "nonzero" | "signal" | "valid"
  | "internal-newline" | "cr" | "tab" | "nbsp" | "leading" | "trailing" | "extra-line"
  | "five-spaces" | "invalid-weekday" | "invalid-month" | "impossible-date" | "mismatched-weekday" | "valid-single-day";

function fakePsBinary(mode: FakePsMode): { root: string; calls: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-round-fake-ps-"));
  tempDirs.push(root);
  const binary = path.join(root, "ps");
  const calls = `${binary}.calls`;
  if (mode === "error") {
    fs.writeFileSync(binary, "#!/bin/sh\nexit 127\n");
    fs.chmodSync(binary, 0o755);
    return { root, calls };
  }
  const valid = "Fri Dec 31 23:59:59 1999";
  const body = mode === "hang"
    ? "exec /bin/sleep 30"
    : mode === "malformed"
      ? "printf '%s\\n' 'not-a-process-start'"
      : mode === "internal-newline"
        ? "printf 'Wed\\nDec 31 23:59:59 1999\\n'"
        : mode === "cr"
          ? "printf 'Wed Dec 31 23:59:59 1999\\r\\n'"
          : mode === "tab"
            ? "printf 'Wed\\tDec 31 23:59:59 1999\\n'"
            : mode === "nbsp"
              ? "printf 'Wed\\302\\240Dec 31 23:59:59 1999\\n'"
              : mode === "leading"
                ? "printf '%s\\n' ' Wed Dec 31 23:59:59 1999'"
                : mode === "trailing"
                  ? "printf '%s\\n' 'Wed Dec 31 23:59:59 1999 '"
              : mode === "extra-line"
                    ? "printf '%s\\n' 'Wed Dec 31 23:59:59 1999'; printf '%s\\n' 'extra'"
                    : mode === "five-spaces"
                      ? "printf '%s\\n' 'Wed     Dec 31 23:59:59 1999'"
                      : mode === "invalid-weekday"
                        ? "printf '%s\\n' 'Xyz Dec 31 23:59:59 1999'"
                        : mode === "invalid-month"
                          ? "printf '%s\\n' 'Fri Xxx 31 23:59:59 1999'"
                          : mode === "impossible-date"
                            ? "printf '%s\\n' 'Fri Feb 29 23:59:59 2023'"
                            : mode === "mismatched-weekday"
                              ? "printf '%s\\n' 'Wed Dec 31 23:59:59 1999'"
                              : mode === "valid-single-day"
                                ? "printf '%s\\n' 'Tue Aug  1 00:00:00 2023'"
      : mode === "stderr"
        ? `printf '%s\\n' '${valid}'\nprintf '%s\\n' 'unexpected stderr' >&2`
        : mode === "empty"
          ? ":"
          : mode === "oversize"
            ? "yes x | head -c 4097"
            : mode === "nonzero"
              ? `printf '%s\\n' '${valid}'\nexit 7`
              : mode === "signal"
                ? "kill -TERM $$"
                : `printf x >> \"$0.calls\"\nprintf '%s\\n' '${valid}'`;
  fs.writeFileSync(binary, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(binary, 0o755);
  return { root, calls };
}

function runFreshProcess(modulePath: string, code: string, binaryRoot: string, includeSystemPath = true): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code], {
    cwd: process.cwd(),
    env: { ...process.env, PATH: `${binaryRoot}${includeSystemPath ? `${path.delimiter}${process.env.PATH ?? ""}` : ""}` },
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    timeout: 5_000,
  });
}

function ledgerDir(root: string): string {
  return path.join(root, REVIEW_ROUNDS_DIR);
}

function readMetric(root: string): ProductOutcomeMetrics["metrics"]["review_rounds"] {
  return buildReport(root).metrics.review_rounds;
}

function buildReport(root: string): ProductOutcomeMetrics {
  return buildProductOutcomeMetrics(root, "2026-08-29T12:00:00.000Z");
}

async function twoRoundProject(decisions: Array<"approve" | "request_changes" | "free_text"> = ["request_changes", "approve"]) {
  const project = trackedProject();
  const rounds: RoundResult[] = [];
  for (let index = 0; index < decisions.length; index += 1) {
    rounds.push(await runReviewRound(project, { decision: decisions[index] }));
  }
  return { project, rounds };
}

describe("review_rounds durable history contract (Issue #29 Phase 6)", () => {
  it("counts two genuine completed rounds with full evidence and a schema-valid report", async () => {
    const { project, rounds } = await twoRoundProject();
    expect(rounds).toHaveLength(2);
    const report = buildReport(project.root);
    const metric = report.metrics.review_rounds;
    expect(metric.status).toBe("measured");
    expect(metric.value).toMatchObject({
      completeness: "complete",
      history: {
        ledger_path: REVIEW_ROUNDS_DIR,
        event_count: 4,
        unanswered_rounds: 0,
        superseded_rounds: 0,
        scope: "complete",
      },
    });
    const value = metric.value as unknown as { rounds: Array<Record<string, unknown>> };
    expect(value.rounds).toHaveLength(2);
    expect(value.rounds.map((round) => round.round_index)).toEqual([1, 2]);
    expect(value.rounds.map((round) => round.round_identity)).toEqual([
      rounds[0]!.roundIdentity,
      rounds[1]!.roundIdentity,
    ]);
    for (const round of value.rounds) {
      expect(round.timeline).toMatchObject({ path: "05_timeline/timeline.json", hash: expect.any(String), version: expect.any(String) });
      expect((round.ask as Record<string, unknown>).ask_id).toEqual(expect.any(String));
      expect((round.response as Record<string, unknown>).decision).toEqual(expect.any(String));
    }
    expect(validateAgainstSchema(report, "product-outcome-metrics.schema.json")).toEqual({ valid: true, errors: [] });
    // Provenance includes every ledger event plus generation, QA, render,
    // audio, and attestation receipts of the counted rounds.
    const ledger = readReviewRoundLedger(project.root);
    const provenancePaths = report.provenance.inputs.map((input) => input.path);
    for (const event of ledger.chain) {
      expect(provenancePaths).toContain(`06_review/review-rounds/${event.file}`);
    }
    expect(provenancePaths).toContain(`09_output/social-review/generations/${rounds[0]!.generationId.slice(7)}/review-ready-receipt.json`);
    expect(provenancePaths).toContain(`09_output/social-review/generations/${rounds[0]!.generationId.slice(7)}/review-qa-receipt.json`);
    expect(provenancePaths).toContain(`09_output/social-review/generations/${rounds[0]!.generationId.slice(7)}/social-review-report.json`);
    expect(provenancePaths).toContain(`09_output/social-review/generations/${rounds[0]!.generationId.slice(7)}/audio-mastering-receipt.json`);
    expect(provenancePaths).toContain(`09_output/social-review/generations/${rounds[0]!.generationId.slice(7)}/source-input-attestation.json`);

    const responseRounds = value.rounds as Array<{
      response: { event_identity: string; artifact: { path: string; sha256: string } };
    }>;
    for (const entry of ledger.chain.filter((candidate) => candidate.event.version === "review-round-response/v1")) {
      const responseEvent = entry.event as ReviewRoundResponseEvent;
      const artifact = responseEvent.artifact;
      const responseRound = responseRounds.find((candidate) => candidate.response.event_identity === entry.identity)!;
      expect(responseRound.response.artifact).toEqual(artifact);
      expect(artifact.path).toMatch(/^06_review\/review-round-responses\/[0-9a-f]{64}\.json$/);
      expect(artifact.sha256).toBe(sha(fs.readFileSync(path.join(project.root, artifact.path))));
      expect(report.provenance.inputs).toContainEqual(expect.objectContaining({ path: artifact.path, hash: artifact.sha256 }));
    }
  });

  it("keeps the response artifact hash captured before a hostile post-inspection replacement", async () => {
    const project = trackedProject();
    const round = await runReviewRound(project, { decision: "approve", responseText: "captured" });
    const ledger = readReviewRoundLedger(project.root);
    const responseEntry = ledger.chain.find((candidate) => candidate.event.version === "review-round-response/v1")!;
    const responseEvent = responseEntry.event as ReviewRoundResponseEvent;
    const artifactPath = path.join(project.root, responseEvent.artifact.path);
    const originalBytes = fs.readFileSync(artifactPath);
    const capturedHash = sha(originalBytes);
    const originalDocument = JSON.parse(originalBytes.toString("utf8")) as Record<string, unknown>;
    const replacementBytes = Buffer.from(`${JSON.stringify({ ...originalDocument, text: "replacement-generation" }, null, 2)}\n`);

    const derivation = deriveReviewRoundsMetric({
      projectDir: project.root,
      projectId: project.projectId,
      timeline: { path: "05_timeline/timeline.json", version: round.timelineVersion, hash: round.timelineSha256 },
      askPointer: JSON.parse(fs.readFileSync(path.join(project.root, "06_review/review-ask.json"), "utf8")),
      responsePointer: JSON.parse(fs.readFileSync(path.join(project.root, "06_review/review-response.json"), "utf8")),
      revisionDiffCandidates: [],
      onResponseArtifactCaptured: (artifact) => {
        if (artifact.path === responseEvent.artifact.path) fs.writeFileSync(artifactPath, replacementBytes);
      },
    });

    expect(derivation.metric.status).toBe("unavailable");
    expect(derivation.provenanceArtifacts).toContainEqual(expect.objectContaining({
      relativePath: responseEvent.artifact.path,
      sha256: capturedHash,
    }));
    expect(capturedHash).not.toBe(sha(replacementBytes));
  });

  it.each(["delete", "rename"] as const)("keeps captured response provenance after an inspection-time %s", async (disposition) => {
    const project = trackedProject();
    await runReviewRound(project, { decision: "approve", responseText: `captured-${disposition}` });
    const ledger = readReviewRoundLedger(project.root);
    const responseEntry = ledger.chain.find((candidate) => candidate.event.version === "review-round-response/v1")!;
    const responseEvent = responseEntry.event as ReviewRoundResponseEvent;
    const artifactPath = path.join(project.root, responseEvent.artifact.path);
    const originalBytes = fs.readFileSync(artifactPath);
    const capturedHash = sha(originalBytes);
    const retainedPath = `${artifactPath}.retained`;

    const report = buildProductOutcomeMetrics(project.root, "2026-08-29T12:00:00.000Z", {
      onResponseArtifactCaptured: (artifact) => {
        if (artifact.path !== responseEvent.artifact.path) return;
        expect(artifact.sha256).toBe(capturedHash);
        if (disposition === "delete") fs.unlinkSync(artifactPath);
        else fs.renameSync(artifactPath, retainedPath);
      },
    });

    expect(report.metrics.review_rounds.status).toBe("unavailable");
    expect(report.provenance.inputs).toContainEqual({
      path: responseEvent.artifact.path,
      hash: capturedHash,
      required: false,
    });
    expect(fs.existsSync(artifactPath)).toBe(false);
    if (disposition === "rename") expect(fs.readFileSync(retainedPath)).toEqual(originalBytes);
  });

  it("writes an 850k response artifact through stdin and preserves final byte provenance", async () => {
    const project = trackedProject();
    const responseText = "x".repeat(850_000);
    await runReviewRound(project, { decision: "approve", responseText });

    const ledger = readReviewRoundLedger(project.root);
    const responseEntry = ledger.chain.find((candidate) => candidate.event.version === "review-round-response/v1")!;
    const responseEvent = responseEntry.event as ReviewRoundResponseEvent;
    const artifactPath = path.join(project.root, responseEvent.artifact.path);
    const artifactBytes = fs.readFileSync(artifactPath);
    const capturedHash = sha(artifactBytes);

    expect(responseEvent.text).toBe(responseText);
    expect(responseEvent.artifact.path).toMatch(/^06_review\/review-round-responses\/[0-9a-f]{64}\.json$/);
    expect(responseEvent.artifact.sha256).toBe(capturedHash);
    expect(buildReport(project.root).provenance.inputs).toContainEqual(expect.objectContaining({
      path: responseEvent.artifact.path,
      hash: capturedHash,
    }));
  });

  it("counts three genuine completed rounds and keeps round identities chain-derived", async () => {
    const { project, rounds } = await twoRoundProject(["request_changes", "request_changes", "approve"]);
    expect(rounds).toHaveLength(3);
    const metric = readMetric(project.root);
    expect(metric.status).toBe("measured");
    expect(metric.value).toMatchObject({ history: { event_count: 6 } });
    const value = metric.value as unknown as { rounds: Array<{ round_identity: string; round_index: number }> };
    expect(value.rounds).toHaveLength(3);
    expect(value.rounds.map((round) => round.round_identity)).toEqual(rounds.map((round) => round.roundIdentity));
  });

  it("is byte-stable when equivalent history is written in a different file order", async () => {
    const { project } = await twoRoundProject();
    const before = buildReport(project.root);
    const hashBefore = computeProductOutcomeMetricsHash(before);
    // Recreate the immutable ledger writing the identical event files in
    // reverse order; the reader must be order-independent.
    const files = fs.readdirSync(ledgerDir(project.root)).sort();
    const snapshots = files.map((name) => ({
      name,
      bytes: fs.readFileSync(path.join(ledgerDir(project.root), name)),
    }));
    fs.rmSync(ledgerDir(project.root), { recursive: true });
    fs.mkdirSync(ledgerDir(project.root), { recursive: true });
    for (const snapshot of [...snapshots].reverse()) {
      fs.writeFileSync(path.join(ledgerDir(project.root), snapshot.name), snapshot.bytes);
    }
    const after = buildReport(project.root);
    expect(computeProductOutcomeMetricsHash(after)).toBe(hashBefore);
  });

  it("treats repeated dispatch and duplicate human responses as one round", async () => {
    const project = trackedProject();
    const first = await runReviewRound(project);
    // Re-dispatch the same Ask: idempotent, no new history event.
    const askState = JSON.parse(fs.readFileSync(path.join(project.root, "06_review/review-ask.json"), "utf8")) as { status: string };
    expect(askState.status).toBe("responded");
    const reDispatched = await dispatchReviewAsk(project.root, project.adapter);
    expect(reDispatched.ask_id).toBe(first.askId);
    // Re-record the same response: heals nothing, adds no duplicate event.
    const again = await recordReviewResponse(project.root, {
      review_identity: first.reviewIdentity,
      generation_id: first.generationId,
      video_sha256: first.outputSha256,
      timeline_sha256: first.timelineSha256,
      ask_id: first.askId,
      decision: first.decision as "approve" | "request_changes" | "free_text",
      text: null,
    });
    expect(again.decision).toBe(first.decision);
    // A conflicting decision for the same ask fails closed.
    await expect(recordReviewResponse(project.root, {
      review_identity: first.reviewIdentity,
      generation_id: first.generationId,
      video_sha256: first.outputSha256,
      timeline_sha256: first.timelineSha256,
      ask_id: first.askId,
      decision: first.decision === "approve" ? "request_changes" : "approve",
      text: null,
    })).rejects.toThrow(/conflicts/i);
    const metric = readMetric(project.root);
    expect(metric.value).toMatchObject({ history: { event_count: 2 } });
    expect((metric.value as unknown as { rounds: unknown[] }).rounds).toHaveLength(1);
  });

  it("keeps counting completed rounds when the compatibility Ask pointer is overwritten by a new generation", async () => {
    const project = trackedProject();
    await runReviewRound(project, { decision: "request_changes" });
    // A new generation finalizes and dispatches (overwriting the Ask pointer), but no response arrives.
    await runReviewRound(project, { decision: "request_changes", skipResponse: true });
    const askPointer = JSON.parse(fs.readFileSync(path.join(project.root, "06_review/review-ask.json"), "utf8")) as { round_event_sha256?: string };
    expect(askPointer.round_event_sha256).toEqual(expect.any(String));
    const metric = readMetric(project.root);
    expect(metric.status).toBe("measured");
    expect(metric.value).toMatchObject({ history: { unanswered_rounds: 1 } });
    // Round 1 is historical (its generation is no longer latest) and still counts.
    const value = metric.value as unknown as { rounds: Array<{ round_index: number }> };
    expect(value.rounds).toHaveLength(1);
    expect(value.rounds.map((round) => round.round_index)).toEqual([1]);
  });

  it("measures zero verified rounds from a valid complete scope with an unanswered Ask", async () => {
    const project = trackedProject();
    await runReviewRound(project, { skipResponse: true });
    const metric = readMetric(project.root);
    expect(metric.status).toBe("measured");
    expect(metric.value).toMatchObject({
      rounds: [],
      completeness: "complete",
      history: { unanswered_rounds: 1, scope: "complete" },
    });
  });

  it("is unavailable, never guessed, for absent, empty, or malformed history", async () => {
    const absent = trackedProject();
    expect(readMetric(absent.root).status).toBe("unavailable");
    expect(readMetric(absent.root).value).toBeNull();

    const empty = trackedProject();
    fs.mkdirSync(ledgerDir(empty.root), { recursive: true });
    const emptyMetric = readMetric(empty.root);
    expect(emptyMetric.status).toBe("unavailable");
    expect(emptyMetric.limitations.join(" ")).toMatch(/scope is empty/);

    const malformed = trackedProject();
    await runReviewRound(malformed);
    fs.writeFileSync(path.join(ledgerDir(malformed.root), "garbage.json"), "{ nope");
    const malformedMetric = readMetric(malformed.root);
    expect(malformedMetric.status).toBe("unavailable");
    expect(malformedMetric.limitations.join(" ")).toMatch(/malformed or conflicting/);
  });

  it("fails closed when one ask_id, generation, review identity, payload, or response decision participates in two completed rounds", async () => {
    const project = trackedProject();
    await runReviewRound(project);
    const ledger = readReviewRoundLedger(project.root);
    const askEvent = ledger.chain.find((entry) => entry.event.version === "review-round-ask/v1")!;
    const responseEvent = ledger.chain.find((entry) => entry.event.version === "review-round-response/v1")!;
    // A second completed round reusing the same ask_id (fabricated generation)
    // creates a ledger-wide semantic conflict.
    const forgedAsk = {
      ...(askEvent.event as ReviewRoundAskEvent),
      generation_id: sha("forged-second-generation"),
      timeline: { ...(askEvent.event as ReviewRoundAskEvent).timeline, hash: sha("forged-second-timeline") },
      review_ready_receipt: { path: `09_output/social-review/generations/${sha("forged-second-generation").slice(7)}/review-ready-receipt.json`, sha256: sha("forged-receipt") },
      qa_receipt: { path: "06_review/review-qa-receipt.json", sha256: sha("forged-qa"), status: "pass" },
      output: { path: `09_output/social-review/generations/${sha("forged-second-generation").slice(7)}/review.mp4`, sha256: sha("forged-video") },
      predecessor: responseEvent.identity,
    };
    const forgedResponse = {
      ...(responseEvent.event as ReviewRoundResponseEvent),
      ask_event: reviewRoundEventIdentity(forgedAsk),
      predecessor: reviewRoundEventIdentity(forgedAsk),
      // The forged pair reuses the SAME durable response artifact binding so
      // the ask_id uniqueness conflict is the failure being exercised.
      artifact: (responseEvent.event as ReviewRoundResponseEvent).artifact,
      text: (responseEvent.event as ReviewRoundResponseEvent).text,
      review_identity: (responseEvent.event as ReviewRoundAskEvent).review_identity,
    };
    appendReviewRoundEvent(project.root, forgedAsk);
    appendReviewRoundEvent(project.root, forgedResponse);
    const metric = readMetric(project.root);
    expect(metric.status).toBe("unavailable");
    expect(metric.limitations.join(" ")).toMatch(/malformed or conflicting|response artifact namespace/);
    expect(flagged(project.root, "review_rounds_history_conflict")).toBe(true);
  });

  it("fails closed when a pointer-bound durable response artifact contradicts its event decision or hash", async () => {
    const project = trackedProject();
    await runReviewRound(project, { decision: "approve", responseText: "ship it" });
    const responsePath = path.join(project.root, "06_review/review-response.json");
    const response = JSON.parse(fs.readFileSync(responsePath, "utf8")) as { decision: string; text: string | null; round_event_sha256: string };
    response.decision = "request_changes";
    fs.writeFileSync(responsePath, `${JSON.stringify(response, null, 2)}\n`);
    const metric = readMetric(project.root);
    expect(metric.status).toBe("unavailable");
    expect(metric.limitations.join(" ")).toMatch(/malformed or conflicting/);
  });

  it("fails closed when a superseded event does not bind the exact project, generation, review identity, and Ask it supersedes", async () => {
    const project = trackedProject();
    await runReviewRound(project, { skipResponse: true });
    const captionPlanPath = path.join(project.root, project.paths.captionPlan);
    const plan = JSON.parse(fs.readFileSync(captionPlanPath, "utf8")) as { cues: Array<{ text: string }> };
    plan.cues[0]!.text = "changed after dispatch";
    fs.writeFileSync(captionPlanPath, JSON.stringify(plan));
    refreshReviewFreshness(project.root);
    const ledger = readReviewRoundLedger(project.root);
    const superseded = ledger.chain.find((entry) => entry.event.version === "review-round-superseded/v1")!;
    const forged = { ...(superseded.event as ReviewRoundSupersededEvent), review_identity: sha("forged-review-identity") };
    fs.writeFileSync(path.join(ledgerDir(project.root), superseded.file), `${JSON.stringify(forged, null, 2)}\n`);
    // Identity/filename mismatch alone already fails closed.
    const metric = readMetric(project.root);
    expect(metric.status).toBe("unavailable");
  });

  it("fails closed when a durable response artifact is missing, tampered, copied, or contradicts its event", async () => {
    const base = trackedProject();
    const round = await runReviewRound(base, { decision: "request_changes", responseText: "tighten intro" });
    const ledger = readReviewRoundLedger(base.root);
    const responseEvent = ledger.chain.find((entry) => entry.event.version === "review-round-response/v1")!;
    const artifactPath = path.join(base.root, (responseEvent.event as { artifact: { path: string } }).artifact.path);

    const missing = trackedProject();
    await runReviewRound(missing, { decision: "request_changes", responseText: "tighten intro" });
    const missingLedger = readReviewRoundLedger(missing.root);
    const missingEvent = missingLedger.chain.find((entry) => entry.event.version === "review-round-response/v1")!;
    fs.rmSync(path.join(missing.root, (missingEvent.event as { artifact: { path: string } }).artifact.path));
    const missingMetric = readMetric(missing.root);
    expect(missingMetric.status).toBe("unavailable");
    expect(missingMetric.limitations.join(" ")).toMatch(/response artifact namespace/);
    expect(flagMessage(missing.root, "missing from the namespace")).toBe(true);

    const tampered = trackedProject();
    await runReviewRound(tampered, { decision: "request_changes", responseText: "tighten intro" });
    const tamperedLedger = readReviewRoundLedger(tampered.root);
    const tamperedEvent = tamperedLedger.chain.find((entry) => entry.event.version === "review-round-response/v1")!;
    const tamperTarget = path.join(tampered.root, (tamperedEvent.event as { artifact: { path: string } }).artifact.path);
    const artifactBody = JSON.parse(fs.readFileSync(tamperTarget, "utf8")) as Record<string, unknown>;
    artifactBody.decision = "approve";
    fs.writeFileSync(tamperTarget, `${JSON.stringify(artifactBody, null, 2)}\n`);
    const tamperedMetric = readMetric(tampered.root);
    expect(tamperedMetric.status).toBe("unavailable");
    expect(tamperedMetric.limitations.join(" ")).toMatch(/response artifact namespace|failed canonical verification/);

    const copied = trackedProject();
    await runReviewRound(copied, { decision: "request_changes", responseText: "tighten intro" });
    const copiedLedger = readReviewRoundLedger(copied.root);
    const copiedEvent = copiedLedger.chain.find((entry) => entry.event.version === "review-round-response/v1")!;
    const originalArtifact = path.join(copied.root, (copiedEvent.event as { artifact: { path: string } }).artifact.path);
    fs.copyFileSync(originalArtifact, path.join(copied.root, "06_review/review-round-responses/deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef.json"));
    const copiedMetric = readMetric(copied.root);
    expect(copiedMetric.status).toBe("unavailable");

    // The genuine artifact binds the exact decision, text, output, and round.
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as { decision: string; text: string; generation_id: string; ask_id: string };
    expect(artifact.decision).toBe("request_changes");
    expect(artifact.text).toBe("tighten intro");
    expect(artifact.generation_id).toBe(round.generationId);
    expect(artifact.ask_id).toBe(round.askId);
    const roundIdentity = round.roundIdentity;
    expect(roundIdentity).toEqual(expect.any(String));
  });

  it("fails closed when an unanswered Ask duplicates ask_id, generation, review identity, or payload", async () => {
    const project = trackedProject();
    await runReviewRound(project, { skipResponse: true });
    const ledger = readReviewRoundLedger(project.root);
    const askEvent = ledger.chain.find((entry) => entry.event.version === "review-round-ask/v1")!;
    // A duplicate unanswered Ask reusing the same ask_id (fabricated later
    // generation) is a ledger-wide conflict even though nothing completed.
    const duplicate = {
      ...(askEvent.event as ReviewRoundAskEvent),
      generation_id: sha("duplicate-generation"),
      timeline: { ...(askEvent.event as ReviewRoundAskEvent).timeline, hash: sha("duplicate-timeline") },
      review_ready_receipt: { path: "09_output/social-review/generations/dup/review-ready-receipt.json", sha256: sha("dup-receipt") },
      qa_receipt: { path: "06_review/qa.json", sha256: sha("dup-qa"), status: "pass" },
      output: { path: "09_output/social-review/generations/dup/review.mp4", sha256: sha("dup-video") },
      predecessor: askEvent.identity,
    };
    appendReviewRoundEvent(project.root, duplicate);
    const metric = readMetric(project.root);
    expect(metric.status).toBe("unavailable");
    expect(metric.limitations.join(" ")).toMatch(/malformed or conflicting/);
  });

  it("fails closed on duplicate supersession or a supersession targeting a completed Ask", async () => {
    // Duplicate supersession: two superseded events for the same Ask.
    const duplicated = trackedProject();
    await runReviewRound(duplicated, { skipResponse: true });
    const captionPlanPath = path.join(duplicated.root, duplicated.paths.captionPlan);
    const plan = JSON.parse(fs.readFileSync(captionPlanPath, "utf8")) as { cues: Array<{ text: string }> };
    plan.cues[0]!.text = "changed after dispatch";
    fs.writeFileSync(captionPlanPath, JSON.stringify(plan));
    refreshReviewFreshness(duplicated.root);
    const ledger = readReviewRoundLedger(duplicated.root);
    const superseded = ledger.chain.find((entry) => entry.event.version === "review-round-superseded/v1")!;
    const duplicateSuperseded = {
      ...(superseded.event as ReviewRoundSupersededEvent),
      reason: "a different reason",
    };
    appendReviewRoundEvent(duplicated.root, duplicateSuperseded);
    expect(readMetric(duplicated.root).status).toBe("unavailable");

    // A supersession targeting a completed Ask is a conflict.
    const completed = trackedProject();
    await runReviewRound(completed);
    const completedLedger = readReviewRoundLedger(completed.root);
    const completedAsk = completedLedger.chain.find((entry) => entry.event.version === "review-round-ask/v1")!;
    const targetingCompleted = buildReviewRoundSupersededEvent({
      project_id: completed.projectId,
      generation_id: (completedAsk.event as { generation_id: string }).generation_id,
      review_identity: (completedAsk.event as { review_identity: string }).review_identity,
      ask_event: completedAsk.identity,
      ask_id: (completedAsk.event as { ask_id: string }).ask_id,
      reason: "forged supersession of a completed round",
      predecessor: completedAsk.identity,
    });
    appendReviewRoundEvent(completed.root, targetingCompleted);
    expect(readMetric(completed.root).status).toBe("unavailable");
  });

  it("aborts finalize when the pending supersession intent cannot heal, preserving evidence", async () => {
    const project = trackedProject();
    await runReviewRound(project, { skipResponse: true });
    // Corrupt the ledger so healing cannot complete.
    const ledgerFiles = fs.readdirSync(ledgerDir(project.root)).sort();
    const firstEvent = JSON.parse(fs.readFileSync(path.join(ledgerDir(project.root), ledgerFiles[0]!), "utf8")) as Record<string, unknown>;
    firstEvent.ask_payload_sha256 = sha("tampered");
    fs.writeFileSync(path.join(ledgerDir(project.root), ledgerFiles[0]!), `${JSON.stringify(firstEvent, null, 2)}\n`);
    await expect(finalizeOnlyGeneration(project)).rejects.toThrow(/malformed/);
    // Evidence preserved: the outstanding Ask pointer still binds the old round.
    const ask = JSON.parse(fs.readFileSync(path.join(project.root, "06_review/review-ask.json"), "utf8")) as { round_event_sha256?: string };
    expect(ask.round_event_sha256).toBe(askEventIdentityOf(project));
  });

  it("supersedes an outstanding unanswered Ask before finalize overwrites it (never Ask(old)->Ask(new) unanswered)", async () => {
    const project = trackedProject();
    await runReviewRound(project, { skipResponse: true });
    const oldAskId = askEventIdentityOf(project);
    finalizeOnlyGeneration(project);
    const ledger = readReviewRoundLedger(project.root);
    expect(ledger.chain.map((entry) => entry.event.version)).toEqual([
      "review-round-ask/v1",
      "review-round-superseded/v1",
    ]);
    const superseded = ledger.chain[1]!.event as { ask_event: string; predecessor: string };
    expect(superseded.ask_event).toBe(oldAskId);
    expect(superseded.predecessor).toBe(oldAskId);
    // The old round is durably superseded, not silently unanswered; the new
    // generation is fresh, so zero completed rounds is a valid measurement.
    const metric = readMetric(project.root);
    expect(metric.status).toBe("measured");
    expect(metric.value).toMatchObject({ rounds: [], history: { superseded_rounds: 1 } });
  });

  it("rejects an external ledger-root symlink as unavailable", async () => {
    const project = trackedProject();
    await runReviewRound(project);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "review-round-ledger-outside-"));
    tempDirs.push(outside);
    fs.rmSync(ledgerDir(project.root), { recursive: true });
    fs.symlinkSync(outside, ledgerDir(project.root));
    const metric = readMetric(project.root);
    expect(metric.status).toBe("unavailable");
    expect(metric.limitations.join(" ")).toMatch(/malformed or conflicting|ledger directory/);
  });

  it("heals 16 concurrent interrupted-response retries idempotently without ENOENT or cross-round supersession", async () => {
    const project = trackedProject();
    const round = await runReviewRound(project);
    // Crash simulation: lose the durable response artifacts and events.
    for (const file of fs.readdirSync(ledgerDir(project.root))) fs.rmSync(path.join(ledgerDir(project.root), file));
    for (const file of fs.readdirSync(path.join(project.root, "06_review/review-round-responses"))) {
      fs.rmSync(path.join(project.root, "06_review/review-round-responses", file));
    }
    // 16 concurrent in-process retries (serialized by the heal lock).
    const attempts = await Promise.all(Array.from({ length: 16 }, () =>
      recordReviewResponse(project.root, {
        review_identity: round.reviewIdentity,
        generation_id: round.generationId,
        video_sha256: round.outputSha256,
        timeline_sha256: round.timelineSha256,
        ask_id: round.askId,
        decision: "request_changes",
        text: null,
      }).then(() => "ok" as const).catch((error: unknown) => `error: ${String(error)}`)));
    expect(attempts.every((result) => result === "ok")).toBe(true);
    const healed = readReviewRoundLedger(project.root);
    expect(healed.chain.map((entry) => entry.event.version)).toEqual(["review-round-ask/v1", "review-round-response/v1"]);
    // Exactly one response artifact exists.
    expect(fs.readdirSync(path.join(project.root, "06_review/review-round-responses")).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    const metric = readMetric(project.root);
    expect((metric.value as unknown as { rounds: unknown[] }).rounds).toHaveLength(1);
  }, 60_000);

  it("yields byte-identical review_rounds metrics for equivalent projects accessed via /var and /private/var aliases", async () => {
    const project = trackedProject();
    await runReviewRound(project, { decision: "request_changes" });
    const realRoot = fs.realpathSync(project.root);
    // The /var -> /private/var alias is macOS-specific. Linux has no paired
    // alias, so the equivalent-root assertion is not applicable there.
    if (process.platform !== "darwin") {
      expect(realRoot.startsWith("/private/var/")).toBe(false);
      return;
    }
    expect(realRoot.startsWith("/private/var/")).toBe(true);
    const aliasRoot = realRoot.replace("/private/var/", "/var/");
    if (aliasRoot === realRoot) return; // platform without the alias
    const viaAlias = buildReport(aliasRoot);
    const viaReal = buildReport(realRoot);
    expect(JSON.stringify(viaAlias.metrics.review_rounds)).toBe(JSON.stringify(viaReal.metrics.review_rounds));
  });

  it("rejects hardlinked ledger events and response artifacts, and hardlinks introduced after a clean measurement", async () => {
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "review-round-hardlink-"));
    tempDirs.push(external);
    const externalEvent = path.join(external, "outside-event.json");
    fs.writeFileSync(externalEvent, "external-bytes");

    const eventHardlink = trackedProject();
    await runReviewRound(eventHardlink);
    const ledgerFiles = fs.readdirSync(ledgerDir(eventHardlink.root)).sort();
    fs.rmSync(path.join(ledgerDir(eventHardlink.root), ledgerFiles[0]!));
    fs.linkSync(externalEvent, path.join(ledgerDir(eventHardlink.root), ledgerFiles[0]!));
    const eventMetric = readMetric(eventHardlink.root);
    expect(eventMetric.status).toBe("unavailable");
    expect(eventMetric.limitations.join(" ")).toMatch(/malformed or conflicting/);
    expect(flagged(eventHardlink.root, "review_rounds_malformed_history")).toBe(true);

    const artifactHardlink = trackedProject();
    await runReviewRound(artifactHardlink);
    const responsesDir = path.join(artifactHardlink.root, "06_review/review-round-responses");
    const artifactFiles = fs.readdirSync(responsesDir).filter((name) => name.endsWith(".json"));
    const artifactTarget = path.join(external, "outside-artifact.json");
    fs.writeFileSync(artifactTarget, "external-artifact-bytes");
    fs.rmSync(path.join(responsesDir, artifactFiles[0]!));
    fs.linkSync(artifactTarget, path.join(responsesDir, artifactFiles[0]!));
    const artifactMetric = readMetric(artifactHardlink.root);
    expect(artifactMetric.status).toBe("unavailable");
    expect(artifactMetric.limitations.join(" ")).toMatch(/response artifact namespace/);
    expect(flagged(artifactHardlink.root, "review_rounds_history_conflict")).toBe(true);
    // The external artifact bytes are unchanged: nothing escaped.
    expect(fs.readFileSync(artifactTarget, "utf8")).toBe("external-artifact-bytes");

    const betweenChecks = trackedProject();
    await runReviewRound(betweenChecks);
    expect(readMetric(betweenChecks.root).status).toBe("measured");
    // Introduce the hardlink after a clean measurement (between checks).
    const betweenLedgerFiles = fs.readdirSync(ledgerDir(betweenChecks.root)).sort();
    fs.rmSync(path.join(ledgerDir(betweenChecks.root), betweenLedgerFiles[0]!));
    fs.linkSync(externalEvent, path.join(ledgerDir(betweenChecks.root), betweenLedgerFiles[0]!));
    expect(readMetric(betweenChecks.root).status).toBe("unavailable");
  });

  it("fails closed when response artifacts are unreferenced, stale, duplicated under another name, or foreign", async () => {
    const base = trackedProject();
    const round = await runReviewRound(base, { decision: "request_changes", responseText: "note" });
    const baseResponsesDir = path.join(base.root, "06_review/review-round-responses");
    const original = JSON.parse(fs.readFileSync(path.join(baseResponsesDir, fs.readdirSync(baseResponsesDir)[0]!), "utf8")) as Record<string, unknown>;
    const writeArtifact = (targetRoot: string, body: Record<string, unknown>): string => {
      const identity = hashCanonical(body);
      const name = `${identity.slice("sha256:".length)}.json`;
      const targetDir = path.join(targetRoot, "06_review/review-round-responses");
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, name), `${JSON.stringify(body, null, 2)}\n`);
      return name;
    };

    // Unreferenced self-consistent artifact (different text -> new identity).
    const unreferenced = trackedProject();
    await runReviewRound(unreferenced, { decision: "request_changes", responseText: "note" });
    const unreferencedBody = { ...original, text: "never referenced" };
    writeArtifact(unreferenced.root, unreferencedBody);
    const unreferencedMetric = readMetric(unreferenced.root);
    expect(unreferencedMetric.status).toBe("unavailable");
    expect(unreferencedMetric.limitations.join(" ")).toMatch(/response artifact namespace/);
    expect(flagMessage(unreferenced.root, "unreferenced response artifact")).toBe(true);

    // Stale prior-generation artifact (bound to an older generation).
    const stale = trackedProject();
    await runReviewRound(stale, { decision: "request_changes" });
    await runReviewRound(stale, { decision: "approve" });
    const staleBody = { ...original, generation_id: sha("prior-generation"), ask_id: "stale-ask" };
    writeArtifact(stale.root, staleBody);
    const staleMetric = readMetric(stale.root);
    expect(staleMetric.status).toBe("unavailable");
    expect(flagMessage(stale.root, "unreferenced response artifact")).toBe(true);

    // Duplicate content under another valid-format filename.
    const duplicated = trackedProject();
    await runReviewRound(duplicated);
    const duplicatedDir = path.join(duplicated.root, "06_review/review-round-responses");
    const content = fs.readFileSync(path.join(duplicatedDir, fs.readdirSync(duplicatedDir)[0]!));
    fs.writeFileSync(path.join(duplicatedDir, "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.json"), content);
    expect(readMetric(duplicated.root).status).toBe("unavailable");

    // Foreign project identity artifact.
    const foreign = trackedProject();
    await runReviewRound(foreign);
    const foreignBody = { ...original, project_id: "other-project", text: "foreign" };
    writeArtifact(foreign.root, foreignBody);
    const foreignMetric = readMetric(foreign.root);
    expect(foreignMetric.status).toBe("unavailable");
    expect(flagMessage(foreign.root, "foreign project identity")).toBe(true);
    void round;
  });

  it("fails closed on unexpected regular and non-regular entries in the response artifact namespace", async () => {
    const regular = trackedProject();
    await runReviewRound(regular);
    fs.writeFileSync(path.join(regular.root, "06_review/review-round-responses/garbage.json"), "{}");
    expect(readMetric(regular.root).status).toBe("unavailable");

    const nonRegular = trackedProject();
    await runReviewRound(nonRegular);
    fs.mkdirSync(path.join(nonRegular.root, "06_review/review-round-responses/nested-dir"));
    expect(readMetric(nonRegular.root).status).toBe("unavailable");
  });

  it("never writes through a symlinked review-round namespace and leaves external bytes unchanged", async () => {
    const escaped = fs.mkdtempSync(path.join(os.tmpdir(), "review-round-escape-target-"));
    tempDirs.push(escaped);
    const { appendReviewRoundEvent, buildReviewRoundAskEvent } = await import("../runtime/review/review-rounds-ledger.js");
    const project = trackedProject();
    // Root namespace symlink: 06_review itself points outside.
    const reviewDir = path.join(project.root, "06_review");
    const outsideReview = path.join(escaped, "outside-review");
    fs.mkdirSync(outsideReview, { recursive: true });
    fs.rmSync(reviewDir, { recursive: true, force: true });
    fs.symlinkSync(outsideReview, reviewDir);
    const event = buildReviewRoundAskEvent({
      project_id: project.projectId,
      generation_id: sha("escape-probe-generation"),
      review_identity: sha("escape-probe-review"),
      review_ready_receipt: { path: "09_output/x.json", sha256: sha("x") },
      qa_receipt: { path: "06_review/qa.json", sha256: sha("qa"), status: "pass" },
      output: { path: "09_output/y.mp4", sha256: sha("y") },
      timeline: { path: "05_timeline/timeline.json", version: "2", hash: sha("t") },
      ask_id: "escape-probe-ask",
      ask_payload_sha256: sha("payload"),
      predecessor: null,
    });
    expect(() => appendReviewRoundEvent(project.root, event)).toThrow(/symlink|escapes the project/);
    expect(fs.readdirSync(outsideReview)).toEqual([]);
    // Nested namespace symlink: review-rounds points outside while 06_review is real.
    fs.rmSync(reviewDir);
    fs.mkdirSync(reviewDir, { recursive: true });
    const outsideRounds = path.join(escaped, "outside-rounds");
    fs.mkdirSync(outsideRounds, { recursive: true });
    fs.symlinkSync(outsideRounds, path.join(reviewDir, "review-rounds"));
    expect(() => appendReviewRoundEvent(project.root, event)).toThrow(/symlink|escapes the project/);
    expect(fs.readdirSync(outsideRounds)).toEqual([]);
  });

  it("refuses to reap a replaced heal claim and reclaims PID-reuse claims only with lstart proof", async () => {
    const ledgerModule = await import("../runtime/review/review-rounds-ledger.js");
    const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-round-lock-"));
    tempDirs.push(lockDir);
    const lockPath = path.join(lockDir, "review-round-heal.lock");
    // Stale claim from a dead PID with a plausible-but-dead identity.
    const staleClaim = { pid: 999999, uuid: "stale-uuid", lstart: "Wed Dec 31 1999 23:59:59" };
    fs.writeFileSync(lockPath, `${JSON.stringify(staleClaim, null, 2)}\n`);
    const observed = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    void observed;
    // Replacement race: another writer swaps in a live self-owned claim
    // after the reaper's observation.
    const liveClaim = { pid: process.pid, uuid: "live-uuid", lstart: "real-start" };
    fs.writeFileSync(lockPath, `${JSON.stringify(liveClaim, null, 2)}\n`);
    const prior = {
      bytes: `${JSON.stringify(staleClaim, null, 2)}\n`,
      dev: fs.lstatSync(lockPath).dev,
      ino: 1, // inode changed by the replacement
      mode: fs.lstatSync(lockPath).mode,
      nlink: 1,
    };
    expect(ledgerModule.tryReclaimStaleHealClaim(lockPath, prior)).toBe(false);
    // The live replacement claim survives: no second concurrent writer.
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).uuid).toBe("live-uuid");

    // PID reuse: a live PID whose lstart differs from the claimed one is a
    // departed owner -> the claim is stale and reclamation is allowed.
    const reused = { pid: process.pid, uuid: "reused-uuid", lstart: "not-the-real-lstart" };
    fs.writeFileSync(lockPath, `${JSON.stringify(reused, null, 2)}\n`);
    const reusedSnapshot = {
      bytes: fs.readFileSync(lockPath, "utf8"),
      dev: fs.lstatSync(lockPath).dev,
      ino: fs.lstatSync(lockPath).ino,
      mode: fs.lstatSync(lockPath).mode,
      nlink: fs.lstatSync(lockPath).nlink,
    };
    expect(ledgerModule.tryReclaimStaleHealClaim(lockPath, reusedSnapshot)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);

    // A live claim with the TRUE lstart is never reclaimed.
    const realLstart = ledgerModule.processLstartOf(process.pid);
    const genuine = { pid: process.pid, uuid: "genuine-uuid", lstart: realLstart };
    fs.writeFileSync(lockPath, `${JSON.stringify(genuine, null, 2)}\n`);
    const genuineSnapshot = {
      bytes: fs.readFileSync(lockPath, "utf8"),
      dev: fs.lstatSync(lockPath).dev,
      ino: fs.lstatSync(lockPath).ino,
      mode: fs.lstatSync(lockPath).mode,
      nlink: fs.lstatSync(lockPath).nlink,
    };
    expect(ledgerModule.tryReclaimStaleHealClaim(lockPath, genuineSnapshot)).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("rejects every bounded ps failure mode in a fresh process", () => {
    const modulePath = path.resolve("runtime/review/review-rounds-ledger.ts");
    const modes: FakePsMode[] = [
      "error", "hang", "malformed", "internal-newline", "cr", "tab", "nbsp", "leading", "trailing", "extra-line",
      "stderr", "empty", "oversize", "nonzero", "signal",
    ];
    for (const mode of modes) {
      const fake = fakePsBinary(mode);
      const result = runFreshProcess(modulePath, `
const ledger = await import(${JSON.stringify(modulePath)});
const started = Date.now();
const value = ledger.processLstartOf(process.pid);
process.stdout.write(JSON.stringify({ value, elapsed: Date.now() - started }));
`, fake.root, mode !== "error");
      expect(result.error, `${mode} outer child error`).toBeUndefined();
      expect(result.status, `${mode} child status`).toBe(0);
      expect(result.signal, `${mode} child signal`).toBeNull();
      const observed = JSON.parse(String(result.stdout)) as { value: unknown; elapsed: number };
      expect(observed.value, `${mode} value`).toBeNull();
      expect(observed.elapsed, `${mode} elapsed`).toBeLessThan(2_500);
    }
  }, 60_000);

  it("preserves normal ps parsing and caches the current-process probe", () => {
    const modulePath = path.resolve("runtime/review/review-rounds-ledger.ts");
    const fake = fakePsBinary("valid");
    const result = runFreshProcess(modulePath, `
const ledger = await import(${JSON.stringify(modulePath)});
const first = ledger.processLstartOf(process.pid);
const second = ledger.processLstartOf(process.pid);
process.stdout.write(JSON.stringify({ first, second }));
`, fake.root);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    const observed = JSON.parse(String(result.stdout)) as { first: unknown; second: unknown };
    expect(observed.first).toBe("Fri Dec 31 23:59:59 1999");
    expect(observed.second).toBe(observed.first);
    expect(fs.readFileSync(fake.calls, "utf8")).toBe("x");

    const singleDay = fakePsBinary("valid-single-day");
    const singleDayResult = runFreshProcess(modulePath, `
const ledger = await import(${JSON.stringify(modulePath)});
process.stdout.write(JSON.stringify({ value: ledger.processLstartOf(process.pid) }));
`, singleDay.root);
    expect(singleDayResult.error).toBeUndefined();
    expect(singleDayResult.status).toBe(0);
    expect(singleDayResult.signal).toBeNull();
    expect(JSON.parse(String(singleDayResult.stdout))).toEqual({ value: "Tue Aug  1 00:00:00 2023" });

    const real = processLstartOf(process.pid);
    expect(real).toEqual(expect.any(String));
    expect(processLstartOf(process.pid)).toBe(real);
  });

  it.each(["hang", "malformed"] as const)("rejects claim creation when ps is %s in a fresh process", (mode) => {
    const project = trackedProject();
    const fake = fakePsBinary(mode);
    const modulePath = path.resolve("runtime/review/review-rounds-ledger.ts");
    const projectPath = path.resolve(project.root);
    const result = runFreshProcess(modulePath, `
import * as fs from "node:fs";
const ledger = await import(${JSON.stringify(modulePath)});
const projectRoot = ${JSON.stringify(projectPath)};
const lockPath = ${JSON.stringify(path.join(projectPath, "06_review/review-round-heal.lock"))};
const started = Date.now();
let outcome = null;
let failure = null;
let claimLstart = "missing";
try {
  outcome = ledger.withReviewRoundHealLock(projectRoot, () => {
    claimLstart = JSON.parse(fs.readFileSync(lockPath, "utf8")).lstart;
    return "ok";
  });
} catch (error) {
  failure = String(error);
}
process.stdout.write(JSON.stringify({ outcome, failure, claimLstart, elapsed: Date.now() - started }));
`, fake.root);
    expect(result.error, `${mode} outer child error`).toBeUndefined();
    expect(result.status, `${mode} child status`).toBe(0);
    expect(result.signal, `${mode} child signal`).toBeNull();
    const observed = JSON.parse(String(result.stdout)) as { outcome: unknown; failure: unknown; claimLstart: unknown; elapsed: number };
    expect(observed.outcome).toBeNull();
    expect(observed.failure).toMatch(/current-process lstart|ps probe failed/);
    expect(observed.claimLstart).toBe("missing");
    expect(observed.elapsed).toBeLessThan(2_500);
    expect(fs.existsSync(path.join(project.root, "06_review/review-round-heal.lock"))).toBe(false);
    expect(fs.readdirSync(path.join(project.root, "06_review"))
      .filter((name) => name === "review-round-heal.lock" || name.includes(".tmp-"))).toEqual([]);
  });

  it("reprobes after a transient current-process lstart failure and acquires normally", () => {
    const modulePath = path.resolve("runtime/review/review-rounds-ledger.ts");
    const project = trackedProject();
    const failedPs = fakePsBinary("error");
    const validPs = fakePsBinary("valid");
    const projectPath = path.resolve(project.root);
    const result = runFreshProcess(modulePath, `
import * as fs from "node:fs";
const ledger = await import(${JSON.stringify(modulePath)});
const projectRoot = ${JSON.stringify(projectPath)};
const reviewDir = ${JSON.stringify(path.join(projectPath, "06_review"))};
const lockPath = ${JSON.stringify(path.join(projectPath, "06_review/review-round-heal.lock"))};
let firstFailure = null;
const firstStarted = Date.now();
try {
  ledger.withReviewRoundHealLock(projectRoot, () => "must-not-report-success");
} catch (error) {
  firstFailure = String(error);
}
const firstElapsed = Date.now() - firstStarted;
const afterFirst = fs.readdirSync(reviewDir).filter((name) => name === "review-round-heal.lock" || name.includes(".tmp-"));
process.env.PATH = ${JSON.stringify(validPs.root)} + ":" + (process.env.PATH ?? "");
let retryLstart = null;
const retry = ledger.withReviewRoundHealLock(projectRoot, () => {
  retryLstart = JSON.parse(fs.readFileSync(lockPath, "utf8")).lstart;
  return "recovered";
});
const afterRetry = fs.readdirSync(reviewDir).filter((name) => name === "review-round-heal.lock" || name.includes(".tmp-"));
process.stdout.write(JSON.stringify({ firstFailure, firstElapsed, afterFirst, retry, retryLstart, afterRetry }));
`, failedPs.root);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    const observed = JSON.parse(String(result.stdout)) as {
      firstFailure: unknown;
      firstElapsed: number;
      afterFirst: unknown;
      retry: unknown;
      retryLstart: unknown;
      afterRetry: unknown;
    };
    expect(observed.firstFailure).toMatch(/current-process lstart|ps probe failed/);
    expect(observed.firstElapsed).toBeLessThan(2_500);
    expect(observed.afterFirst).toEqual([]);
    expect(observed.retry).toBe("recovered");
    expect(observed.retryLstart).toBe("Fri Dec 31 23:59:59 1999");
    expect(observed.afterRetry).toEqual([]);
    expect(fs.readFileSync(validPs.calls, "utf8")).toBe("x");
  });

  it("reclaims a valid acquired claim after its owner process exits", () => {
    const modulePath = path.resolve("runtime/review/review-rounds-ledger.ts");
    const project = trackedProject();
    const validPs = fakePsBinary("valid");
    const projectPath = path.resolve(project.root);
    const lockPath = path.join(projectPath, "06_review/review-round-heal.lock");
    const result = runFreshProcess(modulePath, `
const ledger = await import(${JSON.stringify(modulePath)});
ledger.withReviewRoundHealLock(${JSON.stringify(projectPath)}, () => {
  process.exit(0);
});
`, validPs.root);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    const claimBytes = fs.readFileSync(lockPath, "utf8");
    const claim = JSON.parse(claimBytes) as { pid: number; uuid: string; lstart: string };
    expect(claim.pid).toBeGreaterThan(0);
    expect(claim.uuid).toEqual(expect.any(String));
    expect(claim.lstart).toBe("Fri Dec 31 23:59:59 1999");
    const stats = fs.lstatSync(lockPath);
    const prior = { bytes: claimBytes, dev: stats.dev, ino: stats.ino, mode: stats.mode, nlink: stats.nlink };
    expect(tryReclaimStaleHealClaim(lockPath, prior)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it.each([
    "hang", "malformed", "internal-newline", "cr", "tab", "nbsp", "leading", "trailing", "extra-line",
    "five-spaces", "invalid-weekday", "invalid-month", "impossible-date", "mismatched-weekday",
  ] as const)("does not reclaim a live owner when ps is %s in a fresh process", (mode) => {
    const project = trackedProject();
    const fake = fakePsBinary(mode);
    const modulePath = path.resolve("runtime/review/review-rounds-ledger.ts");
    const projectPath = path.resolve(project.root);
    const result = runFreshProcess(modulePath, `
import * as fs from "node:fs";
const ledger = await import(${JSON.stringify(modulePath)});
const lockPath = ${JSON.stringify(path.join(projectPath, "06_review/review-round-heal.lock"))};
const claimBytes = JSON.stringify({ pid: process.pid, uuid: "fresh-live-owner", lstart: "Fri Dec 31 23:59:59 1999" }, null, 2) + "\\n";
fs.writeFileSync(lockPath, claimBytes);
const stats = fs.lstatSync(lockPath);
const prior = { bytes: claimBytes, dev: stats.dev, ino: stats.ino, mode: stats.mode, nlink: stats.nlink };
const started = Date.now();
const reclaimed = ledger.tryReclaimStaleHealClaim(lockPath, prior);
const after = fs.readFileSync(lockPath, "utf8");
process.stdout.write(JSON.stringify({ reclaimed, after, expected: claimBytes, elapsed: Date.now() - started }));
`, fake.root);
    expect(result.error, `${mode} outer child error`).toBeUndefined();
    expect(result.status, `${mode} child status`).toBe(0);
    expect(result.signal, `${mode} child signal`).toBeNull();
    const observed = JSON.parse(String(result.stdout)) as { reclaimed: unknown; after: string; expected: string; elapsed: number };
    expect(observed.reclaimed).toBe(false);
    expect(observed.after).toBe(observed.expected);
    expect(observed.elapsed).toBeLessThan(2_500);
  });

  it("generates byte-identical FULL production report bytes at two roots and rejects external paths", async () => {
    const script = await import("../scripts/render-social-review.js");
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "report-golden-a-"));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "report-golden-b-"));
    tempDirs.push(rootA, rootB);
    for (const root of [rootA, rootB]) {
      fs.mkdirSync(path.join(root, "06_review/renderer-fonts"), { recursive: true });
      fs.mkdirSync(path.join(root, "05_timeline"), { recursive: true });
      fs.writeFileSync(path.join(root, "06_review/caption-preview-plan.json"), "plan");
      fs.writeFileSync(path.join(root, "05_timeline/timeline.json"), "{}");
      fs.writeFileSync(path.join(root, "06_review/renderer-fonts/ass-heavy.otf"), "font-bytes");
      fs.mkdirSync(path.join(root, "09_output/social-review/generations/gen/work/layers"), { recursive: true });
      fs.mkdirSync(path.join(root, "09_output/social-review/generations/gen/work/audio"), { recursive: true });
      fs.writeFileSync(path.join(root, "09_output/social-review/generations/gen/review.mp4"), "video");
      fs.writeFileSync(path.join(root, "09_output/social-review/generations/gen/work/audio/report.json"), "audio-report");
      fs.writeFileSync(path.join(root, "09_output/social-review/generations/gen/work/layers/r1.json"), "layer-receipt");
    }
    const buildInputs = (root: string) => ({
      projectDir: root,
      timelinePath: path.join(root, "05_timeline/timeline.json"),
      timelineVersion: "2",
      cutIdentity: { cut: "cut-identity" },
      reviewEditIdentity: { accepted_patch: { path: "06_review/review_patch.json", sha256: "sha256:patch" } },
      captionPlanPath: path.join(root, "06_review/caption-preview-plan.json"),
      captionPlanIsV2: true,
      captions: [{ text: "hello", in_frame: 30, out_frame: 300, style: "sns-vertical" }],
      durationFrames: 1620,
      durationSec: 54,
      fpsNum: 30,
      fpsDen: 1,
      width: 1080,
      height: 1920,
      audioPresent: true,
      bgmPresent: false,
      gapFree: true,
      renderedLayers: {
        layers: [{ renderer: "remotion", layer: 1 }],
        receipts: [{ renderer: "remotion", composite_stage: "base", receipt_path: path.join(root, "09_output/social-review/generations/gen/work/layers/r1.json"), element_ids: ["el-1"] }],
      },
      fontPath: path.join(root, "06_review/renderer-fonts/ass-heavy.otf"),
      sharedAudioResult: {
        planHash: "sha256:audio-plan",
        reportPath: path.join(root, "09_output/social-review/generations/gen/work/audio/report.json"),
        reportSha256: sha(fs.readFileSync(path.join(root, "09_output/social-review/generations/gen/work/audio/report.json"))),
        dialogueFinishScope: "none",
        masteringCount: 1,
      },
      audioMastering: { status: "verified" },
      outputPath: path.join(root, "09_output/social-review/generations/gen/review.mp4"),
      outputSha256: sha(fs.readFileSync(path.join(root, "09_output/social-review/generations/gen/review.mp4"))),
      generationId: "sha256:" + "f".repeat(64),
      generationInputs: { canonical_timeline_sha256: "sha256:timeline" },
      outputQa: { status: "verified", issues: [] },
      layoutQa: { verified: true },
    });
    const reportA = script.assembleSocialReviewRenderReport(buildInputs(rootA));
    const reportB = script.assembleSocialReviewRenderReport(buildInputs(rootB));
    const bytesA = `${JSON.stringify(reportA, null, 2)}\n`;
    const bytesB = `${JSON.stringify(reportB, null, 2)}\n`;
    expect(bytesA).toBe(bytesB);
    // No machine-root path leaks into hashed report material.
    expect(bytesA).not.toMatch(/\/var\//);
    expect(bytesA).not.toMatch(/\/private\//);
    expect(bytesA).not.toMatch(/\/Users\//);
    expect(reportA.project).toBe(".");
    expect(reportA.timeline_path).toBe("05_timeline/timeline.json");
    expect(reportA.output_path).toBe("09_output/social-review/generations/gen/review.mp4");
    // External paths are rejected rather than relativized to ../../..
    expect(() => script.relativeProjectPath(rootA, rootB)).toThrow(/project-local/);
  });

  it("fails closed on an Ask-to-Ask transition without canonical response or supersession", async () => {
    const project = trackedProject();
    const first = await runReviewRound(project);
    const ledger = readReviewRoundLedger(project.root);
    const firstAsk = ledger.chain.find((entry) => entry.event.version === "review-round-ask/v1")!;
    const firstResponse = ledger.chain.find((entry) => entry.event.version === "review-round-response/v1")!;
    // A second dispatched Ask (fresh generation) whose predecessor chains
    // correctly, but then a THIRD Ask is appended directly after the SECOND
    // Ask — an Ask-to-Ask transition with no response or supersession.
    const secondAsk = {
      ...(firstAsk.event as ReviewRoundAskEvent),
      generation_id: sha("second-generation"),
      review_identity: sha("second-review-identity"),
      timeline: { ...(firstAsk.event as ReviewRoundAskEvent).timeline, hash: sha("second-timeline") },
      review_ready_receipt: { path: "09_output/social-review/generations/second/review-ready-receipt.json", sha256: sha("second-receipt") },
      qa_receipt: { path: "06_review/qa.json", sha256: sha("second-qa"), status: "pass" },
      output: { path: "09_output/social-review/generations/second/review.mp4", sha256: sha("second-video") },
      ask_id: "second-ask-id",
      ask_payload_sha256: sha("second-payload"),
      predecessor: firstResponse.identity,
    };
    appendReviewRoundEvent(project.root, secondAsk);
    const thirdAsk = {
      ...(secondAsk as ReviewRoundAskEvent),
      generation_id: sha("third-generation"),
      review_identity: sha("third-review-identity"),
      ask_id: "third-ask-id",
      ask_payload_sha256: sha("third-payload"),
      predecessor: reviewRoundEventIdentity(secondAsk),
    };
    appendReviewRoundEvent(project.root, thirdAsk);
    const metric = readMetric(project.root);
    expect(metric.status).toBe("unavailable");
    expect(metric.limitations.join(" ")).toMatch(/Ask-to-Ask transition/);
  });

  it("makes a schema-valid foreign or fabricated unanswered Ask unavailable instead of measured zero", async () => {
    const foreign = trackedProject();
    await runReviewRound(foreign, { skipResponse: true });
    // Relabel the project so the dispatched-but-unanswered Ask binds a
    // foreign project identity.
    const timelinePath = path.join(foreign.root, "05_timeline/timeline.json");
    const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8")) as { project_id: string };
    timeline.project_id = "relabelled-foreign";
    fs.writeFileSync(timelinePath, JSON.stringify(timeline, null, 2));
    // The current generation is also invalidated by the relabel; either way
    // the metric must be unavailable, never measured zero.
    const foreignMetric = readMetric(foreign.root);
    expect(foreignMetric.status).toBe("unavailable");

    // A fabricated unanswered Ask (nonexistent generation) is unavailable.
    const fabricated = trackedProject();
    await runReviewRound(fabricated, { skipResponse: true });
    const fabricatedLedger = readReviewRoundLedger(fabricated.root);
    const realAsk = fabricatedLedger.chain.find((entry) => entry.event.version === "review-round-ask/v1")!;
    const fabricatedAsk = {
      ...(realAsk.event as ReviewRoundAskEvent),
      generation_id: sha("fabricated-generation"),
      review_ready_receipt: { path: "09_output/social-review/generations/fabricated/review-ready-receipt.json", sha256: sha("fabricated-receipt") },
      output: { path: "09_output/social-review/generations/fabricated/review.mp4", sha256: sha("fabricated-video") },
    };
    fs.writeFileSync(path.join(ledgerDir(fabricated.root), "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef.json"), `${JSON.stringify(fabricatedAsk, null, 2)}\n`);
    // The forged filename makes the ledger malformed (fail closed) — the key
    // invariant is unavailable, never measured zero with complete scope.
    const fabricatedMetric = readMetric(fabricated.root);
    expect(fabricatedMetric.status).toBe("unavailable");
  });

  it("keeps legacy version 1 diffs schema-valid but never measures them", async () => {
    const project = trackedProject();
    await runReviewRound(project);
    const legacy = {
      version: 1,
      project_id: project.projectId,
      handoff_id: "HND_1",
      base_timeline_version: "2",
      capability_profile_id: "premiere",
      status: "review_required" as const,
      summary: { trim: 1 },
      operations: [{ operation_id: "OP_1", type: "trim", target: { exchange_clip_id: "XCLIP_1" }, delta: { in_us: 100000, out_us: -200000 } }],
    };
    writeYaml(project.root, "07_handoff/HND_1/human_revision_diff.yaml", legacy);
    const schema = validateAgainstSchema(legacy, "human-revision-diff.schema.json");
    expect(schema.valid).toBe(true); // legacy v1 stays schema-valid
    const report = buildReport(project.root);
    expect(report.metrics.post_export_edit_distance.status).toBe("unavailable");
    expect(flagMessage(project.root, "not a version 2 identity-bound diff")).toBe(true);
  });

  it("rejects identity-bound diffs whose paths, versions, or handoff folder were altered while hashes stay intact", async () => {
    const base = trackedProject();
    const round = await runReviewRound(base);
    const buildDiff = (identityOverrides: Record<string, unknown> = {}, diffOverrides: Record<string, unknown> = {}, handoffFolder = "HND_1") => ({
      version: 2 as const,
      project_id: base.projectId,
      handoff_id: handoffFolder,
      base_timeline_version: round.timelineVersion,
      capability_profile_id: "premiere",
      status: "review_required" as const,
      summary: { trim: 1 },
      operations: [{ operation_id: "OP_1", type: "trim", target: { exchange_clip_id: "XCLIP_1" }, delta: { in_us: 100000, out_us: -200000 } }],
      identity: {
        base_timeline: { path: "05_timeline/timeline.json", version: round.timelineVersion, sha256: round.timelineSha256, ...(identityOverrides.baseTimeline as object) },
        review_generation: {
          generation_id: round.generationId,
          review_identity: round.reviewIdentity,
          output: { path: `09_output/social-review/generations/${round.generationId.slice(7)}/review.mp4`, sha256: round.outputSha256, ...(identityOverrides.output as object) },
          review_ready_receipt: {
            path: `09_output/social-review/generations/${round.generationId.slice(7)}/review-ready-receipt.json`,
            sha256: sha(fs.readFileSync(path.join(base.root, "09_output/social-review/generations", round.generationId.slice(7), "review-ready-receipt.json"))),
            ...(identityOverrides.receipt as object),
          },
        },
        review_round: { round_index: 1, round_identity: round.roundIdentity },
        ...(identityOverrides.rest as object),
      },
      ...diffOverrides,
    });

    // Altered output path with the SAME hash.
    const alteredOutput = trackedProject();
    await runReviewRound(alteredOutput, { decision: "request_changes", responseText: "note" });
    writeYaml(alteredOutput.root, "07_handoff/HND_1/human_revision_diff.yaml",
      buildDiff({ output: { path: "elsewhere/review.mp4" } }));
    expect(buildReport(alteredOutput.root).metrics.post_export_edit_distance.status).toBe("unavailable");

    // Altered base timeline path with the SAME hash.
    const alteredTimelinePath = trackedProject();
    await runReviewRound(alteredTimelinePath, { decision: "request_changes", responseText: "note" });
    writeYaml(alteredTimelinePath.root, "07_handoff/HND_1/human_revision_diff.yaml",
      buildDiff({ baseTimeline: { path: "elsewhere/timeline.json" } }));
    expect(buildReport(alteredTimelinePath.root).metrics.post_export_edit_distance.status).toBe("unavailable");

    // Top-level base_timeline_version contradicting the nested identity.
    const alteredVersion = trackedProject();
    await runReviewRound(alteredVersion, { decision: "request_changes", responseText: "note" });
    writeYaml(alteredVersion.root, "07_handoff/HND_1/human_revision_diff.yaml",
      buildDiff({}, { base_timeline_version: "999" }));
    expect(buildReport(alteredVersion.root).metrics.post_export_edit_distance.status).toBe("unavailable");

    // Handoff folder not matching the handoff identity.
    const alteredHandoff = trackedProject();
    await runReviewRound(alteredHandoff, { decision: "request_changes", responseText: "note" });
    writeYaml(alteredHandoff.root, "07_handoff/OTHER/human_revision_diff.yaml",
      buildDiff({}, {}, "OTHER"));
    expect(buildReport(alteredHandoff.root).metrics.post_export_edit_distance.status).toBe("unavailable");
  });

  it("rejects re-signed ask events with elsewhere output or QA receipt paths despite identical hashes", async () => {
    // Re-signing one event changes its identity, so the WHOLE chain tail is
    // re-signed consistently (response predecessor + artifact binding kept);
    // only the axis under test is altered.
    const resignAsk = (project: RoundProject, mutate: (ask: ReviewRoundAskEvent) => void): void => {
      const ledger = readReviewRoundLedger(project.root);
      const askEntry = ledger.chain.find((candidate) => candidate.event.version === "review-round-ask/v1")!;
      const responseEntry = ledger.chain.find((candidate) => candidate.event.version === "review-round-response/v1")!;
      const reSignedAsk = { ...(askEntry.event as ReviewRoundAskEvent) };
      mutate(reSignedAsk);
      const reSignedAskIdentity = reviewRoundEventIdentity(reSignedAsk);
      const reSignedResponse = {
        ...(responseEntry.event as ReviewRoundResponseEvent),
        ask_event: reSignedAskIdentity,
        predecessor: reSignedAskIdentity,
      };
      fs.rmSync(path.join(ledgerDir(project.root), askEntry.file));
      fs.rmSync(path.join(ledgerDir(project.root), responseEntry.file));
      appendReviewRoundEvent(project.root, reSignedAsk);
      appendReviewRoundEvent(project.root, reSignedResponse);
    };
    const elsewhereOutput = trackedProject();
    await runReviewRound(elsewhereOutput);
    resignAsk(elsewhereOutput, (ask) => { ask.output = { ...ask.output, path: "elsewhere/review.mp4" }; });
    const outputMetric = readMetric(elsewhereOutput.root);
    expect(outputMetric.status).toBe("unavailable");
    expect(flagMessage(elsewhereOutput.root, "output path does not bind the canonical generation output")).toBe(true);

    const elsewhereQa = trackedProject();
    await runReviewRound(elsewhereQa);
    resignAsk(elsewhereQa, (ask) => { ask.qa_receipt = { ...ask.qa_receipt, path: "elsewhere/review-qa-receipt.json" }; });
    const qaMetric = readMetric(elsewhereQa.root);
    expect(qaMetric.status).toBe("unavailable");
    expect(flagMessage(elsewhereQa.root, "QA receipt path does not bind the canonical generation QA location")).toBe(true);
  });

  it("rejects re-signed response events whose artifact reference is traversal or alias spelled", async () => {
    const traversalForms = [
      "06_review/review-round-responses/../../06_review/review-ask.json",
      "06_review/review-round-responses/./artifact.json",
      "/absolute/06_review/review-round-responses/artifact.json",
      "06_review/review-round-responses\\artifact.json",
      "06_review//review-round-responses/artifact.json",
      "06_review/review-round-responses/artifact.json/",
      "06_review/review-round-responses/../../etc/passwd",
    ];
    for (const traversal of traversalForms) {
      const project = trackedProject();
      await runReviewRound(project);
      const ledger = readReviewRoundLedger(project.root);
      const entry = ledger.chain.find((candidate) => candidate.event.version === "review-round-response/v1")!;
      const prior = entry.event as ReviewRoundResponseEvent;
      const event = { ...prior, artifact: { ...prior.artifact, path: traversal } };
      // Re-sign only the response (the artifact file itself stays put so the
      // closed-world census still sees the referenced bytes).
      fs.rmSync(path.join(ledgerDir(project.root), entry.file));
      appendReviewRoundEvent(project.root, event);
      const metric = readMetric(project.root);
      expect(metric.status).toBe("unavailable");
      if (traversal.startsWith("/")) {
        // Absolute spellings are rejected at the event-schema layer
        // (binding path pattern ^[^/]) before the canonical validator runs.
        expect(flagged(project.root, "review_rounds_malformed_history")).toBe(true);
      } else {
        expect(flagMessage(project.root, "response artifact reference is not canonical")).toBe(true);
      }
    }
  });

  it("keeps the exact parent-shaped v1 identity-bearing artifact schema-valid but unmeasured", async () => {
    const project = trackedProject();
    await runReviewRound(project);
    const round = await runReviewRound(project, { decision: "request_changes", responseText: "note" });
    const parentShapedV1 = {
      version: 1,
      project_id: project.projectId,
      handoff_id: "HND_1",
      base_timeline_version: "2",
      capability_profile_id: "premiere",
      status: "review_required" as const,
      summary: { trim: 1 },
      operations: [{ operation_id: "OP_1", type: "trim", target: { exchange_clip_id: "XCLIP_1" }, delta: { in_us: 100000, out_us: -200000 } }],
      identity: {
        base_timeline: { path: "05_timeline/timeline.json", version: "2", sha256: round.timelineSha256 },
        review_generation: {
          generation_id: round.generationId,
          review_identity: round.reviewIdentity,
          output: { path: `09_output/social-review/generations/${round.generationId.slice(7)}/review.mp4`, sha256: round.outputSha256 },
          review_ready_receipt: {
            path: `09_output/social-review/generations/${round.generationId.slice(7)}/review-ready-receipt.json`,
            sha256: sha(fs.readFileSync(path.join(project.root, "09_output/social-review/generations", round.generationId.slice(7), "review-ready-receipt.json"))),
          },
        },
        review_round: { round_index: 1, round_identity: round.roundIdentity },
      },
    };
    expect(validateAgainstSchema(parentShapedV1, "human-revision-diff.schema.json").valid).toBe(true);
    writeYaml(project.root, "07_handoff/HND_1/human_revision_diff.yaml", parentShapedV1);
    const report = buildReport(project.root);
    expect(report.metrics.post_export_edit_distance.status).toBe("unavailable");
    expect(flagMessage(project.root, "not a version 2 identity-bound diff")).toBe(true);
  });

  it("rejects symlinked 07_handoff roots, symlinked diff files, and hardlinked diffs without touching outside bytes", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "review-round-diff-outside-"));
    tempDirs.push(outside);
    fs.writeFileSync(path.join(outside, "outside-diff.yaml"), "outside: true\n");

    const symlinkedRoot = trackedProject();
    await runReviewRound(symlinkedRoot, { decision: "request_changes", responseText: "note" });
    fs.rmSync(path.join(symlinkedRoot.root, "07_handoff"), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(symlinkedRoot.root, "07_handoff"));
    const rootReport = buildReport(symlinkedRoot.root);
    expect(rootReport.metrics.review_rounds.status).toBe("measured"); // diff discovery finds nothing valid
    expect(rootReport.metrics.post_export_edit_distance.status).toBe("unavailable");
    expect(flagMessage(symlinkedRoot.root, "symlinked discovery roots are rejected")).toBe(true);
    expect(fs.readdirSync(outside)).toEqual(["outside-diff.yaml"]);

    const symlinkedFile = trackedProject();
    await runReviewRound(symlinkedFile, { decision: "request_changes", responseText: "note" });
    writeYaml(symlinkedFile.root, "07_handoff/HND_1/human_revision_diff.yaml", { version: 2 });
    fs.rmSync(path.join(symlinkedFile.root, "07_handoff/HND_1/human_revision_diff.yaml"));
    fs.symlinkSync(path.join(outside, "outside-diff.yaml"), path.join(symlinkedFile.root, "07_handoff/HND_1/human_revision_diff.yaml"));
    const symlinkedFileReport = buildReport(symlinkedFile.root);
    expect(symlinkedFileReport.metrics.post_export_edit_distance.status).toBe("unavailable");
    expect(flagMessage(symlinkedFile.root, "diff discovery entry is a symlink")).toBe(true);
    expect(fs.readFileSync(path.join(outside, "outside-diff.yaml"), "utf8")).toBe("outside: true\n");

    const hardlinked = trackedProject();
    await runReviewRound(hardlinked, { decision: "request_changes", responseText: "note" });
    writeYaml(hardlinked.root, "07_handoff/HND_1/human_revision_diff.yaml", { version: 2 });
    const diffPath = path.join(hardlinked.root, "07_handoff/HND_1/human_revision_diff.yaml");
    const hardlinkTarget = path.join(outside, "hardlinked-diff.yaml");
    fs.copyFileSync(diffPath, hardlinkTarget);
    fs.rmSync(diffPath);
    fs.linkSync(hardlinkTarget, diffPath);
    const hardlinkedReport = buildReport(hardlinked.root);
    expect(hardlinkedReport.metrics.post_export_edit_distance.status).toBe("unavailable");
    expect(flagMessage(hardlinked.root, "hardlinked evidence")).toBe(true);
  });

  it("sweep completion binding: same-basename outside entry survives a mid-sweep namespace swap", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "review-round-sweep-completion-"));
    tempDirs.push(outside);
    // The OUTSIDE directory contains an entry with the SAME basename as the
    // inside dead-writer temp: a following sweep that dereferences the
    // swapped namespace would delete exactly this victim.
    const insideTempName = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.json.tmp-999999-cafebabecafebabecafebabecafebabe";
    fs.writeFileSync(path.join(outside, insideTempName), "outside-victim-bytes\n");
    const project = trackedProject();
    await runReviewRound(project, { skipResponse: true });
    fs.writeFileSync(path.join(ledgerDir(project.root), insideTempName), "inside-junk\n");
    // Barrier: fire AFTER the directory snapshot check and swap the ledger
    // namespace to the outside directory (same basename present there).
    const barrier = (): void => {
      fs.rmSync(ledgerDir(project.root), { recursive: true, force: true });
      fs.symlinkSync(outside, ledgerDir(project.root));
    };
    expect(() => sweepReviewRoundTemporaries(project.root, barrier)).toThrow(/replaced after validation|namespace changed during the sweep|replaced before completion|failed closed/);
    // The outside victim with the same basename SURVIVES, byte for byte.
    expect(fs.readFileSync(path.join(outside, insideTempName), "utf8")).toBe("outside-victim-bytes\n");
  });

  it("heal-lock completion binding: a namespace swap during the operation is never reported as success and leaves no residual own claim", async () => {
    const module = await import("../runtime/review/review-rounds-ledger.js");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "review-round-lock-completion-"));
    tempDirs.push(outside);
    const project = trackedProject();
    const lockPath = path.join(project.root, "06_review/review-round-heal.lock");
    // Barrier inside the operation: swap 06_review itself to the outside
    // directory while the claim is held at the original namespace.
    let swapFired = false;
    // The lock holder detects the swap at the completion binding and throws
    // instead of returning success; no residual claim and no foreign write.
    expect(() => module.withReviewRoundHealLock(project.root, () => {
      if (swapFired) return;
      swapFired = true;
      fs.rmSync(path.join(project.root, "06_review"), { recursive: true, force: true });
      fs.symlinkSync(outside, path.join(project.root, "06_review"));
    })).toThrow(/swapped during the operation|namespace changed/);
    expect(swapFired).toBe(true);
    // The outside directory never received the claim through the swap: the
    // completion binding threw before any foreign write.
    expect(fs.readdirSync(outside)).toEqual([]);
    // Restore the namespace to a real directory: the swapped-in link is the
    // hostile actor's file, not ours; the own claim died with the original
    // directory, so nothing residual of ours can exist.
    fs.rmSync(path.join(project.root, "06_review"), { force: true });
    fs.mkdirSync(path.join(project.root, "06_review"), { recursive: true });
    // A subsequent heal on the same project acquires cleanly (no dead end).
    expect(module.withReviewRoundHealLock(project.root, () => "recovered")).toBe("recovered");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("releases a rename-retained heal claim through the acquired directory handle and reacquires after restoration", async () => {
    const module = await import("../runtime/review/review-rounds-ledger.js");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "review-round-lock-retain-"));
    tempDirs.push(outside);
    fs.writeFileSync(path.join(outside, "outside-sentinel.txt"), "outside-bytes\n");
    const project = trackedProject();
    const reviewPath = path.join(project.root, "06_review");
    const retainedPath = path.join(outside, "retained-06_review");
    const lockPath = path.join(reviewPath, "review-round-heal.lock");
    fs.writeFileSync(path.join(reviewPath, "original-sentinel.txt"), "original-bytes\n");

    expect(() => module.withReviewRoundHealLock(project.root, () => {
      fs.renameSync(reviewPath, retainedPath);
      fs.mkdirSync(reviewPath);
      fs.writeFileSync(path.join(reviewPath, "replacement-sentinel.txt"), "replacement-bytes\n");
    })).toThrow(/namespace changed|swapped during the operation/);

    expect(fs.existsSync(path.join(retainedPath, "review-round-heal.lock"))).toBe(false);
    expect(fs.readFileSync(path.join(retainedPath, "original-sentinel.txt"), "utf8")).toBe("original-bytes\n");
    expect(fs.readFileSync(path.join(outside, "outside-sentinel.txt"), "utf8")).toBe("outside-bytes\n");
    expect(fs.readdirSync(reviewPath)).toEqual(["replacement-sentinel.txt"]);

    fs.rmSync(reviewPath, { recursive: true, force: true });
    fs.renameSync(retainedPath, reviewPath);
    expect(module.withReviewRoundHealLock(project.root, () => "reacquired")).toBe("reacquired");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("binds acquisition to the opened directory generation during a rename-retain swap", async () => {
    const module = await import("../runtime/review/review-rounds-ledger.js");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "review-round-lock-acquire-retain-"));
    tempDirs.push(outside);
    fs.writeFileSync(path.join(outside, "outside-sentinel.txt"), "outside-bytes\n");
    const project = trackedProject();
    const reviewPath = path.join(project.root, "06_review");
    const retainedPath = path.join(outside, "retained-06_review");
    const lockPath = path.join(reviewPath, "review-round-heal.lock");
    fs.writeFileSync(path.join(reviewPath, "original-sentinel.txt"), "original-bytes\n");

    expect(() => module.withReviewRoundHealLock(project.root, () => "must-not-report-success", {
      afterDirectoryHandleOpen: () => {
        fs.renameSync(reviewPath, retainedPath);
        fs.mkdirSync(reviewPath);
        fs.writeFileSync(path.join(reviewPath, "replacement-sentinel.txt"), "replacement-bytes\n");
      },
    })).toThrow(/namespace changed|swapped/);

    expect(fs.existsSync(path.join(retainedPath, "review-round-heal.lock"))).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readFileSync(path.join(retainedPath, "original-sentinel.txt"), "utf8")).toBe("original-bytes\n");
    expect(fs.readFileSync(path.join(outside, "outside-sentinel.txt"), "utf8")).toBe("outside-bytes\n");
    expect(fs.readdirSync(reviewPath)).toEqual(["replacement-sentinel.txt"]);

    fs.rmSync(reviewPath, { recursive: true, force: true });
    fs.renameSync(retainedPath, reviewPath);
    expect(module.withReviewRoundHealLock(project.root, () => "reacquired")).toBe("reacquired");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("refuses maintenance mutation after a post-acquisition namespace swap", async () => {
    const module = await import("../runtime/review/review-rounds-ledger.js");
    const project = trackedProject();
    const reviewPath = path.join(project.root, "06_review");
    const retainedPath = path.join(project.root, "06_review-retained");
    const replacementRounds = path.join(reviewPath, "review-rounds");
    const tempName = "post-swap.tmp-999999-cafebabecafebabecafebabecafebabecafebabe";
    let retainedClaimPath = "";

    expect(() => module.withReviewRoundHealLock(project.root, () => {
      sweepReviewRoundTemporaries(project.root);
    }, {
      beforeOperation: () => {
        fs.renameSync(reviewPath, retainedPath);
        retainedClaimPath = path.join(retainedPath, "review-round-heal.lock");
        fs.mkdirSync(replacementRounds, { recursive: true });
        fs.writeFileSync(path.join(replacementRounds, tempName), "replacement-temp\n");
        fs.writeFileSync(path.join(reviewPath, "replacement-sentinel.txt"), "replacement-bytes\n");
      },
    })).toThrow(/namespace changed|swapped/);

    expect(fs.readFileSync(path.join(replacementRounds, tempName), "utf8")).toBe("replacement-temp\n");
    expect(fs.readFileSync(path.join(reviewPath, "replacement-sentinel.txt"), "utf8")).toBe("replacement-bytes\n");
    expect(fs.existsSync(retainedClaimPath)).toBe(false);
  });

  it("binds the final append check and mutation to the acquired 06_review handle", async () => {
    const module = await import("../runtime/review/review-rounds-ledger.js");
    const project = trackedProject();
    const reviewPath = path.join(project.root, "06_review");
    const retainedPath = path.join(project.root, "06_review-retained-final-append");
    const replacementRounds = path.join(reviewPath, "review-rounds");
    const event = buildReviewRoundSupersededEvent({
      project_id: project.projectId,
      generation_id: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      review_identity: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      ask_event: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
      ask_id: "append-final-seam",
      reason: "hostile final mutation seam",
      predecessor: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
    });

    expect(() => module.withReviewRoundHealLock(project.root, () => {
      appendReviewRoundEventInternal(project.root, event);
    }, {
      beforeMaintenanceMutation: () => {
        fs.renameSync(reviewPath, retainedPath);
        fs.mkdirSync(replacementRounds, { recursive: true });
        fs.writeFileSync(path.join(reviewPath, "replacement-sentinel.txt"), "replacement-bytes\n");
      },
    })).toThrow(/namespace changed|swapped/);

    expect(fs.readFileSync(path.join(reviewPath, "replacement-sentinel.txt"), "utf8")).toBe("replacement-bytes\n");
    expect(fs.readdirSync(replacementRounds)).toEqual([]);
    expect(fs.existsSync(path.join(retainedPath, "review-round-heal.lock"))).toBe(false);
  });

  it("binds the final sweep delete check to the acquired 06_review handle", async () => {
    const module = await import("../runtime/review/review-rounds-ledger.js");
    const project = trackedProject();
    const reviewPath = path.join(project.root, "06_review");
    const originalRounds = path.join(reviewPath, "review-rounds");
    const retainedPath = path.join(project.root, "06_review-retained-final-sweep");
    const tempName = "final-sweep.tmp-999999-cafebabecafebabecafebabecafebabecafebabe";
    fs.mkdirSync(originalRounds, { recursive: true });
    fs.writeFileSync(path.join(originalRounds, tempName), "original-temp\n");

    expect(() => module.withReviewRoundHealLock(project.root, () => {
      sweepReviewRoundTemporaries(project.root);
    }, {
      beforeMaintenanceMutation: () => {
        fs.renameSync(reviewPath, retainedPath);
        fs.mkdirSync(path.join(reviewPath, "review-rounds"), { recursive: true });
        fs.writeFileSync(path.join(reviewPath, "review-rounds", tempName), "replacement-temp\n");
        fs.writeFileSync(path.join(reviewPath, "replacement-sentinel.txt"), "replacement-bytes\n");
      },
    })).toThrow(/namespace changed|swapped/);

    expect(fs.readFileSync(path.join(reviewPath, "review-rounds", tempName), "utf8")).toBe("replacement-temp\n");
    expect(fs.readFileSync(path.join(reviewPath, "replacement-sentinel.txt"), "utf8")).toBe("replacement-bytes\n");
    expect(fs.existsSync(path.join(retainedPath, "review-round-heal.lock"))).toBe(false);
  });

  it("fails closed when the own claim disappears before release", async () => {
    const module = await import("../runtime/review/review-rounds-ledger.js");
    const project = trackedProject();
    const lockPath = path.join(project.root, "06_review/review-round-heal.lock");

    expect(() => module.withReviewRoundHealLock(project.root, () => {
      fs.unlinkSync(lockPath);
    })).toThrow(/lost ownership|claim/);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("does not unlink a foreign same-name claim exchanged after identity verification", async () => {
    const module = await import("../runtime/review/review-rounds-ledger.js");
    const project = trackedProject();
    const lockPath = path.join(project.root, "06_review/review-round-heal.lock");
    const foreignBytes = `${JSON.stringify({ pid: process.pid, uuid: "foreign-after-verify", lstart: "foreign" }, null, 2)}\n`;

    expect(() => module.withReviewRoundHealLock(project.root, () => "must-not-report-success", {
      replaceClaimAfterVerification: foreignBytes,
    })).toThrow(/changed or foreign|foreign claim/);

    const foreignStats = fs.lstatSync(lockPath);
    expect(fs.readFileSync(lockPath, "utf8")).toBe(foreignBytes);
    expect(foreignStats.nlink).toBe(1);
    expect(foreignStats.isSymbolicLink()).toBe(false);
  });

  it("does not unlink a foreign same-name claim exchanged after the final helper verification", async () => {
    const module = await import("../runtime/review/review-rounds-ledger.js");
    const project = trackedProject();
    const lockPath = path.join(project.root, "06_review/review-round-heal.lock");
    const foreignBytes = `${JSON.stringify({ pid: process.pid, uuid: "foreign-after-final-verify", lstart: "foreign" }, null, 2)}\n`;

    expect(() => module.withReviewRoundHealLock(project.root, () => "must-not-report-success", {
      replaceClaimAfterFinalVerification: foreignBytes,
    })).toThrow(/changed or foreign|foreign claim/);

    const foreignStats = fs.lstatSync(lockPath);
    expect(fs.readFileSync(lockPath, "utf8")).toBe(foreignBytes);
    expect(foreignStats.nlink).toBe(1);
    expect(foreignStats.isSymbolicLink()).toBe(false);
  });

  it("does not unlink a foreign sweep target exchanged after final captured-identity verification", async () => {
    const module = await import("../runtime/review/review-rounds-ledger.js");
    const project = trackedProject();
    await runReviewRound(project, { skipResponse: true });
    const tempName = "final-capture.tmp-999999-cafebabecafebabecafebabecafebabecafebabe";
    const target = path.join(ledgerDir(project.root), tempName);
    const foreignBytes = "foreign-final-sweep-bytes\n";
    fs.writeFileSync(target, "own-sweep-bytes\n");

    expect(() => module.withReviewRoundHealLock(project.root, () => {
      sweepReviewRoundTemporaries(project.root);
    }, {
      replaceTemporaryAfterFinalVerification: foreignBytes,
    })).toThrow(/failed closed|foreign|namespace/);

    const foreignStats = fs.lstatSync(target);
    expect(fs.readFileSync(target, "utf8")).toBe(foreignBytes);
    expect(foreignStats.nlink).toBe(1);
    expect(foreignStats.isSymbolicLink()).toBe(false);
  });

  it("refuses a same-inode same-size sweep rewrite before quarantine", async () => {
    const module = await import("../runtime/review/review-rounds-ledger.js");
    const project = trackedProject();
    await runReviewRound(project, { skipResponse: true });
    const tempName = "same-bytes.tmp-999999-cafebabecafebabecafebabecafebabecafebabe";
    const target = path.join(ledgerDir(project.root), tempName);
    const originalBytes = "original-temp!\n";
    const foreignBytes = "foreign-temp!!\n";
    expect(foreignBytes.length).toBe(originalBytes.length);
    fs.writeFileSync(target, originalBytes);
    const before = fs.lstatSync(target);

    expect(() => module.withReviewRoundHealLock(project.root, () => {
      sweepReviewRoundTemporaries(project.root);
    }, {
      beforeMaintenanceMutation: () => {
        // Keep the inode, mode, link count, and size unchanged while changing
        // only the bytes that the pre-capture hash must bind.
        fs.writeFileSync(target, foreignBytes);
      },
    })).toThrow(/failed closed|foreign|hash/);

    const after = fs.lstatSync(target);
    expect(fs.readFileSync(target, "utf8")).toBe(foreignBytes);
    expect({ dev: after.dev, ino: after.ino, mode: after.mode, nlink: after.nlink, size: after.size })
      .toEqual({ dev: before.dev, ino: before.ino, mode: before.mode, nlink: before.nlink, size: before.size });
  });

  it("does not unlink a foreign claim exchanged after final captured-identity verification during stale reclaim", async () => {
    const module = await import("../runtime/review/review-rounds-ledger.js");
    const project = trackedProject();
    const lockPath = path.join(project.root, "06_review/review-round-heal.lock");
    const priorBytes = `${JSON.stringify({ pid: 999999, uuid: "stale-final-capture", lstart: "Wed Dec 31 1999 23:59:59" }, null, 2)}\n`;
    fs.writeFileSync(lockPath, priorBytes);
    const priorStats = fs.lstatSync(lockPath);
    const prior = {
      bytes: priorBytes,
      dev: priorStats.dev,
      ino: priorStats.ino,
      mode: priorStats.mode,
      nlink: priorStats.nlink,
    };
    const foreignBytes = `${JSON.stringify({ pid: process.pid, uuid: "foreign-stale-final", lstart: "foreign" }, null, 2)}\n`;

    expect(module.tryReclaimStaleHealClaim(lockPath, prior, {
      replaceClaimAfterFinalVerification: foreignBytes,
    })).toBe(false);

    const foreignStats = fs.lstatSync(lockPath);
    expect(fs.readFileSync(lockPath, "utf8")).toBe(foreignBytes);
    expect(foreignStats.nlink).toBe(1);
    expect(foreignStats.isSymbolicLink()).toBe(false);
  });

  it("fails closed and leaves the own claim explicit when the Python directory-fd release dependency is unavailable", async () => {
    const module = await import("../runtime/review/review-rounds-ledger.js");
    const project = trackedProject();
    const lockPath = path.join(project.root, "06_review/review-round-heal.lock");
    const previousPath = process.env.PATH;
    process.env.PATH = path.join(project.root, "empty-bin");
    fs.mkdirSync(process.env.PATH, { recursive: true });
    try {
      expect(() => module.withReviewRoundHealLock(project.root, () => "must-not-report-success"))
        .toThrow(/dependency failed|path fallback/);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("rejects nonzero, stderr, and signal helper results during acquisition", async () => {
    const module = await import("../runtime/review/review-rounds-ledger.js");
    for (const options of [{ exitCode: 7 }, { stderr: "unexpected helper stderr" }, { signal: "TERM" }] as const) {
      const project = trackedProject();
      const fake = fakePythonBinary(JSON.stringify({ status: "acquired" }), options);
      expect(() => withPythonPath(fake, () => module.withReviewRoundHealLock(project.root, () => "must-not-report-success")))
        .toThrow(/dependency failed|acquire/);
      expect(fs.existsSync(path.join(project.root, "06_review/review-round-heal.lock"))).toBe(false);
    }
  });

  it("does not clean pre-existing foreign private-temp collisions during acquire or write", async () => {
    const module = await import("../runtime/review/review-rounds-ledger.js");
    const foreignBytes = "foreign-private-temp\n";

    const acquisition = trackedProject();
    let acquisitionForeignPath = "";
    let acquisitionBefore: fs.Stats;
    expect(() => module.withReviewRoundHealLock(acquisition.root, () => "must-not-report-success", {
      beforeClaimTempCreate: (tempName) => {
        acquisitionForeignPath = path.join(acquisition.root, "06_review", tempName);
        fs.writeFileSync(acquisitionForeignPath, foreignBytes);
        acquisitionBefore = fs.lstatSync(acquisitionForeignPath);
      },
    })).toThrow(/dependency failed|acquire/);
    const acquisitionAfter = fs.lstatSync(acquisitionForeignPath);
    expect(fs.readFileSync(acquisitionForeignPath, "utf8")).toBe(foreignBytes);
    expect({ dev: acquisitionAfter.dev, ino: acquisitionAfter.ino, mode: acquisitionAfter.mode, nlink: acquisitionAfter.nlink, size: acquisitionAfter.size })
      .toEqual({ dev: acquisitionBefore!.dev, ino: acquisitionBefore!.ino, mode: acquisitionBefore!.mode, nlink: acquisitionBefore!.nlink, size: acquisitionBefore!.size });

    const writing = trackedProject();
    const initial = await runReviewRound(writing, { skipResponse: true });
    const ledger = readReviewRoundLedger(writing.root);
    const askEntry = ledger.chain.find((entry) => entry.event.version === "review-round-ask/v1")!;
    const ask = askEntry.event as ReviewRoundAskEvent;
    const event = buildReviewRoundSupersededEvent({
      project_id: writing.projectId,
      generation_id: initial.generationId,
      review_identity: initial.reviewIdentity,
      ask_event: askEntry.identity,
      ask_id: ask.ask_id,
      reason: "private temp collision",
      predecessor: ledger.chain[ledger.chain.length - 1]!.identity,
    });
    let writingForeignPath = "";
    let writingBefore: fs.Stats;
    expect(() => module.withReviewRoundHealLock(writing.root, () => {
      appendReviewRoundEventInternal(writing.root, event);
    }, {
      beforeMaintenanceTempCreate: (tempName) => {
        writingForeignPath = path.join(ledgerDir(writing.root), tempName);
        fs.writeFileSync(writingForeignPath, foreignBytes);
        writingBefore = fs.lstatSync(writingForeignPath);
      },
    })).toThrow(/dependency failed|write|release/);
    const writingAfter = fs.lstatSync(writingForeignPath);
    expect(fs.readFileSync(writingForeignPath, "utf8")).toBe(foreignBytes);
    expect({ dev: writingAfter.dev, ino: writingAfter.ino, mode: writingAfter.mode, nlink: writingAfter.nlink, size: writingAfter.size })
      .toEqual({ dev: writingBefore!.dev, ino: writingBefore!.ino, mode: writingBefore!.mode, nlink: writingBefore!.nlink, size: writingBefore!.size });
  });

  it("bounds hanging helper calls and reports residual claim state without false success", async () => {
    const module = await import("../runtime/review/review-rounds-ledger.js");
    const acquisition = trackedProject();
    const hanging = fakePythonBinary("", { sleepSeconds: 30 });
    const acquisitionStarted = Date.now();
    expect(() => withPythonPath(hanging, () => module.withReviewRoundHealLock(acquisition.root, () => "must-not-report-success")))
      .toThrow(/dependency failed|acquire/);
    expect(Date.now() - acquisitionStarted).toBeLessThan(4_500);
    expect(fs.existsSync(path.join(acquisition.root, "06_review/review-round-heal.lock"))).toBe(false);
    expect(fs.readdirSync(path.join(acquisition.root, "06_review")).some((name) => name.includes(".tmp-"))).toBe(false);

    const release = trackedProject();
    const previousPath = process.env.PATH;
    const releaseStarted = Date.now();
    try {
      expect(() => module.withReviewRoundHealLock(release.root, () => {
        process.env.PATH = `${hanging}${path.delimiter}${process.env.PATH ?? ""}`;
        return "must-not-report-success";
      })).toThrow(/release|worker|operation/);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    expect(Date.now() - releaseStarted).toBeLessThan(4_500);
    // A timed-out release is fail-closed and leaves the own claim explicit;
    // no later path fallback or foreign deletion is permitted.
    expect(fs.existsSync(path.join(release.root, "06_review/review-round-heal.lock"))).toBe(true);
  });

  it("rejects malformed helper results during acquisition, stale reclaim, write, sweep, and release", async () => {
    const module = await import("../runtime/review/review-rounds-ledger.js");
    const malformed = JSON.stringify({ status: "removed", bytes: 17, unexpected: true });

    const acquisition = trackedProject();
    const acquisitionFake = fakePythonBinary(malformed);
    expect(() => withPythonPath(acquisitionFake, () => module.withReviewRoundHealLock(acquisition.root, () => "must-not-report-success")))
      .toThrow(/dependency failed|acquire/);
    expect(fs.existsSync(path.join(acquisition.root, "06_review/review-round-heal.lock"))).toBe(false);

    const reclaim = trackedProject();
    const reclaimLock = path.join(reclaim.root, "06_review/review-round-heal.lock");
    const reclaimBytes = `${JSON.stringify({ pid: 999999, uuid: "malformed-reclaim", lstart: "Wed Dec 31 1999 23:59:59" }, null, 2)}\n`;
    fs.writeFileSync(reclaimLock, reclaimBytes);
    const reclaimStats = fs.lstatSync(reclaimLock);
    const reclaimPrior = { bytes: reclaimBytes, dev: reclaimStats.dev, ino: reclaimStats.ino, mode: reclaimStats.mode, nlink: reclaimStats.nlink };
    const reclaimFake = fakePythonBinary(malformed);
    expect(withPythonPath(reclaimFake, () => module.tryReclaimStaleHealClaim(reclaimLock, reclaimPrior))).toBe(false);
    expect(fs.readFileSync(reclaimLock, "utf8")).toBe(reclaimBytes);

    const writeProject = trackedProject();
    await runReviewRound(writeProject, { skipResponse: true });
    const writeFake = fakePythonBinary(malformed);
    const writeEvent = buildReviewRoundSupersededEvent({
      project_id: writeProject.projectId,
      generation_id: "sha256:" + "1".repeat(64),
      review_identity: "sha256:" + "2".repeat(64),
      ask_event: "sha256:" + "3".repeat(64),
      ask_id: "malformed-write",
      reason: "malformed helper",
      predecessor: "sha256:" + "3".repeat(64),
    });
    const previousWritePath = process.env.PATH;
    try {
      expect(() => module.withReviewRoundHealLock(writeProject.root, () => {
        process.env.PATH = `${writeFake}${path.delimiter}${process.env.PATH ?? ""}`;
        appendReviewRoundEventInternal(writeProject.root, writeEvent);
      })).toThrow(/dependency failed|write|release/);
    } finally {
      if (previousWritePath === undefined) delete process.env.PATH;
      else process.env.PATH = previousWritePath;
    }

    const sweepProject = trackedProject();
    await runReviewRound(sweepProject, { skipResponse: true });
    const sweepFake = fakePythonBinary(malformed);
    fs.writeFileSync(path.join(ledgerDir(sweepProject.root), "malformed-sweep.tmp-999999-cafebabecafebabecafebabecafebabecafebabe"), "temp\n");
    const previousSweepPath = process.env.PATH;
    try {
      expect(() => module.withReviewRoundHealLock(sweepProject.root, () => {
        process.env.PATH = `${sweepFake}${path.delimiter}${process.env.PATH ?? ""}`;
        sweepReviewRoundTemporaries(sweepProject.root);
      })).toThrow(/dependency failed|sweep|release/);
    } finally {
      if (previousSweepPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousSweepPath;
    }

    const releaseProject = trackedProject();
    const releaseFake = fakePythonBinary(malformed);
    const previousReleasePath = process.env.PATH;
    try {
      expect(() => module.withReviewRoundHealLock(releaseProject.root, () => {
        process.env.PATH = `${releaseFake}${path.delimiter}${process.env.PATH ?? ""}`;
        return "must-not-report-success";
      })).toThrow(/dependency failed|release|claim/);
    } finally {
      if (previousReleasePath === undefined) delete process.env.PATH;
      else process.env.PATH = previousReleasePath;
    }
    expect(fs.existsSync(path.join(releaseProject.root, "06_review/review-round-heal.lock"))).toBe(true);
  });

  it("post-guard/pre-publish swap fails closed for append and leaves outside bytes unchanged (barrier seam)", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "review-round-swap-outside-"));
    tempDirs.push(outside);
    const victimTmp = path.join(outside, "victim.tmp-999999-deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    fs.writeFileSync(victimTmp, "victim-bytes\n");
    const appendSwap = trackedProject();
    await runReviewRound(appendSwap);
    const ledger = readReviewRoundLedger(appendSwap.root);
    const askEntry = ledger.chain.find((entry) => entry.event.version === "review-round-ask/v1")!;
    // The barrier fires AFTER the namespace guard and BEFORE publish: it
    // swaps the ledger namespace to the outside directory mid-write.
    const barrier = (): void => {
      fs.rmSync(ledgerDir(appendSwap.root), { recursive: true, force: true });
      fs.symlinkSync(outside, ledgerDir(appendSwap.root));
    };
    expect(() => appendReviewRoundEventInternal(appendSwap.root, askEntry.event, barrier)).toThrow(/namespace changed|post-publish inspection|dependency failed/);
    // Nothing this writer escaped remains outside: the victim temp and any
    // attacker-owned files are untouched, and no event file was published.
    expect(fs.readdirSync(outside).sort()).toEqual(["victim.tmp-999999-deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"]);
    expect(fs.readFileSync(victimTmp, "utf8")).toBe("victim-bytes\n");
  });

  it("pre-unlink swap fails closed for sweep and never deletes outside temporaries (barrier seam)", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "review-round-sweep-outside-"));
    tempDirs.push(outside);
    // An outside dead-writer temp that a following sweep must never delete.
    const outsideVictim = path.join(outside, "victim.tmp-999999-deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    fs.writeFileSync(outsideVictim, "victim-bytes\n");
    const sweepSwap = trackedProject();
    await runReviewRound(sweepSwap, { skipResponse: true });
    // Plant an inside dead-writer temp so the sweep has something to reap.
    fs.writeFileSync(path.join(ledgerDir(sweepSwap.root), "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.json.tmp-999999-cafebabecafebabecafebabecafebabe"), "junk");
    // The barrier fires AFTER guard/enumeration and BEFORE the unlink: it
    // replaces the ledger namespace with a symlink to the outside directory.
    const barrier = (): void => {
      fs.rmSync(ledgerDir(sweepSwap.root), { recursive: true, force: true });
      fs.symlinkSync(outside, ledgerDir(sweepSwap.root));
    };
    expect(() => sweepReviewRoundTemporaries(sweepSwap.root, barrier)).toThrow(/replaced after validation|namespace changed|failed closed/);
    expect(fs.existsSync(outsideVictim)).toBe(true);
    expect(fs.readFileSync(outsideVictim, "utf8")).toBe("victim-bytes\n");
  });

  it("lock ownership is project-keyed: nested project B heal acquires its own claim while A is held", async () => {
    const moduleA = await import("../runtime/review/review-rounds-ledger.js");
    const projectA = trackedProject();
    const projectB = trackedProject();
    const lockPathOf = (root: string): string => path.join(root, "06_review/review-round-heal.lock");
    let bAcquiredOwnLock = false;
    moduleA.withReviewRoundHealLock(projectA.root, () => {
      expect(fs.existsSync(lockPathOf(projectA.root))).toBe(true);
      // A nested heal operation for project B must acquire B's OWN lock file
      // instead of bypassing through A's process-global ownership.
      moduleA.withReviewRoundHealLock(projectB.root, () => {
        bAcquiredOwnLock = fs.existsSync(lockPathOf(projectB.root));
      });
    });
    expect(bAcquiredOwnLock).toBe(true);
    // Both claims are released after their scopes end.
    expect(fs.existsSync(lockPathOf(projectA.root))).toBe(false);
    expect(fs.existsSync(lockPathOf(projectB.root))).toBe(false);
  });

  it("never reclaims lock claims with missing or malformed lstart (unknown is live)", async () => {
    const ledgerModule = await import("../runtime/review/review-rounds-ledger.js");
    const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-round-lock-strict-"));
    tempDirs.push(lockDir);
    const lockPath = path.join(lockDir, "review-round-heal.lock");
    const writeClaim = (claim: Record<string, unknown>): void => {
      fs.writeFileSync(lockPath, `${JSON.stringify(claim, null, 2)}\n`);
    };
    const snapshot = (): { bytes: string; dev: number; ino: number; mode: number; nlink: number } => {
      const stats = fs.lstatSync(lockPath);
      return { bytes: fs.readFileSync(lockPath, "utf8"), dev: stats.dev, ino: stats.ino, mode: stats.mode, nlink: stats.nlink };
    };
    // Missing lstart.
    writeClaim({ pid: 999999, uuid: "no-lstart" });
    expect(ledgerModule.tryReclaimStaleHealClaim(lockPath, snapshot())).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true);
    // Malformed lstart.
    writeClaim({ pid: 999999, uuid: "bad-lstart", lstart: 12345 });
    expect(ledgerModule.tryReclaimStaleHealClaim(lockPath, snapshot())).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true);
    // Confirmed dead PID with a well-formed claim IS reclaimable.
    writeClaim({ pid: 999999, uuid: "dead-owner", lstart: "Wed Dec 31 1999 23:59:59" });
    expect(ledgerModule.tryReclaimStaleHealClaim(lockPath, snapshot())).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("refuses canonical human_revision_diff output without identity bindings and writes identity-bound diffs atomically", async () => {
    const project = trackedProject();
    const round = await runReviewRound(project);
    const diffModule = await import("../runtime/handoff/diff.js");
    const diffModule2 = await import("../runtime/eval/review-rounds.js");
    const boundDiff = {
      version: 2 as const,
      project_id: project.projectId,
      handoff_id: "HND_9",
      base_timeline_version: round.timelineVersion,
      capability_profile_id: "premiere",
      status: "review_required" as const,
      summary: { trim: 1 },
      identity: {
        base_timeline: { path: "05_timeline/timeline.json", version: round.timelineVersion, sha256: round.timelineSha256 },
        review_generation: {
          generation_id: round.generationId,
          review_identity: round.reviewIdentity,
          output: { path: `09_output/social-review/generations/${round.generationId.slice(7)}/review.mp4`, sha256: round.outputSha256 },
          review_ready_receipt: {
            path: `09_output/social-review/generations/${round.generationId.slice(7)}/review-ready-receipt.json`,
            sha256: sha(fs.readFileSync(path.join(project.root, "09_output/social-review/generations", round.generationId.slice(7), "review-ready-receipt.json"))),
          },
        },
        review_round: { round_index: 1, round_identity: round.roundIdentity },
      },
    };
    // Identity-less diffs are refused as canonical output.
    const { identity: _identity, ...identityLess } = boundDiff;
    expect(() => diffModule.writeCanonicalHumanRevisionDiff(project.root, { handoffId: "HND_9", diff: identityLess as never }))
      .toThrow(/requires immutable identity bindings|required property 'identity'/i);
    // The production resolver is FIXED inside the public API: a caller cannot
    // inject a resolver (the parameter does not exist at type or runtime
    // level), so the identity must resolve against the REAL project ledger.
    const written = diffModule.writeCanonicalHumanRevisionDiff(project.root, {
      handoffId: "HND_9",
      diff: boundDiff,
      // Runtime-hostile extra property: any injected resolver is ignored.
      resolveIdentity: () => {
        throw new Error("forged resolver must never be invoked");
      },
    } as never);
    expect(written.round.round_identity).toBe(round.roundIdentity);
    expect(written.relativePath).toBe("07_handoff/HND_9/human_revision_diff.yaml");
    expect(fs.existsSync(path.join(project.root, "07_handoff/HND_9/human_revision_diff.yaml"))).toBe(true);
    // The canonical route's output is exactly what the metric binds.
    const metric = readMetric(project.root);
    expect(metric.value).toMatchObject({
      human_revision_diff: { path: "07_handoff/HND_9/human_revision_diff.yaml", round_identity: round.roundIdentity },
    });
    // Forged identities (nonexistent round hash, wrong index) are rejected by
    // the production resolver.
    const forgedIdentity = {
      ...boundDiff.identity,
      review_round: { round_index: 999, round_identity: sha("nonexistent-round") },
    };
    expect(() => diffModule2.resolveCanonicalDiffIdentity(project.root, project.projectId, forgedIdentity)).toThrow(/does not resolve/);
  });

  it("excludes rounds whose generation receipt, bound artifacts, or QA are invalid", async () => {
    // A tampered CURRENT generation receipt breaks current identity -> unavailable.
    const tamperedReceipt = trackedProject();
    await runReviewRound(tamperedReceipt);
    fs.appendFileSync(path.join(newestGenerationDir(tamperedReceipt.root), "review-ready-receipt.json"), "tampered");
    const receiptMetric = readMetric(tamperedReceipt.root);
    expect(receiptMetric.status).toBe("unavailable");
    expect(receiptMetric.limitations.join(" ")).toMatch(/current review identity cannot be established/);
    // A tampered HISTORICAL completed round also invalidates the whole
    // history: invalid completed pairs are never filtered into partial counts.
    const historical = trackedProject();
    await runReviewRound(historical, { decision: "request_changes" });
    await runReviewRound(historical, { decision: "approve" });
    const oldestGeneration = (readReviewRoundLedger(historical.root).chain.find(
        (entry) => entry.event.version === "review-round-ask/v1",
      )!.event as ReviewRoundAskEvent).generation_id.slice("sha256:".length);
    fs.appendFileSync(path.join(historical.root, "09_output/social-review/generations", oldestGeneration, "review-ready-receipt.json"), "tampered");
    const historicalMetric = readMetric(historical.root);
    expect(historicalMetric.status).toBe("unavailable");
    expect(historicalMetric.limitations.join(" ")).toMatch(/completed review round failed canonical verification/);

    const missingArtifact = trackedProject();
    await runReviewRound(missingArtifact);
    fs.rmSync(path.join(newestGenerationDir(missingArtifact.root), "review.mp4"));
    const missingMetric = readMetric(missingArtifact.root);
    expect(missingMetric.status).toBe("unavailable");
    expect(missingMetric.limitations.join(" ")).toMatch(/current review identity cannot be established/);
    // A historical generation missing its output invalidates the whole history.
    const historicalMissing = trackedProject();
    await runReviewRound(historicalMissing, { decision: "request_changes" });
    await runReviewRound(historicalMissing, { decision: "approve" });
    const oldestMissing = (readReviewRoundLedger(historicalMissing.root).chain.find(
        (entry) => entry.event.version === "review-round-ask/v1",
      )!.event as ReviewRoundAskEvent).generation_id.slice("sha256:".length);
    fs.rmSync(path.join(historicalMissing.root, "09_output/social-review/generations", oldestMissing, "review.mp4"));
    const missingHistoricalMetric = readMetric(historicalMissing.root);
    expect(missingHistoricalMetric.status).toBe("unavailable");
    expect(missingHistoricalMetric.limitations.join(" ")).toMatch(/completed review round failed canonical verification/);

    const blockerQa = trackedProject();
    await runReviewRound(blockerQa);
    const qaPath = path.join(newestGenerationDir(blockerQa.root), "review-qa-receipt.json");
    const qa = JSON.parse(fs.readFileSync(qaPath, "utf8")) as { status: string };
    qa.status = "blocker";
    fs.writeFileSync(qaPath, `${JSON.stringify(qa, null, 2)}\n`);
    const blockerMetric = readMetric(blockerQa.root);
    // The tampered QA bytes break the current generation -> strict unavailable.
    expect(blockerMetric.status).toBe("unavailable");
    expect(blockerMetric.limitations.join(" ")).toMatch(/current review identity cannot be established/);

    const videoTamper = trackedProject();
    await runReviewRound(videoTamper);
    fs.writeFileSync(path.join(newestGenerationDir(videoTamper.root), "review.mp4"), "replaced");
    const videoMetric = readMetric(videoTamper.root);
    expect(videoMetric.status).toBe("unavailable");
    expect(videoMetric.limitations.join(" ")).toMatch(/current review identity cannot be established/);
  });

  it("requires the current generation to pass verifyCurrentReviewReady and rejects broken current state", async () => {
    const project = trackedProject();
    await runReviewRound(project);
    const readyStatePath = path.join(project.root, "06_review/review-ready-state.json");
    const readyState = JSON.parse(fs.readFileSync(readyStatePath, "utf8")) as { status: string };
    readyState.status = "failed";
    fs.writeFileSync(readyStatePath, `${JSON.stringify(readyState, null, 2)}\n`);
    const metric = readMetric(project.root);
    expect(metric.status).toBe("unavailable");
    expect(metric.limitations.join(" ")).toMatch(/current review-ready verification failed/);
  });

  it("rejects project relabel copies and generation directory symlink escapes", async () => {
    const source = trackedProject();
    await runReviewRound(source);
    const copyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "review-round-copy-"));
    tempDirs.push(copyRoot);
    fs.cpSync(source.root, copyRoot, { recursive: true });
    const timelinePath = path.join(copyRoot, "05_timeline/timeline.json");
    const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8")) as { project_id: string };
    timeline.project_id = "relabelled";
    fs.writeFileSync(timelinePath, JSON.stringify(timeline, null, 2));
    const copyMetric = readMetric(copyRoot);
    expect(copyMetric.status).toBe("unavailable");
    expect(copyMetric.limitations.join(" ")).toMatch(/current review identity cannot be established|response artifact namespace/);

    const escape = trackedProject();
    await runReviewRound(escape);
    const generationDir = newestGenerationDir(escape.root);
    const outside = path.join(os.tmpdir(), `review-round-escape-${Date.now()}`);
    fs.writeFileSync(outside, "outside");
    fs.rmSync(path.join(generationDir, "review.mp4"));
    fs.symlinkSync(outside, path.join(generationDir, "review.mp4"));
    const escapeMetric = readMetric(escape.root);
    expect(escapeMetric.status).toBe("unavailable");
    expect(escapeMetric.limitations.join(" ")).toMatch(/current review identity cannot be established/);
    fs.rmSync(outside, { force: true });
  });

  it("records supersession and excludes stale unanswered rounds", async () => {
    const project = trackedProject();
    await runReviewRound(project, { skipResponse: true });
    // Invalidate a bound artifact so the current generation goes stale.
    const captionPlanPath = path.join(project.root, project.paths.captionPlan);
    const plan = JSON.parse(fs.readFileSync(captionPlanPath, "utf8")) as { cues: Array<{ text: string }> };
    plan.cues[0]!.text = "changed after dispatch";
    fs.writeFileSync(captionPlanPath, JSON.stringify(plan));
    const stale = refreshReviewFreshness(project.root);
    expect(stale.status).toBe("stale");
    const ledger = readReviewRoundLedger(project.root);
    const events = ledger.chain.map((entry) => entry.event.version);
    expect(events).toEqual(["review-round-ask/v1", "review-round-superseded/v1"]);
    const metric = readMetric(project.root);
    // The stale transition leaves the current generation unverifiable, so the
    // strict current-identity rule makes the metric unavailable; the durable
    // superseded event is still recorded.
    expect(metric.status).toBe("unavailable");
    expect(metric.limitations.join(" ")).toMatch(/current review identity cannot be established/);
  });

  it("heals an interrupted superseded event on rerun instead of early-returning", async () => {
    const project = trackedProject();
    await runReviewRound(project, { skipResponse: true });
    const captionPlanPath = path.join(project.root, project.paths.captionPlan);
    const plan = JSON.parse(fs.readFileSync(captionPlanPath, "utf8")) as { cues: Array<{ text: string }> };
    plan.cues[0]!.text = "changed after dispatch";
    fs.writeFileSync(captionPlanPath, JSON.stringify(plan));
    refreshReviewFreshness(project.root);
    expect(readReviewRoundLedger(project.root).chain.map((entry) => entry.event.version))
      .toEqual(["review-round-ask/v1", "review-round-superseded/v1"]);
    // Simulate a crash after the stale commit but before the superseded append.
    const ledger = readReviewRoundLedger(project.root);
    const supersededEntry = ledger.chain.find((entry) => entry.event.version === "review-round-superseded/v1")!;
    fs.rmSync(path.join(ledgerDir(project.root), supersededEntry.file));
    expect(readReviewRoundLedger(project.root).chain).toHaveLength(1);
    // Rerun: the stale early-return path must heal the supersession.
    refreshReviewFreshness(project.root);
    expect(readReviewRoundLedger(project.root).chain.map((entry) => entry.event.version))
      .toEqual(["review-round-ask/v1", "review-round-superseded/v1"]);
  });

  it("produces byte-identical normalized metrics for equivalent projects in different roots", async () => {
    const first = trackedProject();
    await runReviewRound(first, { decision: "request_changes" });
    const second = trackedProject();
    await runReviewRound(second, { decision: "request_changes" });
    // The identical flow in a different root must hash identically: no
    // absolute paths may leak into hashed material.
    const left = buildReport(first.root);
    const right = buildReport(second.root);
    expect(JSON.stringify(left.metrics.review_rounds)).toBe(JSON.stringify(right.metrics.review_rounds));
    expect(JSON.stringify(left.metrics.review_rounds.value)).toBe(JSON.stringify(right.metrics.review_rounds.value));
  });

  it("fails closed on duplicated round identities, forked chains, orphan predecessors, and tampered events", async () => {
    const forked = trackedProject();
    await runReviewRound(forked);
    const ledger = readReviewRoundLedger(forked.root);
    const askEvent = ledger.chain.find((entry) => entry.event.version === "review-round-ask/v1")!;
    // A second response claiming the same Ask forks the chain.
    const conflictingResponse = buildReviewRoundResponseEvent({
      project_id: forked.projectId,
      generation_id: (askEvent.event as { generation_id: string }).generation_id,
      review_identity: (askEvent.event as { review_identity: string }).review_identity,
      ask_event: askEvent.identity,
      ask_id: (askEvent.event as { ask_id: string }).ask_id,
      decision: "approve",
      text: "other",
      response_sha256: reviewRoundResponseHash({ ask_id: (askEvent.event as { ask_id: string }).ask_id, decision: "approve", text: "other" }),
      artifact: { path: "06_review/review-round-responses/forged.json", sha256: sha("forged-artifact") },
      predecessor: askEvent.identity,
    });
    appendReviewRoundEvent(forked.root, conflictingResponse);
    const forkedMetric = readMetric(forked.root);
    expect(forkedMetric.status).toBe("unavailable");
    expect(forkedMetric.limitations.join(" ")).toMatch(/malformed or conflicting/);

    const copiedFile = trackedProject();
    await runReviewRound(copiedFile);
    const files = fs.readdirSync(ledgerDir(copiedFile.root)).sort();
    fs.copyFileSync(path.join(ledgerDir(copiedFile.root), files[0]!), path.join(ledgerDir(copiedFile.root), "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef.json"));
    const copiedMetric = readMetric(copiedFile.root);
    expect(copiedMetric.status).toBe("unavailable");

    const orphan = trackedProject();
    await runReviewRound(orphan);
    const orphanEvent = buildReviewRoundResponseEvent({
      project_id: orphan.projectId,
      generation_id: sha("orphan-generation"),
      review_identity: sha("orphan-review-identity"),
      ask_event: sha("nonexistent-ask"),
      ask_id: "orphan-ask",
      decision: "approve",
      text: null,
      response_sha256: reviewRoundResponseHash({ ask_id: "orphan-ask", decision: "approve", text: null }),
      artifact: { path: "06_review/review-round-responses/orphan.json", sha256: sha("orphan-artifact") },
      predecessor: sha("nonexistent-ask"),
    });
    appendReviewRoundEvent(orphan.root, orphanEvent);
    const orphanMetric = readMetric(orphan.root);
    expect(orphanMetric.status).toBe("unavailable");
    expect(orphanMetric.limitations.join(" ")).toMatch(/malformed or conflicting/);

    const tamperedEvent = trackedProject();
    await runReviewRound(tamperedEvent);
    const eventFiles = fs.readdirSync(ledgerDir(tamperedEvent.root)).sort();
    const firstEventPath = path.join(ledgerDir(tamperedEvent.root), eventFiles[0]!);
    const firstEvent = JSON.parse(fs.readFileSync(firstEventPath, "utf8")) as Record<string, unknown>;
    firstEvent.ask_payload_sha256 = sha("tampered-payload");
    fs.writeFileSync(firstEventPath, `${JSON.stringify(firstEvent, null, 2)}\n`);
    const tamperedMetric = readMetric(tamperedEvent.root);
    expect(tamperedMetric.status).toBe("unavailable");
  });

  it("recovers from interrupted history appends and ignores stale temp files", async () => {
    const project = trackedProject();
    const round = await runReviewRound(project);
    // Simulate a crash that lost the durable event files after the pointer commits.
    const ledger = readReviewRoundLedger(project.root);
    for (const entry of ledger.chain) fs.rmSync(path.join(ledgerDir(project.root), entry.file));
    // A stale temp file is malformed evidence: the scope is never complete.
    // Use a provably dead writer PID so the sweep can reclaim it.
    fs.writeFileSync(path.join(ledgerDir(project.root), "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.json.tmp-999999-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), "junk");
    expect(readReviewRoundLedger(project.root).chain).toHaveLength(0);
    expect(readMetric(project.root).status).toBe("unavailable");
    // Re-recording the same human response heals the durable history idempotently.
    recordReviewResponse(project.root, {
      review_identity: round.reviewIdentity,
      generation_id: round.generationId,
      video_sha256: round.outputSha256,
      timeline_sha256: round.timelineSha256,
      ask_id: round.askId,
      decision: round.decision as "approve" | "request_changes" | "free_text",
      text: null,
    });
    const healed = readReviewRoundLedger(project.root);
    expect(healed.chain.map((entry) => entry.event.version)).toEqual(["review-round-ask/v1", "review-round-response/v1"]);
    const metric = readMetric(project.root);
    expect((metric.value as unknown as { rounds: Array<{ ask: { ask_id: string } }> }).rounds[0]!.ask.ask_id).toBe(round.askId);
  });

  it("appends events idempotently and fails closed on identity conflicts", async () => {
    const project = trackedProject();
    await runReviewRound(project);
    const ledger = readReviewRoundLedger(project.root);
    const askEvent = ledger.chain.find((entry) => entry.event.version === "review-round-ask/v1")!;
    // Identical content: idempotent no-op.
    const again = appendReviewRoundEvent(project.root, askEvent.event);
    expect(again.identity).toBe(askEvent.identity);
    expect(fs.readdirSync(ledgerDir(project.root)).filter((name) => name.endsWith(".json"))).toHaveLength(2);
    // A conflicting file body fails closed.
    const eventPath = path.join(ledgerDir(project.root), askEvent.file);
    const original = fs.readFileSync(eventPath, "utf8");
    fs.writeFileSync(eventPath, `${original}tampered`);
    expect(() => appendReviewRoundEvent(project.root, askEvent.event)).toThrow(/record conflict|not trustworthy/);
    fs.writeFileSync(eventPath, original);
  });

  it("rejects foreign, stale, or unbound human_revision_diff and fails closed on ambiguity", async () => {
    const project = trackedProject();
    const round = await runReviewRound(project);
    const validIdentity = () => ({
      base_timeline: { path: "05_timeline/timeline.json", version: round.timelineVersion, sha256: round.timelineSha256 },
      review_generation: {
        generation_id: round.generationId,
        review_identity: round.reviewIdentity,
        output: { path: `09_output/social-review/generations/${round.generationId.slice(7)}/review.mp4`, sha256: round.outputSha256 },
        review_ready_receipt: {
          path: `09_output/social-review/generations/${round.generationId.slice(7)}/review-ready-receipt.json`,
          sha256: sha(fs.readFileSync(path.join(project.root, "09_output/social-review/generations", round.generationId.slice(7), "review-ready-receipt.json"))),
        },
      },
      review_round: { round_index: 1, round_identity: round.roundIdentity },
    });
    const baseDiff = {
      version: 2,
      project_id: project.projectId,
      handoff_id: "HND_1",
      base_timeline_version: round.timelineVersion,
      capability_profile_id: "premiere",
      status: "review_required",
      summary: { trim: 1, unmapped: 1 },
      operations: [{ operation_id: "OP_1", type: "trim", target: { exchange_clip_id: "XCLIP_1" }, delta: { in_us: 100000, out_us: -200000 } }],
      unmapped_edits: [{ classification: "split_clip", item_ref: "XCLIP_2", review_required: true, reason: "split" }],
    };

    const foreign = trackedProject();
    await runReviewRound(foreign);
    writeYaml(foreign.root, "07_handoff/HND_1/human_revision_diff.yaml", { ...baseDiff, project_id: "other-project", identity: validIdentity() });
    const foreignReport = buildReport(foreign.root);
    expect(foreignReport.metrics.post_export_edit_distance.status).toBe("unavailable");
    expect(flagged(foreign.root, "review_rounds_foreign_revision_diff")).toBe(true);

    const unbound = trackedProject();
    await runReviewRound(unbound);
    writeYaml(unbound.root, "07_handoff/HND_1/human_revision_diff.yaml", { ...baseDiff });
    const unboundReport = buildReport(unbound.root);
    expect(unboundReport.metrics.post_export_edit_distance.status).toBe("unavailable");
    // An identity-less diff is schema-invalid now that identity is mandatory.
    expect(flagged(unbound.root, "review_rounds_malformed_revision_diff")).toBe(true);

    const stale = trackedProject();
    await runReviewRound(stale);
    writeYaml(stale.root, "07_handoff/HND_1/human_revision_diff.yaml", {
      ...baseDiff,
      identity: { ...validIdentity(), base_timeline: { ...validIdentity().base_timeline, sha256: sha("unrelated-timeline") } },
    });
    const staleReport = buildReport(stale.root);
    expect(staleReport.metrics.post_export_edit_distance.status).toBe("unavailable");
    expect(flagged(stale.root, "review_rounds_stale_revision_diff")).toBe(true);

    // Ambiguity: two distinct valid diffs fail closed.
    writeYaml(project.root, "07_handoff/HND_1/human_revision_diff.yaml", { ...baseDiff, identity: validIdentity(), summary: { trim: 1, unmapped: 1 } });
    writeYaml(project.root, "exports/handoffs/HND_2/human_revision_diff.yaml", { ...baseDiff, identity: validIdentity(), summary: { trim: 2, unmapped: 0 }, handoff_id: "HND_2" });
    const ambiguous = buildReport(project.root);
    expect(ambiguous.metrics.post_export_edit_distance.status).toBe("unavailable");
    expect(flagged(project.root, "review_rounds_ambiguous_revision_diff")).toBe(true);
  });

  it("selects an identity-bound human_revision_diff deterministically regardless of mtime order", async () => {
    const project = trackedProject();
    const round = await runReviewRound(project);
    const identity = {
      base_timeline: { path: "05_timeline/timeline.json", version: round.timelineVersion, sha256: round.timelineSha256 },
      review_generation: {
        generation_id: round.generationId,
        review_identity: round.reviewIdentity,
        output: { path: `09_output/social-review/generations/${round.generationId.slice(7)}/review.mp4`, sha256: round.outputSha256 },
        review_ready_receipt: {
          path: `09_output/social-review/generations/${round.generationId.slice(7)}/review-ready-receipt.json`,
          sha256: sha(fs.readFileSync(path.join(project.root, "09_output/social-review/generations", round.generationId.slice(7), "review-ready-receipt.json"))),
        },
      },
      review_round: { round_index: 1, round_identity: round.roundIdentity },
    };
    const body = {
      version: 2,
      project_id: project.projectId,
      handoff_id: "HND_1",
      base_timeline_version: round.timelineVersion,
      capability_profile_id: "premiere",
      status: "review_required",
      summary: { trim: 1, reorder: 1, unmapped: 1 },
      operations: [{ operation_id: "OP_1", type: "trim", target: { exchange_clip_id: "XCLIP_1" }, delta: { in_us: 100000, out_us: -200000 } }],
      unmapped_edits: [{ classification: "split_clip", item_ref: "XCLIP_2", review_required: true, reason: "split" }],
      identity,
    };
    writeYaml(project.root, "07_handoff/HND_1/human_revision_diff.yaml", body);
    fs.mkdirSync(path.join(project.root, "exports/handoffs/HND_1"), { recursive: true });
    fs.copyFileSync(
      path.join(project.root, "07_handoff/HND_1/human_revision_diff.yaml"),
      path.join(project.root, "exports/handoffs/HND_1/human_revision_diff.yaml"),
    );
    // Reverse the mtimes: the later-sorted copy appears oldest.
    const first = path.join(project.root, "07_handoff/HND_1/human_revision_diff.yaml");
    const second = path.join(project.root, "exports/handoffs/HND_1/human_revision_diff.yaml");
    fs.utimesSync(first, new Date(2000), new Date(2000));
    fs.utimesSync(second, new Date(3000), new Date(3000));
    const report = buildReport(project.root);
    // Identical content is deduplicated and deterministically selected.
    expect(report.metrics.post_export_edit_distance.status).toBe("measured");
    expect(report.metrics.post_export_edit_distance.value).toMatchObject({ operation_count: 2, trim_delta_us: 300000 });
    expect(report.metrics.review_rounds.value).toMatchObject({
      human_revision_diff: { path: "07_handoff/HND_1/human_revision_diff.yaml" },
    });
    // Flip the mtimes and confirm the selection is unchanged.
    fs.utimesSync(first, new Date(5000), new Date(5000));
    fs.utimesSync(second, new Date(1000), new Date(1000));
    const flipped = buildReport(project.root);
    expect(computeProductOutcomeMetricsHash(report)).toBe(computeProductOutcomeMetricsHash(flipped));
  });

  it("rejects caller-shaped measured values that carry no verified round evidence", async () => {
    const project = trackedProject();
    await runReviewRound(project);
    const report = buildReport(project.root);
    expect(validateAgainstSchema(report, "product-outcome-metrics.schema.json").valid).toBe(true);
    const forged = JSON.parse(JSON.stringify(report)) as ProductOutcomeMetrics;
    (forged.metrics.review_rounds as { value: unknown }).value = 999;
    expect(validateAgainstSchema(forged, "product-outcome-metrics.schema.json").valid).toBe(false);
    // The runtime rederivation guarantees a built report can never diverge:
    // verified_rounds always equals the bound verified-round evidence length.
    const rebuilt = buildProductOutcomeMetrics(project.root, "2026-08-29T12:00:00.000Z");
    const rebuiltValue = rebuilt.metrics.review_rounds.value as unknown as { rounds: unknown[] };
    expect(rebuiltValue.rounds).toHaveLength(1);
    // A structured forged count with a serialized verified_rounds field is
    // schema-invalid: rounds is the sole serialized count source.
    const forgedShape = JSON.parse(JSON.stringify(rebuilt)) as { metrics: { review_rounds: { value: Record<string, unknown> } } };
    forgedShape.metrics.review_rounds.value = { ...(forgedShape.metrics.review_rounds.value as Record<string, unknown>), verified_rounds: 999 };
    expect(validateAgainstSchema(forgedShape, "product-outcome-metrics.schema.json").valid).toBe(false);
  });
});

async function finalizeOnlyGeneration(project: RoundProject): Promise<void> {
  await runReviewRound(project, { skipDispatch: true });
}

function askEventIdentityOf(project: RoundProject): string {
  const ask = JSON.parse(fs.readFileSync(path.join(project.root, "06_review/review-ask.json"), "utf8")) as { round_event_sha256?: string };
  return ask.round_event_sha256 ?? "";
}

function flagMessage(root: string, fragment: string): boolean {
  return buildProductOutcomeMetrics(root, "2026-08-29T12:00:00.000Z")
    .degraded_run_flags.some((flag) => flag.message.includes(fragment));
}

function flagged(root: string, code: string): boolean {
  return buildProductOutcomeMetrics(root, "2026-08-29T12:00:00.000Z")
    .degraded_run_flags.some((flag) => flag.code === code);
}

function newestGenerationDir(root: string): string {
  const generationsRoot = path.join(root, "09_output/social-review/generations");
  const entries = fs.readdirSync(generationsRoot).sort();
  if (entries.length === 0) throw new Error("no generations in fixture");
  return path.join(generationsRoot, entries[entries.length - 1]!);
}

function writeYaml(root: string, relative: string, data: unknown): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, stringifyYaml(data), "utf-8");
}
