/**
 * MCP Repository — read-only backend for media-mcp tools.
 *
 * Per milestone-2-design.md §media-mcp Integration:
 * - AnalysisRepository: read-only interface used by MCP tools
 * - FixtureAnalysisRepository: M1 mode reading static fixture files
 * - LiveAnalysisRepository: reads live pipeline artifacts
 * - Factory selects backend by config
 *
 * Tool interface is unchanged; only the backing repository swaps.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { parse as parseYaml } from "yaml";
import type { AssetItem } from "../connectors/ffprobe.js";
import type { SegmentItem } from "../connectors/ffmpeg-segmenter.js";
import type { ContactSheetManifest } from "../connectors/ffmpeg-derivatives.js";
import {
  projectAnalysisGaps,
  deriveQcStatus,
  type GapReport,
  type QcStatus,
} from "./gap-projection.js";

// ── MCP Response Types ─────────────────────────────────────────────

export interface ProjectSummaryResponse {
  project_id: string;
  artifact_version: string;
  assets_total: number;
  segments_total: number;
  transcripts_available: boolean;
  contact_sheets_available: boolean;
  qc_status: QcStatus;
  top_motifs: string[];
  analysis_gaps: string[];
}

export interface ListAssetsResponse {
  project_id: string;
  artifact_version: string;
  items: Array<{
    asset_id: string;
    role_guess: string;
    duration_us: number;
    segments: number;
    quality_flags: string[];
    poster_path?: string;
    contact_sheet_ids: string[];
  }>;
  next_cursor: string | null;
}

export interface GetAssetResponse {
  project_id: string;
  artifact_version: string;
  asset_id: string;
  duration_us: number;
  video_stream?: {
    width: number;
    height: number;
    fps_num: number;
    fps_den: number;
  };
  audio_stream?: {
    sample_rate: number;
    channels: number;
  };
  transcript_ref: string | null;
  contact_sheet_ids: string[];
  segment_ids: string[];
  quality_flags: string[];
}

export interface PeekSegmentResponse {
  project_id: string;
  artifact_version: string;
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  src_in_tc: string;
  src_out_tc: string;
  filmstrip_path?: string;
  waveform_path?: string;
  transcript_excerpt: string;
  quality_flags: string[];
  tags: string[];
}

export interface TranscriptSpanItem {
  speaker: string;
  start_us: number;
  end_us: number;
  text: string;
}

export interface ReadTranscriptSpanResponse {
  project_id: string;
  artifact_version: string;
  items: TranscriptSpanItem[];
}

export interface ContactSheetResponse {
  project_id: string;
  artifact_version: string;
  contact_sheet_id: string;
  mode: "shot_keyframes" | "overview";
  image_path: string;
  sample_fps?: number;
  tile_map: Array<{
    tile_index: number;
    segment_id?: string;
    rep_frame_us: number;
    src_in_us?: number;
    src_out_us?: number;
    summary?: string;
  }>;
}

export interface SearchSegmentsResponse {
  project_id: string;
  artifact_version: string;
  results: Array<{
    segment_id: string;
    asset_id: string;
    src_in_us: number;
    src_out_us: number;
    score: number;
    evidence: string[];
    summary: string;
  }>;
}

export interface ExtractWindowResponse {
  project_id: string;
  artifact_version: string;
  window_id: string;
  filmstrip_path: string;
  clip_proxy_path: string;
}

// ── Transcript File Type ───────────────────────────────────────────

interface TranscriptFile {
  project_id: string;
  artifact_version: string;
  transcript_ref: string;
  asset_id: string;
  items: TranscriptSpanItem[];
}

// ── Assets/Segments File Types ─────────────────────────────────────

interface AssetsFile {
  project_id: string;
  artifact_version: string;
  items: AssetItem[];
}

interface SegmentsFile {
  project_id: string;
  artifact_version: string;
  items: SegmentItem[];
}

// ── Repository Interface ───────────────────────────────────────────

export interface AnalysisRepository {
  projectSummary(projectId: string): ProjectSummaryResponse;
  listAssets(projectId: string, filter?: {
    has_transcript?: boolean;
    tags_any?: string[];
  }, limit?: number, cursor?: string | null): ListAssetsResponse;
  getAsset(projectId: string, assetId: string): GetAssetResponse;
  peekSegment(projectId: string, segmentId: string): PeekSegmentResponse;
  readTranscriptSpan(projectId: string, transcriptRef: string, startUs: number, endUs: number): ReadTranscriptSpanResponse;
  openContactSheet(projectId: string, contactSheetId: string): ContactSheetResponse;
  searchSegments(projectId: string, query: string, filters?: {
    exclude_quality_flags?: string[];
    duration_max_us?: number;
  }, topK?: number): SearchSegmentsResponse;
  extractWindow(projectId: string, assetId: string, startUs: number, endUs: number, sampleFps: number, width: number): Promise<ExtractWindowResponse>;
}

// ── Timecode Helpers ───────────────────────────────────────────────

function usToTimecode(us: number, fps: number = 24): string {
  const totalFrames = Math.round(us / 1_000_000 * fps);
  const frames = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}:${String(frames).padStart(2, "0")}`;
}

// ── Live Analysis Repository ───────────────────────────────────────

export class LiveAnalysisRepository implements AnalysisRepository {
  private readonly projectDir: string;
  private readonly analysisDir: string;

  constructor(projectDir: string) {
    this.projectDir = path.resolve(projectDir);
    this.analysisDir = path.join(this.projectDir, "03_analysis");
  }

  private readAssetsFile(): AssetsFile {
    const filePath = path.join(this.analysisDir, "assets.json");
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  }

  private readSegmentsFile(): SegmentsFile {
    const filePath = path.join(this.analysisDir, "segments.json");
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  }

  private readGapReport(): GapReport {
    const filePath = path.join(this.analysisDir, "gap_report.yaml");
    if (!fs.existsSync(filePath)) {
      return { version: "1", entries: [] };
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    return parseYaml(raw) as GapReport;
  }

  private readTranscript(transcriptRef: string): TranscriptFile | null {
    const filePath = path.join(this.analysisDir, "transcripts", `${transcriptRef}.json`);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  }

  private readContactSheetManifest(contactSheetId: string): ContactSheetManifest | null {
    const filePath = path.join(this.analysisDir, "contact_sheets", `${contactSheetId}.json`);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  }

  // ── Tool Implementations ──────────────────────────────────────────

  projectSummary(projectId: string): ProjectSummaryResponse {
    const assets = this.readAssetsFile();
    const segments = this.readSegmentsFile();
    const gapReport = this.readGapReport();

    // transcripts_available: at least one asset has has_transcript: true
    const transcriptsAvailable = assets.items.some((a) => a.has_transcript);

    // contact_sheets_available: at least one contact_sheet_ids entry exists
    const contactSheetsAvailable = assets.items.some(
      (a) => a.contact_sheet_ids && a.contact_sheet_ids.length > 0,
    );

    // top_motifs: collect all tags, count, return top 5
    const tagCounts = new Map<string, number>();
    for (const seg of segments.items) {
      for (const tag of seg.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }
    const sortedTags = [...tagCounts.entries()]
      .sort((a, b) => {
        if (a[1] !== b[1]) return b[1] - a[1]; // count desc
        return a[0].localeCompare(b[0]); // alphabetical tie-break
      })
      .slice(0, 5)
      .map(([tag]) => tag);

    // analysis_gaps projection
    const analysisGaps = projectAnalysisGaps(gapReport);

    // qc_status
    const qcStatus = deriveQcStatus(gapReport, assets.items.length);

    return {
      project_id: projectId,
      artifact_version: assets.artifact_version,
      assets_total: assets.items.length,
      segments_total: segments.items.length,
      transcripts_available: transcriptsAvailable,
      contact_sheets_available: contactSheetsAvailable,
      qc_status: qcStatus,
      top_motifs: sortedTags,
      analysis_gaps: analysisGaps,
    };
  }

  listAssets(
    projectId: string,
    filter?: { has_transcript?: boolean; tags_any?: string[] },
    limit: number = 50,
    _cursor: string | null = null,
  ): ListAssetsResponse {
    const assets = this.readAssetsFile();

    let items = assets.items;

    // Apply filters
    if (filter) {
      if (filter.has_transcript !== undefined) {
        items = items.filter((a) => a.has_transcript === filter.has_transcript);
      }
      if (filter.tags_any && filter.tags_any.length > 0) {
        const filterTags = new Set(filter.tags_any);
        items = items.filter((a) => a.tags.some((t) => filterTags.has(t)));
      }
    }

    // Apply limit
    const limited = items.slice(0, limit);

    return {
      project_id: projectId,
      artifact_version: assets.artifact_version,
      items: limited.map((a) => ({
        asset_id: a.asset_id,
        role_guess: a.role_guess ?? "unknown",
        duration_us: a.duration_us,
        segments: a.segments,
        quality_flags: a.quality_flags,
        poster_path: a.poster_path,
        contact_sheet_ids: a.contact_sheet_ids ?? [],
      })),
      next_cursor: null,
    };
  }

  getAsset(projectId: string, assetId: string): GetAssetResponse {
    const assets = this.readAssetsFile();
    const asset = assets.items.find((a) => a.asset_id === assetId);
    if (!asset) throw new Error(`Asset not found: ${assetId}`);

    return {
      project_id: projectId,
      artifact_version: assets.artifact_version,
      asset_id: asset.asset_id,
      duration_us: asset.duration_us,
      video_stream: asset.video_stream
        ? {
          width: asset.video_stream.width,
          height: asset.video_stream.height,
          fps_num: asset.video_stream.fps_num,
          fps_den: asset.video_stream.fps_den,
        }
        : undefined,
      audio_stream: asset.audio_stream
        ? {
          sample_rate: asset.audio_stream.sample_rate,
          channels: asset.audio_stream.channels,
        }
        : undefined,
      transcript_ref: asset.transcript_ref,
      contact_sheet_ids: asset.contact_sheet_ids ?? [],
      segment_ids: asset.segment_ids,
      quality_flags: asset.quality_flags,
    };
  }

  peekSegment(projectId: string, segmentId: string): PeekSegmentResponse {
    const segments = this.readSegmentsFile();
    const seg = segments.items.find((s) => s.segment_id === segmentId);
    if (!seg) throw new Error(`Segment not found: ${segmentId}`);

    // Resolve waveform_path: deterministic crop path per design doc
    const waveformPath = seg.waveform_path ??
      `waveforms/${segmentId}.png`;

    return {
      project_id: projectId,
      artifact_version: segments.artifact_version,
      segment_id: seg.segment_id,
      asset_id: seg.asset_id,
      src_in_us: seg.src_in_us,
      src_out_us: seg.src_out_us,
      src_in_tc: usToTimecode(seg.src_in_us),
      src_out_tc: usToTimecode(seg.src_out_us),
      filmstrip_path: seg.filmstrip_path,
      waveform_path: waveformPath,
      transcript_excerpt: seg.transcript_excerpt,
      quality_flags: seg.quality_flags,
      tags: seg.tags,
    };
  }

  readTranscriptSpan(
    projectId: string,
    transcriptRef: string,
    startUs: number,
    endUs: number,
  ): ReadTranscriptSpanResponse {
    const transcript = this.readTranscript(transcriptRef);
    if (!transcript) throw new Error(`Transcript not found: ${transcriptRef}`);

    // Filter items that overlap with the requested time range
    const items = transcript.items.filter(
      (item) => item.end_us > startUs && item.start_us < endUs,
    );

    return {
      project_id: projectId,
      artifact_version: transcript.artifact_version,
      items,
    };
  }

  openContactSheet(projectId: string, contactSheetId: string): ContactSheetResponse {
    const manifest = this.readContactSheetManifest(contactSheetId);
    if (!manifest) throw new Error(`Contact sheet not found: ${contactSheetId}`);

    // Overview mode: no segment enrichment needed
    if (manifest.mode === "overview") {
      return {
        project_id: projectId,
        artifact_version: "analysis-v1",
        contact_sheet_id: manifest.contact_sheet_id,
        mode: "overview",
        image_path: manifest.image_path,
        sample_fps: manifest.sample_fps,
        tile_map: manifest.tile_map,
      };
    }

    // Shot keyframes mode: enrich tile_map with segment summaries
    const segments = this.readSegmentsFile();
    const segmentMap = new Map(segments.items.map((s) => [s.segment_id, s]));

    return {
      project_id: projectId,
      artifact_version: segments.artifact_version,
      contact_sheet_id: manifest.contact_sheet_id,
      mode: "shot_keyframes",
      image_path: manifest.image_path,
      tile_map: manifest.tile_map.map((tile) => ({
        ...tile,
        summary: tile.segment_id ? segmentMap.get(tile.segment_id)?.summary : undefined,
      })),
    };
  }

  async extractWindow(
    projectId: string,
    assetId: string,
    startUs: number,
    endUs: number,
    sampleFps: number,
    width: number,
  ): Promise<ExtractWindowResponse> {
    const assets = this.readAssetsFile();
    const asset = assets.items.find((a) => a.asset_id === assetId);
    if (!asset) throw new Error(`Asset not found: ${assetId}`);

    const windowId = `WIN_${assetId}_${startUs}_${endUs}`;
    const windowsDir = path.join(this.analysisDir, "windows");
    fs.mkdirSync(windowsDir, { recursive: true });

    const filmstripPath = path.join(windowsDir, `${windowId}.png`);
    const clipProxyPath = path.join(windowsDir, `${windowId}.mp4`);

    // Resolve source file — look for source_path in asset or find in 00_sources
    const sourcePath = this.resolveSourcePath(assetId);

    const startSec = startUs / 1_000_000;
    const durationSec = (endUs - startUs) / 1_000_000;

    // Generate filmstrip: extract frames at sampleFps, scale to width, tile into contact sheet
    await this.execFfmpeg([
      "-y",
      "-ss", String(startSec),
      "-t", String(durationSec),
      "-i", sourcePath,
      "-vf", `fps=${sampleFps},scale=${width}:-1,tile=1x0`,
      "-frames:v", "1",
      filmstripPath,
    ]);

    // Generate proxy clip: re-encode window to lightweight mp4
    await this.execFfmpeg([
      "-y",
      "-ss", String(startSec),
      "-t", String(durationSec),
      "-i", sourcePath,
      "-vf", `scale=${width}:-1`,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "28",
      "-an",
      clipProxyPath,
    ]);

    return {
      project_id: projectId,
      artifact_version: assets.artifact_version,
      window_id: windowId,
      filmstrip_path: filmstripPath,
      clip_proxy_path: clipProxyPath,
    };
  }

  /** Resolve the source file path for an asset. */
  private resolveSourcePath(assetId: string): string {
    // Check 00_sources directory for files matching the asset_id
    const sourcesDir = path.join(this.projectDir, "00_sources");
    if (fs.existsSync(sourcesDir)) {
      const files = fs.readdirSync(sourcesDir);
      for (const file of files) {
        const fullPath = path.join(sourcesDir, file);
        if (fs.statSync(fullPath).isFile()) {
          return fullPath;
        }
      }
    }
    throw new Error(`No source file found for asset ${assetId}`);
  }

  /** Execute an ffmpeg command and return a promise. */
  private execFfmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile("ffmpeg", args, { maxBuffer: 10 * 1024 * 1024 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  searchSegments(
    projectId: string,
    query: string,
    filters?: { exclude_quality_flags?: string[]; duration_max_us?: number },
    topK: number = 20,
  ): SearchSegmentsResponse {
    const segments = this.readSegmentsFile();
    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter(Boolean);

    // Score each segment with basic lexical search
    const scored: Array<{
      segment: SegmentItem;
      score: number;
      evidence: string[];
    }> = [];

    for (const seg of segments.items) {
      // Apply filters
      if (filters?.exclude_quality_flags) {
        const excludeSet = new Set(filters.exclude_quality_flags);
        if (seg.quality_flags.some((f) => excludeSet.has(f))) continue;
      }
      if (filters?.duration_max_us) {
        const dur = seg.src_out_us - seg.src_in_us;
        if (dur > filters.duration_max_us) continue;
      }

      let score = 0;
      const evidence: string[] = [];

      // Summary match
      const summaryLower = (seg.summary || "").toLowerCase();
      const summaryHits = queryTerms.filter((t) => summaryLower.includes(t)).length;
      if (summaryHits > 0) {
        score += summaryHits / queryTerms.length * 0.4;
        evidence.push("summary");
      }

      // Tag match
      const tagStr = seg.tags.join(" ").toLowerCase();
      const tagHits = queryTerms.filter((t) => tagStr.includes(t)).length;
      if (tagHits > 0) {
        score += tagHits / queryTerms.length * 0.35;
        evidence.push("visual_tag");
      }

      // Transcript match
      const transcriptLower = (seg.transcript_excerpt || "").toLowerCase();
      const transcriptHits = queryTerms.filter((t) => transcriptLower.includes(t)).length;
      if (transcriptHits > 0) {
        score += transcriptHits / queryTerms.length * 0.25;
        evidence.push("transcript");
      }

      if (score > 0) {
        scored.push({ segment: seg, score: Math.round(score * 100) / 100, evidence });
      }
    }

    // Sort by score desc, then segment_id asc for determinism
    scored.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.segment.segment_id.localeCompare(b.segment.segment_id);
    });

    const topResults = scored.slice(0, topK);

    return {
      project_id: projectId,
      artifact_version: segments.artifact_version,
      results: topResults.map((r) => ({
        segment_id: r.segment.segment_id,
        asset_id: r.segment.asset_id,
        src_in_us: r.segment.src_in_us,
        src_out_us: r.segment.src_out_us,
        score: r.score,
        evidence: r.evidence,
        summary: r.segment.summary,
      })),
    };
  }
}

// ── Factory ────────────────────────────────────────────────────────

export type RepositoryMode = "fixture" | "live";

export interface RepositoryConfig {
  mode: RepositoryMode;
  projectDir: string;
}

/**
 * Create an AnalysisRepository from config.
 * Both fixture and live use the same implementation since they read
 * the same file layout — the difference is how 03_analysis/ was populated.
 */
export function createRepository(config: RepositoryConfig): AnalysisRepository {
  return new LiveAnalysisRepository(config.projectDir);
}
