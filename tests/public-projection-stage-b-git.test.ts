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
  PUBLIC_PROJECTION_COMMIT_AUTHOR_EMAIL,
  PUBLIC_PROJECTION_COMMIT_AUTHOR_NAME,
  PUBLIC_PROJECTION_COMMIT_TIMESTAMP,
  REQUIRED_PUBLIC_BOUNDARY_JOBS,
  buildPromotionEnvelope,
  buildPublicProjectionReceipt,
  canonicalJsonBytes,
  canonicalPublicProjectionCommitMessage,
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
  commitAllAsRoot,
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

describe("IMP-04b Stage B exact Git projection", () => {
  it("rejects Stage A/public mixups, duplicate/order/hash tamper, and envelope commit/tree tamper", () => {
    const fixture = stageBFixture();
    const mixed = structuredClone(fixture.receipt);
    mixed.public_path_ledger[0].sha256 = SHA_A;
    mixed.public_path_ledger_sha256 = sha256Hex(canonicalJsonBytes(mixed.public_path_ledger));
    expect(() => buildPromotionEnvelope({
      ...promotionOptions(fixture),
      stageAReceiptBytes: canonicalJsonBytes(mixed),
    })).toThrow(/public path ledger|content|payload/i);

    const duplicate = structuredClone(fixture.receipt);
    duplicate.public_path_ledger.push(structuredClone(duplicate.public_path_ledger[0]));
    duplicate.public_path_ledger_sha256 = sha256Hex(canonicalJsonBytes(duplicate.public_path_ledger));
    expect(() => buildPromotionEnvelope({
      ...promotionOptions(fixture),
      stageAReceiptBytes: canonicalJsonBytes(duplicate),
    })).toThrow(/duplicate/i);

    const reordered = structuredClone(fixture.receipt);
    reordered.public_path_ledger.reverse();
    reordered.public_path_ledger_sha256 = sha256Hex(canonicalJsonBytes(reordered.public_path_ledger));
    expect(() => buildPromotionEnvelope({
      ...promotionOptions(fixture),
      stageAReceiptBytes: canonicalJsonBytes(reordered),
    })).toThrow(/canonical .*order/i);

    const badHash = structuredClone(fixture.receipt);
    badHash.public_path_ledger_sha256 = SHA_A;
    expect(() => buildPromotionEnvelope({
      ...promotionOptions(fixture),
      stageAReceiptBytes: canonicalJsonBytes(badHash),
    })).toThrow(/ledger hash/i);

    const envelope = buildPromotionEnvelope(promotionOptions(fixture));
    const badCommit = structuredClone(envelope);
    badCommit.public_commit_sha = "0".repeat(40);
    expect(() => verifyPromotionEnvelope({
      ...promotionOptions(fixture),
      envelopeBytes: canonicalJsonBytes(badCommit),
    })).toThrow(/envelope|CI head SHA/i);
    const badTree = structuredClone(envelope);
    badTree.public_tree_sha = "0".repeat(40);
    expect(() => verifyPromotionEnvelope({
      ...promotionOptions(fixture),
      envelopeBytes: canonicalJsonBytes(badTree),
    })).toThrow(/envelope/i);
    const badRunIdentity = structuredClone(envelope);
    badRunIdentity.ci.run.id = "other-run";
    badRunIdentity.ci.run.attempt = 2;
    expect(() => verifyPromotionEnvelope({
      ...promotionOptions(fixture),
      envelopeBytes: canonicalJsonBytes(badRunIdentity),
    })).toThrow(/envelope|CI run URL/i);
  });

  it("rejects abbreviated commits and gitlinks without consulting branch working state", () => {
    const abbreviated = stageBFixture();
    expect(() => buildPromotionEnvelope({
      ...promotionOptions(abbreviated),
      exactPublicCommit: abbreviated.publicCommit.slice(0, 12),
    })).toThrow(/full exact public commit/i);

    const gitlink = stageBFixture();
    git(gitlink.publicRepo, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${gitlink.publicCommit},vendor/submodule`,
    ]);
    const gitlinkTree = git(gitlink.publicRepo, ["write-tree"]);
    gitlink.publicCommit = git(gitlink.publicRepo, [
      "commit-tree",
      gitlinkTree,
      "-m",
      "gitlink",
    ]);
    resignCi(gitlink, (ci) => { ci.run.head_sha = gitlink.publicCommit; });
    expect(() => buildPromotionEnvelope(promotionOptions(gitlink))).toThrow(/gitlink|mode 160000/i);
  });

  it("rejects an approved tip tree that exposes private parent history", () => {
    const fixture = stageBFixture();
    fs.writeFileSync(
      path.join(fixture.publicRepo, "private-history-secret.txt"),
      "must never become reachable\n",
    );
    commitAll(fixture.publicRepo, "private parent");
    fs.unlinkSync(path.join(fixture.publicRepo, "private-history-secret.txt"));
    fixture.publicCommit = commitAll(fixture.publicRepo, "approved tree with private parent");
    expect(git(fixture.publicRepo, ["rev-parse", `${fixture.publicCommit}^{tree}`]))
      .toBe(fixture.publicTree);
    resignCi(fixture, (ci) => { ci.run.head_sha = fixture.publicCommit; });

    expect(() => buildPromotionEnvelope(promotionOptions(fixture))).toThrow(
      /isolated root commit|parent history/i,
    );
  });

  it("rejects private identity or secret-bearing metadata outside the scanned tree", () => {
    const fixture = stageBFixture();
    const stageAReceiptSha256 = sha256Hex(fixture.receiptBytes);
    const canonicalIdentity =
      `${PUBLIC_PROJECTION_COMMIT_AUTHOR_NAME} <${PUBLIC_PROJECTION_COMMIT_AUTHOR_EMAIL}> ${PUBLIC_PROJECTION_COMMIT_TIMESTAMP}`;
    const variants = [
      [
        `tree ${fixture.publicTree}`,
        `author Private Operator <private@example.com> ${PUBLIC_PROJECTION_COMMIT_TIMESTAMP}`,
        `committer ${canonicalIdentity}`,
        "",
        canonicalPublicProjectionCommitMessage(stageAReceiptSha256),
      ].join("\n"),
      [
        `tree ${fixture.publicTree}`,
        `author ${canonicalIdentity}`,
        `committer ${canonicalIdentity}`,
        "",
        canonicalPublicProjectionCommitMessage(stageAReceiptSha256),
        "Private-Token: must-not-leave-stage-b",
        "",
      ].join("\n"),
    ];

    for (const rawCommit of variants) {
      fixture.publicCommit = git(
        fixture.publicRepo,
        ["hash-object", "-t", "commit", "-w", "--stdin"],
        rawCommit,
      );
      resignCi(fixture, (ci) => { ci.run.head_sha = fixture.publicCommit; });
      expect(() => buildPromotionEnvelope(promotionOptions(fixture))).toThrow(
        /canonical metadata.*Stage A receipt/i,
      );
    }
  });

  it.each([
    ["commit", (fixture: StageBFixture) => {
      const trustedCommit = fixture.publicCommit;
      fs.writeFileSync(path.join(fixture.publicRepo, "extra.txt"), "hidden by commit replacement\n");
      const replacedCommit = commitAllAsRoot(fixture.publicRepo, "replacement-hidden commit");
      git(fixture.publicRepo, ["replace", replacedCommit, trustedCommit]);
      fixture.publicCommit = replacedCommit;
      resignCi(fixture, (ci) => { ci.run.head_sha = replacedCommit; });
    }],
    ["tree", (fixture: StageBFixture) => {
      const trustedTree = fixture.publicTree;
      fs.writeFileSync(path.join(fixture.publicRepo, "extra.txt"), "hidden by tree replacement\n");
      const replacedCommit = commitAllAsRoot(fixture.publicRepo, "replacement-hidden tree");
      const replacedTree = git(fixture.publicRepo, ["rev-parse", `${replacedCommit}^{tree}`]);
      git(fixture.publicRepo, ["replace", replacedTree, trustedTree]);
      fixture.publicCommit = replacedCommit;
      resignCi(fixture, (ci) => { ci.run.head_sha = replacedCommit; });
    }],
    ["blob", (fixture: StageBFixture) => {
      const trustedBlob = git(fixture.publicRepo, [
        "rev-parse",
        `${fixture.publicCommit}:README.md`,
      ]);
      fs.chmodSync(path.join(fixture.publicRepo, "README.md"), 0o644);
      fs.writeFileSync(path.join(fixture.publicRepo, "README.md"), "hidden by blob replacement\n");
      const replacedCommit = commitAllAsRoot(fixture.publicRepo, "replacement-hidden blob");
      const replacedBlob = git(fixture.publicRepo, ["rev-parse", `${replacedCommit}:README.md`]);
      git(fixture.publicRepo, ["replace", replacedBlob, trustedBlob]);
      fixture.publicCommit = replacedCommit;
      resignCi(fixture, (ci) => { ci.run.head_sha = replacedCommit; });
    }],
    ["workflow blob", (fixture: StageBFixture) => {
      const trustedBlob = fixture.workflowBlobSha;
      const workflow = path.join(fixture.publicRepo, fixture.workflowPath);
      fs.chmodSync(workflow, 0o644);
      fs.writeFileSync(workflow, "name: replacement-hidden workflow\n");
      const replacedCommit = commitAllAsRoot(fixture.publicRepo, "replacement-hidden workflow");
      const replacedBlob = git(fixture.publicRepo, [
        "rev-parse",
        `${replacedCommit}:${fixture.workflowPath}`,
      ]);
      git(fixture.publicRepo, ["replace", replacedBlob, trustedBlob]);
      fixture.publicCommit = replacedCommit;
      fixture.workflowBlobSha = replacedBlob;
      resignCi(fixture, (ci) => {
        ci.run.head_sha = replacedCommit;
        ci.workflow.blob_sha = replacedBlob;
      });
    }],
  ])("rejects Git replace-ref bypass for %s reads", (_label, arrangeBypass) => {
    const fixture = stageBFixture();
    arrangeBypass(fixture);
    expect(() => buildPromotionEnvelope(promotionOptions(fixture))).toThrow(
      /public path ledger|extra|content|workflow/i,
    );
  });

});
