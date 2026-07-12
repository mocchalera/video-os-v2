import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  appendPreferenceEntry,
  computePreferenceMemoryHash,
  readPreferenceEntries,
  readPreferenceEntriesWithConsumedOffset,
  resolveActivePreference,
} from "../runtime/artifacts/p3-preference-memory.js";
import { projectP3ContinuityPreferenceSignals } from "../runtime/commands/blueprint.js";

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  addSchema(schema: object): void;
  compile(schema: object): { (data: unknown): boolean; errors?: unknown[] | null };
};
const addFormats = require_("ajv-formats") as (ajv: unknown) => void;

const FIXTURE_DIR = path.resolve("tests/fixtures/editorial_preference_memory");
const SCHEMA_PATH = path.resolve("schemas/editorial-preference-memory-entry.schema.json");
const COMMON_SCHEMA_PATH = path.resolve("schemas/analysis-common.schema.json");

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function schemaValidator(): ReturnType<InstanceType<typeof Ajv2020>["compile"]> {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(readJson(COMMON_SCHEMA_PATH) as object);
  return ajv.compile(readJson(SCHEMA_PATH) as object);
}

describe("P3 editorial_preference_memory", () => {
  it.each([
    "valid_active_pacing.jsonl",
    "valid_superseded_transition_style.jsonl",
    "valid_redaction_entry.jsonl",
  ])("accepts %s line-by-line", (fixture) => {
    const validate = schemaValidator();
    const result = readPreferenceEntries(path.join(FIXTURE_DIR, fixture), { validateEntry: validate });

    expect(result.malformedLines).toEqual([]);
    expect(result.entries.length).toBeGreaterThan(0);
    for (const item of result.entries) {
      expect(validate(item.entry), JSON.stringify(validate.errors, null, 2)).toBe(true);
      expect(item.lineNumber).toBeGreaterThan(0);
      expect(item.byteOffset).toBeGreaterThanOrEqual(0);
    }
  });

  it("reports malformed JSON lines with last-known-good offset", () => {
    const result = readPreferenceEntries(path.join(FIXTURE_DIR, "invalid_malformed_line.jsonl"));

    expect(result.entries).toHaveLength(1);
    expect(result.malformedLines).toHaveLength(1);
    expect(result.malformedLines[0]).toMatchObject({ lineNumber: 2 });
    expect(result.lastKnownGoodOffset).toBeGreaterThan(result.entries[0].byteOffset);
  });

  it("rejects schema-invalid lines", () => {
    const validate = schemaValidator();
    const result = readPreferenceEntries(path.join(FIXTURE_DIR, "invalid_missing_status.jsonl"), { validateEntry: validate });

    expect(result.entries).toHaveLength(0);
    expect(result.malformedLines).toHaveLength(1);
    expect(result.malformedLines[0].error).toContain("schema");
  });

  it("returns unresolved blocker for conflicting active preferences without priority", () => {
    const validate = schemaValidator();
    const result = readPreferenceEntries(path.join(FIXTURE_DIR, "edge_conflicting_active_preferences.jsonl"), { validateEntry: validate });
    const resolved = resolveActivePreference(result.entries.map((item) => item.entry), "pacing");

    expect(resolved.active).toBeNull();
    expect(resolved.conflicts.map((entry) => entry.entry_id).sort()).toEqual(["EPM_pacing_fast", "EPM_pacing_slow"]);
    expect(resolved.errors).toContain("unresolved active preference conflict for pacing");
  });

  it("classifies malformed consumed ranges as errors before offset and warnings after offset", () => {
    const filePath = path.join(FIXTURE_DIR, "edge_consumed_range_malformed.jsonl");
    const raw = fs.readFileSync(filePath, "utf-8");
    const line2Offset = Buffer.byteLength(raw.split("\n")[0] + "\n", "utf-8");
    const line3Offset = line2Offset + Buffer.byteLength(raw.split("\n")[1] + "\n", "utf-8");

    const afterBadLine = readPreferenceEntriesWithConsumedOffset(filePath, line3Offset);
    expect(afterBadLine.errorsInConsumed).toHaveLength(1);
    expect(afterBadLine.warningsAfterConsumed).toHaveLength(0);

    const beforeBadLine = readPreferenceEntriesWithConsumedOffset(filePath, line2Offset);
    expect(beforeBadLine.errorsInConsumed).toHaveLength(0);
    expect(beforeBadLine.warningsAfterConsumed).toHaveLength(1);
  });

  it("resolves supersession chains and detects cycles", () => {
    const validate = schemaValidator();
    const result = readPreferenceEntries(path.join(FIXTURE_DIR, "valid_superseded_transition_style.jsonl"), { validateEntry: validate });
    const resolved = resolveActivePreference(result.entries.map((item) => item.entry), "transition_style");

    expect(resolved.active?.entry_id).toBe("EPM_transition_new");
    expect(resolved.errors).toEqual([]);

    const cycleEntries = result.entries.map((item) => item.entry);
    cycleEntries[0].supersedes_entry_id = "EPM_transition_new";
    const cycle = resolveActivePreference(cycleEntries, "transition_style");
    expect(cycle.errors.join("\n")).toContain("cycle");
  });

  it("appends validated JSONL entries without array wrapping", () => {
    const validate = schemaValidator();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p3-pref-"));
    const filePath = path.join(tmpDir, "editorial_preference_memory.jsonl");
    const entry = readPreferenceEntries(path.join(FIXTURE_DIR, "valid_active_pacing.jsonl"), { validateEntry: validate }).entries[0].entry;

    const metadata = appendPreferenceEntry(filePath, entry, { validateEntry: validate });
    appendPreferenceEntry(filePath, { ...entry, entry_id: "EPM_pacing_active_2" }, { validateEntry: validate });

    const raw = fs.readFileSync(filePath, "utf-8");
    expect(raw.startsWith("[")).toBe(false);
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.trim().split("\n")).toHaveLength(2);
    expect(metadata.consumedOffset).toBeGreaterThan(0);
    expect(metadata.consumedHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("keeps redaction as append-only status entry", () => {
    const validate = schemaValidator();
    const result = readPreferenceEntries(path.join(FIXTURE_DIR, "valid_redaction_entry.jsonl"), { validateEntry: validate });

    expect(result.entries[0].entry.status).toBe("redacted");
    expect(result.entries[0].entry.preference_type).toBe("redaction");
  });

  it("computes canonical jsonl-records-v1 hash with line order preserved", () => {
    const rawPath = path.join(FIXTURE_DIR, "valid_superseded_transition_style.jsonl");
    const hash = computePreferenceMemoryHash(fs.readFileSync(rawPath, "utf-8"));
    const reversed = fs.readFileSync(rawPath, "utf-8").trim().split("\n").reverse().join("\n") + "\n";

    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(hash).not.toBe(computePreferenceMemoryHash(reversed));
  });

  it("projects active preferences into first-class blueprint fields without notes wrappers", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p3-pref-first-class-"));
    fs.mkdirSync(path.join(tmpDir, "00_project"), { recursive: true });
    fs.copyFileSync(
      path.join(FIXTURE_DIR, "valid_active_pacing.jsonl"),
      path.join(tmpDir, "00_project/editorial_preference_memory.jsonl"),
    );
    const raw = fs.readFileSync(path.join(tmpDir, "00_project/editorial_preference_memory.jsonl"), "utf-8");
    const blueprint: any = {
      version: "1.0.0",
      project_id: "p3-pref-first-class",
      sequence_goals: ["test"],
      beats: [{ id: "B01", label: "opening", target_duration_frames: 24, required_roles: ["hero"] }],
      pacing: { opening_cadence: "a", middle_cadence: "b", ending_cadence: "c" },
      music_policy: { start_sparse: true, allow_release_late: true, entry_beat: "B01" },
      dialogue_policy: { preserve_natural_breath: true, avoid_wall_to_wall_voiceover: true },
      transition_policy: { prefer_match_texture_over_flashy_fx: true },
      ending_policy: { should_feel: "resolved" },
      rejection_rules: ["none"],
    };

    expect(projectP3ContinuityPreferenceSignals(tmpDir, blueprint)).toBe(true);
    expect(blueprint.beats[0].applied_preferences).toEqual([
      expect.objectContaining({
        entry_id: "EPM_pacing_active",
        preference_type: "pacing",
        consumed_offset: Buffer.byteLength(raw, "utf-8"),
        consumed_hash: computePreferenceMemoryHash(raw),
      }),
    ]);
    expect(blueprint.beats[0].notes).toBeUndefined();
  });
});
