import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import { computeSha256 } from "../runtime/packaging/manifest.js";
import { computeNormalizedJsonHash } from "../runtime/artifacts/p1-manifest-coverage.js";
import {
  computePrivatePilotInputFingerprint,
  evaluatePrivatePilot,
  PRIVATE_PILOT_GATES,
} from "../runtime/pilot/private-pilot-gates.js";
import {
  buildExternalRenderRouteReceipt,
  type ExternalRouteMetadata,
} from "../runtime/render/route-resolver.js";
import { parsePrivatePilotArgs, runPrivatePilotCli } from "../scripts/private-pilot.js";

const fixtureRoot = path.resolve("tests/fixtures/private-pilot");
const externalRouteMetadataFixturePath = path.resolve("tests/fixtures/external-route-metadata/day1-external-nle.json");

function fixtureDir(name: "pending" | "ready-synthetic"): string {
  return path.join(fixtureRoot, name);
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function copyFixture(name: "pending" | "ready-synthetic"): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), `rfa-016-${name}-`));
  fs.cpSync(fixtureDir(name), target, { recursive: true });
  return target;
}

function refreshManifestReceiptHashes(projectDir: string): void {
  const manifestPath = path.join(projectDir, "manifest.json");
  const manifest = readJson<{ receipts: Array<{ path: string; sha256: string }> }>(manifestPath);
  for (const receipt of manifest.receipts) {
    receipt.sha256 = computeSha256(path.join(projectDir, receipt.path));
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function refreshPlatformPreviewReferences(projectDir: string): void {
  const profilePath = path.join(projectDir, "platform-profile.json");
  const profile = readJson<Record<string, any>>(profilePath);
  const profileHash = computeSha256(profilePath);
  const safeZonePath = path.join(projectDir, "safe-zone-receipt.json");
  const safeZone = readJson<Record<string, any>>(safeZonePath);
  safeZone.profile_id = profile.profile_id;
  safeZone.profile_hash = profileHash;
  delete safeZone.receipt_hash;
  safeZone.receipt_hash = computeNormalizedJsonHash(safeZone);
  writeJson(safeZonePath, safeZone);

  const receiptPath = path.join(projectDir, "receipts/platform-preview.json");
  const receipt = readJson<Record<string, any>>(receiptPath);
  const preview = receipt.evidence.platform_preview;
  preview.profile.sha256 = profileHash;
  preview.profile_evidence_status = profile.evidence_status;
  preview.profile_supersession_state = profile.supersession.state;
  preview.safe_zone_receipt.sha256 = computeSha256(safeZonePath);
  receipt.provenance.profile.sha256 = profileHash;
  writeJson(receiptPath, receipt);
  refreshManifestReceiptHashes(projectDir);
}

function addConfirmedRouteReceipt(projectDir: string): { path: string; sha256: string } {
  const inputsPath = path.join(projectDir, "inputs.json");
  const nleEvidencePath = path.join(projectDir, "evidence-nle.json");
  const externalRouteMetadataFixture = readJson<ExternalRouteMetadata>(externalRouteMetadataFixturePath);
  const inputRef = { path: "inputs.json", sha256: computeSha256(inputsPath) };
  const nleEvidenceRef = { path: "evidence-nle.json", sha256: computeSha256(nleEvidencePath) };
  const metadata: ExternalRouteMetadata = {
    ...structuredClone(externalRouteMetadataFixture),
    project_id: "rfa-016-required-nle",
    source_identity: {
      ...structuredClone(externalRouteMetadataFixture.source_identity),
      timeline: inputRef,
    },
    output: inputRef,
    required_handoff_artifacts: [nleEvidenceRef],
    handoff: {
      status: "confirmed",
      human_owner: "synthetic-nle-confirmation",
      human_approval_status: "approved",
      artifacts: [nleEvidenceRef],
    },
    human_approval: {
      status: "approved",
      owner: "synthetic-nle-confirmation",
    },
  };
  const routeReceipt = buildExternalRenderRouteReceipt(metadata);
  const routePath = path.join(projectDir, "receipts/render-route-receipt.json");
  writeJson(routePath, routeReceipt);
  const routeRef = { path: "receipts/render-route-receipt.json", sha256: computeSha256(routePath) };

  const receiptPath = path.join(projectDir, "receipts/nle-handoff.json");
  const receipt = readJson<Record<string, any>>(receiptPath);
  receipt.status = "confirmed";
  receipt.decision = "pass";
  receipt.evidence.handoff.confirmation = "confirmed";
  receipt.evidence.handoff.artifacts.push(routeRef);
  receipt.evidence.artifacts.push(routeRef);
  writeJson(receiptPath, receipt);
  refreshManifestReceiptHashes(projectDir);
  return routeRef;
}

describe("RFA-016 private pilot gate separation", () => {
  it("validates both representative manifests and all four independent receipt schemas", () => {
    for (const name of ["pending", "ready-synthetic"] as const) {
      const root = fixtureDir(name);
      const manifest = readJson<unknown>(path.join(root, "manifest.json"));
      expect(validateAgainstSchema(manifest, "private-pilot-manifest.schema.json")).toEqual({ valid: true, errors: [] });
      for (const gate of PRIVATE_PILOT_GATES) {
        const receiptPath = path.join(root, "receipts", {
          agent_qa: "agent-qa.json",
          human_visual_audio: "human-visual-audio.json",
          nle_handoff: "nle-handoff.json",
          platform_preview: "platform-preview.json",
        }[gate]);
        expect(validateAgainstSchema(readJson(receiptPath), "private-pilot-gate-receipt.schema.json")).toEqual({ valid: true, errors: [] });
      }
    }
  });

  it("passes complete Phase 7 agent QA coverage and holds incomplete coverage", () => {
    const complete = evaluatePrivatePilot(fixtureDir("pending"), { manifestPath: "manifest.json" });
    expect(complete.gates.agent_qa).toMatchObject({ ready: true, status: "passed", decision: "pass" });
    expect(readJson<{ evidence: { checks: Array<{ id: string }> } }>(path.join(fixtureDir("pending"), "receipts/agent-qa.json")).evidence.checks.map((check) => check.id)).toEqual([
      "schema", "timing", "caption", "safe-zone", "audio", "SFX", "route", "accessibility",
    ]);

    const incompleteProject = copyFixture("ready-synthetic");
    const incompletePath = path.join(incompleteProject, "receipts/agent-qa.json");
    const incomplete = readJson<Record<string, any>>(incompletePath);
    incomplete.evidence.checks = incomplete.evidence.checks.filter((check: { id: string }) => check.id !== "accessibility");
    writeJson(incompletePath, incomplete);
    refreshManifestReceiptHashes(incompleteProject);
    const incompleteResult = evaluatePrivatePilot(incompleteProject, { manifestPath: "manifest.json" });
    expect(incompleteResult.gates.agent_qa.ready).toBe(false);
    expect(incompleteResult.reasons.some((reason) => reason.includes("agent_qa: receipt schema invalid"))).toBe(true);
  });

  it("does not accept arbitrary agent QA check IDs", () => {
    const projectDir = copyFixture("ready-synthetic");
    const receiptPath = path.join(projectDir, "receipts/agent-qa.json");
    const receipt = readJson<Record<string, any>>(receiptPath);
    receipt.evidence.checks = Array.from({ length: 8 }, (_, index) => ({ id: `arbitrary-${index}`, status: "pass", details: "not a Phase 7 domain" }));
    writeJson(receiptPath, receipt);
    refreshManifestReceiptHashes(projectDir);

    const result = evaluatePrivatePilot(projectDir, { manifestPath: "manifest.json" });
    expect(result.ready).toBe(false);
    expect(result.gates.agent_qa.ready).toBe(false);
    expect(result.reasons.some((reason) => reason.includes("agent_qa: receipt schema invalid"))).toBe(true);
  });

  it("keeps agent pass separate from the three pending/HOLD gates", () => {
    const result = evaluatePrivatePilot(fixtureDir("pending"), { manifestPath: "manifest.json" });
    expect(result.ready).toBe(false);
    expect(result.gates.agent_qa).toMatchObject({ ready: true, status: "passed", decision: "pass", freshness: "fresh" });
    expect(result.gates.human_visual_audio).toMatchObject({ ready: false, status: "pending", decision: "hold" });
    expect(result.gates.nle_handoff).toMatchObject({ ready: false, status: "pending", decision: "hold" });
    expect(result.gates.platform_preview).toMatchObject({ ready: false, status: "pending", decision: "hold" });
    expect(result.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining("human_visual_audio: human visual/audio approval"),
      expect.stringContaining("nle_handoff: required NLE handoff"),
      expect.stringContaining("platform_preview: platform preview"),
    ]));
  });

  it("accepts only the fully explicit synthetic metadata-only shape", () => {
    const result = evaluatePrivatePilot(fixtureDir("ready-synthetic"), { manifestPath: "manifest.json" });
    expect(result).toMatchObject({
      ready: true,
      decision: "ready",
      synthetic_fixture: true,
      public_promotion: "out_of_scope",
    });
    expect(result.gates).toMatchObject({
      agent_qa: { ready: true, status: "passed", decision: "pass" },
      human_visual_audio: { ready: true, status: "approved", decision: "approve" },
      nle_handoff: { ready: true, status: "not_required", decision: "not_required" },
      platform_preview: { ready: true, status: "approved", decision: "approve" },
    });
    expect(result.reasons).toEqual([]);
  });

  it("fails closed on stale evidence even when the receipt hash is updated", () => {
    const projectDir = copyFixture("ready-synthetic");
    const receiptPath = path.join(projectDir, "receipts/human-visual-audio.json");
    const receipt = readJson<{ freshness: { status: string; reason: string } }>(receiptPath);
    receipt.freshness.status = "stale";
    receipt.freshness.reason = "fixture intentionally stale";
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    refreshManifestReceiptHashes(projectDir);

    const result = evaluatePrivatePilot(projectDir, { manifestPath: "manifest.json" });
    expect(result.ready).toBe(false);
    expect(result.gates.human_visual_audio).toMatchObject({ ready: false, freshness: "stale" });
    expect(result.reasons).toContain("human_visual_audio: human_visual_audio evidence is stale; fresh evidence is required");
  });

  it("fails closed on mismatched input hashes and does not let a safe-zone receipt pass platform preview", () => {
    const projectDir = copyFixture("ready-synthetic");
    const inputPath = path.join(projectDir, "inputs.json");
    fs.writeFileSync(inputPath, `${JSON.stringify({ changed: true })}\n`, "utf8");
    const result = evaluatePrivatePilot(projectDir, { manifestPath: "manifest.json" });
    expect(result.ready).toBe(false);
    expect(result.reasons.some((reason) => reason.includes("manifest provenance.inputs: hash mismatch"))).toBe(true);

    const platformProject = copyFixture("ready-synthetic");
    const platformReceiptPath = path.join(platformProject, "receipts/platform-preview.json");
    const platformReceipt = readJson<{ evidence: { platform_preview: { current_profile: boolean; human_preview: boolean } } }>(platformReceiptPath);
    platformReceipt.evidence.platform_preview.current_profile = false;
    platformReceipt.evidence.platform_preview.human_preview = false;
    fs.writeFileSync(platformReceiptPath, `${JSON.stringify(platformReceipt, null, 2)}\n`, "utf8");
    refreshManifestReceiptHashes(platformProject);
    const platformResult = evaluatePrivatePilot(platformProject, { manifestPath: "manifest.json" });
    expect(platformResult.ready).toBe(false);
    expect(platformResult.gates.platform_preview.ready).toBe(false);
    expect(platformResult.reasons).toContain("platform_preview: platform preview requires a current delivery profile and human preview; safe-zone automation alone cannot pass");
  });

  it("fails closed when the current profile identity does not match preview evidence", () => {
    const projectDir = copyFixture("ready-synthetic");
    const profilePath = path.join(projectDir, "platform-profile.json");
    const profile = readJson<Record<string, unknown>>(profilePath);
    profile.profile_id = "different-profile";
    fs.writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");

    const platformReceiptPath = path.join(projectDir, "receipts/platform-preview.json");
    const platformReceipt = readJson<{
      evidence: { platform_preview: { profile: { sha256: string } } };
      provenance: { profile: { sha256: string } };
    }>(platformReceiptPath);
    const profileHash = computeSha256(profilePath);
    platformReceipt.evidence.platform_preview.profile.sha256 = profileHash;
    platformReceipt.provenance.profile.sha256 = profileHash;
    fs.writeFileSync(platformReceiptPath, `${JSON.stringify(platformReceipt, null, 2)}\n`, "utf8");
    refreshManifestReceiptHashes(projectDir);

    const result = evaluatePrivatePilot(projectDir, { manifestPath: "manifest.json" });
    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("platform_preview: platform preview profile_id mismatch: preview=synthetic-platform-profile profile=different-profile");
  });

  it("fails closed for invalid, mismatched, or stale platform profile contracts", () => {
    const invalidVersionProject = copyFixture("ready-synthetic");
    const invalidVersionProfile = readJson<Record<string, any>>(path.join(invalidVersionProject, "platform-profile.json"));
    invalidVersionProfile.version = "platform-safe-zone-profile/v0";
    writeJson(path.join(invalidVersionProject, "platform-profile.json"), invalidVersionProfile);
    refreshPlatformPreviewReferences(invalidVersionProject);
    const invalidVersionResult = evaluatePrivatePilot(invalidVersionProject, { manifestPath: "manifest.json" });
    expect(invalidVersionResult.gates.platform_preview.ready).toBe(false);
    expect(invalidVersionResult.reasons.some((reason) => reason.includes("platform_preview: platform preview profile contract invalid"))).toBe(true);

    const mismatchedPlatformProject = copyFixture("ready-synthetic");
    const mismatchedPlatformProfile = readJson<Record<string, any>>(path.join(mismatchedPlatformProject, "platform-profile.json"));
    mismatchedPlatformProfile.platform = "tiktok";
    mismatchedPlatformProfile.surface = "ads";
    writeJson(path.join(mismatchedPlatformProject, "platform-profile.json"), mismatchedPlatformProfile);
    refreshPlatformPreviewReferences(mismatchedPlatformProject);
    const mismatchedPlatformResult = evaluatePrivatePilot(mismatchedPlatformProject, { manifestPath: "manifest.json" });
    expect(mismatchedPlatformResult.gates.platform_preview.ready).toBe(false);
    expect(mismatchedPlatformResult.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining("platform_preview: platform preview platform mismatch"),
      expect.stringContaining("platform_preview: platform preview surface mismatch"),
    ]));

    const staleProject = copyFixture("ready-synthetic");
    const staleProfile = readJson<Record<string, any>>(path.join(staleProject, "platform-profile.json"));
    staleProfile.evidence_status = "stale";
    staleProfile.geometry.status = "stale";
    writeJson(path.join(staleProject, "platform-profile.json"), staleProfile);
    refreshPlatformPreviewReferences(staleProject);
    const staleResult = evaluatePrivatePilot(staleProject, { manifestPath: "manifest.json" });
    expect(staleResult.gates.platform_preview.ready).toBe(false);
    expect(staleResult.reasons).toContain("platform_preview: platform preview current_profile mismatch: receipt=true profile_current=false");
  });

  it("fails closed when the safe-zone receipt identity is mismatched", () => {
    const projectDir = copyFixture("ready-synthetic");
    const safeZonePath = path.join(projectDir, "safe-zone-receipt.json");
    const safeZone = readJson<Record<string, any>>(safeZonePath);
    safeZone.profile_id = "different-profile";
    delete safeZone.receipt_hash;
    safeZone.receipt_hash = computeNormalizedJsonHash(safeZone);
    writeJson(safeZonePath, safeZone);
    const platformReceiptPath = path.join(projectDir, "receipts/platform-preview.json");
    const platformReceipt = readJson<Record<string, any>>(platformReceiptPath);
    platformReceipt.evidence.platform_preview.safe_zone_receipt.sha256 = computeSha256(safeZonePath);
    writeJson(platformReceiptPath, platformReceipt);
    refreshManifestReceiptHashes(projectDir);

    const result = evaluatePrivatePilot(projectDir, { manifestPath: "manifest.json" });
    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("platform_preview: platform preview safe-zone profile_id mismatch: receipt=different-profile profile=synthetic-platform-profile");
  });

  it("fails closed when a required nested NLE artifact escapes the project root", () => {
    const projectDir = copyFixture("pending");
    const receiptPath = path.join(projectDir, "receipts/nle-handoff.json");
    const receipt = readJson<Record<string, any>>(receiptPath);
    receipt.evidence.handoff.artifacts[0].path = "../../missing-outside-project.mov";
    writeJson(receiptPath, receipt);
    refreshManifestReceiptHashes(projectDir);

    const result = evaluatePrivatePilot(projectDir, { manifestPath: "manifest.json" });
    expect(result.ready).toBe(false);
    expect(result.reasons.some((reason) => reason.includes("nle_handoff handoff.artifacts: artifact escapes project root: ../../missing-outside-project.mov"))).toBe(true);
  });

  it("fails closed for rejected receipts and direct receipt hash mismatches", () => {
    const rejectedProject = copyFixture("ready-synthetic");
    const rejectedPath = path.join(rejectedProject, "receipts/human-visual-audio.json");
    const rejected = readJson<Record<string, any>>(rejectedPath);
    rejected.status = "rejected";
    rejected.decision = "reject";
    rejected.evidence.human_review.decision = "rejected";
    writeJson(rejectedPath, rejected);
    refreshManifestReceiptHashes(rejectedProject);
    const rejectedResult = evaluatePrivatePilot(rejectedProject, { manifestPath: "manifest.json" });
    expect(rejectedResult.gates.human_visual_audio.ready).toBe(false);
    expect(rejectedResult.reasons.some((reason) => reason.includes("human_visual_audio: human visual/audio approval must independently declare status=approved and decision=approve; got rejected/reject"))).toBe(true);

    const tamperedProject = copyFixture("ready-synthetic");
    const tamperedPath = path.join(tamperedProject, "receipts/human-visual-audio.json");
    const tampered = readJson<Record<string, any>>(tamperedPath);
    tampered.freshness.reason = "tampered without receipt manifest refresh";
    writeJson(tamperedPath, tampered);
    const tamperedResult = evaluatePrivatePilot(tamperedProject, { manifestPath: "manifest.json" });
    expect(tamperedResult.ready).toBe(false);
    expect(tamperedResult.reasons.some((reason) => reason.includes("human_visual_audio: receipt hash mismatch"))).toBe(true);
  });

  it("requires an explicitly identified confirmed M5A route receipt for required NLE", () => {
    const genericProject = copyFixture("pending");
    const genericPath = path.join(genericProject, "receipts/nle-handoff.json");
    const generic = readJson<Record<string, any>>(genericPath);
    generic.status = "confirmed";
    generic.decision = "pass";
    generic.evidence.handoff.confirmation = "confirmed";
    writeJson(genericPath, generic);
    refreshManifestReceiptHashes(genericProject);
    const genericResult = evaluatePrivatePilot(genericProject, { manifestPath: "manifest.json" });
    expect(genericResult.gates.nle_handoff.ready).toBe(false);
    expect(genericResult.reasons).toContain("nle_handoff: required NLE handoff must include a valid render-route-receipt/v3 artifact with confirmed supplied/external handoff identity bound to pilot common inputs");

    const confirmedProject = copyFixture("pending");
    const routeRef = addConfirmedRouteReceipt(confirmedProject);
    const confirmedResult = evaluatePrivatePilot(confirmedProject, { manifestPath: "manifest.json" });
    expect(confirmedResult.gates.nle_handoff).toMatchObject({ ready: true, status: "confirmed", decision: "pass" });
    expect(confirmedResult.gates.nle_handoff.issues).toEqual([]);
    expect(readJson<Record<string, any>>(path.join(confirmedProject, routeRef.path)).receipt_version).toBe("render-route-receipt/v3");

    const pendingRouteProject = copyFixture("pending");
    addConfirmedRouteReceipt(pendingRouteProject);
    const pendingRoutePath = path.join(pendingRouteProject, "receipts/render-route-receipt.json");
    const pendingRoute = readJson<Record<string, any>>(pendingRoutePath);
    pendingRoute.route_evidence.handoff.status = "pending";
    writeJson(pendingRoutePath, pendingRoute);
    const pendingNlePath = path.join(pendingRouteProject, "receipts/nle-handoff.json");
    const pendingNle = readJson<Record<string, any>>(pendingNlePath);
    const pendingRouteRef = pendingNle.evidence.handoff.artifacts.find((artifact: { path: string }) => artifact.path === "receipts/render-route-receipt.json");
    pendingRouteRef.sha256 = computeSha256(pendingRoutePath);
    const pendingManifest = readJson<Record<string, any>>(path.join(pendingRouteProject, "manifest.json"));
    const pendingManifestNleRef = pendingManifest.receipts.find((receipt: { gate: string }) => receipt.gate === "nle_handoff");
    writeJson(pendingNlePath, pendingNle);
    pendingManifestNleRef.sha256 = computeSha256(pendingNlePath);
    writeJson(path.join(pendingRouteProject, "manifest.json"), pendingManifest);
    const pendingRouteResult = evaluatePrivatePilot(pendingRouteProject, { manifestPath: "manifest.json" });
    expect(pendingRouteResult.gates.nle_handoff.ready).toBe(false);
    expect(pendingRouteResult.reasons).toContain("nle_handoff: required NLE handoff must include a valid render-route-receipt/v3 artifact with confirmed supplied/external handoff identity bound to pilot common inputs");
  });

  it("rejects a confirmed route timeline present only in NLE receipt provenance", () => {
    const projectDir = copyFixture("pending");
    addConfirmedRouteReceipt(projectDir);
    const timelinePath = path.join(projectDir, "receipt-only-timeline.json");
    writeJson(timelinePath, { fixture: "receipt-only-timeline" });
    const timelineRef = { path: "receipt-only-timeline.json", sha256: computeSha256(timelinePath) };

    const routePath = path.join(projectDir, "receipts/render-route-receipt.json");
    const routeReceipt = readJson<Record<string, any>>(routePath);
    routeReceipt.inputs.timeline = timelineRef;
    routeReceipt.route_evidence.source_identity.timeline = timelineRef;
    writeJson(routePath, routeReceipt);
    expect(validateAgainstSchema(readJson(routePath), "render-route-receipt.schema.json")).toEqual({ valid: true, errors: [] });

    const nlePath = path.join(projectDir, "receipts/nle-handoff.json");
    const nleReceipt = readJson<Record<string, any>>(nlePath);
    nleReceipt.provenance.inputs.push(timelineRef);
    nleReceipt.freshness.input_fingerprint = computePrivatePilotInputFingerprint(nleReceipt.provenance.inputs);
    for (const artifact of [...nleReceipt.evidence.artifacts, ...nleReceipt.evidence.handoff.artifacts]) {
      if (artifact.path === "receipts/render-route-receipt.json") artifact.sha256 = computeSha256(routePath);
    }
    writeJson(nlePath, nleReceipt);
    refreshManifestReceiptHashes(projectDir);

    const result = evaluatePrivatePilot(projectDir, { manifestPath: "manifest.json" });
    expect(result.gates.nle_handoff.ready).toBe(false);
    expect(result.reasons).toContain("nle_handoff: required NLE handoff must include a valid render-route-receipt/v3 artifact with confirmed supplied/external handoff identity bound to pilot common inputs");
  });

  it("binds the freshness fingerprint to the ordered provenance inputs", () => {
    expect(computePrivatePilotInputFingerprint([
      { path: "b.json", sha256: `sha256:${"b".repeat(64)}` },
      { path: "a.json", sha256: `sha256:${"a".repeat(64)}` },
    ])).toBe(computePrivatePilotInputFingerprint([
      { path: "a.json", sha256: `sha256:${"a".repeat(64)}` },
      { path: "b.json", sha256: `sha256:${"b".repeat(64)}` },
    ]));
  });

  it("provides a read-only CLI with a non-zero HOLD exit and a ready exit", () => {
    expect(parsePrivatePilotArgs([
      "node",
      "scripts/private-pilot.ts",
      "--project",
      fixtureDir("pending"),
      "--manifest",
      "manifest.json",
      "--json",
    ])).toMatchObject({ projectDir: fixtureDir("pending"), manifestPath: "manifest.json", json: true });

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(runPrivatePilotCli(["node", "scripts/private-pilot.ts", "--project", fixtureDir("pending"), "--manifest", "manifest.json", "--json"])).toBe(1);
      expect(runPrivatePilotCli(["node", "scripts/private-pilot.ts", "--project", fixtureDir("ready-synthetic"), "--manifest", "manifest.json", "--json"])).toBe(0);
      expect(log).toHaveBeenCalledTimes(2);
      expect(String(log.mock.calls[1][0])).toContain('"public_promotion": "out_of_scope"');
    } finally {
      log.mockRestore();
    }
  });
});
