import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { ArtifactValidationError } from "../runtime/artifacts/loaders.js";
import {
  buildBgmShortlistReviewQueue,
  inferShortlistBatchRoots,
  updateBgmShortlistReview,
  verifyReviewCandidateSource,
  writeBgmShortlistReviewQueue,
  type BgmShortlistReviewQueue,
  type TechnicalShortlist,
} from "../runtime/music/shortlist-import.js";
import {
  BGM_SHORTLIST_CLI_EXIT,
  parseBgmShortlistArgs,
  runBgmShortlistCli,
} from "../scripts/bgm-shortlist.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) fs.rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface Fixture {
  root: string;
  shortlistPath: string;
  catalogPath: string;
  reviewPath: string;
  audioPath: string;
  shortlist: TechnicalShortlist;
}

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "video-os-bgm-shortlist-"));
  tempRoots.push(root);
  const batch1 = path.join(root, "music-workspace");
  const aggregate = path.join(root, "music-workspace-2");
  const input = path.join(batch1, "input");
  const analysis = path.join(aggregate, "analysis");
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(analysis, { recursive: true });
  const audio = Buffer.from("synthetic audio fixture\n", "utf8");
  const audioPath = path.join(input, "Clear Ground.wav");
  fs.writeFileSync(audioPath, audio);

  const shortlist: TechnicalShortlist = {
    version: "technical-shortlist/v1",
    created_at: "2026-07-17T03:00:00.000Z",
    candidate_count: 12,
    method: {
      duration: "within target tolerance",
      tempo: "normalized to target range",
      warning: "Do not treat this ranking as musical acceptance.",
    },
    tracks: {
      "trust-clarity-low-01": {
        working_title: "Clear Ground",
        target_bpm: 84,
        target_duration_sec: 149,
        shortlist: [{
          batch: 1,
          filename: "Clear Ground.wav",
          duration_sec: 148.6,
          measured_bpm: 84.1,
          normalized_bpm: 84.1,
          technical_score: 98.2,
          sha256: hash(audio),
          suno_comment: "Technically closest; audition under dialogue.",
        }],
        note: "Technical preselection only.",
      },
    },
  };
  const shortlistPath = path.join(analysis, "technical-shortlist.json");
  fs.writeFileSync(shortlistPath, JSON.stringify(shortlist, null, 2));
  const catalogPath = path.join(root, "track-catalog.yaml");
  fs.writeFileSync(catalogPath, stringifyYaml({
    schema_version: "1.0",
    pack_id: "video-os-core-bgm-v1",
    tracks: [{
      id: "trust-clarity-low-01",
      family: "Trust / Clarity",
      energy: "low",
      working_title: "Clear Ground",
      use_cases: ["executive interview", "customer proof"],
      bpm: 84,
      structure_90_150s: { target_duration_seconds: 149 },
    }],
  }));
  return {
    root,
    shortlistPath,
    catalogPath,
    reviewPath: path.join(analysis, "musical-review-queue.json"),
    audioPath,
    shortlist,
  };
}

