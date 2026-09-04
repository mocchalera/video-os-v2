import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { stringify as stringifyYaml } from "yaml";
import {
  createSourceInputAttestation,
  writeRenderFreshnessMetadata,
} from "../runtime/render/source-input-attestation.js";
import {
  deriveWholeCutSemanticAxes,
  evaluateWholeCutSemantic,
  type WholeCutSemanticProvider,
  type WholeCutSemanticProviderObservation,
} from "../runtime/review/whole-cut-semantic.js";
import type { CreativeBrief } from "../runtime/artifacts/types.js";

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020") as new (options: Record<string, unknown>) => {
  compile(schema: object): {
    (data: unknown): boolean;
    errors?: Array<{ instancePath: string; message?: string }> | null;
  };
};
const addFormats = require("ajv-formats") as (ajv: unknown) => void;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fixtureBrief(): CreativeBrief {
  return {
    version: "1",
    project_id: "whole-cut-fixture",
    project: { id: "whole-cut-fixture", title: "Fixture", strategy: "message-first" },
    message: { primary: "A deliberate change becomes understandable through observed action." },
    audience: { primary: "people evaluating a change" },
    emotion_curve: ["curiosity", "understanding", "release"],
    must_have: ["the initiating action", "the resulting change"],
    must_avoid: ["unexplained jumps"],
    autonomy: { may_decide: [], must_ask: ["semantic ambiguity"] },
    resolved_assumptions: ["The full cut is the review authority."],
  };
}

