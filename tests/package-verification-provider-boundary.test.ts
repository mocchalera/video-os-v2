import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../scripts/package.js";
import {
  buildMacOSStudioContractFixture,
} from "../scripts/generate-macos-studio-contract-fixture.js";
import {
  macosStudioFixtureRendererVersionProvider,
} from "../scripts/helpers/macos-studio-fixture-renderer-versions.js";
import {
  verifyExistingPackage,
  verifyExistingPackageWithRendererVersionProvider,
  verifyPackageGeneration,
  verifyPackageGenerationWithRendererVersionProvider,
  type PackageVerificationResult,
} from "../runtime/packaging/package-verification.js";
import * as rendererVersionProviderModule
  from "../runtime/packaging/renderer-version-provider.js";

interface FixtureCase {
  id: string;
  files: Record<string, string>;
}

interface StudioContractFixture {
  packageCases: FixtureCase[];
}

function withMaterializedCase<T>(
  testCase: FixtureCase,
  evaluate: (projectDir: string) => T,
): T {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "renderer-provider-boundary-"));
  try {
    for (const [relativePath, contents] of Object.entries(testCase.files)) {
      const filePath = path.join(projectDir, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, contents, "utf8");
    }
    return evaluate(projectDir);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

function fixtureCase(fixture: StudioContractFixture, id: string): FixtureCase {
  const testCase = fixture.packageCases.find((candidate) => candidate.id === id);
  if (!testCase) throw new Error(`missing fixture case: ${id}`);
  return testCase;
}

function failedCheck(result: PackageVerificationResult, name: string): boolean {
  return result.checks.some((check) => check.name === name && !check.passed);
}

function generationPaths(projectDir: string) {
  return {
    qaReportPath: path.join(projectDir, "07_package", "qa-report.json"),
    packageManifestPath: path.join(projectDir, "07_package", "package_manifest.json"),
    finalVideoPath: path.join(projectDir, "09_output", "final.mp4"),
    captionApprovalPath: path.join(projectDir, "07_package", "caption_approval.json"),
  };
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.name === "node_modules"
        || entry.name === ".git"
        || entry.name === "dist"
      ) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(absolute);
    }
  };
  visit(root);
  return files;
}