function memoryIo(): {
  io: { stdout: { write(value: string): boolean }; stderr: { write(value: string): boolean } };
  stdout: () => string;
  stderr: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: { write(value: string) { stdout += value; return true; } },
      stderr: { write(value: string) { stderr += value; return true; } },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe("BGM technical shortlist import", () => {
  it("infers generation batches, verifies SHA-256, and produces a gated review queue", () => {
    const fixture = makeFixture();
    const roots = inferShortlistBatchRoots(fixture.shortlistPath, [1, 2, 3]);
    expect(roots.get(1)).toBe(path.join(fixture.root, "music-workspace"));
    expect(roots.get(2)).toBe(path.join(fixture.root, "music-workspace-1"));
    expect(roots.get(3)).toBe(path.join(fixture.root, "music-workspace-2"));

    const result = buildBgmShortlistReviewQueue({
      shortlistPath: fixture.shortlistPath,
      catalogPath: fixture.catalogPath,
    });
    expect(result.ok).toBe(true);
    expect(result.artifact.status).toBe("ready_for_musical_review");
    expect(result.artifact.counts).toMatchObject({
      tracks: 1,
      shortlisted_candidates: 1,
      source_verified: 1,
      promotion_eligible: 0,
      errors: 0,
      warnings: 0,
    });
    const candidate = result.artifact.tracks[0].candidates[0];
    expect(candidate.source_ref).toBe("batch:1/input/Clear Ground.wav");
    expect(candidate.source_comment).toContain("audition under dialogue");
    expect(candidate.review.musical_fit).toBe("pending");
    expect(candidate.promotion_eligible).toBe(false);
    expect(JSON.stringify(result.artifact)).not.toContain(fixture.root);
    expect(result.resolved_paths.get(candidate.candidate_id)).toBe(fs.realpathSync(fixture.audioPath));
  });

  it("blocks a candidate when the original bytes no longer match the shortlist hash", () => {
    const fixture = makeFixture();
    fs.appendFileSync(fixture.audioPath, "changed");
    const result = buildBgmShortlistReviewQueue({
      shortlistPath: fixture.shortlistPath,
      catalogPath: fixture.catalogPath,
    });
    expect(result.ok).toBe(false);
    expect(result.artifact.status).toBe("blocked");
    expect(result.artifact.counts.source_verified).toBe(0);
    expect(result.artifact.issues.map((item) => item.code)).toContain("BGM_SHORTLIST_HASH_MISMATCH");
  });

  it("rejects unsafe filenames at the versioned input boundary", () => {
    const fixture = makeFixture();
    fixture.shortlist.tracks["trust-clarity-low-01"].shortlist[0].filename = "../escape.wav";
    fs.writeFileSync(fixture.shortlistPath, JSON.stringify(fixture.shortlist, null, 2));
    expect(() => buildBgmShortlistReviewQueue({
      shortlistPath: fixture.shortlistPath,
      catalogPath: fixture.catalogPath,
    })).toThrow(ArtifactValidationError);
  });

  it("blocks a symlink that resolves outside the private batch input directory", () => {
    const fixture = makeFixture();
    const outside = path.join(fixture.root, "outside.wav");
    const bytes = Buffer.from("outside bytes");
    fs.writeFileSync(outside, bytes);
    const link = path.join(path.dirname(fixture.audioPath), "linked.wav");
    fs.symlinkSync(outside, link);
    const candidate = fixture.shortlist.tracks["trust-clarity-low-01"].shortlist[0];
    candidate.filename = "linked.wav";
    candidate.sha256 = hash(bytes);
    fs.writeFileSync(fixture.shortlistPath, JSON.stringify(fixture.shortlist, null, 2));

    const result = buildBgmShortlistReviewQueue({
      shortlistPath: fixture.shortlistPath,
      catalogPath: fixture.catalogPath,
    });
    expect(result.ok).toBe(false);
    expect(result.artifact.issues.map((item) => item.code)).toContain("BGM_SHORTLIST_SOURCE_UNSAFE");
  });

  it("carries forward completed reviews only for the exact candidate identity and hash", () => {
    const fixture = makeFixture();
    const first = buildBgmShortlistReviewQueue({
      shortlistPath: fixture.shortlistPath,
      catalogPath: fixture.catalogPath,
    });
    const reviewed = structuredClone(first.artifact) as BgmShortlistReviewQueue;
    const candidate = reviewed.tracks[0].candidates[0];
    candidate.review = {
      musical_fit: "approved",
      dialogue_bed: "passed",
      artifact_quality: "passed",
      originality: "passed",
      rights: "operator_declared_ok",
      reviewer_ref: "reviewer:fixture",
      reviewed_at: "2026-07-17T04:00:00.000Z",
      notes: ["Auditioned against representative dialogue."],
    };
    candidate.promotion_eligible = true;
    reviewed.counts.promotion_eligible = 1;
    writeBgmShortlistReviewQueue(fixture.reviewPath, reviewed);

    const rebuilt = buildBgmShortlistReviewQueue({
      shortlistPath: fixture.shortlistPath,
      catalogPath: fixture.catalogPath,
      existingReviewPath: fixture.reviewPath,
    });
    expect(rebuilt.artifact.tracks[0].candidates[0].review).toEqual(candidate.review);
    expect(rebuilt.artifact.tracks[0].candidates[0].promotion_eligible).toBe(true);
    expect(rebuilt.artifact.counts.promotion_eligible).toBe(1);

    const newBytes = Buffer.from("replacement audio fixture");
    fs.writeFileSync(fixture.audioPath, newBytes);
    fixture.shortlist.tracks["trust-clarity-low-01"].shortlist[0].sha256 = hash(newBytes);
    fs.writeFileSync(fixture.shortlistPath, JSON.stringify(fixture.shortlist, null, 2));
    const changed = buildBgmShortlistReviewQueue({
      shortlistPath: fixture.shortlistPath,
      catalogPath: fixture.catalogPath,
      existingReviewPath: fixture.reviewPath,
    });
    expect(changed.artifact.tracks[0].candidates[0].review.musical_fit).toBe("pending");
    expect(changed.artifact.tracks[0].candidates[0].promotion_eligible).toBe(false);
  });

  it("refuses to overwrite a malformed existing review queue", async () => {
    const fixture = makeFixture();
    fs.writeFileSync(fixture.reviewPath, JSON.stringify({ version: "broken" }));
    expect(() => buildBgmShortlistReviewQueue({
      shortlistPath: fixture.shortlistPath,
      catalogPath: fixture.catalogPath,
      existingReviewPath: fixture.reviewPath,
    })).toThrow(ArtifactValidationError);

    const io = memoryIo();
    const exit = await runBgmShortlistCli([
      "node", "bgm-shortlist.ts", "prepare-review",
      "--shortlist", fixture.shortlistPath,
      "--catalog", fixture.catalogPath,
      "--output", fixture.reviewPath,
      "--json",
    ], io.io);
    expect(exit).toBe(BGM_SHORTLIST_CLI_EXIT.verificationFailed);
    expect(fs.readFileSync(fixture.reviewPath, "utf8")).toBe(JSON.stringify({ version: "broken" }));
  });

  it("re-verifies source bytes before atomically saving a complete human review", () => {
    const fixture = makeFixture();
    const prepared = buildBgmShortlistReviewQueue({
      shortlistPath: fixture.shortlistPath,
      catalogPath: fixture.catalogPath,
    });
    writeBgmShortlistReviewQueue(fixture.reviewPath, prepared.artifact);
    const candidate = prepared.artifact.tracks[0].candidates[0];
    expect(verifyReviewCandidateSource(fixture.reviewPath, candidate)).toBe(fs.realpathSync(fixture.audioPath));

    const result = updateBgmShortlistReview({
      reviewPath: fixture.reviewPath,
      candidateId: candidate.candidate_id,
      review: {
        musical_fit: "approved",
        dialogue_bed: "passed",
        artifact_quality: "passed",
        originality: "passed",
        rights: "operator_declared_ok",
        reviewer_ref: "reviewer:fixture",
        reviewed_at: "2026-07-17T05:00:00.000Z",
        notes: ["Auditioned under representative dialogue."],
      },
    });
    expect(result.candidate.promotion_eligible).toBe(true);
    expect(result.artifact.counts.promotion_eligible).toBe(1);
    const saved = JSON.parse(fs.readFileSync(fixture.reviewPath, "utf8")) as BgmShortlistReviewQueue;
    expect(saved.tracks[0].candidates[0].review.reviewer_ref).toBe("reviewer:fixture");
  });

  it("does not mutate the queue when audio changes before review save", () => {
    const fixture = makeFixture();
    const prepared = buildBgmShortlistReviewQueue({
      shortlistPath: fixture.shortlistPath,
      catalogPath: fixture.catalogPath,
    });
    writeBgmShortlistReviewQueue(fixture.reviewPath, prepared.artifact);
    const before = fs.readFileSync(fixture.reviewPath);
    fs.appendFileSync(fixture.audioPath, "changed");
    expect(() => updateBgmShortlistReview({
      reviewPath: fixture.reviewPath,
      candidateId: prepared.artifact.tracks[0].candidates[0].candidate_id,
      review: {
        musical_fit: "approved",
        dialogue_bed: "passed",
        artifact_quality: "passed",
        originality: "passed",
        rights: "operator_declared_ok",
        reviewer_ref: "reviewer:fixture",
        reviewed_at: "2026-07-17T05:00:00.000Z",
        notes: [],
      },
    })).toThrow("no longer matches");
    expect(fs.readFileSync(fixture.reviewPath)).toEqual(before);
  });
});

describe("bgm-shortlist CLI", () => {
  it("requires an output only for prepare-review and parses repeatable batch roots", () => {
    const args = parseBgmShortlistArgs([
      "node", "bgm-shortlist.ts", "prepare-review",
      "--shortlist", "shortlist.json", "--output", "review.json",
      "--batch-root", "1=/private/a", "--batch-root", "2=/private/b",
    ]);
    expect(args.command).toBe("prepare-review");
    expect(args.batchRoots.get(2)).toBe("/private/b");
    expect(() => parseBgmShortlistArgs([
      "node", "bgm-shortlist.ts", "prepare-review", "--shortlist", "shortlist.json",
    ])).toThrow();

    const review = parseBgmShortlistArgs([
      "node", "bgm-shortlist.ts", "review",
      "--queue", "review.json", "--candidate", "track-low-01--b1--000000000000",
      "--reviewer", "Music Reviewer", "--musical-fit", "approved",
      "--dialogue-bed", "passed", "--artifact-quality", "passed",
      "--originality", "passed", "--rights", "operator_declared_ok",
      "--note", "First note", "--note", "First note",
    ]);
    expect(review.command).toBe("review");
    expect(review.notes).toEqual(["First note"]);
  });

  it("writes a path-redacted review queue and verify remains read-only", async () => {
    const fixture = makeFixture();
    const preparedIo = memoryIo();
    const preparedExit = await runBgmShortlistCli([
      "node", "bgm-shortlist.ts", "prepare-review",
      "--shortlist", fixture.shortlistPath,
      "--catalog", fixture.catalogPath,
      "--output", fixture.reviewPath,
      "--json",
    ], preparedIo.io);
    expect(preparedExit).toBe(BGM_SHORTLIST_CLI_EXIT.ok);
    expect(fs.existsSync(fixture.reviewPath)).toBe(true);
    expect(preparedIo.stderr()).toBe("");
    expect(preparedIo.stdout()).not.toContain(fixture.root);
    expect(JSON.parse(preparedIo.stdout())).toMatchObject({
      ok: true,
      command: "prepare-review",
      wrote_artifact: true,
      output_ref: "musical-review-queue.json",
    });

    fs.rmSync(fixture.reviewPath);
    const verifyIo = memoryIo();
    const verifyExit = await runBgmShortlistCli([
      "node", "bgm-shortlist.ts", "verify",
      "--shortlist", fixture.shortlistPath,
      "--catalog", fixture.catalogPath,
      "--json",
    ], verifyIo.io);
    expect(verifyExit).toBe(BGM_SHORTLIST_CLI_EXIT.ok);
    expect(fs.existsSync(fixture.reviewPath)).toBe(false);
    expect(JSON.parse(verifyIo.stdout())).toMatchObject({ wrote_artifact: false });
  });

  it("does not write a review queue when source verification fails", async () => {
    const fixture = makeFixture();
    fs.appendFileSync(fixture.audioPath, "changed");
    const io = memoryIo();
    const exit = await runBgmShortlistCli([
      "node", "bgm-shortlist.ts", "prepare-review",
      "--shortlist", fixture.shortlistPath,
      "--catalog", fixture.catalogPath,
      "--output", fixture.reviewPath,
      "--json",
    ], io.io);
    expect(exit).toBe(BGM_SHORTLIST_CLI_EXIT.verificationFailed);
    expect(fs.existsSync(fixture.reviewPath)).toBe(false);
    expect(JSON.parse(io.stdout())).toMatchObject({ ok: false, wrote_artifact: false });
  });

  it("saves a five-gate review through the path-redacted CLI", async () => {
    const fixture = makeFixture();
    const prepared = buildBgmShortlistReviewQueue({
      shortlistPath: fixture.shortlistPath,
      catalogPath: fixture.catalogPath,
    });
    writeBgmShortlistReviewQueue(fixture.reviewPath, prepared.artifact);
    const io = memoryIo();
    const exit = await runBgmShortlistCli([
      "node", "bgm-shortlist.ts", "review",
      "--queue", fixture.reviewPath,
      "--candidate", prepared.artifact.tracks[0].candidates[0].candidate_id,
      "--reviewer", "Music Reviewer",
      "--musical-fit", "approved",
      "--dialogue-bed", "passed",
      "--artifact-quality", "passed",
      "--originality", "passed",
      "--rights", "operator_declared_ok",
      "--note", "Auditioned with dialogue.",
      "--json",
    ], io.io);
    expect(exit).toBe(BGM_SHORTLIST_CLI_EXIT.ok);
    expect(io.stdout()).not.toContain(fixture.root);
    expect(JSON.parse(io.stdout())).toMatchObject({
      ok: true,
      command: "review",
      promotion_eligible: true,
      wrote_artifact: true,
    });
  });
});
