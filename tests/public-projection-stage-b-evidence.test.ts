import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  parseGeneratePublicProjectionArgs,
  runGeneratePublicProjection,
} from "../scripts/generate-public-projection.js";
import {
  finalizePublicProjectionReceiptWithApprovedVerifier,
  parseFinalizePublicProjectionArgs,
} from "../scripts/finalize-public-projection-receipt.js";
import {
  parseVerifyPublicProjectionArgs,
} from "../scripts/verify-public-projection.js";
import {
  parseVerifyPromotionEnvelopeArgs,
  verifyPromotionEnvelopeWithTrustedVerifiers,
} from "../scripts/verify-promotion-envelope.js";
import {
  REQUIRED_PUBLIC_BOUNDARY_JOBS,
  buildPromotionEnvelope,
  buildPublicProjectionReceipt,
  canonicalJsonBytes,
  generatePublicProjection,
  sha256Hex,
  verifyPromotionEnvelope,
  verifyPublicProjectionReceipt,
  writeExclusiveOutputFile,
  type ApprovedAttestationVerifier,
  type PromotionApprovalReceipt,
  type PromotionCiEvidence,
  type PromotionDestination,
  type PublicProjectionPolicy,
  type PublicProjectionReceipt,
  type PublicProjectionScanAttestation,
  type TrustedEvidenceVerifier,
} from "../runtime/release/public-projection.js";

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (options: Record<string, unknown>) => {
  compile(schema: object): {
    (data: unknown): boolean;
    errors?: unknown[] | null;
  };
};
const addFormats = require_("ajv-formats") as (ajv: unknown) => void;

import {
  SHA_A,
  commitAll,
  createOutputSymlinkAttack,
  git,
  makeWritable,
  policy,
  promotionOptions,
  resignApproval,
  resignCi,
  schemaValidator,
  signedEvidence,
  stageAFixture,
  stageBFixture,
  tempRoot,
  wrapperStageAReceipt,
  type StageAFixture,
  type StageBFixture,
} from "./helpers/public-projection-fixtures.js";

describe("IMP-04b Stage B evidence bindings", () => {
  it.each([
    ["CI head SHA", (fixture: StageBFixture) => resignCi(fixture, (ci) => { ci.run.head_sha = "0".repeat(40); })],
    ["repository ID", (fixture: StageBFixture) => resignCi(fixture, (ci) => { ci.repository.repository_id = "999"; })],
    ["repository full name/fork", (fixture: StageBFixture) => resignCi(fixture, (ci) => { ci.repository.repository_full_name = "fork/roughcut-agent"; })],
    ["CI head branch", (fixture: StageBFixture) => resignCi(fixture, (ci) => { ci.run.head_branch = "release"; })],
    ["workflow path", (fixture: StageBFixture) => resignCi(fixture, (ci) => { ci.workflow.path = ".github/workflows/other.yml"; })],
    ["workflow blob", (fixture: StageBFixture) => resignCi(fixture, (ci) => { ci.workflow.blob_sha = "0".repeat(40); })],
  ])("rejects CI/destination binding drift: %s", (_label, mutate) => {
    const fixture = stageBFixture();
    mutate(fixture);
    expect(() => buildPromotionEnvelope(promotionOptions(fixture))).toThrow(
      /CI|repository|branch|workflow|attempt|event|job|product-gate|conclusion/i,
    );
  });

});
