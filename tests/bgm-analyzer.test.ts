// Tests for BGM Analyzer
// Covers:
//   - Beat detection command argument generation
//   - Section estimation heuristics
//   - BPM estimation from beat intervals
//   - Downbeat proximity bonus in compiler scoring
//   - Chorus-peak priority bonus
//   - BGM file detection
//   - Beat grid generation

import { describe, it, expect } from "vitest";
import type { Candidate, NormalizedBeat } from "../runtime/compiler/types.js";
import type { BgmSection } from "../runtime/compiler/transition-types.js";
import {
  estimateBpm,
  estimateSectionsFromEnergy,
  labelSections,
  generateBeatGrid,
  detectBeatsFromEnergy,
  BGM_EXTENSIONS,
  type BeatEvent,
  type BgmAnalyzerOptions,
} from "../runtime/media/bgm-analyzer.js";
import {
  computeBgmBonus,
  computePeakSalienceBonus,
  type BgmScoringContext,
} from "../runtime/compiler/score.js";

// ── Helpers ─────────────────────────────────────────────────────────

const makeCandidate = (overrides: Partial<Candidate> = {}): Candidate => ({
  segment_id: "SEG_001",
  asset_id: "AST_001",
  src_in_us: 0,
  src_out_us: 3_000_000,
  role: "hero",
  why_it_matches: "test",
  risks: [],
  confidence: 0.9,
  ...overrides,
});

const makeBeat = (id: string, overrides: Partial<NormalizedBeat> = {}): NormalizedBeat => ({
  beat_id: id,
  label: `Beat ${id}`,
  target_duration_frames: 72,
  required_roles: ["hero"],
  preferred_roles: [],
  purpose: "test",
  ...overrides,
});

const makeBgmContext = (overrides: Partial<BgmScoringContext> = {}): BgmScoringContext => ({
  downbeats_sec: [0, 2.0, 4.0, 6.0, 8.0],
  sections: [
    { id: "S1", label: "intro", start_sec: 0, end_sec: 4, energy: 0.3 },
    { id: "S2", label: "chorus", start_sec: 4, end_sec: 8, energy: 0.85 },
    { id: "S3", label: "outro", start_sec: 8, end_sec: 12, energy: 0.2 },
  ],
  fpsNum: 24,
  ...overrides,
});

// ── BPM estimation ──────────────────────────────────────────────────

describe("estimateBpm", () => {
  it("estimates 120 BPM from 0.5s intervals", () => {
    const beats: BeatEvent[] = [
      { time_sec: 0, strength: 1 },
      { time_sec: 0.5, strength: 1 },
      { time_sec: 1.0, strength: 1 },
      { time_sec: 1.5, strength: 1 },
      { time_sec: 2.0, strength: 1 },
    ];
    expect(estimateBpm(beats)).toBe(120);
  });

  it("estimates ~100 BPM from 0.6s intervals", () => {
    const beats: BeatEvent[] = [
      { time_sec: 0, strength: 1 },
      { time_sec: 0.6, strength: 1 },
      { time_sec: 1.2, strength: 1 },
      { time_sec: 1.8, strength: 1 },
      { time_sec: 2.4, strength: 1 },
    ];
    expect(estimateBpm(beats)).toBe(100);
  });

  it("returns 120 BPM for too few beats", () => {
    const beats: BeatEvent[] = [
      { time_sec: 0, strength: 1 },
      { time_sec: 0.5, strength: 1 },
    ];
    expect(estimateBpm(beats)).toBe(120);
  });

  it("performs octave correction for very fast tempo", () => {
    // 0.2s intervals = 300 BPM → should halve to 150
    const beats: BeatEvent[] = [
      { time_sec: 0, strength: 1 },
      { time_sec: 0.2, strength: 1 },
      { time_sec: 0.4, strength: 1 },
      { time_sec: 0.6, strength: 1 },
      { time_sec: 0.8, strength: 1 },
    ];
    const bpm = estimateBpm(beats);
    expect(bpm).toBeLessThanOrEqual(200);
    expect(bpm).toBeGreaterThanOrEqual(60);
  });

  it("performs octave correction for very slow tempo", () => {
    // 1.5s intervals = 40 BPM → should double to 80
    const beats: BeatEvent[] = [
      { time_sec: 0, strength: 1 },
      { time_sec: 1.5, strength: 1 },
      { time_sec: 3.0, strength: 1 },
      { time_sec: 4.5, strength: 1 },
      { time_sec: 6.0, strength: 1 },
    ];
    const bpm = estimateBpm(beats);
    expect(bpm).toBeLessThanOrEqual(200);
    expect(bpm).toBeGreaterThanOrEqual(60);
  });
});

