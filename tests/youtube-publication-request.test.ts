import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  resolveYoutubePublicationRequest,
} from "../scripts/youtube-upload.js";
import { computeSha256 } from "../runtime/packaging/manifest.js";
import {
  youtubeUploadMetadataSha256,
  type YoutubeUploadMetadata,
} from "../runtime/packaging/youtube-resumable-upload.js";

const tempDirs: string[] = [];
const metadata: YoutubeUploadMetadata = {
  snippet: {
    title: "AX-1 short 01",
    description: "Approved local fixture",
    tags: ["AX-1", "AI"],
    categoryId: "22",
  },
};

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createProject(
  version: "publication-approval/v1" | "publication-approval/v2" =
    "publication-approval/v2",
): {
  projectDir: string;
  metadataPath: string;
  videoSha256: string;
} {
  const projectDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "youtube-publication-request-"),
  );
  tempDirs.push(projectDir);
  const packageDir = path.join(projectDir, "07_package");
  const outputDir = path.join(projectDir, "09_output");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  const videoPath = path.join(outputDir, "final.mp4");
  fs.writeFileSync(videoPath, "approved-video");
  const videoSha256 = computeSha256(videoPath);
  fs.writeFileSync(
    path.join(packageDir, "qa-report.json"),
    JSON.stringify({ project_id: "ax1-publication-fixture", passed: true }),
  );
  fs.writeFileSync(
    path.join(packageDir, "package_manifest.json"),
    JSON.stringify({
      project_id: "ax1-publication-fixture",
      artifacts: {
        final_video: { path: videoPath, sha256: videoSha256 },
      },
    }),
  );
  const metadataPath = path.join(projectDir, "youtube-metadata.json");
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  const destination = version === "publication-approval/v2"
    ? {
      platform: "youtube",
      visibility: "unlisted",
      account: "AX-1",
      channel_id: "UC_AX1_APPROVED",
      metadata_sha256: youtubeUploadMetadataSha256(metadata),
    }
    : {
      platform: "youtube",
      visibility: "unlisted",
      account: "AX-1",
    };
  fs.writeFileSync(
    path.join(packageDir, "publication_approval.yaml"),
    stringifyYaml({
      version,
      project_id: "ax1-publication-fixture",
      created_at: "2026-07-25T00:00:00.000Z",
      canonical_video: {
        path: "09_output/final.mp4",
        sha256: videoSha256,
      },
      approvals: Object.fromEntries(
        ["creative", "rights", "privacy"].map((kind) => [kind, {
          status: "approved",
          approved_by: "operator",
          approved_at: "2026-07-25T00:00:00.000Z",
          scope: `${kind} approved for exact YouTube request`,
          artifact_sha256: videoSha256,
        }]),
      ),
      destinations: [destination],
    }),
  );
  return { projectDir, metadataPath, videoSha256 };
}

describe("hash-bound YouTube publication request", () => {
  it("derives channel, metadata, visibility, artifact, and approval identity from v2 approval", () => {
    const fixture = createProject();
    const request = resolveYoutubePublicationRequest({
      projectDir: fixture.projectDir,
      metadataPath: fixture.metadataPath,
      privacyStatus: "unlisted",
    });

    expect(request).toMatchObject({
      expectedChannelId: "UC_AX1_APPROVED",
      destinationAccount: "AX-1",
      videoPath: path.join(fixture.projectDir, "09_output", "final.mp4"),
      videoSha256: fixture.videoSha256,
      metadata,
      metadataSha256: youtubeUploadMetadataSha256(metadata),
      publicationApproval: {
        version: "publication-approval/v2",
        approvalSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        artifactSha256: fixture.videoSha256,
        privacyStatus: "unlisted",
        channelId: "UC_AX1_APPROVED",
        metadataSha256: youtubeUploadMetadataSha256(metadata),
      },
    });
  });

  it("fails before upload when metadata or an explicit channel override differs", () => {
    const fixture = createProject();
    fs.writeFileSync(
      fixture.metadataPath,
      JSON.stringify({
        ...metadata,
        snippet: { ...metadata.snippet, title: "Unapproved title" },
      }),
    );
    expect(() => resolveYoutubePublicationRequest({
      projectDir: fixture.projectDir,
      metadataPath: fixture.metadataPath,
      privacyStatus: "unlisted",
    })).toThrow("youtube_approved_metadata_hash_mismatch");

    fs.writeFileSync(fixture.metadataPath, JSON.stringify(metadata));
    expect(() => resolveYoutubePublicationRequest({
      projectDir: fixture.projectDir,
      metadataPath: fixture.metadataPath,
      privacyStatus: "unlisted",
      expectedChannelId: "UC_OTHER",
    })).toThrow("youtube_expected_channel_conflicts_with_approval");
  });

  it("keeps v1 preflight readable but requires v2 for a mutating request", () => {
    const fixture = createProject("publication-approval/v1");
    expect(() => resolveYoutubePublicationRequest({
      projectDir: fixture.projectDir,
      metadataPath: fixture.metadataPath,
      privacyStatus: "unlisted",
    })).toThrow("youtube_publication_approval_v2_required");
  });
});
