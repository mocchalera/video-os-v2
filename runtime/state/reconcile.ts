/**
 * State Reconcile Engine
 *
 * Reads project_state.yaml, checks canonical artifact existence + hashes,
 * re-computes current_state, applies invalidation matrix, and self-heals.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createHistoryEntry, type HistoryEntry } from "./history.js";
import { validateProject } from "../../scripts/validate-schemas.js";
import { LiveAnalysisRepository } from "../mcp/repository.js";

// ── Types ──────────────────────────────────────────────────────────

export type ProjectState =
  | "intent_pending"
  | "intent_locked"
  | "media_analyzed"
  | "selects_ready"
  | "blueprint_ready"
  | "blocked"
  | "timeline_drafted"
  | "critique_ready"
  | "approved"
  | "packaged";

export interface ArtifactHashes {
  brief_hash?: string;
  blockers_hash?: string;
  analysis_artifact_version?: string;
  selects_hash?: string;
  blueprint_hash?: string;
  uncertainty_hash?: string;
  timeline_version?: string;
  review_report_version?: string;
  review_patch_hash?: string;
  human_notes_hash?: string;
  style_hash?: string;
  // M4 additive fields
  editorial_timeline_hash?: string;
  caption_approval_hash?: string;
  music_cues_hash?: string;
  qa_report_hash?: string;
  package_manifest_hash?: string;
  packaging_projection_hash?: string;
}

export interface ApprovalRecord {
  status: "pending" | "clean" | "creative_override" | "stale";
  approved_by?: string;
  approved_at?: string;
  override_reason?: string;
  artifact_versions?: {
    timeline_version?: string;
    review_report_version?: string;
    review_patch_hash?: string;
    human_notes_hash?: string;
    style_hash?: string;
    // M4: canonical timeline identity for packaging freshness
    base_timeline_version?: string;
    editorial_timeline_hash?: string;
  };
}

export interface AnalysisOverride {
  status: "none" | "active" | "stale";
  approved_by?: string;
  approved_at?: string;
  reason?: string;
  scope?: string;
  artifact_version?: string;
}

export interface GateStatus {
  analysis_gate: "ready" | "partial_override" | "blocked";
  compile_gate: "open" | "blocked";
  planning_gate: "open" | "blocked";
  timeline_gate: "open" | "blocked";
  review_gate: "open" | "blocked";
  packaging_gate?: "open" | "blocked";
}

export interface HandoffResolution {
  handoff_id: string;
  status: "pending" | "decided";
  source_of_truth_decision?: "engine_render" | "nle_finishing";
  decided_by?: string;
  decided_at?: string;
  basis_report_hashes?: {
    roundtrip_import_report?: string;
    human_revision_diff?: string;
  };
}

export interface ProjectStateDoc {
  version: string | number;
  project_id: string;
  current_state: ProjectState;
  last_updated?: string;
  last_agent?: string;
  last_command?: string;
  last_runtime?: string;
  artifact_hashes?: ArtifactHashes;
  approval_record?: ApprovalRecord;
  analysis_override?: AnalysisOverride;
  handoff_resolution?: HandoffResolution;
  gates?: GateStatus;
  resume?: {
    pending_human_step?: string;
    pending_questions?: string[];
    resume_command?: string;
    last_error?: string;
  };
  history?: HistoryEntry[];
}

export interface ReconcileResult {
  persisted_state: ProjectState;
  reconciled_state: ProjectState;
  self_healed: boolean;
  stale_artifacts: string[];
  gates: GateStatus;
  history_appended: HistoryEntry[];
  doc: ProjectStateDoc;
}

// ── Artifact Paths ─────────────────────────────────────────────────

const ARTIFACT_PATHS: Record<string, { path: string; format: "yaml" | "json" | "md" }> = {
  brief: { path: "01_intent/creative_brief.yaml", format: "yaml" },
  blockers: { path: "01_intent/unresolved_blockers.yaml", format: "yaml" },
  selects: { path: "04_plan/selects_candidates.yaml", format: "yaml" },
  blueprint: { path: "04_plan/edit_blueprint.yaml", format: "yaml" },
  uncertainty: { path: "04_plan/uncertainty_register.yaml", format: "yaml" },
  timeline: { path: "05_timeline/timeline.json", format: "json" },
  review_report: { path: "06_review/review_report.yaml", format: "yaml" },
  review_patch: { path: "06_review/review_patch.json", format: "json" },
  human_notes: { path: "06_review/human_notes.yaml", format: "yaml" },
  style: { path: "STYLE.md", format: "md" },
  // M4 packaging artifacts
  caption_approval: { path: "07_package/caption_approval.json", format: "json" },
  music_cues: { path: "07_package/music_cues.json", format: "json" },
  qa_report: { path: "07_package/qa-report.json", format: "json" },
  package_manifest: { path: "07_package/package_manifest.json", format: "json" },
};

// ── Invalidation Matrix ────────────────────────────────────────────
//
// When an artifact hash changes, everything downstream becomes stale.
// Key = changed artifact, Value = list of downstream artifact keys + fallback state

interface InvalidationRule {
  stale_keys: string[];
  fallback_state: ProjectState;
}

const INVALIDATION_MATRIX: Record<string, InvalidationRule> = {
  brief: {
    stale_keys: ["selects", "blueprint", "timeline", "review_report", "review_patch"],
    fallback_state: "intent_locked",
  },
  analysis: {
    stale_keys: ["selects", "blueprint", "timeline", "review_report", "review_patch"],
    fallback_state: "media_analyzed",
  },
  selects: {
    stale_keys: ["blueprint", "timeline", "review_report", "review_patch"],
    fallback_state: "selects_ready",
  },
  style: {
    stale_keys: ["blueprint", "timeline", "review_report", "review_patch"],
    fallback_state: "selects_ready",
  },
  blueprint: {
    stale_keys: ["timeline", "review_report", "review_patch"],
    fallback_state: "blueprint_ready",
  },
  timeline: {
    stale_keys: ["review_report", "review_patch"],
    fallback_state: "timeline_drafted",
  },
  human_notes: {
    stale_keys: ["review_report", "review_patch"],
    fallback_state: "timeline_drafted",
  },
  review: {
    stale_keys: [],
    fallback_state: "critique_ready",
  },
  // M4 invalidation rules
  caption_approval: {
    stale_keys: ["qa_report", "package_manifest"],
    fallback_state: "approved",
  },
  music_cues: {
    stale_keys: ["qa_report", "package_manifest"],
    fallback_state: "approved",
  },
  qa_report: {
    stale_keys: ["package_manifest"],
    fallback_state: "approved",
  },
};

// ── Hash Computation ───────────────────────────────────────────────

export function computeFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ── Artifact Existence Snapshot ────────────────────────────────────

export interface ArtifactSnapshot {
  exists: Record<string, boolean>;
  hashes: ArtifactHashes;
}

function readAnalysisArtifactVersion(projectDir: string): string | undefined {
  const candidates = [
    path.join(projectDir, "03_analysis/assets.json"),
    path.join(projectDir, "03_analysis/segments.json"),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf-8")) as {
        artifact_version?: unknown;
      };
      if (typeof parsed.artifact_version === "string" && parsed.artifact_version.length > 0) {
        return parsed.artifact_version;
      }
    } catch {
      // Analysis validation is handled separately when gates are computed.
    }
  }

  return undefined;
}

export function snapshotArtifacts(projectDir: string): ArtifactSnapshot {
  const exists: Record<string, boolean> = {};
  const hashes: ArtifactHashes = {};

  for (const [key, entry] of Object.entries(ARTIFACT_PATHS)) {
    const absPath = path.join(projectDir, entry.path);
    const fileExists = fs.existsSync(absPath);
    exists[key] = fileExists;
    if (fileExists) {
      const hash = computeFileHash(absPath);
      switch (key) {
        case "brief": hashes.brief_hash = hash; break;
        case "blockers": hashes.blockers_hash = hash; break;
        case "selects": hashes.selects_hash = hash; break;
        case "blueprint": hashes.blueprint_hash = hash; break;
        case "uncertainty": hashes.uncertainty_hash = hash; break;
        case "timeline": hashes.timeline_version = hash; break;
        case "review_report": hashes.review_report_version = hash; break;
        case "review_patch": hashes.review_patch_hash = hash; break;
        case "human_notes": hashes.human_notes_hash = hash; break;
        case "style": hashes.style_hash = hash; break;
        case "caption_approval": hashes.caption_approval_hash = hash; break;
        case "music_cues": hashes.music_cues_hash = hash; break;
        case "qa_report": hashes.qa_report_hash = hash; break;
        case "package_manifest": hashes.package_manifest_hash = hash; break;
      }
    }
  }

  hashes.analysis_artifact_version = readAnalysisArtifactVersion(projectDir);

  // editorial_timeline_hash mirrors timeline_version (both are hashes of timeline.json)
  if (hashes.timeline_version) {
    hashes.editorial_timeline_hash = hashes.timeline_version;
  }

  // packaging_projection_hash: derived from caption_approval + music_cues + render_defaults
  // Per design: render defaults / toolchain fingerprint are part of packaging freshness
  let renderDefaultsHash: string | undefined;
  const renderDefaultsPath = path.join(projectDir, "runtime/render-pipeline-defaults.yaml");
  if (fs.existsSync(renderDefaultsPath)) {
    renderDefaultsHash = computeFileHash(renderDefaultsPath);
  }

  if (hashes.caption_approval_hash || hashes.music_cues_hash || renderDefaultsHash) {
    const parts = [
      hashes.caption_approval_hash ?? "",
      hashes.music_cues_hash ?? "",
      renderDefaultsHash ?? "",
    ].join("+");
    hashes.packaging_projection_hash = crypto
      .createHash("sha256")
      .update(parts)
      .digest("hex")
      .slice(0, 16);
  }

  return { exists, hashes };
}

// ── State Reconstruction ───────────────────────────────────────────
//
// From artifact existence, compute the highest stable state the project
// can reach. This does NOT consider gate conditions — gates are layered
// on top by the caller.

const STATE_ORDER: ProjectState[] = [
  "intent_pending",
  "intent_locked",
  "media_analyzed",
  "selects_ready",
  "blueprint_ready",
  "blocked",
  "timeline_drafted",
  "critique_ready",
  "approved",
  "packaged",
];

export function reconstructState(
  snapshot: ArtifactSnapshot,
  approvalRecord?: ApprovalRecord,
  analysisReady?: boolean,
): ProjectState {
  const { exists } = snapshot;

  // intent_locked: brief + blockers exist
  if (!exists.brief || !exists.blockers) return "intent_pending";

  // media_analyzed: analysis artifacts exist and gate is ready
  if (!exists.selects) {
    if (analysisReady) return "media_analyzed";
    return "intent_locked";
  }

  // selects_ready: selects exist
  if (!exists.blueprint) return "selects_ready";

  // blueprint_ready: blueprint exists
  if (!exists.timeline) return "blueprint_ready";

  // timeline_drafted: timeline exists
  if (!exists.review_report && !exists.review_patch) return "timeline_drafted";

  // critique_ready: review artifacts exist
  if (!approvalRecord || approvalRecord.status === "pending" || approvalRecord.status === "stale") {
    return "critique_ready";
  }

  // approved: approval_record.status in {clean, creative_override}
  // AND artifact_versions match current snapshot
  if (
    (approvalRecord.status === "clean" || approvalRecord.status === "creative_override") &&
    approvalVersionsMatch(approvalRecord, snapshot.hashes)
  ) {
    // packaged: qa_report + package_manifest exist on top of approved
    if (exists.qa_report && exists.package_manifest) {
      return "packaged";
    }
    return "approved";
  }

  return "critique_ready";
}

function approvalVersionsMatch(
  record: ApprovalRecord,
  currentHashes: ArtifactHashes,
): boolean {
  if (!record.artifact_versions) return false;
  const av = record.artifact_versions;
  if (av.timeline_version && av.timeline_version !== currentHashes.timeline_version) return false;
  if (av.review_report_version && av.review_report_version !== currentHashes.review_report_version) return false;
  if (av.review_patch_hash && av.review_patch_hash !== currentHashes.review_patch_hash) return false;
  if (av.human_notes_hash && av.human_notes_hash !== currentHashes.human_notes_hash) return false;
  if (av.style_hash && av.style_hash !== currentHashes.style_hash) return false;
  // M4: check editorial_timeline_hash binding
  if (av.editorial_timeline_hash && av.editorial_timeline_hash !== currentHashes.editorial_timeline_hash) return false;
  return true;
}

// ── Invalidation Detection ─────────────────────────────────────────

export interface InvalidationResult {
  stale_artifacts: string[];
  lowest_fallback: ProjectState | null;
  approval_stale: boolean;
}

export function detectInvalidation(
  oldHashes: ArtifactHashes | undefined,
  newHashes: ArtifactHashes,
  oldHandoff?: HandoffResolution,
  newHandoff?: HandoffResolution,
): InvalidationResult {
  if (!oldHashes) {
    return { stale_artifacts: [], lowest_fallback: null, approval_stale: false };
  }

  const staleSet = new Set<string>();
  let lowestIdx = STATE_ORDER.length;
  let approvalStale = false;

  // Check each upstream artifact for hash changes
  const checks: Array<{
    oldVal: string | undefined;
    newVal: string | undefined;
    ruleKey: string;
  }> = [
    { oldVal: oldHashes.brief_hash, newVal: newHashes.brief_hash, ruleKey: "brief" },
    { oldVal: oldHashes.analysis_artifact_version, newVal: newHashes.analysis_artifact_version, ruleKey: "analysis" },
    { oldVal: oldHashes.selects_hash, newVal: newHashes.selects_hash, ruleKey: "selects" },
    { oldVal: oldHashes.style_hash, newVal: newHashes.style_hash, ruleKey: "style" },
    { oldVal: oldHashes.blueprint_hash, newVal: newHashes.blueprint_hash, ruleKey: "blueprint" },
    { oldVal: oldHashes.timeline_version, newVal: newHashes.timeline_version, ruleKey: "timeline" },
    { oldVal: oldHashes.human_notes_hash, newVal: newHashes.human_notes_hash, ruleKey: "human_notes" },
    { oldVal: oldHashes.review_report_version, newVal: newHashes.review_report_version, ruleKey: "review" },
    { oldVal: oldHashes.review_patch_hash, newVal: newHashes.review_patch_hash, ruleKey: "review" },
    // M4 invalidation checks
    { oldVal: oldHashes.caption_approval_hash, newVal: newHashes.caption_approval_hash, ruleKey: "caption_approval" },
    { oldVal: oldHashes.music_cues_hash, newVal: newHashes.music_cues_hash, ruleKey: "music_cues" },
    { oldVal: oldHashes.qa_report_hash, newVal: newHashes.qa_report_hash, ruleKey: "qa_report" },
  ];

  for (const { oldVal, newVal, ruleKey } of checks) {
    // Only trigger if old hash existed and changed (or was removed)
    if (oldVal && oldVal !== newVal) {
      const rule = INVALIDATION_MATRIX[ruleKey];
      if (!rule) continue;

      for (const key of rule.stale_keys) {
        staleSet.add(key);
      }
      approvalStale = true;

      const idx = STATE_ORDER.indexOf(rule.fallback_state);
      if (idx >= 0 && idx < lowestIdx) {
        lowestIdx = idx;
      }
    }
  }

  // M4: source_of_truth_decision change invalidates packaging artifacts
  if (
    oldHandoff?.source_of_truth_decision &&
    newHandoff?.source_of_truth_decision &&
    oldHandoff.source_of_truth_decision !== newHandoff.source_of_truth_decision
  ) {
    staleSet.add("qa_report");
    staleSet.add("package_manifest");
    approvalStale = true;
    const fallbackIdx = STATE_ORDER.indexOf("approved");
    if (fallbackIdx >= 0 && fallbackIdx < lowestIdx) {
      lowestIdx = fallbackIdx;
    }
  }

  return {
    stale_artifacts: Array.from(staleSet),
    lowest_fallback: lowestIdx < STATE_ORDER.length ? STATE_ORDER[lowestIdx] : null,
    approval_stale: approvalStale,
  };
}

// ── Read / Write project_state.yaml ────────────────────────────────

export function readProjectState(projectDir: string): ProjectStateDoc | null {
  const stateFile = path.join(projectDir, "project_state.yaml");
  if (!fs.existsSync(stateFile)) return null;
  const raw = fs.readFileSync(stateFile, "utf-8");
  return parseYaml(raw) as ProjectStateDoc;
}

export function writeProjectState(projectDir: string, doc: ProjectStateDoc): void {
  const stateFile = path.join(projectDir, "project_state.yaml");
  doc.last_updated = new Date().toISOString();
  fs.writeFileSync(stateFile, stringifyYaml(doc), "utf-8");
}

// ── Reconcile ──────────────────────────────────────────────────────

export function reconcile(
  projectDir: string,
  actor: string = "reconcile",
  trigger: string = "startup",
): ReconcileResult {
  const absProject = path.resolve(projectDir);

  // 1. Read persisted state
  let doc = readProjectState(absProject);
  const persistedState = doc?.current_state ?? "intent_pending";

  if (!doc) {
    doc = {
      version: 1,
      project_id: "",
      current_state: "intent_pending",
      history: [],
    };
  }

  // 2. Snapshot current artifact hashes
  const snapshot = snapshotArtifacts(absProject);

  // 3. Detect invalidation from hash changes + source_of_truth changes
  const invalidation = detectInvalidation(
    doc.artifact_hashes,
    snapshot.hashes,
    doc.handoff_resolution,
    doc.handoff_resolution,
  );

  // 4. Mark approval_record stale if needed
  if (invalidation.approval_stale && doc.approval_record) {
    doc.approval_record.status = "stale";
  }

  // 5. Check analysis_override staleness
  if (
    doc.analysis_override &&
    doc.analysis_override.status === "active" &&
    (
      !doc.analysis_override.artifact_version ||
      !snapshot.hashes.analysis_artifact_version ||
      doc.analysis_override.artifact_version !== snapshot.hashes.analysis_artifact_version
    )
  ) {
    doc.analysis_override.status = "stale";
  }

  // 6. Compute gates from current artifacts
  const gates = computeGates(absProject, snapshot, doc);
  const analysisReady = gates.analysis_gate === "ready" || gates.analysis_gate === "partial_override";

  // 7. Reconstruct state from filesystem
  const reconstructed = reconstructState(snapshot, doc.approval_record, analysisReady);

  // 8. If invalidation pushed state lower, use the lowest
  let reconciledState = reconstructed;
  if (invalidation.lowest_fallback) {
    const fallbackIdx = STATE_ORDER.indexOf(invalidation.lowest_fallback);
    const reconstructedIdx = STATE_ORDER.indexOf(reconstructed);
    if (fallbackIdx >= 0 && reconstructedIdx >= 0 && fallbackIdx < reconstructedIdx) {
      reconciledState = invalidation.lowest_fallback;
    }
  }

  if (
    snapshot.exists.blueprint &&
    (gates.compile_gate === "blocked" || gates.planning_gate === "blocked")
  ) {
    reconciledState = "blocked";
  }

  // M4: source_of_truth_decision consistency check
  // If packaged but the manifest's source_of_truth doesn't match the current decision, fall back
  if (reconciledState === "packaged" && snapshot.exists.package_manifest && doc.handoff_resolution?.source_of_truth_decision) {
    try {
      const manifestPath = path.join(absProject, ARTIFACT_PATHS.package_manifest.path);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as { source_of_truth?: string };
      if (manifest.source_of_truth && manifest.source_of_truth !== doc.handoff_resolution.source_of_truth_decision) {
        reconciledState = "approved";
        invalidation.stale_artifacts.push("qa_report", "package_manifest");
      }
    } catch {
      // Non-fatal: if manifest can't be parsed, leave state as-is
    }
  }

  // 9. Self-heal if needed
  const selfHealed = reconciledState !== persistedState;
  const historyAppended: HistoryEntry[] = [];

  if (selfHealed) {
    const entry = createHistoryEntry(
      persistedState,
      reconciledState,
      trigger,
      actor,
      `self-heal: ${persistedState} -> ${reconciledState}`,
    );
    historyAppended.push(entry);
    if (!doc.history) doc.history = [];
    doc.history.push(entry);
  }

  // 10. Update doc
  doc.current_state = reconciledState;
  doc.artifact_hashes = snapshot.hashes;
  doc.gates = gates;

  return {
    persisted_state: persistedState,
    reconciled_state: reconciledState,
    self_healed: selfHealed,
    stale_artifacts: invalidation.stale_artifacts,
    gates,
    history_appended: historyAppended,
    doc,
  };
}

// ── Gate Computation ───────────────────────────────────────────────

function computeGates(
  projectDir: string,
  snapshot: ArtifactSnapshot,
  doc: ProjectStateDoc,
): GateStatus {
  let analysisGate: GateStatus["analysis_gate"] = "blocked";
  const analysis = computeAnalysisStatus(projectDir, doc.project_id || "");
  if (analysis.qcStatus === "ready") {
    analysisGate = "ready";
  } else if (
    analysis.qcStatus === "partial" &&
    doc.analysis_override?.status === "active" &&
    doc.analysis_override.artifact_version === snapshot.hashes.analysis_artifact_version
  ) {
    analysisGate = "partial_override";
  }

  // compile_gate: check unresolved_blockers for status:blocker
  let compileGate: GateStatus["compile_gate"] = "open";
  if (snapshot.exists.blockers) {
    try {
      const raw = fs.readFileSync(
        path.join(projectDir, ARTIFACT_PATHS.blockers.path),
        "utf-8",
      );
      const blockers = parseYaml(raw) as { blockers?: Array<{ status?: string }> };
      if (blockers?.blockers?.some((b) => b.status === "blocker")) {
        compileGate = "blocked";
      }
    } catch {
      // Non-fatal
    }
  }

  // planning_gate: check uncertainty_register for status:blocker
  let planningGate: GateStatus["planning_gate"] = "open";
  if (snapshot.exists.uncertainty) {
    try {
      const raw = fs.readFileSync(
        path.join(projectDir, ARTIFACT_PATHS.uncertainty.path),
        "utf-8",
      );
      const register = parseYaml(raw) as { uncertainties?: Array<{ status?: string }> };
      if (register?.uncertainties?.some((u) => u.status === "blocker")) {
        planningGate = "blocked";
      }
    } catch {
      // Non-fatal
    }
  }

  // timeline_gate: timeline exists and passes basic checks
  const timelineGate: GateStatus["timeline_gate"] = snapshot.exists.timeline ? "open" : "blocked";

  // review_gate: review_report exists and no fatal_issues
  let reviewGate: GateStatus["review_gate"] = "blocked";
  if (snapshot.exists.review_report) {
    try {
      const raw = fs.readFileSync(
        path.join(projectDir, ARTIFACT_PATHS.review_report.path),
        "utf-8",
      );
      const report = parseYaml(raw) as { fatal_issues?: unknown[] };
      const fatalIssues = Array.isArray(report?.fatal_issues) ? report.fatal_issues : [];
      reviewGate = fatalIssues.length === 0 ? "open" : "blocked";
    } catch {
      // Non-fatal
    }
  }

  // packaging_gate: review_gate open + handoff_resolution decided + M4 prerequisites
  // Also requires caption_approval if caption_policy.source != "none"
  // Also requires music_cues if BGM is enabled
  let packagingGate: "open" | "blocked" = "blocked";
  if (
    reviewGate === "open" &&
    doc.handoff_resolution?.status === "decided" &&
    doc.handoff_resolution?.source_of_truth_decision &&
    doc.approval_record &&
    (doc.approval_record.status === "clean" || doc.approval_record.status === "creative_override")
  ) {
    // Check caption/music prerequisites from blueprint caption_policy
    let captionPrereqMet = true;
    let musicPrereqMet = true;
    try {
      const blueprintPath = path.join(projectDir, ARTIFACT_PATHS.blueprint.path);
      if (fs.existsSync(blueprintPath)) {
        const bp = parseYaml(fs.readFileSync(blueprintPath, "utf-8")) as {
          caption_policy?: { source?: string };
          music_policy?: { enabled?: boolean };
        };
        // Captions enabled → require caption_approval
        if (bp.caption_policy?.source && bp.caption_policy.source !== "none") {
          captionPrereqMet = snapshot.exists.caption_approval === true;
        }
        // Music enabled → require music_cues
        if (bp.music_policy?.enabled === true) {
          musicPrereqMet = snapshot.exists.music_cues === true;
        }
      }
    } catch {
      // Non-fatal
    }
    if (captionPrereqMet && musicPrereqMet) {
      packagingGate = "open";
    }
  }

  return {
    analysis_gate: analysisGate,
    compile_gate: compileGate,
    planning_gate: planningGate,
    timeline_gate: timelineGate,
    review_gate: reviewGate,
    packaging_gate: packagingGate,
  };
}

function computeAnalysisStatus(
  projectDir: string,
  projectId: string,
): {
  artifactVersion?: string;
  qcStatus?: "ready" | "partial" | "blocked";
} {
  const assetsPath = path.join(projectDir, "03_analysis/assets.json");
  const segmentsPath = path.join(projectDir, "03_analysis/segments.json");
  const artifactVersion = readAnalysisArtifactVersion(projectDir);

  if (!fs.existsSync(assetsPath) || !fs.existsSync(segmentsPath)) {
    return { artifactVersion };
  }

  const validation = validateProject(projectDir);
  const analysisViolations = validation.violations.filter(
    (violation) =>
      violation.artifact === "analysis_policy.yaml" ||
      violation.artifact.startsWith("03_analysis/"),
  );
  if (analysisViolations.length > 0) {
    return { artifactVersion };
  }

  try {
    const summary = new LiveAnalysisRepository(projectDir).projectSummary(projectId);
    return {
      artifactVersion: summary.artifact_version || artifactVersion,
      qcStatus: summary.qc_status,
    };
  } catch {
    return { artifactVersion };
  }
}