describe("package verification renderer-provider boundary", () => {
  it("keeps runtime exports live-only and production wrapper arity non-injectable", () => {
    expect(Object.keys(rendererVersionProviderModule)).toEqual([
      "liveRendererVersionProvider",
    ]);
    expect(verifyExistingPackage.length).toBe(1);
    expect(verifyPackageGeneration.length).toBe(2);

    const runtimeProviderSource = fs.readFileSync(
      path.resolve("runtime/packaging/renderer-version-provider.ts"),
      "utf8",
    );
    expect(runtimeProviderSource).not.toMatch(/fixture|fixed/i);
  });

  it("restricts fixed provider and injectable core imports to fixture/test producers", () => {
    const root = path.resolve(".");
    const allowedFixedImporters = new Set([
      "scripts/generate-macos-studio-contract-fixture.ts",
      "tests/macos-studio-contract-fixture.test.ts",
      "tests/package-verification-provider-boundary.test.ts",
    ]);
    const allowedCoreImporters = new Set([
      "runtime/packaging/package-verification.ts",
      "scripts/generate-macos-studio-contract-fixture.ts",
      "tests/package-verification-provider-boundary.test.ts",
    ]);

    for (const absolute of sourceFiles(root)) {
      const relative = path.relative(root, absolute);
      const source = fs.readFileSync(absolute, "utf8");
      if (source.includes("macos-studio-fixture-renderer-versions")) {
        expect(allowedFixedImporters.has(relative), relative).toBe(true);
      }
      if (
        source.includes("verifyExistingPackageWithRendererVersionProvider")
        || source.includes("verifyPackageGenerationWithRendererVersionProvider")
      ) {
        expect(allowedCoreImporters.has(relative), relative).toBe(true);
      }
    }

    const captionFinalizeSource = fs.readFileSync(
      path.resolve("runtime/caption/caption-finalize.ts"),
      "utf8",
    );
    expect(captionFinalizeSource).toContain("verifyPackageGeneration");
    expect(captionFinalizeSource).not.toContain("WithRendererVersionProvider");
  });

  it("uses the fixed provider only through the fixture/test core seam", () => {
    const fixture = buildMacOSStudioContractFixture() as StudioContractFixture;
    const valid = fixtureCase(fixture, "valid");

    withMaterializedCase(valid, (projectDir) => {
      expect(
        verifyExistingPackageWithRendererVersionProvider(
          projectDir,
          macosStudioFixtureRendererVersionProvider,
        ).ready,
      ).toBe(true);
      expect(
        verifyPackageGenerationWithRendererVersionProvider(
          projectDir,
          generationPaths(projectDir),
          macosStudioFixtureRendererVersionProvider,
        ).ready,
      ).toBe(true);
    });
  });

  it("hard-wires both production wrappers to live identity despite env or fixed artifacts", () => {
    const fixture = buildMacOSStudioContractFixture() as StudioContractFixture;
    const valid = fixtureCase(fixture, "valid");
    const previousProvider = process.env.VIDEOOS_RENDERER_VERSION_PROVIDER;
    const previousVersion = process.env.VIDEOOS_FFMPEG_VERSION;
    process.env.VIDEOOS_RENDERER_VERSION_PROVIDER = "fixed";
    process.env.VIDEOOS_FFMPEG_VERSION = "ffmpeg forged through env";
    try {
      withMaterializedCase(valid, (projectDir) => {
        const existing = verifyExistingPackage(projectDir);
        const generation = verifyPackageGeneration(projectDir, generationPaths(projectDir));
        expect(existing.ready).toBe(false);
        expect(generation.ready).toBe(false);
        expect(failedCheck(existing, "renderer_versions_match_runtime")).toBe(true);
        expect(failedCheck(generation, "renderer_versions_match_runtime")).toBe(true);
      });
    } finally {
      if (previousProvider === undefined) delete process.env.VIDEOOS_RENDERER_VERSION_PROVIDER;
      else process.env.VIDEOOS_RENDERER_VERSION_PROVIDER = previousProvider;
      if (previousVersion === undefined) delete process.env.VIDEOOS_FFMPEG_VERSION;
      else process.env.VIDEOOS_FFMPEG_VERSION = previousVersion;
    }
  });

  it("keeps tamper and drift checks fail-closed under the fixed core oracle", () => {
    const fixture = buildMacOSStudioContractFixture() as StudioContractFixture;
    const cases: Array<[string, string]> = [
      ["render_route_receipt_tampered", "render_route_receipt_hash_matches"],
      ["render_route_drift", "render_route_matches_canonical_inputs"],
      ["renderer_version_drift", "renderer_versions_match_runtime"],
      ["encode_pass_drift", "lossy_video_encode_passes_match_execution"],
      ["font_receipt_missing", "render_font_receipt_presence_matches_route"],
      ["layer_receipt_missing", "render_layer_receipts_complete"],
    ];

    for (const [id, checkName] of cases) {
      withMaterializedCase(fixtureCase(fixture, id), (projectDir) => {
        const result = verifyExistingPackageWithRendererVersionProvider(
          projectDir,
          macosStudioFixtureRendererVersionProvider,
        );
        expect(result.ready, id).toBe(false);
        expect(failedCheck(result, checkName), id).toBe(true);
      });
    }
  });

  it("rejects CLI and project-artifact attempts to select a fixed provider", () => {
    for (const args of [
      ["--renderer-version-provider", "fixed"],
      ["--renderer-provider", "fixed"],
      ["--ffmpeg-version", "fixture"],
    ]) {
      expect(() => parseArgs([
        "node",
        "scripts/package.ts",
        "projects/demo",
        ...args,
      ])).toThrow("Unknown or incomplete argument");
    }

    const fixture = buildMacOSStudioContractFixture() as StudioContractFixture;
    const valid = structuredClone(fixtureCase(fixture, "valid"));
    const manifestPath = "07_package/package_manifest.json";
    const manifest = JSON.parse(valid.files[manifestPath]) as Record<string, unknown>;
    manifest.renderer_version_provider = "fixed";
    valid.files[manifestPath] = `${JSON.stringify(manifest, null, 2)}\n`;
    withMaterializedCase(valid, (projectDir) => {
      const result = verifyExistingPackage(projectDir);
      expect(result.ready).toBe(false);
      expect(failedCheck(result, "package_manifest_schema_valid")).toBe(true);
    });
  });
});
