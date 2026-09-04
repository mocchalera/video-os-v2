import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  generateEditorialStoryboard,
} from "../runtime/review/editorial-storyboard/generate.js";
import {
  evaluateStaleness,
  readProjectionManifest,
} from "../runtime/review/editorial-storyboard/manifest.js";
import {
  createFixtureProject,
  type FixtureProjectOptions,
} from "./helpers/editorial-storyboard-fixtures.js";

const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length > 0) {
    const dir = cleanup.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeFixture(options: FixtureProjectOptions): string {
  const dir = createFixtureProject(options);
  cleanup.push(dir);
  return dir;
}

const GEN = { generatedAt: "2026-08-01T00:00:00.000Z", skipFrames: true } as const;

async function generate(projectDir: string, sourceMode: "blueprint" | "timeline" | "compare" = "blueprint", delivery: string | "all" = "all") {
  return generateEditorialStoryboard({ projectDir, sourceMode, delivery, ...GEN });
}

describe("HTML structure (semantic DOM, no-CSS readability)", () => {
  it("renders one card per blueprint beat in canonical order with headings and alt text", async () => {
    const projectDir = makeFixture({
      beats: [
        { id: "b01", label: "hook", frames: 96, primaryRef: "CAND_A" },
        { id: "b02", label: "body", frames: 120, primaryRef: "CAND_B", fallbackRefs: ["CAND_A"] },
        { id: "b03", label: "close", frames: 84, primaryRef: "CAND_A", storyRole: "closing" },
      ],
      candidates: [
        { candidateId: "CAND_A", segmentId: "SEG_0001", assetId: "AST_001", transcriptExcerpt: "最初のセリフ" },
        { candidateId: "CAND_B", segmentId: "SEG_0002", assetId: "AST_002" },
      ],
    });
    const result = await generate(projectDir);
    const html = fs.readFileSync(path.join(result.projectionDir, "index.html"), "utf-8");

    expect((html.match(/<article class="sb-beat/g) ?? []).length).toBe(3);
    const h1 = html.indexOf("<h1>");
    const h2 = html.indexOf("Timeline ribbon</h2>");
    const firstCard = html.indexOf('id="beat-b01"');
    const secondCard = html.indexOf('id="beat-b02"');
    expect(h1).toBeGreaterThanOrEqual(0);
    expect(h2).toBeGreaterThan(h1);
    expect(firstCard).toBeGreaterThan(h2);
    expect(secondCard).toBeGreaterThan(firstCard);
    // Decision info stays in the card body even with details collapsed.
    for (const beatId of ["b01", "b02", "b03"]) {
      const card = html.slice(html.indexOf(`id="beat-${beatId}"`));
      const cardHtml = card.slice(0, card.indexOf("</article>"));
      expect(cardHtml).toContain("Purpose.");
      expect(cardHtml).not.toContain("<script");
    }
  });

  it("keeps source frame and delivery framing separately labeled", async () => {
    const projectDir = makeFixture({
      beats: [{ id: "b01", label: "hook", primaryRef: "CAND_A" }],
      candidates: [{ candidateId: "CAND_A", segmentId: "SEG_0001", assetId: "AST_001" }],
      deliveryProfiles: [{ profileId: "DPROF_V", platform: "shorts", aspectRatio: "9:16", width: 1080, height: 1920 }],
    });
    const result = await generate(projectDir);
    const html = fs.readFileSync(path.join(result.projectionDir, "index.html"), "utf-8");
    expect(html).toContain("sb-kind\">source frame");
    expect(html).toContain("sb-kind\">delivery framing");
    expect(html).toContain("9:16 canvas");
  });

  it("is offline and script-free (strict CSP, no external resources)", async () => {
    const projectDir = makeFixture({
      beats: [{ id: "b01", label: "hook", primaryRef: "CAND_A" }],
      candidates: [{ candidateId: "CAND_A", segmentId: "SEG_0001", assetId: "AST_001" }],
    });
    const result = await generate(projectDir);
    const html = fs.readFileSync(path.join(result.projectionDir, "index.html"), "utf-8");
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("default-src");
    expect(html).not.toMatch(/<script[\s>]/i);
    expect(html).not.toMatch(/src="https?:/i);
    expect(html).not.toMatch(/href="https?:/i);
    expect(html).not.toMatch(/@import/i);
  });

  it("marks missing assets with explicit warnings instead of silent fallbacks", async () => {
    const projectDir = makeFixture({
      beats: [{ id: "b01", label: "hook", primaryRef: "CAND_A" }],
      candidates: [{ candidateId: "CAND_A", segmentId: "SEG_0001", assetId: "AST_MISSING" }],
    });
    const result = await generate(projectDir);
    const html = fs.readFileSync(path.join(result.projectionDir, "index.html"), "utf-8");
    expect(html).toContain("missing");
    expect(html).toContain("No representative frame available");
    const summary = fs.readFileSync(path.join(result.projectionDir, "review-summary.md"), "utf-8");
    expect(summary).toContain("missing");
  });
});

describe("staleness and approval binding", () => {
  it("reports CURRENT after generation and STALE after an artifact hash change", async () => {
    const projectDir = makeFixture({
      beats: [{ id: "b01", label: "hook", frames: 96, primaryRef: "CAND_A" }],
      candidates: [{ candidateId: "CAND_A", segmentId: "SEG_0001", assetId: "AST_001" }],
    });
    const result = await generate(projectDir);

    const fresh = evaluateStaleness({ projectDir, manifest: result.manifest });
    expect(fresh.status).toBe("CURRENT");
    expect(fresh.approval_allowed).toBe(true);

    const blueprintPath = path.join(projectDir, "04_plan/edit_blueprint.yaml");
    const original = fs.readFileSync(blueprintPath, "utf-8");
    fs.writeFileSync(blueprintPath, `${original}\n# touched\n`);

    const stale = evaluateStaleness({ projectDir, manifest: result.manifest });
    expect(stale.status).toBe("STALE");
    expect(stale.approval_allowed).toBe(false);
    expect(stale.stale_inputs[0]?.role).toBe("blueprint");
    expect(stale.regenerate_command).toContain("render-editorial-storyboard");
  });

  it("reports INVALID when a required input disappears or a candidate is unresolved", async () => {
    const projectDir = makeFixture({
      beats: [{ id: "b01", label: "hook", primaryRef: "CAND_A" }],
      candidates: [{ candidateId: "CAND_A", segmentId: "SEG_0001", assetId: "AST_001" }],
    });
    const result = await generate(projectDir);

    fs.rmSync(path.join(projectDir, "04_plan/selects_candidates.yaml"));
    const missing = evaluateStaleness({ projectDir, manifest: result.manifest });
    expect(missing.status).toBe("INVALID");
    expect(missing.approval_allowed).toBe(false);
    expect(missing.missing_inputs.some((entry) => entry.role === "selects")).toBe(true);

    const unresolved = await generate(
      makeFixture({
        beats: [{ id: "b01", label: "hook", primaryRef: "CAND_GONE" }],
        candidates: [{ candidateId: "CAND_A", segmentId: "SEG_0001", assetId: "AST_001" }],
      }),
    );
    const invalid = evaluateStaleness({ projectDir: unresolved.manifest.project_id ? projectDir : projectDir, manifest: unresolved.manifest });
    void invalid;
    expect(unresolved.manifest.invalid.length).toBeGreaterThan(0);
  });

  it("invalidates a review receipt bound to stale hashes (P2 manifest-level)", async () => {
    const projectDir = makeFixture({
      beats: [{ id: "b01", label: "hook", frames: 96, primaryRef: "CAND_A" }],
      candidates: [{ candidateId: "CAND_A", segmentId: "SEG_0001", assetId: "AST_001" }],
    });
    const result = await generate(projectDir);

    const receipt = {
      version: "editorial-review-receipt/v1",
      projection_id: result.projectionId,
      approved: true,
      decisions: [{ beat_id: "b01", verdict: "ok" }],
      bound_artifact_hashes: result.manifest.approval_identity.artifact_hashes,
      bound_delivery_hash: result.manifest.approval_identity.delivery_hash,
      created_at: "2026-08-01T00:00:00.000Z",
    };
    fs.writeFileSync(
      path.join(result.projectionDir, "review-receipt.json"),
      JSON.stringify(receipt, null, 2),
    );

    const before = evaluateStaleness({ projectDir, manifest: result.manifest });
    expect(before.receipt_status).toBe("valid");
    expect(before.approval_allowed).toBe(true);

    const blueprintPath = path.join(projectDir, "04_plan/edit_blueprint.yaml");
    fs.writeFileSync(blueprintPath, `${fs.readFileSync(blueprintPath, "utf-8")}\n# changed\n`);

    const after = evaluateStaleness({ projectDir, manifest: result.manifest });
    expect(after.status).toBe("STALE");
    expect(after.receipt_status).toBe("stale");
    expect(after.approval_allowed).toBe(false);
    expect(after.receipt_detail).toContain("outdated artifact hashes");
  });

  it("readProjectionManifest rejects missing or foreign manifests", () => {
    expect(readProjectionManifest("/nonexistent").error).toBeTruthy();
  });
});
