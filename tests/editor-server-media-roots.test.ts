import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseThumbnailDimension } from "../editor/shared/thumbnail-dimensions.js";
import {
  redactSourceMapForApi,
  resolveAllowedSourceMapPath,
} from "../editor/server/utils.js";

function tmpProject(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `video-os-${name}-`));
  fs.mkdirSync(path.join(dir, "02_media"), { recursive: true });
  return dir;
}

describe("editor server source_map media roots", () => {
  it("allows project-local media paths", () => {
    const projectDir = tmpProject("media-root-local");
    try {
      const sourceMapPath = path.join(projectDir, "02_media", "source_map.json");
      const mediaPath = path.join(projectDir, "02_media", "clip.mov");
      fs.writeFileSync(mediaPath, "media");

      const resolved = resolveAllowedSourceMapPath(projectDir, sourceMapPath, {
        asset_id: "AST_001",
        source_locator: "02_media/clip.mov",
      });

      expect(resolved).toBe(mediaPath);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("blocks arbitrary absolute paths from source_map entries", () => {
    const projectDir = tmpProject("media-root-block");
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-os-outside-"));
    try {
      const sourceMapPath = path.join(projectDir, "02_media", "source_map.json");
      const outsidePath = path.join(outsideDir, "secret.mov");
      fs.writeFileSync(outsidePath, "secret");

      const resolved = resolveAllowedSourceMapPath(projectDir, sourceMapPath, {
        asset_id: "AST_001",
        local_source_path: outsidePath,
      });

      expect(resolved).toBeNull();
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("allows an external source only when linked through 02_media", () => {
    const projectDir = tmpProject("media-root-link");
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-os-linked-source-"));
    try {
      const sourceMapPath = path.join(projectDir, "02_media", "source_map.json");
      const outsidePath = path.join(outsideDir, "camera.mov");
      const linkPath = path.join(projectDir, "02_media", "camera.mov");
      fs.writeFileSync(outsidePath, "camera");
      fs.symlinkSync(outsidePath, linkPath);

      const resolved = resolveAllowedSourceMapPath(projectDir, sourceMapPath, {
        asset_id: "AST_001",
        local_source_path: outsidePath,
        link_path: "02_media/camera.mov",
      });

      expect(resolved).toBe(outsidePath);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("does not allow sibling-prefix escapes", () => {
    const projectDir = tmpProject("media-root-prefix");
    const siblingDir = `${projectDir}-evil`;
    try {
      fs.mkdirSync(siblingDir, { recursive: true });
      const sourceMapPath = path.join(projectDir, "02_media", "source_map.json");
      const siblingPath = path.join(siblingDir, "clip.mov");
      fs.writeFileSync(siblingPath, "evil");

      const resolved = resolveAllowedSourceMapPath(projectDir, sourceMapPath, {
        asset_id: "AST_001",
        local_source_path: siblingPath,
      });

      expect(resolved).toBeNull();
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(siblingDir, { recursive: true, force: true });
    }
  });
});

describe("editor server source_map API redaction", () => {
  it("removes local capability paths while preserving stable client fields", () => {
    const redacted = redactSourceMapForApi({
      version: "1",
      items: [
        {
          asset_id: "AST_001",
          filename: "clip.mov",
          local_source_path: "/Users/example/private/clip.mov",
          link_path: "02_media/clip.mov",
          source_locator: "file:///Users/example/private/clip.mov",
          duration_us: 1_000_000,
        },
      ],
    });

    expect(redacted.items?.[0]).toEqual({
      asset_id: "AST_001",
      filename: "clip.mov",
      duration_us: 1_000_000,
    });
  });
});

describe("editor server thumbnail resource limits", () => {
  it("accepts default and bounded dimensions", () => {
    expect(parseThumbnailDimension(undefined, 160)).toBe(160);
    expect(parseThumbnailDimension("", 90)).toBe(90);
    expect(parseThumbnailDimension("2048", 160)).toBe(2048);
  });

  it("rejects invalid or oversized dimensions", () => {
    expect(parseThumbnailDimension("0", 160)).toBeNull();
    expect(parseThumbnailDimension("-1", 160)).toBeNull();
    expect(parseThumbnailDimension("20000", 160)).toBeNull();
    expect(parseThumbnailDimension("120.5", 160)).toBeNull();
  });
});
