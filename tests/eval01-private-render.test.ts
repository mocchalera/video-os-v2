import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { buildAssSubtitleFile } from "../runtime/render/promo-finisher.js";
import {
  resolveSocialReviewCaptionStyle,
  socialReviewCaptionStyle,
} from "../runtime/render/review-caption-style.js";
import {
  EVAL01_OUTPUT_HASH_ORDER,
  buildClosedQaReport,
  buildClosedReceipt,
  countBoundOverlaps,
  domainSeparatedBodyHash,
  evaluateAssCaptionStyle,
  invokeRendererExactlyOnce,
  runEval01PrivateRender,
  validateExactInputBindings,
  validateJsonSchema,
  type Eval01QaEvidence,
  type Eval01ReceiptEvidence,
} from "../scripts/eval01-private-render.js";

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (options: Record<string, unknown>) => {
  compile(schema: object): ((value: unknown) => boolean) & { errors?: unknown[] | null };
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval01-private-render-"));
  tempDirs.push(dir);
  return dir;
}

interface VerifiedNodeModulesLayout {
  kind: "symlink" | "directory";
  repoPath: string;
  restoreSource: string;
  nodeModulesTarget: string;
}

function inspectVerifiedNodeModulesLayout(repoPath: string): VerifiedNodeModulesLayout {
  const stat = fs.lstatSync(repoPath);
  expect(
    stat.isSymbolicLink() || stat.isDirectory(),
    "repo node_modules must be a symlink or a real directory",
  ).toBe(true);
  const nodeModulesTarget = fs.realpathSync(repoPath);
  const targetStat = fs.lstatSync(nodeModulesTarget);
  expect(targetStat.isDirectory()).toBe(true);
  expect(targetStat.isSymbolicLink()).toBe(false);
  expect(fs.existsSync(path.join(nodeModulesTarget, "tsx/dist/cli.mjs"))).toBe(true);
  return {
    kind: stat.isSymbolicLink() ? "symlink" : "directory",
    repoPath,
    restoreSource: stat.isSymbolicLink() ? fs.readlinkSync(repoPath) : nodeModulesTarget,
    nodeModulesTarget,
  };
}

function writeFixtureNodeModules(root: string): string {
  const realDir = path.join(root, "real-node-modules");
  fs.mkdirSync(path.join(realDir, "tsx/dist"), { recursive: true });
  fs.writeFileSync(path.join(realDir, "tsx/dist/cli.mjs"), "export {}\n");
  return realDir;
}

