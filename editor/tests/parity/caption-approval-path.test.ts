import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveCaptionApprovalPath,
  resolveProjectCaptionStylePreset,
} from "../../shared/project-caption-settings.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function createProject(): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-caption-path-"));
  tempDirs.push(projectDir);
  return projectDir;
}

describe("Studio caption approval resolution", () => {
  it("resolves the blueprint styling class through shared caption tokens", () => {
    const projectDir = createProject();
    const blueprintPath = path.join(projectDir, "04_plan", "edit_blueprint.yaml");
    fs.mkdirSync(path.dirname(blueprintPath), { recursive: true });
    fs.writeFileSync(
      blueprintPath,
      "caption_policy:\n  styling_class: clean-lower-third\n",
    );

    const preset = resolveProjectCaptionStylePreset(projectDir);
    expect(preset.presetId).toBe("clean-lower-third");
    expect(preset.fontSizePx1080).toBe(60);
    expect(preset.outlinePx1080).toBe(3);
  });

  it("prefers the canonical 07_package artifact", () => {
    const projectDir = createProject();
    const canonicalPath = path.join(projectDir, "07_package", "caption_approval.json");
    const legacyPath = path.join(projectDir, "caption_approval.json");
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    fs.writeFileSync(canonicalPath, "{}\n");
    fs.writeFileSync(legacyPath, "{}\n");

    expect(resolveCaptionApprovalPath(projectDir)).toBe(canonicalPath);
  });

  it("falls back to the legacy project-root artifact", () => {
    const projectDir = createProject();
    const legacyPath = path.join(projectDir, "caption_approval.json");
    fs.writeFileSync(legacyPath, "{}\n");

    expect(resolveCaptionApprovalPath(projectDir)).toBe(legacyPath);
  });
});
