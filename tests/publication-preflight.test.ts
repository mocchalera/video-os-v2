import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { computeSha256 } from "../runtime/packaging/manifest.js";
import { runPublicationPreflight } from "../runtime/packaging/publication-preflight.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function createPublicationProject(): { projectDir: string; videoSha256: string } {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-os-publication-"));
  tempDirs.push(projectDir);
  fs.mkdirSync(path.join(projectDir, "07_package"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "09_output"), { recursive: true });
  const videoPath = path.join(projectDir, "09_output", "final.mp4");
  fs.writeFileSync(videoPath, "canonical-video", "utf-8");
  const videoSha256 = computeSha256(videoPath);
  fs.writeFileSync(path.join(projectDir, "07_package", "qa-report.json"), JSON.stringify({
    project_id: "publication-test",
    passed: true,
  }));
  fs.writeFileSync(path.join(projectDir, "07_package", "package_manifest.json"), JSON.stringify({
    project_id: "publication-test",
    artifacts: { final_video: { path: videoPath, sha256: videoSha256 } },
  }));
  const approval = {
    version: "publication-approval/v1",
    project_id: "publication-test",
    created_at: "2026-07-21T00:00:00.000Z",
    canonical_video: { path: "09_output/final.mp4", sha256: videoSha256 },
    approvals: Object.fromEntries(["creative", "rights", "privacy"].map((kind) => [kind, {
      status: "approved",
      approved_by: "operator",
      approved_at: "2026-07-21T00:00:00.000Z",
      scope: `${kind} approved for unlisted YouTube delivery`,
      artifact_sha256: videoSha256,
    }])),
    destinations: [{ platform: "youtube", visibility: "unlisted", account: "AX-1" }],
  };
  fs.writeFileSync(
    path.join(projectDir, "07_package", "publication_approval.yaml"),
    stringifyYaml(approval),
  );
  return { projectDir, videoSha256 };
}

describe("publication preflight", () => {
  it("passes only when QA, package manifest, approvals, destination, and canonical hash agree", () => {
    const { projectDir, videoSha256 } = createPublicationProject();
    const result = runPublicationPreflight(projectDir, {
      platform: "youtube",
      visibility: "unlisted",
    });

    expect(result.ready).toBe(true);
    expect(result.canonical_video?.sha256).toBe(videoSha256);
    expect(result.checks.every((check) => check.passed)).toBe(true);
  });

  it("fails closed when the approved video changes after approval", () => {
    const { projectDir } = createPublicationProject();
    fs.appendFileSync(path.join(projectDir, "09_output", "final.mp4"), "-changed");

    const result = runPublicationPreflight(projectDir, {
      platform: "youtube",
      visibility: "unlisted",
    });

    expect(result.ready).toBe(false);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "canonical_video_hash_valid", passed: false }),
      expect.objectContaining({ name: "rights_approval_bound_to_video", passed: false }),
      expect.objectContaining({ name: "package_manifest_bound_to_video", passed: false }),
    ]));
  });

  it("fails when the requested visibility was not approved", () => {
    const { projectDir } = createPublicationProject();
    const result = runPublicationPreflight(projectDir, {
      platform: "youtube",
      visibility: "public",
    });

    expect(result.ready).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "destination_approved",
      passed: false,
    }));
  });
});
