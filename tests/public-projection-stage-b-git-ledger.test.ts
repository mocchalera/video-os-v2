import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPromotionEnvelope } from "../runtime/release/public-projection.js";
import {
  commitAllAsRoot,
  git,
  promotionOptions,
  resignCi,
  stageBFixture,
  type StageBFixture,
} from "./helpers/public-projection-fixtures.js";

describe("IMP-04b Stage B exact Git ledger", () => {
  it.each([
    ["extra file", (fixture: StageBFixture) => {
      fs.writeFileSync(path.join(fixture.publicRepo, "extra.txt"), "extra\n");
      fixture.publicCommit = commitAllAsRoot(fixture.publicRepo, "extra");
    }],
    ["missing file", (fixture: StageBFixture) => {
      fs.rmSync(path.join(fixture.publicRepo, "README.md"));
      fixture.publicCommit = commitAllAsRoot(fixture.publicRepo, "missing");
    }],
    ["regular content drift", (fixture: StageBFixture) => {
      fs.chmodSync(path.join(fixture.publicRepo, "README.md"), 0o644);
      fs.writeFileSync(path.join(fixture.publicRepo, "README.md"), "changed\n");
      fixture.publicCommit = commitAllAsRoot(fixture.publicRepo, "content");
    }],
    ["executable mode drift", (fixture: StageBFixture) => {
      fs.chmodSync(path.join(fixture.publicRepo, "README.md"), 0o755);
      fixture.publicCommit = commitAllAsRoot(fixture.publicRepo, "mode");
    }],
    ["file to symlink drift", (fixture: StageBFixture) => {
      fs.rmSync(path.join(fixture.publicRepo, "README.md"));
      fs.symlinkSync("bin/run.sh", path.join(fixture.publicRepo, "README.md"));
      fixture.publicCommit = commitAllAsRoot(fixture.publicRepo, "type");
    }],
    ["symlink target drift", (fixture: StageBFixture) => {
      fs.rmSync(path.join(fixture.publicRepo, "docs-link"));
      fs.symlinkSync("bin/run.sh", path.join(fixture.publicRepo, "docs-link"));
      fixture.publicCommit = commitAllAsRoot(fixture.publicRepo, "symlink");
    }],
  ])("rejects exact public commit ledger drift: %s", (_label, mutate) => {
    const fixture = stageBFixture();
    mutate(fixture);
    resignCi(fixture, (ci) => {
      ci.run.head_sha = fixture.publicCommit;
      ci.workflow.blob_sha = git(fixture.publicRepo, [
        "rev-parse",
        `${fixture.publicCommit}:${fixture.workflowPath}`,
      ]);
    });
    fixture.workflowBlobSha = fixture.ciEvidence.workflow.blob_sha;
    expect(() => buildPromotionEnvelope(promotionOptions(fixture))).toThrow(
      /public path ledger|extra|missing|type|mode|content|symlink/i,
    );
  });
});