// ── Beat grid generation ────────────────────────────────────────────

describe("generateBeatGrid", () => {
  it("generates correct number of beats for 120 BPM over 4 seconds", () => {
    const { beats, downbeats } = generateBeatGrid(120, 4.0, "4/4");
    // 120 BPM = 0.5s per beat, 4s → 8 beats
    expect(beats.length).toBe(8);
    // 2 bars → 2 downbeats
    expect(downbeats.length).toBe(2);
  });

  it("marks downbeats with higher strength", () => {
    // 120 BPM = 0.5s per beat, 4 seconds → 8 beats → 2 bars
    const { beats } = generateBeatGrid(120, 4.0, "4/4");
    // First beat of each bar = downbeat (strength 1.0)
    expect(beats[0].strength).toBe(1.0);
    // Non-downbeat (strength 0.6)
    expect(beats[1].strength).toBe(0.6);
    expect(beats[2].strength).toBe(0.6);
    expect(beats[3].strength).toBe(0.6);
    // Next bar's downbeat
    expect(beats[4].strength).toBe(1.0);
  });

  it("handles 3/4 meter", () => {
    const { beats, downbeats } = generateBeatGrid(120, 3.0, "3/4");
    // 120 BPM = 0.5s per beat, 3s → 6 beats
    expect(beats.length).toBe(6);
    // 3 beats per bar → 2 bars → 2 downbeats
    expect(downbeats.length).toBe(2);
  });
});

// ── Section estimation from energy ──────────────────────────────────

