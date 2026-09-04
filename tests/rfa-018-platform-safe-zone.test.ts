import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadPlatformSafeZoneRegistry,
  runPlatformSafeZoneRegression,
  selectPlatformSafeZoneProfile,
  verifyPlatformScreenshotEvidence,
} from "../runtime/platform/safe-zone-profile.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";

const root = process.cwd();

describe("RFA-018 platform safe-zone evidence foundation", () => {
  it("passes geometry regression only for the anonymous verified fixture", () => {
    const registry = loadPlatformSafeZoneRegistry(root);
    expect(registry.malformed).toEqual([]);
    const fixture = registry.profiles.find((item) => item.profile.profile_id === "fixture-anonymous-verified-v1");
    expect(fixture).toBeDefined();
    verifyPlatformScreenshotEvidence(fixture!.profile, root);
    const receipt = runPlatformSafeZoneRegression({
      profile: fixture!.profile,
      profileHash: fixture!.hash,
      rootDir: root,
      elements: [
        { id: "caption", kind: "caption", rect: { x: 0.2, y: 0.72, width: 0.6, height: 0.08 } },
        { id: "anchor", kind: "anchor", rect: { x: 0.2, y: 0.2, width: 0.2, height: 0.08 } },
        { id: "content", kind: "content", rect: { x: 0.25, y: 0.35, width: 0.5, height: 0.2 } },
        { id: "profile-overlay", kind: "profile_overlay", rect: { x: 0.7, y: 0.2, width: 0.12, height: 0.08 } },
      ],
    });
    expect(receipt.status).toBe("pass");
    expect(receipt.checks.every((check) => check.status === "pass")).toBe(true);
    expect(receipt.profile_hash).toBe(fixture!.hash);
  });

  it("degrades stale and unknown fixtures to unknown geometry with a human hold", () => {
    for (const variant of ["stale", "unknown", "fallback"]) {
      const selection = selectPlatformSafeZoneProfile({ rootDir: root, platform: "fixture", surface: "fixture", variant });
      expect(selection.status).toBe("human_hold");
      expect(selection.human_preview_required).toBe(true);
      const receipt = runPlatformSafeZoneRegression({
        profile: selection.profile!.profile,
        elements: [{ id: "caption", kind: "caption", rect: { x: 0.2, y: 0.72, width: 0.6, height: 0.08 } }],
      });
      expect(receipt.status).toBe("human_hold");
      expect(receipt.checks).toEqual(expect.arrayContaining([expect.objectContaining({ status: "unknown" })]));
    }
  });

  it("keeps all three production organic profiles on hold and isolates ads", () => {
    for (const platform of ["instagram", "tiktok", "youtube_shorts"] as const) {
      const organic = selectPlatformSafeZoneProfile({ rootDir: root, platform, surface: "organic", variant: "production-organic" });
      expect(organic.status).toBe("human_hold");
      expect(organic.human_preview_required).toBe(true);
      expect(organic.profile?.profile.geometry.safe_regions.unknown).toBe(true);
      expect(organic.profile?.profile.geometry.ui_regions.unknown).toBe(true);
      expect(organic.profile?.profile.screenshot_evidence.status).not.toBe("verified");
      expect(organic.profile?.profile.measured_at).toBeNull();
      expect(organic.profile?.profile.geometry.safe_regions.regions).toEqual([]);
      expect(organic.profile?.profile.screenshot_evidence.path).toBeUndefined();
      if (platform !== "youtube_shorts") {
        const ads = selectPlatformSafeZoneProfile({ rootDir: root, platform, surface: "ads", variant: "ads-reference" });
        expect(ads.profile?.profile.surface).toBe("ads");
        expect(ads.profile?.profile.profile_id).not.toBe(organic.profile?.profile.profile_id);
      }
    }
  });

  it("fails closed when a verified screenshot hash is changed", () => {
    const registry = loadPlatformSafeZoneRegistry(root);
    const fixturePath = path.join(root, "tests/fixtures/platform-preview/anonymous-safe-zone.svg");
    const profile = registry.profiles.find((item) => item.profile.profile_id === "fixture-anonymous-verified-v1")!.profile;
    const changed = structuredClone(profile);
    changed.screenshot_evidence.sha256 = `sha256:${"0".repeat(64)}`;
    expect(() => verifyPlatformScreenshotEvidence(changed, root)).toThrow(/hash mismatch/);
    expect(fs.existsSync(fixturePath)).toBe(true);
  });

  it("does not allow synthetic geometry to become a verified production profile", () => {
    const registry = loadPlatformSafeZoneRegistry(root);
    const fixture = registry.profiles.find((item) => item.profile.profile_id === "fixture-anonymous-verified-v1")!.profile;
    const productionClaim = { ...structuredClone(fixture), platform: "instagram", surface: "organic", profile_id: "invalid-production-claim-v1" };
    expect(validateAgainstSchema(productionClaim, "platform-safe-zone-profile.schema.json").valid).toBe(false);
  });

  it("rejects an official-documentation-only production verified claim without current measurement evidence", () => {
    const registry = loadPlatformSafeZoneRegistry(root);
    const fixture = registry.profiles.find((item) => item.profile.profile_id === "fixture-anonymous-verified-v1")!.profile;
    const productionClaim = structuredClone(fixture);
    productionClaim.platform = "instagram";
    productionClaim.surface = "organic";
    productionClaim.profile_id = "invalid-production-official-only-v1";
    productionClaim.measured_at = null;
    productionClaim.source_references = [{ url: "https://www.facebook.com/help/instagram/1038071743007909", retrieved_at: "2026-08-21", published_date: null, owner: "Instagram", evidence_kind: "official_documentation" }];
    expect(validateAgainstSchema(productionClaim, "platform-safe-zone-profile.schema.json").valid).toBe(false);
  });

  it("rejects a production verified claim whose screenshot evidence remains unknown", () => {
    const registry = loadPlatformSafeZoneRegistry(root);
    const fixture = registry.profiles.find((item) => item.profile.profile_id === "fixture-anonymous-verified-v1")!.profile;
    const productionClaim = structuredClone(fixture);
    productionClaim.platform = "instagram";
    productionClaim.surface = "organic";
    productionClaim.profile_id = "invalid-production-screenshot-unknown-v1";
    productionClaim.screenshot_evidence.status = "unknown";
    expect(validateAgainstSchema(productionClaim, "platform-safe-zone-profile.schema.json").valid).toBe(false);
  });
});