function liveNodeModulesIdentity(repoPath: string): {
  kind: "symlink" | "directory";
  ino: number;
  realpath: string;
} {
  const stat = fs.lstatSync(repoPath);
  return {
    kind: stat.isSymbolicLink() ? "symlink" : "directory",
    ino: stat.ino,
    realpath: fs.realpathSync(repoPath),
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function qaEvidence(overrides: Partial<Eval01QaEvidence> = {}): Eval01QaEvidence {
  return {
    createdAt: "2026-08-18T00:00:00.000Z",
    videoPath: "/artifact/project/06_review/useful-private-v2.mp4",
    captionPlanSha256: "1".repeat(64),
    provenanceSha256: "2".repeat(64),
    cueCount: 21,
    burnedCaptionCount: 21,
    rawAsrOverlapCount: 3,
    displaySourceOverlapCount: 0,
    displayTimelineOverlapCount: 0,
    maxLinesObserved: 2,
    safeAreaPass: true,
    captionStyleFailures: [],
    captionFontFamily: "VideoOS Noto Sans JP Black",
    captionFontSha256: "3".repeat(64),
    audioStreamPresent: true,
    audioPreset: "dialogue-clean",
    beforeIntegratedLufs: -22.4,
    beforeTruePeakDbtp: -4.2,
    afterIntegratedLufs: -16.1,
    afterTruePeakDbtp: -1.3,
    targetIntegratedLufs: -16,
    audioMixPolicyValid: true,
    fullDecode: true,
    width: 1920,
    height: 1080,
    fpsNum: 30,
    fpsDen: 1,
    frameCount: 2700,
    durationMs: 90_000,
    audioDurationMs: 89_980,
    avStartDeltaMs: 0,
    avEndDeltaMs: 20,
    representativeFrames: [
      { frame: 0, path: "project/06_review/useful-private-v2-representative-frames/frame-000000.png", sha256: "4".repeat(64) },
      { frame: 1350, path: "project/06_review/useful-private-v2-representative-frames/frame-001350.png", sha256: "5".repeat(64) },
      { frame: 2699, path: "project/06_review/useful-private-v2-representative-frames/frame-002699.png", sha256: "6".repeat(64) },
    ],
    assemblyTimingValid: true,
    ...overrides,
  };
}

function receiptEvidence(overrides: Partial<Eval01ReceiptEvidence> = {}): Eval01ReceiptEvidence {
  const outputHashes = EVAL01_OUTPUT_HASH_ORDER.map((relativePath) => ({
    path: relativePath,
    state: "present" as const,
    regular_file: true,
    bytes: relativePath.includes(".log") ? 0 : 1,
    sha256: sha256(relativePath),
    mode_octal: "0600",
    nlink: 1,
  }));
  return {
    status: "PASS",
    createdAt: "2026-08-18T00:00:01.000Z",
    authority: {
      base_plan_sha256: "a".repeat(64),
      overlay_sha256: "b".repeat(64),
      pcl_task_id: "T-0054",
      pcl_evidence_id: "E-0477",
      human_render_ask_id: "ask_exact1",
      human_render_decision_sha256: "c".repeat(64),
    },
    invocation: {
      cwd: "/repo",
      executable: "/node",
      argv: ["tsx", "scripts/render-social-review.ts", "--project", "/artifact/project"],
      env: { CI: "1", NODE_ENV: "production", NO_COLOR: "1", PATH: "/bin" },
      started_at: "2026-08-18T00:00:00.000Z",
      ended_at: "2026-08-18T00:00:01.000Z",
      timed_out: false,
      signal: null,
      retry_count: 0,
      workaround_count: 0,
    },
    inputHashes: [
      "base_plan",
      "timeline_current",
      "caption_plan_v2",
      "caption_provenance_v2",
      "authoring_receipt_v2",
      "independent_authoring_audit_v2",
      "source_media",
      "render_social_review_source",
      "render_rough_cut_source",
      "future_v2_native_runner_source",
    ].map((id) => ({ id, path: `/inputs/${id}`, bytes: 1, sha256: sha256(id), verified_before: true, verified_after: true })),
    symlinkProof: {
      pre: { path: "/repo/node_modules", state: "absent" },
      during: {
        path: "/repo/node_modules",
        lstat_type: "symlink",
        mode_octal: "0777",
        nlink: 1,
        readlink_target: "/deps/node_modules",
        realpath_target: "/deps/node_modules",
        tsx_cli_sha256: "d".repeat(64),
      },
      post: { path: "/repo/node_modules", state: "absent" },
    },
    exitRecords: [
      { stage: "pre_render_project_schema", invoked: true, exit_code: 0, not_invoked_reason: null },
      { stage: "render", invoked: true, exit_code: 0, not_invoked_reason: null },
      { stage: "post_render_targeted_media_qa", invoked: true, exit_code: 0, not_invoked_reason: null },
      { stage: "receipt_publication", invoked: true, exit_code: 0, not_invoked_reason: null },
    ],
    outputHashes,
    qa: buildClosedQaReport(qaEvidence()),
    outsideOwnedChanges: [],
    failureReasons: [],
    ...overrides,
  };
}

describe("EVAL-01 bounded private render contract", () => {
  it("publishes a schema-valid closed env when the pre-render child fails", async () => {
    const root = tempDir();
    const projectDir = path.join(root, "project");
    const inputsDir = path.join(root, "inputs");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(inputsDir, { recursive: true });

    const inputIds = [
      "base_plan",
      "timeline_current",
      "caption_plan_v2",
      "caption_provenance_v2",
      "authoring_receipt_v2",
      "independent_authoring_audit_v2",
      "source_media",
    ];
    const inputBindings = inputIds.map((id) => {
      const inputPath = path.join(inputsDir, `${id}.json`);
      const contents = `${id}\n`;
      fs.writeFileSync(inputPath, contents, "utf8");
      return { id, path: inputPath, bytes: Buffer.byteLength(contents), sha256: sha256(contents) };
    });
    const persistentAllowlist = [...EVAL01_OUTPUT_HASH_ORDER, "evidence/private-render-v2.json"];
    const overlayPath = path.join(root, "overlay.json");
    fs.writeFileSync(overlayPath, JSON.stringify({
      authority: { pcl_task_id: "T-0054", pcl_evidence_id: "E-test" },
      human_gates: { render_exact1: { status: "approved" } },
      owned_paths: { later_render_exact_allowlist: { files_in_hash_order: persistentAllowlist } },
      current_input_bindings: inputBindings,
    }), "utf8");
    const overlaySha256 = sha256(fs.readFileSync(overlayPath));

    const liveRepoNodeModules = path.resolve("node_modules");
    const beforeLive = liveNodeModulesIdentity(liveRepoNodeModules);
    const layout = inspectVerifiedNodeModulesLayout(liveRepoNodeModules);
    const nodeModulesTarget = layout.nodeModulesTarget;
    const fixtureNodeModules = path.join(root, "isolated-node-modules");
    const repoAuditRoot = path.join(root, "isolated-audit-root");
    const auditSentinel = path.join(repoAuditRoot, "audit-sentinel.txt");
    fs.mkdirSync(repoAuditRoot, { recursive: true });
    fs.writeFileSync(auditSentinel, "isolated-audit-root\n", "utf8");
    const beforeAuditSentinel = sha256(fs.readFileSync(auditSentinel));
    const canonicalRunner = path.resolve("scripts/eval01-private-render.ts");
    const beforeCanonicalRunner = {
      ino: fs.statSync(canonicalRunner).ino,
      sha256: sha256(fs.readFileSync(canonicalRunner)),
    };
    expect(fixtureNodeModules).not.toBe(liveRepoNodeModules);
    expect(path.resolve(repoAuditRoot)).not.toBe(path.resolve("."));
    expect(fs.realpathSync(repoAuditRoot)).not.toBe(fs.realpathSync("."));
    expect(fs.lstatSync(fixtureNodeModules, { throwIfNoEntry: false })).toBeUndefined();
    const dependencyRoot = path.dirname(nodeModulesTarget);
    const sourceHashes = {
      render_social_review_source: sha256(fs.readFileSync("scripts/render-social-review.ts")),
      render_rough_cut_source: sha256(fs.readFileSync("scripts/render-rough-cut.ts")),
      future_v2_native_runner_source: sha256(fs.readFileSync("scripts/eval01-private-render.ts")),
    };
    const renderEnv = { CI: "1", NODE_ENV: "production", NO_COLOR: "1", PATH: "/bin" };
    const decisionPath = path.join(root, "decision.json");
    fs.writeFileSync(decisionPath, JSON.stringify({
      schema_version: "eval01-private-render-decision/v1",
      status: "APPROVED",
      overlay_sha256: overlaySha256,
      invocation_count: 1,
      retry_count: 0,
      workaround_count: 0,
      ask_id: "ask-test",
      persistent_allowlist: persistentAllowlist,
      dependency: {
        node_modules_target: nodeModulesTarget,
        package_json_sha256: sha256(fs.readFileSync(path.join(dependencyRoot, "package.json"))),
        package_lock_sha256: sha256(fs.readFileSync(path.join(dependencyRoot, "package-lock.json"))),
        tsx_cli_sha256: sha256(fs.readFileSync(path.join(nodeModulesTarget, "tsx/dist/cli.mjs"))),
      },
      render_env: renderEnv,
      input_hashes: {
        ...Object.fromEntries(inputBindings.map((entry) => [entry.id, entry.sha256])),
        ...sourceHashes,
      },
    }), "utf8");
    const humanDecisionSha256 = sha256(fs.readFileSync(decisionPath));

    const receipt = await runEval01PrivateRender({
      overlayPath,
      overlaySha256,
      humanDecisionPath: decisionPath,
      humanDecisionSha256,
      projectDir,
      nodeModulesTarget,
      nodeModulesPath: fixtureNodeModules,
      repoAuditRoot,
    });
    expect(receipt.status).toBe("NONPASS_STOP");
    expect(receipt.invocation_count).toBe(0);
    expect(receipt.invocation.cwd).toBe(path.resolve("."));
    expect(receipt.invocation.env).toEqual(renderEnv);
    expect(Object.keys(receipt.invocation.env)).toEqual(["CI", "NODE_ENV", "NO_COLOR", "PATH"]);
    expect(receipt.exit_records[0]).toMatchObject({
      stage: "pre_render_project_schema",
      invoked: true,
      exit_code: 1,
    });
    expect(receipt.exit_records[1]).toMatchObject({ stage: "render", invoked: false });
    expect(receipt.symlink_proof.pre).toMatchObject({ path: fixtureNodeModules, state: "absent" });
    expect(receipt.symlink_proof.during).toMatchObject({
      path: fixtureNodeModules,
      lstat_type: "symlink",
      readlink_target: nodeModulesTarget,
      realpath_target: fs.realpathSync(nodeModulesTarget),
    });
    expect(receipt.symlink_proof.post).toMatchObject({ path: fixtureNodeModules, state: "absent" });
    expect(fs.lstatSync(fixtureNodeModules, { throwIfNoEntry: false })).toBeUndefined();
    expect(validateJsonSchema("schemas/eval01-private-render-receipt.schema.json", receipt)).toEqual([]);
    expect(receipt.nonpass_stop.failure_reasons).not.toContain("outside_owned_change");
    expect(sha256(fs.readFileSync(auditSentinel))).toBe(beforeAuditSentinel);
    expect(fs.readdirSync(repoAuditRoot)).toEqual(["audit-sentinel.txt"]);
    expect(liveNodeModulesIdentity(liveRepoNodeModules)).toEqual(beforeLive);
    expect(fs.statSync(canonicalRunner).ino).toBe(beforeCanonicalRunner.ino);
    expect(sha256(fs.readFileSync(canonicalRunner))).toBe(beforeCanonicalRunner.sha256);
    expect(fs.readFileSync("scripts/eval01-private-render.ts", "utf8")).not.toMatch(/--repo-audit-root/);
    expect(fs.readFileSync("scripts/eval01-private-render.ts", "utf8")).toMatch(
      /const repoAuditRoot = args\.repoAuditRoot \?\? repoRoot;/,
    );
  });

  it("accepts a verified node_modules symlink or real directory without rewriting the original layout", () => {
    const root = tempDir();
    const realDir = writeFixtureNodeModules(root);
    const linkPath = path.join(root, "linked-node-modules");
    fs.symlinkSync(realDir, linkPath);

    const fromDir = inspectVerifiedNodeModulesLayout(realDir);
    const fromLink = inspectVerifiedNodeModulesLayout(linkPath);
    expect(fromDir.kind).toBe("directory");
    expect(fromLink.kind).toBe("symlink");
    expect(fromDir.nodeModulesTarget).toBe(fs.realpathSync(realDir));
    expect(fromLink.nodeModulesTarget).toBe(fromDir.nodeModulesTarget);
    expect(fromDir.restoreSource).toBe(fromDir.nodeModulesTarget);
    expect(fromLink.restoreSource).toBe(realDir);
    expect(fs.lstatSync(realDir).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(linkPath)).toBe(realDir);
  });

  it("defers the Remotion-dependent caption normalizer until after bootstrap", () => {
    const source = fs.readFileSync("scripts/eval01-private-render.ts", "utf8");
    const dynamicImport = 'const { normalizeCaptionPlan } = await import("./render-social-review.js");';
    const qaDefinitionIndex = source.indexOf("export async function runTargetedQa(");
    const dynamicImportIndex = source.indexOf(dynamicImport);
    const normalizerUseIndex = source.indexOf("normalizeCaptionPlan(captionPlan)");
    const symlinkIndex = source.indexOf("fs.symlinkSync(args.nodeModulesTarget, nodeModulesPath)");
    const qaCalls = [...source.matchAll(/await runTargetedQa\(/g)];
    const cleanupIndex = source.indexOf("if (symlinkCreated) fs.unlinkSync(nodeModulesPath)");

    expect(source).not.toMatch(/^import\s+\{\s*normalizeCaptionPlan\s*\}\s+from\s+["']\.\/render-social-review\.js["'];$/m);
    expect(source.split(dynamicImport)).toHaveLength(2);
    expect(qaDefinitionIndex).toBeGreaterThanOrEqual(0);
    expect(dynamicImportIndex).toBeGreaterThan(qaDefinitionIndex);
    expect(dynamicImportIndex).toBeLessThan(normalizerUseIndex);
    expect(qaCalls).toHaveLength(1);
    expect(qaCalls[0].index).toBeGreaterThan(symlinkIndex);
    expect(qaCalls[0].index).toBeLessThan(cleanupIndex);
  });

  it("counts raw overlaps independently from clamped display bounds", () => {
    expect(countBoundOverlaps([
      { in: 0, out: 10 },
      { in: 9, out: 20 },
      { in: 20, out: 30 },
      { in: 29, out: 40 },
      { in: 39, out: 50 },
    ])).toBe(3);
    expect(countBoundOverlaps([
      { in: 0, out: 10 },
      { in: 10, out: 20 },
    ])).toBe(0);
  });

  it("fails exact input preflight before execution when bytes or SHA drift", () => {
    const root = tempDir();
    const inputPath = path.join(root, "input.json");
    fs.writeFileSync(inputPath, "fixed", "utf8");
    const bindings = [{ id: "fixed", path: inputPath, bytes: 5, sha256: sha256("fixed") }];
    expect(validateExactInputBindings(bindings).every((entry) => entry.verified_before)).toBe(true);

    fs.writeFileSync(inputPath, "drift", "utf8");
    expect(() => validateExactInputBindings(bindings)).toThrow("input_hash_drift:fixed");
  });

  it("permits exactly one social-review renderer invocation", async () => {
    let calls = 0;
    const invoke = async () => {
      calls += 1;
      return { exitCode: 0, stdout: "ok", stderr: "", timedOut: false, signal: null };
    };
    const result = await invokeRendererExactlyOnce(invoke);
    expect(result.exitCode).toBe(0);
    expect(calls).toBe(1);
  });

  it("rejects an actual ASS mismatch instead of caption-plan safe-area metadata", () => {
    const expected = resolveSocialReviewCaptionStyle("clean-lower-third", 1920, 1080);
    const matchingAss = buildAssSubtitleFile([], 30, expected);
    const socialAss = buildAssSubtitleFile([], 30, socialReviewCaptionStyle(1920, 1080));

    expect(evaluateAssCaptionStyle({
      ass: matchingAss,
      stylingClass: "clean-lower-third",
      width: 1920,
      height: 1080,
      requireExplicitStyle: true,
    })).toMatchObject({ pass: true, failures: [] });

    const rejected = evaluateAssCaptionStyle({
      ass: socialAss,
      stylingClass: "clean-lower-third",
      width: 1920,
      height: 1080,
      requireExplicitStyle: true,
    });
    expect(rejected.pass).toBe(false);
    expect(rejected.failures).toEqual(expect.arrayContaining([
      "caption_style_font_size",
      "caption_style_outline",
      "caption_style_border",
      "caption_style_margin_v",
    ]));
    expect(rejected.actual).toMatchObject({ fontSize: 114, outline: 21, marginV: 169 });

    expect(() => buildClosedQaReport(qaEvidence({
      safeAreaPass: false,
      captionStyleFailures: rejected.failures,
    }))).toThrow(/caption_style_font_size|safe_area_pass/);

    expect(evaluateAssCaptionStyle({
      ass: socialAss,
      stylingClass: undefined,
      width: 1920,
      height: 1080,
      requireExplicitStyle: true,
    }).failures).toContain("caption_style_unresolved");
  });

  it("builds a closed PASS QA report only for the exact media/caption contract", () => {
    const qa = buildClosedQaReport(qaEvidence());
    expect(qa.status).toBe("PASS");
    expect(qa.caption.raw_asr_overlap_count).toBe(3);
    expect(qa.caption.display_timeline_overlap_count).toBe(0);
    expect(qa.decode).toMatchObject({ full_decode: true, frame_count: 2700, duration_ms: 90_000 });
    expect(qa.body_sha256).toBe(domainSeparatedBodyHash("eval01-private-render-qa/v1", qa, "body_sha256"));

    expect(() => buildClosedQaReport(qaEvidence({ displayTimelineOverlapCount: 1 })))
      .toThrow("display_timeline_overlap_count");
    expect(() => buildClosedQaReport(qaEvidence({ afterIntegratedLufs: -18 })))
      .toThrow("after_integrated_lufs");
  });

  it("builds a closed receipt with ordered hashes, numeric exits, and no own-file hash", () => {
    const receipt = buildClosedReceipt(receiptEvidence());
    expect(receipt.status).toBe("PASS");
    expect(receipt.invocation_count).toBe(1);
    expect(receipt.output_hashes.map((entry) => entry.path)).toEqual(EVAL01_OUTPUT_HASH_ORDER);
    expect(receipt.exit_records.every((entry) => Number.isInteger(entry.exit_code))).toBe(true);
    expect(receipt.self_check.domain_separated_body_sha256).toBe(
      domainSeparatedBodyHash(
        "eval01-private-render-receipt/v2",
        receipt,
        "self_check.domain_separated_body_sha256",
      ),
    );
    expect(JSON.stringify(receipt)).not.toContain("receipt_sha256");
  });

  it("validates QA and receipt against closed schemas", () => {
    const qa = buildClosedQaReport(qaEvidence());
    const receipt = buildClosedReceipt(receiptEvidence({ qa }));
    expect(validateJsonSchema("schemas/eval01-private-render-qa.schema.json", qa)).toEqual([]);
    expect(validateJsonSchema("schemas/eval01-private-render-receipt.schema.json", receipt)).toEqual([]);

    const ajv = new Ajv2020({ strict: false, allErrors: true });
    for (const [schemaName, value] of [
      ["eval01-private-render-qa.schema.json", qa],
      ["eval01-private-render-receipt.schema.json", receipt],
    ] as const) {
      const schema = JSON.parse(fs.readFileSync(path.join("schemas", schemaName), "utf8")) as object;
      const validate = ajv.compile(schema);
      expect(validate(value), validate.errors ? JSON.stringify(validate.errors) : "schema valid").toBe(true);
      expect(validate({ ...value, unexpected: true })).toBe(false);
    }
  });

  it("downgrades any failed stage to NONPASS_STOP without claiming success", () => {
    const evidence = receiptEvidence({
      status: "NONPASS_STOP",
      exitRecords: [
        { stage: "pre_render_project_schema", invoked: true, exit_code: 0, not_invoked_reason: null },
        { stage: "render", invoked: true, exit_code: 1, not_invoked_reason: null },
        { stage: "post_render_targeted_media_qa", invoked: false, exit_code: null, not_invoked_reason: "render_failed" },
        { stage: "receipt_publication", invoked: true, exit_code: 0, not_invoked_reason: null },
      ],
      qa: null,
      failureReasons: ["render_exit_nonzero"],
    });
    const receipt = buildClosedReceipt(evidence);
    expect(receipt.status).toBe("NONPASS_STOP");
    expect(receipt.nonpass_stop).toEqual({
      active: true,
      failure_reasons: ["render_exit_nonzero", "exit_records", "qa"],
      retry_allowed: false,
      success_claimed: false,
    });
  });
});