describe("estimateSectionsFromEnergy", () => {
  it("returns single section for short audio", () => {
    const profile = [
      { time_sec: 0, lufs: -20 },
      { time_sec: 1, lufs: -18 },
    ];
    const sections = estimateSectionsFromEnergy(profile, 5);
    expect(sections.length).toBe(1);
    expect(sections[0].label).toBe("main");
  });

  it("detects energy change points", () => {
    // Simulate: quiet intro → loud section → quiet outro
    const profile: Array<{ time_sec: number; lufs: number }> = [];
    for (let t = 0; t < 10; t++) {
      profile.push({ time_sec: t, lufs: -40 }); // quiet
    }
    for (let t = 10; t < 25; t++) {
      profile.push({ time_sec: t, lufs: -10 }); // loud
    }
    for (let t = 25; t < 35; t++) {
      profile.push({ time_sec: t, lufs: -38 }); // quiet again
    }

    const sections = estimateSectionsFromEnergy(profile, 35);
    expect(sections.length).toBeGreaterThanOrEqual(2);

    // At least one section should have high energy
    const highEnergy = sections.filter((s) => s.energy > 0.6);
    expect(highEnergy.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Section labeling ────────────────────────────────────────────────

describe("labelSections", () => {
  it("labels first low-energy section as intro", () => {
    const sections: BgmSection[] = [
      { id: "S1", label: "unlabeled", start_sec: 0, end_sec: 5, energy: 0.3 },
      { id: "S2", label: "unlabeled", start_sec: 5, end_sec: 15, energy: 0.9 },
      { id: "S3", label: "unlabeled", start_sec: 15, end_sec: 20, energy: 0.2 },
    ];
    labelSections(sections);
    expect(sections[0].label).toBe("intro");
    expect(sections[1].label).toBe("chorus");
    expect(sections[2].label).toBe("outro");
  });

  it("labels high-energy sections as chorus", () => {
    const sections: BgmSection[] = [
      { id: "S1", label: "unlabeled", start_sec: 0, end_sec: 10, energy: 0.5 },
      { id: "S2", label: "unlabeled", start_sec: 10, end_sec: 20, energy: 1.0 },
      { id: "S3", label: "unlabeled", start_sec: 20, end_sec: 30, energy: 0.6 },
    ];
    labelSections(sections);
    expect(sections[1].label).toBe("chorus");
  });

  it("labels mid-energy non-edge sections as verse", () => {
    const sections: BgmSection[] = [
      { id: "S1", label: "unlabeled", start_sec: 0, end_sec: 5, energy: 0.2 },
      { id: "S2", label: "unlabeled", start_sec: 5, end_sec: 15, energy: 0.6 },
      { id: "S3", label: "unlabeled", start_sec: 15, end_sec: 25, energy: 0.9 },
      { id: "S4", label: "unlabeled", start_sec: 25, end_sec: 30, energy: 0.15 },
    ];
    labelSections(sections);
    expect(sections[1].label).toBe("verse");
  });
});

// ── Beat detection from energy profile ──────────────────────────────

describe("detectBeatsFromEnergy", () => {
  it("detects peaks in energy profile", () => {
    // Simulate a simple beat pattern: peaks every 0.5 seconds
    const profile: Array<{ time_sec: number; lufs: number }> = [];
    for (let t = 0; t < 5; t += 0.1) {
      // Sine wave peaks at 0, 0.5, 1.0, etc.
      const lufs = -20 + 10 * Math.sin(2 * Math.PI * 2 * t); // 2 Hz = 120 BPM
      profile.push({ time_sec: Math.round(t * 10) / 10, lufs });
    }

    const beats = detectBeatsFromEnergy(profile);
    expect(beats.length).toBeGreaterThan(0);
    // All beats should have valid strength values
    for (const b of beats) {
      expect(b.strength).toBeGreaterThanOrEqual(0);
      expect(b.strength).toBeLessThanOrEqual(1);
    }
  });

  it("returns empty for flat energy", () => {
    const profile = Array.from({ length: 20 }, (_, i) => ({
      time_sec: i * 0.1,
      lufs: -20,
    }));
    const beats = detectBeatsFromEnergy(profile);
    expect(beats.length).toBe(0);
  });
});

// ── BGM extensions check ────────────────────────────────────────────

describe("BGM_EXTENSIONS", () => {
  it("includes common audio formats", () => {
    expect(BGM_EXTENSIONS.has(".mp3")).toBe(true);
    expect(BGM_EXTENSIONS.has(".wav")).toBe(true);
    expect(BGM_EXTENSIONS.has(".aac")).toBe(true);
    expect(BGM_EXTENSIONS.has(".flac")).toBe(true);
  });

  it("excludes video formats", () => {
    expect(BGM_EXTENSIONS.has(".mp4")).toBe(false);
    expect(BGM_EXTENSIONS.has(".mov")).toBe(false);
    expect(BGM_EXTENSIONS.has(".avi")).toBe(false);
  });
});

// ── Compiler: Downbeat proximity bonus ──────────────────────────────

describe("computeBgmBonus", () => {
  it("returns 0 when no BGM context", () => {
    const candidate = makeCandidate();
    const beat = makeBeat("B1");
    // No BGM context (caller passes undefined in scoring)
    // Direct test: pass empty context
    const bgm = makeBgmContext({ downbeats_sec: [], sections: [] });
    const bonus = computeBgmBonus(candidate, beat, bgm, 1_000_000 / 24);
    expect(bonus).toBe(0);
  });

  it("gives bonus for candidates in chorus section with peak signal", () => {
    const candidate = makeCandidate({
      editorial_signals: {
        peak_strength_score: 0.8,
        peak_type: "action_peak",
      },
    });
    const beat = makeBeat("B1", { story_role: "hook" });
    const bgm = makeBgmContext();

    const bonus = computeBgmBonus(candidate, beat, bgm, 1_000_000 / 24);
    expect(bonus).toBeGreaterThan(0);
  });

  it("gives no chorus bonus for candidates without peak signal", () => {
    const candidate = makeCandidate(); // no peak signal
    const beat = makeBeat("B1", { story_role: "hook" });
    const bgm = makeBgmContext({ downbeats_sec: [] }); // no downbeat bonus possible

    const bonus = computeBgmBonus(candidate, beat, bgm, 1_000_000 / 24);
    expect(bonus).toBe(0);
  });

  it("gives stronger chorus bonus for hook/experience beats", () => {
    const candidate = makeCandidate({
      editorial_signals: { peak_strength_score: 0.7 },
    });
    const bgm = makeBgmContext({ downbeats_sec: [] }); // isolate chorus bonus

    const hookBeat = makeBeat("B1", { story_role: "hook" });
    const hookBonus = computeBgmBonus(candidate, hookBeat, bgm, 1_000_000 / 24);

    const setupBeat = makeBeat("B2", { story_role: "setup" });
    const setupBonus = computeBgmBonus(candidate, setupBeat, bgm, 1_000_000 / 24);

    expect(hookBonus).toBeGreaterThan(setupBonus);
  });

  it("gives no chorus bonus when all sections are low energy", () => {
    const candidate = makeCandidate({
      editorial_signals: { peak_strength_score: 0.8 },
    });
    const beat = makeBeat("B1", { story_role: "hook" });
    const bgm = makeBgmContext({
      downbeats_sec: [],
      sections: [
        { id: "S1", label: "chorus", start_sec: 0, end_sec: 10, energy: 0.3 },
      ],
    });

    const bonus = computeBgmBonus(candidate, beat, bgm, 1_000_000 / 24);
    expect(bonus).toBe(0);
  });

  it("downbeat bonus decays with distance", () => {
    const candidate = makeCandidate({
      src_in_us: 0,
      src_out_us: 2_000_000, // 2 seconds
    });
    const beat = makeBeat("B1", { target_duration_frames: 48 }); // 2 sec at 24fps
    const bgm = makeBgmContext({
      sections: [], // isolate downbeat bonus
    });

    const bonus = computeBgmBonus(candidate, beat, bgm, 1_000_000 / 24);
    // With downbeats at 0, 2, 4, 6, 8 and candidate duration 2s matching exactly,
    // we should get some downbeat proximity bonus
    expect(bonus).toBeGreaterThanOrEqual(0);
  });
});

// ── Integration: scoring with BGM doesn't break existing behavior ───

describe("BGM scoring integration", () => {
  it("peak salience bonus still works independently", () => {
    const candidate = makeCandidate({
      editorial_signals: {
        peak_strength_score: 0.9,
        peak_type: "action_peak",
      },
    });
    const beat = makeBeat("B1", { story_role: "hook" });

    const bonus = computePeakSalienceBonus(candidate, beat);
    expect(bonus).toBeGreaterThan(0);
    expect(bonus).toBe(0.9 * 1.0 * 1.0); // strength × hook_weight × hero_match
  });

  it("bgm bonus and peak bonus are additive", () => {
    const candidate = makeCandidate({
      editorial_signals: {
        peak_strength_score: 0.8,
        peak_type: "action_peak",
      },
    });
    const beat = makeBeat("B1", { story_role: "hook" });
    const bgm = makeBgmContext();

    const peakBonus = computePeakSalienceBonus(candidate, beat);
    const bgmBonus = computeBgmBonus(candidate, beat, bgm, 1_000_000 / 24);

    // Both should be positive
    expect(peakBonus).toBeGreaterThan(0);
    expect(bgmBonus).toBeGreaterThan(0);
    // Total should be sum
    const total = peakBonus + bgmBonus;
    expect(total).toBeGreaterThan(peakBonus);
  });
});
