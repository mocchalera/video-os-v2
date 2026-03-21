/**
 * Regenerate AX-1 D4887 captions with:
 * 1. Interviewer (S1, S3) exclusion
 * 2. Filler word removal
 * 3. Correct timeline remapping (source → edit time)
 *
 * Then render final_v003.mp4 with burn-in captions + loudnorm.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  generateCaptionSource,
  type CaptionPolicy,
} from "../runtime/caption/segmenter.js";
import { generateSrt } from "../runtime/render/pipeline.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_DIR = path.resolve(__dirname, "../projects/ax1-d4887");
const SOURCE_VIDEO = "/path/to/footage/D4887.MP4";
const OUTPUT_DIR = path.join(PROJECT_DIR, "09_output");

// ── 1. Load timeline and transcript ──────────────────────────────────

const timeline = JSON.parse(
  fs.readFileSync(path.join(PROJECT_DIR, "05_timeline/timeline.json"), "utf-8"),
);

const transcript = JSON.parse(
  fs.readFileSync(
    path.join(PROJECT_DIR, "03_analysis/transcripts/TR_AST_76B05D86.json"),
    "utf-8",
  ),
);

const fps = timeline.sequence?.fps_num ?? 24;

console.log(`Timeline: ${timeline.tracks.audio[0].clips.length} A1 clips, fps=${fps}`);
console.log(`Transcript: ${transcript.items.length} items`);

// Count speakers
const speakerCounts = new Map<string, number>();
for (const item of transcript.items) {
  speakerCounts.set(item.speaker, (speakerCounts.get(item.speaker) ?? 0) + 1);
}
console.log("Speaker distribution:", Object.fromEntries(speakerCounts));

// ── 2. Generate captions with filtering ──────────────────────────────

const captionPolicy: CaptionPolicy = {
  language: "ja",
  delivery_mode: "burn_in",
  source: "transcript",
  styling_class: "default",
};

const transcripts = new Map([[transcript.asset_id, transcript]]);

// NOTE: Speaker-based filtering is NOT used for this project because the
// diarization labels (S1/S2) are unreliable — Yamada is labeled as both S1
// and S2 at different points. Interviewer exclusion is already handled at
// the selects level (interviewer questions are "support" role in V2, not A1).
const captionSource = generateCaptionSource(
  timeline,
  transcripts,
  captionPolicy,
  "ax1-d4887",
  timeline.version ?? "1",
  {
    removeFillers: true, // Remove Japanese fillers (えーと, えー, etc.)
  },
);

console.log(`\nGenerated ${captionSource.speech_captions.length} captions (after filtering)`);

// ── 3. Generate SRT ──────────────────────────────────────────────────

const srtContent = generateSrt(captionSource.speech_captions, fps);
const srtPath = path.join(OUTPUT_DIR, "captions.srt");
fs.writeFileSync(srtPath, srtContent, "utf-8");

console.log(`\nSRT written to: ${srtPath}`);
console.log("--- SRT Content ---");
console.log(srtContent);
console.log("--- End SRT ---");

// ── 4. Report ────────────────────────────────────────────────────────

console.log("\n=== Caption Report ===");
for (const cap of captionSource.speech_captions) {
  const startMs = Math.round((cap.timeline_in_frame / fps) * 1000);
  const endMs = Math.round(
    ((cap.timeline_in_frame + cap.timeline_duration_frames) / fps) * 1000,
  );
  console.log(
    `  ${cap.caption_id}: ${startMs}ms-${endMs}ms | CPS=${cap.metrics.cps} | "${cap.text}"`,
  );
}

// ── 5. Check for remaining issues ────────────────────────────────────

const fillerCheck = /(?:えーと|えーっと|えっと|えー|あー|うーん|うん|まあ|なんか|あの|その)/;
let hasFillers = false;
let hasInterviewer = false;

for (const cap of captionSource.speech_captions) {
  if (fillerCheck.test(cap.text)) {
    console.warn(`  WARNING: Filler found in ${cap.caption_id}: "${cap.text}"`);
    hasFillers = true;
  }
  // Check if any transcript items from excluded speakers leaked through
  for (const itemId of cap.transcript_item_ids) {
    const item = transcript.items.find((i: { item_id: string }) => i.item_id === itemId);
    if (item && (item.speaker === "S1" || item.speaker === "S3")) {
      console.warn(
        `  WARNING: Interviewer item ${itemId} in ${cap.caption_id}`,
      );
      hasInterviewer = true;
    }
  }
}

if (!hasFillers) console.log("  ✓ No fillers remaining");
if (!hasInterviewer) console.log("  ✓ No interviewer utterances remaining");

// ── 6. Render final video ────────────────────────────────────────────

console.log("\n=== Rendering final_v003.mp4 ===");

// Extract the clips from source video based on timeline
// Build ffmpeg concat filter from A1 dialogue clips
const a1Clips = timeline.tracks.audio[0].clips;

// Sort clips by timeline position
const sortedClips = [...a1Clips].sort(
  (a: { timeline_in_frame: number }, b: { timeline_in_frame: number }) =>
    a.timeline_in_frame - b.timeline_in_frame,
);

// Build ffmpeg complex filter for extracting and concatenating clips
const filterParts: string[] = [];
const concatInputs: string[] = [];

for (let i = 0; i < sortedClips.length; i++) {
  const clip = sortedClips[i];
  const startSec = clip.src_in_us / 1_000_000;
  const durationSec = (clip.src_out_us - clip.src_in_us) / 1_000_000;

  filterParts.push(
    `[0:v]trim=start=${startSec}:duration=${durationSec},setpts=PTS-STARTPTS[v${i}];` +
    `[0:a]atrim=start=${startSec}:duration=${durationSec},asetpts=PTS-STARTPTS[a${i}]`,
  );
  concatInputs.push(`[v${i}][a${i}]`);
}

const concatFilter =
  filterParts.join(";") +
  ";" +
  concatInputs.join("") +
  `concat=n=${sortedClips.length}:v=1:a=1[vout][aout]`;

// Step 1: Extract and concat clips
const rawEditPath = path.join(OUTPUT_DIR, "raw_edit_v003.mp4");

try {
  console.log("  Step 1: Extracting and concatenating clips...");
  execFileSync("ffmpeg", [
    "-y",
    "-i", SOURCE_VIDEO,
    "-filter_complex", concatFilter,
    "-map", "[vout]",
    "-map", "[aout]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18",
    "-c:a", "aac", "-b:a", "192k",
    rawEditPath,
  ], { maxBuffer: 100 * 1024 * 1024, stdio: "pipe" });
  console.log(`  ✓ Raw edit: ${rawEditPath}`);
} catch (err) {
  console.error(`  ✗ Clip extraction failed: ${(err as Error).message}`);
  process.exit(1);
}

// Step 2: Burn captions with subtitles filter + loudnorm
const finalPath = path.join(OUTPUT_DIR, "final_v003.mp4");
const escapedSrt = srtPath.replace(/:/g, "\\:").replace(/\\/g, "\\\\");

try {
  console.log("  Step 2: Burning captions + loudnorm...");
  execFileSync("ffmpeg", [
    "-y",
    "-i", rawEditPath,
    "-vf", `subtitles='${escapedSrt}':force_style='FontSize=24,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,MarginV=40'`,
    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18",
    "-c:a", "aac", "-b:a", "192k",
    finalPath,
  ], { maxBuffer: 100 * 1024 * 1024, stdio: "pipe" });
  console.log(`  ✓ Final video: ${finalPath}`);
} catch (err) {
  console.error(`  ✗ Caption burn failed: ${(err as Error).message}`);
  // Try without caption burn as fallback
  console.log("  Attempting render without caption burn...");
  try {
    execFileSync("ffmpeg", [
      "-y",
      "-i", rawEditPath,
      "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
      "-c:v", "libx264", "-preset", "medium", "-crf", "18",
      "-c:a", "aac", "-b:a", "192k",
      finalPath,
    ], { maxBuffer: 100 * 1024 * 1024, stdio: "pipe" });
    console.log(`  ✓ Final video (no burn-in): ${finalPath}`);
    console.log("  NOTE: SRT file available as sidecar at:", srtPath);
  } catch (err2) {
    console.error(`  ✗ Render failed: ${(err2 as Error).message}`);
    process.exit(1);
  }
}

// Cleanup intermediate file
try {
  fs.unlinkSync(rawEditPath);
  console.log("  Cleaned up intermediate file");
} catch { /* ignore */ }

console.log("\n=== Done ===");
