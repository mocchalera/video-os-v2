import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildProjectAudioStoryGraph } from "../runtime/artifacts/audio-story-project-builder.js";

describe("buildProjectAudioStoryGraph", () => {
  it("writes a project audio_story_graph from transcripts and BGM evidence", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "audio-story-project-"));
    const analysisDir = path.join(projectDir, "03_analysis");
    const transcriptDir = path.join(analysisDir, "transcripts");
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(path.join(analysisDir, "assets.json"), JSON.stringify({
      project_id: "audio-story-project",
      items: [
        { asset_id: "AST_dialogue_001", filename: "dialogue.mov" },
        { asset_id: "AST_music_001", filename: "music.wav" },
      ],
    }));
    fs.writeFileSync(path.join(transcriptDir, "TR_AST_dialogue_001.json"), JSON.stringify({
      transcript_ref: "TR_AST_dialogue_001",
      asset_id: "AST_dialogue_001",
      items: [
        { item_id: "intro_001", speaker: "S1", start_us: 1000, end_us: 2000, text: "This is the opening idea.", confidence: 0.9 },
      ],
    }));
    fs.writeFileSync(path.join(analysisDir, "bgm_analysis.json"), JSON.stringify({
      music_asset: { asset_id: "AST_music_001" },
      sections: [{ id: "intro", label: "intro", start_sec: 0, end_sec: 4, energy: 0.5 }],
      beats_sec: [0, 1, 2],
      downbeats_sec: [0],
    }));

    const result = buildProjectAudioStoryGraph({
      projectDir,
      createdAt: "2026-05-22T00:00:00Z",
    });
    const graph = JSON.parse(fs.readFileSync(path.join(analysisDir, "audio_story_graph.json"), "utf-8"));

    expect(result.written).toBe(true);
    expect(result.nodeCount).toBe(2);
    expect(result.dialogueNodeCount).toBe(1);
    expect(result.musicNodeCount).toBe(1);
    expect(result.missingInputs).toContain("audio_events");
    expect(graph.nodes.map((node: { node_id: string }) => node.node_id)).toEqual(["UTTREF_intro_001", "BGMREF_intro"]);
  });

  it("keeps current legacy BGM evidence outside the manifest but excludes stale editorial assets", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "audio-story-project-legacy-bgm-"));
    const mediaDir = path.join(projectDir, "02_media");
    const analysisDir = path.join(projectDir, "03_analysis");
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.mkdirSync(analysisDir, { recursive: true });
    fs.writeFileSync(path.join(analysisDir, "assets.json"), JSON.stringify({
      project_id: "audio-story-project-legacy-bgm",
      items: [{ asset_id: "AST_dialogue_001", filename: "dialogue.mov" }],
    }));
    fs.writeFileSync(path.join(mediaDir, "source_media_manifest.json"), JSON.stringify({
      project_id: "audio-story-project-legacy-bgm",
      artifact_version: "manifest-v1",
      source_media_manifest_hash: "manifest-hash",
      items: [{ asset_id: "AST_dialogue_001", filename: "dialogue.mov" }],
    }));
    fs.writeFileSync(path.join(analysisDir, "bgm_analysis.json"), JSON.stringify({
      music_asset: { asset_id: "BGM_legacy_theme" },
      sections: [{ id: "intro", label: "intro", start_sec: 0, end_sec: 4, energy: 0.5 }],
      beats_sec: [0, 1, 2],
      downbeats_sec: [0],
    }));

    const legacyResult = buildProjectAudioStoryGraph({
      projectDir,
      createdAt: "2026-05-22T00:00:00Z",
    });
    const legacyGraph = JSON.parse(fs.readFileSync(path.join(analysisDir, "audio_story_graph.json"), "utf-8"));

    expect(legacyResult.musicNodeCount).toBe(1);
    expect(legacyGraph.nodes.map((node: { asset_id: string }) => node.asset_id)).toContain("BGM_legacy_theme");

    fs.writeFileSync(path.join(analysisDir, "bgm_analysis.json"), JSON.stringify({
      music_asset: { asset_id: "AST_stale_music" },
      sections: [{ id: "stale", label: "stale", start_sec: 0, end_sec: 4, energy: 0.5 }],
      beats_sec: [0, 1, 2],
      downbeats_sec: [0],
    }));

    const staleResult = buildProjectAudioStoryGraph({
      projectDir,
      createdAt: "2026-05-22T00:00:01Z",
    });
    const freshGraph = JSON.parse(fs.readFileSync(path.join(analysisDir, "audio_story_graph.json"), "utf-8"));

    expect(staleResult.musicNodeCount).toBe(0);
    expect(freshGraph.nodes.some((node: { asset_id: string }) => node.asset_id === "AST_stale_music")).toBe(false);
  });
});
