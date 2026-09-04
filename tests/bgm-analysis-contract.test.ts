import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildAudioStoryGraph } from "../runtime/artifacts/p2-audio-story-graph.js";
import { validateArtifact } from "../runtime/artifacts/loaders.js";
import { loadRhythmEvidenceSnapshot } from "../runtime/compiler/rhythm-sync.js";
import { loadBgmAnalysisFromProjectWithSource } from "../runtime/media/bgm-analyzer.js";
import { inspectBgmAnalysisContract } from "../runtime/media/bgm-analysis-contract.js";
import { sha256FileHex } from "../runtime/source-content-identity.js";
import { validateProject } from "../runtime/validation/schema-validator.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function hostileAnalysis(mediaPath: string): Record<string, unknown> {
  const sourceHash = sha256FileHex(mediaPath);
  const syntheticCue = { time_sec: 0, strength: 1, evidence_classification: "synthetic" };
  return {
    version: "1",
    project_id: "issue39-hostile",
    analysis_status: "ready",
    music_asset: {
      asset_id: "AST_music_hostile",
      path: mediaPath,
      source_hash: sourceHash,
      source_content_sha256: "a".repeat(64),
    },
    bpm: 120,
    meter: "4/4",
    duration_sec: 12,
    beats_sec: [0, 0.5, 1, 1.5],
    downbeats_sec: [0],
    sections: [{
      id: "S1",
      label: "chorus",
      start_sec: 0,
      end_sec: 12,
      energy: 0.8,
      evidence_classification: "synthetic",
    }],
    beats: [syntheticCue, { ...syntheticCue, time_sec: 0.5 }],
    onsets: [syntheticCue, { ...syntheticCue, time_sec: 0.5 }],
    provenance: {
      detector: "hostile-fixture",
      sample_rate_hz: 16_000,
      input_sample_rate_hz: 16_000,
      processing_sample_rate_hz: 16_000,
      source_content_sha256: "b".repeat(64),
      backend_name: "hostile-fixture",
      backend_version: "fixture-1",
      hop_length_samples: 1_600,
      window_length_samples: 6_400,
      time_unit: "seconds",
      evidence_classification: "synthetic",
      measurement_status: "complete",
      tempo_confidence: 1,
      fallback_used: false,
    },
  };
}

describe("Issue #39 M2 shared BGM acceptance predicate", () => {
  it("rejects the same hostile ready artifact in schema, loader, graph, and rhythm paths", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue39-contract-hostile-"));
    tempDirs.push(projectDir);
    const analysisDir = path.join(projectDir, "03_analysis");
    fs.mkdirSync(analysisDir, { recursive: true });
    const mediaPath = path.join(projectDir, "music.wav");
    fs.writeFileSync(mediaPath, "hostile fixture media\n");
    const hostile = hostileAnalysis(mediaPath);
    fs.writeFileSync(path.join(analysisDir, "bgm_analysis.json"), JSON.stringify(hostile));

    const contract = inspectBgmAnalysisContract(hostile);
    expect(contract.readyAccepted).toBe(false);
    expect(contract.failures).toEqual(expect.arrayContaining([
      "bgm_source_sha256_mismatch",
      "bgm_beats_not_measured",
      "bgm_onsets_not_measured",
      "bgm_sections_not_measured",
    ]));
    expect(() => validateArtifact(hostile, "bgm-analysis.schema.json")).toThrow();

    const projectValidation = validateProject(projectDir, { repoRoot: REPO_ROOT });
    expect(projectValidation.valid).toBe(false);
    expect(projectValidation.violations.some((violation) => violation.rule === "schema")).toBe(true);
    expect(projectValidation.violations.some((violation) => violation.rule === "bgm_analysis_integrity")).toBe(true);

    expect(loadBgmAnalysisFromProjectWithSource(projectDir)).toBeUndefined();

    const graph = buildAudioStoryGraph({
      projectId: "issue39-hostile",
      manifest: {
        source_media_manifest_hash: `sha256:${"1".repeat(64)}`,
        items: [{ asset_id: "AST_music_hostile" }],
      },
      coverageReport: {
        hash: `sha256:${"2".repeat(64)}`,
        lanes: [{ lane_id: "bgm_analysis", status: "ready" }],
      },
      bgmAnalysis: hostile as never,
      createdAt: "2026-08-31T00:00:00Z",
    });
    expect(graph.nodes.filter((node) => node.node_type === "music_section")).toHaveLength(0);
    expect(graph.coverage).toMatchObject({ status: "partial", music_lane: "failed" });

    const rhythm = loadRhythmEvidenceSnapshot(projectDir, {
      projectId: "issue39-hostile",
      repoRoot: REPO_ROOT,
    });
    expect(rhythm.bgmBound).toBe(false);
    expect(rhythm.evidence.binding).not.toBe("bound");
  });
});
