import { describe, expect, it } from "vitest";
import {
  buildPromotionEnvelope,
  type PromotionApprovalReceipt,
} from "../runtime/release/public-projection.js";
import {
  SHA_A,
  promotionOptions,
  resignApproval,
  signedEvidence,
  stageBFixture,
  type StageBFixture,
} from "./helpers/public-projection-fixtures.js";

describe("IMP-04b Stage B approval evidence bindings", () => {
  it.each([
    ["Stage A SHA", (fixture: StageBFixture) => resignApproval(fixture, (approval) => { approval.stage_a_receipt_sha256 = SHA_A; })],
    ["repository ID", (fixture: StageBFixture) => resignApproval(fixture, (approval) => { approval.destination.repository_id = "999"; })],
    ["repository full name", (fixture: StageBFixture) => resignApproval(fixture, (approval) => { approval.destination.repository_full_name = "fork/roughcut-agent"; })],
    ["branch", (fixture: StageBFixture) => resignApproval(fixture, (approval) => { approval.destination.branch = "release"; })],
    ["event scope", (fixture: StageBFixture) => resignApproval(fixture, (approval) => { approval.operation_scope.event = "workflow_dispatch"; })],
    ["workflow scope", (fixture: StageBFixture) => resignApproval(fixture, (approval) => { approval.operation_scope.workflow_path = ".github/workflows/other.yml"; })],
  ])("rejects approval binding drift: %s", (_label, mutate) => {
    const fixture = stageBFixture();
    mutate(fixture);
    expect(() => buildPromotionEnvelope(promotionOptions(fixture))).toThrow(
      /approval|repository|branch|scope|event|workflow/i,
    );
  });

  it("rejects ambiguous or overbroad approval scopes", () => {
    const fixture = stageBFixture();
    const overbroad = structuredClone(fixture.approval) as PromotionApprovalReceipt & {
      operation_scope: { operation: string; event: string; workflow_path: string };
    };
    (overbroad.operation_scope as { operation: string }).operation = "push-repository";
    const bytes = signedEvidence(overbroad, "cockpit");
    expect(() => buildPromotionEnvelope({
      ...promotionOptions(fixture),
      approvalReceiptBytes: bytes,
    })).toThrow(/operation scope|approval/i);
  });
});