function makeFixture(): {
  projectDir: string;
  brief: CreativeBrief;
  timeline: Record<string, unknown>;
  renderHash: string;
  clipIds: string[];
} {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "whole-cut-semantic-m1-"));
  tempDirs.push(projectDir);
  fs.mkdirSync(path.join(projectDir, "01_intent"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "02_media"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
  const brief = fixtureBrief();
  fs.writeFileSync(path.join(projectDir, "01_intent/creative_brief.yaml"), stringifyYaml(brief));

  const clipIds = ["clip_alpha", "clip_beta", "clip_gamma"];
  const sourceItems = clipIds.map((assetId) => {
    const sourcePath = path.join(projectDir, "02_media", `${assetId}.mp4`);
    fs.writeFileSync(sourcePath, `source-${assetId}`);
    return {
      asset_id: assetId,
      source_locator: sourcePath,
      local_source_path: sourcePath,
      link_path: `02_media/${assetId}.mp4`,
    };
  });
  fs.writeFileSync(path.join(projectDir, "02_media/source_map.json"), JSON.stringify({
    version: "1",
    project_id: brief.project_id,
    media_dir: "02_media",
    generated_at: "2026-09-01T00:00:00.000Z",
    items: sourceItems,
  }));

  const clips = clipIds.map((clip_id, index) => ({
    clip_id,
    segment_id: `segment_${index}`,
    asset_id: clip_id,
    src_in_us: 0,
    src_out_us: 20_000_000,
    timeline_in_frame: index * 20,
    timeline_duration_frames: 20,
    role: "experience",
    motivation: "fixture",
    beat_id: `beat_${index}`,
    fallback_segment_ids: [],
    confidence: 0.8,
    quality_flags: [],
  }));
  const timeline = {
    version: "timeline-fixture-1",
    project_id: brief.project_id,
    sequence: { name: "fixture", fps_num: 1, fps_den: 1, width: 1920, height: 1080, start_frame: 0 },
    tracks: {
      video: [{ track_id: "V1", kind: "video", clips }],
      audio: [],
    },
    markers: [],
    provenance: {},
  };
  const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
  fs.writeFileSync(timelinePath, JSON.stringify(timeline, null, 2));
  const renderPath = path.join(projectDir, "09_output/rough-cut.mp4");
  fs.mkdirSync(path.dirname(renderPath), { recursive: true });
  fs.writeFileSync(renderPath, "whole-cut-render");
  writeRenderFreshnessMetadata(projectDir, renderPath, {
    sourceInputsBefore: createSourceInputAttestation(projectDir),
  });
  const renderHash = crypto.createHash("sha256").update(fs.readFileSync(renderPath)).digest("hex");
  return { projectDir, brief, timeline, renderHash, clipIds };
}

function completeProvider(progressionScore = 0.8): WholeCutSemanticProvider {
  return {
    id: "fixture-semantic-provider",
    capability: "available",
    async observeWindow(input) {
      const observation: WholeCutSemanticProviderObservation = {
        observation_id: `observation-${input.start_sec}`,
        start_sec: input.start_sec,
        end_sec: input.end_sec,
        observation: "The visible action and spoken explanation are both observable in this interval.",
        inference: "The interval advances the stated change without requiring an unsupported identity assumption.",
        confidence: 0.82,
        confidence_basis: "measured",
        evidence: {
          render: {
            path: input.render_path,
            start_sec: input.start_sec,
            end_sec: input.end_sec,
            sha256: input.render_sha256,
          },
          source_clip_ids: input.active_clip_ids,
        },
        axis_results: input.axes.map((axis) => ({
          axis_id: axis.axis_id,
          outcome: "pass" as const,
          confidence: 0.82,
          confidence_basis: "measured" as const,
          brief_refs: axis.brief_refs,
          rationale: "Observed across the full-cut window.",
        })),
        story_progression: {
          score: progressionScore,
          confidence: 0.8,
          confidence_basis: "measured",
        },
      };
      return { observations: [observation], problem_ranges: [] };
    },
  };
}

describe("whole-cut semantic MVP", () => {
  it("derives minimum axes and verifies start-to-finish provider coverage", async () => {
    const fixture = makeFixture();
    const axes = deriveWholeCutSemanticAxes(fixture.brief);
    expect(axes.map((axis) => axis.axis_id)).toEqual(expect.arrayContaining([
      "protagonist_story_identity",
      "cause_action_progression",
      "semantic_agreement_or_intended_contrast",
      "information_emotion_situation_progression",
      "cut_density_vs_story_progression",
      "role_time_context",
      "intentional_ambiguity_vs_missing_explanation",
      "central_message_retention",
    ]));

    const result = await evaluateWholeCutSemantic(fixture.projectDir, fixture.brief, fixture.timeline, {
      provider: completeProvider(),
      durationSec: 60,
      probeRenderDurationImpl: async () => 60,
    });

    expect(result.status).toBe("verified");
    expect(result.coverage.status).toBe("complete");
    expect(result.coverage.intervals[0]?.start_sec).toBe(0);
    expect(result.coverage.intervals.at(-1)?.end_sec).toBe(60);
    expect(result.render.path).toBe("09_output/rough-cut.mp4");
    expect(result.axis_results.length).toBeGreaterThanOrEqual(8);
    expect(result.story_progression.status).toBe("measured");
  });

  it("fails closed when the optional provider is absent or coverage is partial", async () => {
    const fixture = makeFixture();
    const unavailable = await evaluateWholeCutSemantic(fixture.projectDir, fixture.brief, fixture.timeline, {
      durationSec: 60,
      probeRenderDurationImpl: async () => 60,
    });
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.human_hold?.required).toBe(true);
    expect(unavailable.semantic_outcome.status).not.toBe("pass");
    expect(unavailable.semantic_outcome.confidence).toBeLessThanOrEqual(0.5);

    const partialProvider: WholeCutSemanticProvider = {
      id: "partial-provider",
      capability: "available",
      async observeWindow(input) {
        const end = Math.min(input.end_sec, input.start_sec + 2);
        return {
          observations: [{
            observation_id: `partial-${input.start_sec}`,
            start_sec: input.start_sec,
            end_sec: end,
            observation: "Only a small part of the requested interval was observed.",
            inference: "The rest of the cut is unknown.",
            confidence: 0.9,
            confidence_basis: "measured",
            evidence: {
              render: {
                path: input.render_path,
                start_sec: input.start_sec,
                end_sec: end,
                sha256: input.render_sha256,
              },
              source_clip_ids: input.active_clip_ids,
            },
          }],
        };
      },
    };
    const partial = await evaluateWholeCutSemantic(fixture.projectDir, fixture.brief, fixture.timeline, {
      provider: partialProvider,
      durationSec: 60,
      probeRenderDurationImpl: async () => 60,
    });
    expect(partial.status).toBe("blocked");
    expect(partial.coverage.status).toBe("partial");
    expect(partial.semantic_outcome.confidence).toBeLessThanOrEqual(0.5);
  });

  it("does not turn metrics or visual-QA-shaped evidence into semantic PASS", async () => {
    const fixture = makeFixture();
    const metricsOnly: WholeCutSemanticProvider = {
      id: "metrics-only",
      capability: "available",
      async observeWindow(input) {
        return {
          observations: [{
            observation_id: `metrics-${input.start_sec}`,
            start_sec: input.start_sec,
            end_sec: input.end_sec,
            observation: "A scene-count metric was reported for this interval.",
            inference: "No semantic conclusion is supported by the metric alone.",
            confidence: 0.95,
            confidence_basis: "measured",
            evidence: {
              render: {
                path: input.render_path,
                start_sec: input.start_sec,
                end_sec: input.end_sec,
                sha256: input.render_sha256,
              },
              source_clip_ids: input.active_clip_ids,
            },
          }],
        };
      },
    };
    const result = await evaluateWholeCutSemantic(fixture.projectDir, fixture.brief, fixture.timeline, {
      provider: metricsOnly,
      durationSec: 60,
      probeRenderDurationImpl: async () => 60,
    });
    expect(result.status).toBe("degraded");
    expect(result.semantic_outcome.status).not.toBe("pass");
    expect(result.story_progression.status).toBe("unmeasured");
    expect(result.axis_results.every((axis) => axis.outcome === "uncertain")).toBe(true);
  });

  it("demotes high-confidence-looking observations from a degraded provider", async () => {
    const fixture = makeFixture();
    const provider = completeProvider();
    provider.capability = "degraded";

    const result = await evaluateWholeCutSemantic(fixture.projectDir, fixture.brief, fixture.timeline, {
      provider,
      durationSec: 60,
      probeRenderDurationImpl: async () => 60,
    });

    expect(result.coverage.status).toBe("complete");
    expect(result.status).toBe("degraded");
    expect(result.semantic_outcome.status).toBe("unmeasured");
    expect(result.semantic_outcome.confidence).toBeLessThanOrEqual(0.5);
    expect(result.semantic_outcome.confidence_basis).toBe("degraded");
  });

  it("bounds axis and progression confidence and basis to their parent observation", async () => {
    const fixture = makeFixture();
    const provider: WholeCutSemanticProvider = {
      ...completeProvider(),
      id: "unsupported-child-confidence-provider",
      async observeWindow(input) {
        return {
          observations: [{
            observation_id: `unsupported-child-${input.start_sec}`,
            start_sec: input.start_sec,
            end_sec: input.end_sec,
            observation: "The provider has only degraded support for this interval.",
            inference: "A child judgment cannot exceed the evidence available to its observation.",
            confidence: 0.1,
            confidence_basis: "degraded",
            evidence: {
              render: {
                path: input.render_path,
                start_sec: input.start_sec,
                end_sec: input.end_sec,
                sha256: input.render_sha256,
              },
              source_clip_ids: input.active_clip_ids,
            },
            axis_results: input.axes.map((axis) => ({
              axis_id: axis.axis_id,
              outcome: "pass" as const,
              confidence: 0.99,
              confidence_basis: "measured" as const,
              brief_refs: axis.brief_refs,
              rationale: "Hostile child judgment claims unsupported certainty.",
            })),
            story_progression: {
              score: 0.99,
              confidence: 0.99,
              confidence_basis: "measured" as const,
            },
          }],
        };
      },
    };

    const result = await evaluateWholeCutSemantic(fixture.projectDir, fixture.brief, fixture.timeline, {
      provider,
      durationSec: 60,
      probeRenderDurationImpl: async () => 60,
    });

    const identityAxis = result.axis_results.find((axis) => axis.axis_id === "protagonist_story_identity");
    expect(identityAxis?.confidence).toBeLessThanOrEqual(0.1);
    expect(identityAxis?.confidence_basis).toBe("degraded");
    expect(result.story_progression.confidence).toBeLessThanOrEqual(0.1);
    expect(result.story_progression.confidence_basis).toBe("degraded");
    expect(result.status).toBe("degraded");
    expect(result.semantic_outcome.status).not.toBe("pass");
  });

  it("does not let overall coverage hide an axis evaluated only in the first window", async () => {
    const fixture = makeFixture();
    const baseProvider = completeProvider();
    const provider: WholeCutSemanticProvider = {
      ...baseProvider,
      id: "axis-partial-provider",
      async observeWindow(input) {
        const window = await baseProvider.observeWindow(input);
        if (input.start_sec <= 0) return window;
        return {
          ...window,
          observations: window.observations.map((observation) => ({
            ...observation,
            axis_results: [],
          })),
        };
      },
    };

    const result = await evaluateWholeCutSemantic(fixture.projectDir, fixture.brief, fixture.timeline, {
      provider,
      durationSec: 60,
      probeRenderDurationImpl: async () => 60,
    });

    const identityAxis = result.axis_results.find((axis) => axis.axis_id === "protagonist_story_identity");
    expect(result.coverage.status).toBe("complete");
    expect(identityAxis?.coverage.status).toBe("partial");
    expect(identityAxis?.coverage.uncovered_ranges).toEqual([{ start_sec: 30, end_sec: 60 }]);
    expect(identityAxis?.outcome).toBe("uncertain");
    expect(result.status).toBe("degraded");
    expect(result.semantic_outcome.status).toBe("unmeasured");
    expect(result.human_hold?.required).toBe(true);
    expect(result.uncertainties.some((item) => item.description.includes("per-axis coverage"))).toBe(true);
  });

  it("rejects an unknown provider axis outcome instead of normalizing it to pass", async () => {
    const fixture = makeFixture();
    const baseProvider = completeProvider();
    const provider: WholeCutSemanticProvider = {
      ...baseProvider,
      id: "unknown-axis-outcome-provider",
      async observeWindow(input) {
        const window = await baseProvider.observeWindow(input);
        return {
          ...window,
          observations: window.observations.map((observation) => ({
            ...observation,
            axis_results: observation.axis_results?.map((axis) => ({
              ...axis,
              outcome: "unknown" as never,
            })),
          })),
        };
      },
    };

    const result = await evaluateWholeCutSemantic(fixture.projectDir, fixture.brief, fixture.timeline, {
      provider,
      durationSec: 60,
      probeRenderDurationImpl: async () => 60,
    });

    expect(result.status).toBe("blocked");
    expect(result.semantic_outcome.status).toBe("blocked");
    expect(result.semantic_outcome.status).not.toBe("pass");
    expect(result.observations).toHaveLength(0);
    expect(result.provider.degradation_reasons.some((reason) => reason.includes("unknown axis outcome is rejected"))).toBe(true);
  });

  it("schema-rejects an unknown axis outcome in a canonical whole-cut report", async () => {
    const fixture = makeFixture();
    const valid = await evaluateWholeCutSemantic(fixture.projectDir, fixture.brief, fixture.timeline, {
      provider: completeProvider(),
      durationSec: 60,
      probeRenderDurationImpl: async () => 60,
    });
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const schema = JSON.parse(fs.readFileSync(path.resolve("schemas/whole-cut-semantic-review.schema.json"), "utf8"));
    const validate = ajv.compile(schema);
    expect(validate(valid)).toBe(true);

    const forged = structuredClone(valid);
    forged.axis_results[0] = { ...forged.axis_results[0], outcome: "unknown" as never };
    expect(validate(forged)).toBe(false);
  });

  it("blocks evidence range and identity drift instead of accepting a forged whole cut", async () => {
    const cases = [
      {
        label: "range",
        mutate: (observation: WholeCutSemanticProviderObservation) => ({
          ...observation,
          evidence: {
            ...observation.evidence,
            render: { ...observation.evidence.render, start_sec: observation.start_sec + 1 },
          },
        }),
      },
      {
        label: "render identity",
        mutate: (observation: WholeCutSemanticProviderObservation) => ({
          ...observation,
          evidence: {
            ...observation.evidence,
            render: { ...observation.evidence.render, sha256: "0".repeat(64) },
          },
        }),
      },
      {
        label: "source identity",
        mutate: (observation: WholeCutSemanticProviderObservation) => ({
          ...observation,
          evidence: {
            ...observation.evidence,
            source_clip_ids: ["clip-not-in-canonical-timeline"],
          },
        }),
      },
    ] as const;

    for (const testCase of cases) {
      const fixture = makeFixture();
      const baseProvider = completeProvider();
      const provider: WholeCutSemanticProvider = {
        ...baseProvider,
        id: `drift-${testCase.label}`,
        async observeWindow(input) {
          const window = await baseProvider.observeWindow(input);
          return {
            ...window,
            observations: window.observations.map(testCase.mutate),
          };
        },
      };

      const result = await evaluateWholeCutSemantic(fixture.projectDir, fixture.brief, fixture.timeline, {
        provider,
        durationSec: 60,
        probeRenderDurationImpl: async () => 60,
      });

      expect(result.status, testCase.label).toBe("blocked");
      expect(result.coverage.status, testCase.label).toBe("missing");
      expect(result.semantic_outcome.status, testCase.label).toBe("blocked");
      expect(result.observations, testCase.label).toHaveLength(0);
    }
  });

  it("rejects problem ranges whose cited observations do not overlap or evaluate the cited axis", async () => {
    const fixture = makeFixture();
    const baseProvider = completeProvider();
    const provider: WholeCutSemanticProvider = {
      ...baseProvider,
      id: "problem-observation-binding-provider",
      async observeWindow(input) {
        const window = await baseProvider.observeWindow(input);
        if (input.start_sec > 0) return window;
        const axis = input.axes[0];
        const problem = (problemId: string, observationIds: string[]) => ({
          problem_id: problemId,
          axis_id: axis.axis_id,
          start_sec: 0,
          end_sec: 5,
          observation_ids: observationIds,
          summary: "The cited semantic problem is not bound to the supplied observation.",
          evidence: {
            render: {
              path: input.render_path,
              start_sec: 0,
              end_sec: 5,
              sha256: input.render_sha256,
            },
            source_clip_ids: [input.active_clip_ids[0]],
          },
          brief_refs: axis.brief_refs,
          brief_mismatch: "The problem cannot be trusted without an overlapping axis observation.",
          recommended_correction: "Re-evaluate the cited range with identity-bound axis evidence.",
        });
        return {
          ...window,
          observations: window.observations.map((observation) => ({
            ...observation,
            axis_results: observation.axis_results?.filter((axisResult) => axisResult.axis_id !== axis.axis_id),
          })),
          problem_ranges: [
            problem("problem-non-overlap", ["observation-27"]),
            problem("problem-wrong-axis", ["observation-0"]),
          ],
        };
      },
    };

    const result = await evaluateWholeCutSemantic(fixture.projectDir, fixture.brief, fixture.timeline, {
      provider,
      durationSec: 60,
      probeRenderDurationImpl: async () => 60,
    });

    expect(result.coverage.status).toBe("complete");
    expect(result.problem_ranges).toHaveLength(0);
    expect(result.status).toBe("blocked");
    expect(result.provider.degradation_reasons.some((reason) => reason.includes("does not overlap the problem range"))).toBe(true);
    expect(result.provider.degradation_reasons.some((reason) => reason.includes("does not evaluate axis"))).toBe(true);
  });

  it("rejects problem source evidence that comes from a different axis observation", async () => {
    const fixture = makeFixture();
    const overlappingTimeline = structuredClone(fixture.timeline) as {
      tracks: { video: Array<{ clips: Array<{ timeline_in_frame: number }> }> };
    };
    overlappingTimeline.tracks.video[0]!.clips[1]!.timeline_in_frame = 0;
    fixture.timeline = overlappingTimeline;
    fs.writeFileSync(
      path.join(fixture.projectDir, "05_timeline/timeline.json"),
      JSON.stringify(overlappingTimeline, null, 2),
    );
    writeRenderFreshnessMetadata(fixture.projectDir, path.join(fixture.projectDir, "09_output/rough-cut.mp4"), {
      sourceInputsBefore: createSourceInputAttestation(fixture.projectDir),
    });
    const baseProvider = completeProvider();
    const provider: WholeCutSemanticProvider = {
      ...baseProvider,
      id: "problem-cross-axis-source-provider",
      async observeWindow(input) {
        const window = await baseProvider.observeWindow(input);
        if (input.start_sec > 0) return window;
        const targetAxis = input.axes[0];
        const otherAxis = input.axes[1];
        const targetClipId = input.active_clip_ids[0];
        const otherClipId = input.active_clip_ids[1];
        if (!targetClipId || !otherClipId || targetClipId === otherClipId) {
          throw new Error("fixture needs two active source identities");
        }
        const targetObservation: WholeCutSemanticProviderObservation = {
          ...window.observations[0],
          observation_id: "same-axis-observation",
          evidence: {
            ...window.observations[0].evidence,
            source_clip_ids: [targetClipId],
          },
          axis_results: window.observations[0].axis_results?.filter((axis) => axis.axis_id === targetAxis.axis_id),
        };
        const otherObservation: WholeCutSemanticProviderObservation = {
          ...window.observations[0],
          observation_id: "other-axis-observation",
          evidence: {
            ...window.observations[0].evidence,
            source_clip_ids: [otherClipId],
          },
          axis_results: window.observations[0].axis_results?.filter((axis) => axis.axis_id === otherAxis.axis_id),
        };
        return {
          ...window,
          observations: [targetObservation, otherObservation],
          problem_ranges: [{
            problem_id: "cross-axis-source",
            axis_id: targetAxis.axis_id,
            start_sec: input.start_sec,
            end_sec: Math.min(input.end_sec, 5),
            observation_ids: [targetObservation.observation_id!],
            summary: "The problem cites one axis but supplies another axis source identity.",
            evidence: {
              render: {
                path: input.render_path,
                start_sec: input.start_sec,
                end_sec: Math.min(input.end_sec, 5),
                sha256: input.render_sha256,
              },
              source_clip_ids: [otherClipId],
            },
            brief_refs: targetAxis.brief_refs,
            brief_mismatch: "A problem must retain the source identity of the cited same-axis observation.",
            recommended_correction: "Re-evaluate the range with source evidence bound to the cited axis observation.",
          }],
        };
      },
    };

    const result = await evaluateWholeCutSemantic(fixture.projectDir, fixture.brief, fixture.timeline, {
      provider,
      durationSec: 60,
      probeRenderDurationImpl: async () => 60,
    });

    expect(result.problem_ranges).toHaveLength(0);
    expect(result.status).toBe("blocked");
    expect(result.semantic_outcome.status).toBe("blocked");
    expect(result.provider.degradation_reasons.some((reason) => reason.includes("source evidence is not bound"))).toBe(true);
  });

  it("uses the measured render duration instead of a caller-supplied shorter duration", async () => {
    const fixture = makeFixture();
    const renderPath = path.join(fixture.projectDir, "09_output/rough-cut.mp4");
    await execFileAsync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi",
      "-i", "color=c=black:s=16x16:r=2:d=2",
      "-an",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-y", renderPath,
    ]);
    writeRenderFreshnessMetadata(fixture.projectDir, renderPath, {
      sourceInputsBefore: createSourceInputAttestation(fixture.projectDir),
    });

    const result = await evaluateWholeCutSemantic(fixture.projectDir, fixture.brief, fixture.timeline, {
      provider: completeProvider(),
      durationSec: 1,
    });

    expect(result.render.duration_sec).toBeGreaterThan(1.5);
    expect(result.coverage.expected_duration_sec).toBeGreaterThan(1.5);
    expect(result.coverage.status).toBe("complete");
    expect(result.status).toBe("verified");
    expect(result.semantic_outcome.status).toBe("pass");
  });

  it("keeps dense-cut measurement separate and flags high tempo without semantic progression", async () => {
    const fixture = makeFixture();
    const denseClips = Array.from({ length: 20 }, (_, index) => ({
      clip_id: `dense_clip_${index}`,
      segment_id: `dense_segment_${index}`,
      asset_id: fixture.clipIds[index % fixture.clipIds.length],
      src_in_us: 0,
      src_out_us: 20_000_000,
      timeline_in_frame: index,
      timeline_duration_frames: 1,
      role: "experience",
      motivation: "fixture",
      beat_id: `dense_beat_${index}`,
      fallback_segment_ids: [],
      confidence: 0.8,
      quality_flags: [],
    }));
    const denseTimeline = {
      ...fixture.timeline,
      version: "timeline-dense-fixture-1",
      sequence: { ...fixture.timeline.sequence as Record<string, unknown>, fps_num: 1, fps_den: 1 },
      tracks: { video: [{ track_id: "V1", kind: "video", clips: denseClips }], audio: [] },
    };
    fixture.timeline = denseTimeline;
    fs.writeFileSync(path.join(fixture.projectDir, "05_timeline/timeline.json"), JSON.stringify(denseTimeline, null, 2));
    writeRenderFreshnessMetadata(fixture.projectDir, path.join(fixture.projectDir, "09_output/rough-cut.mp4"), {
      sourceInputsBefore: createSourceInputAttestation(fixture.projectDir),
    });

    const result = await evaluateWholeCutSemantic(fixture.projectDir, fixture.brief, denseTimeline, {
      provider: completeProvider(0.2),
      durationSec: 20,
      probeRenderDurationImpl: async () => 20,
    });

    expect(result.coverage.status).toBe("complete");
    expect(result.cut_density.status).toBe("measured");
    expect(result.cut_density.cuts_per_10_sec).toBeGreaterThan(3);
    expect(result.story_progression.status).toBe("measured");
    expect(result.story_progression.relationship).toBe("dense_without_progression");
    expect(result.semantic_outcome.status).toBe("needs_revision");
  });
});
