import { describe, expect, it } from "vitest";
import {
  buildPromotionEnvelope,
  canonicalJsonBytes,
  verifyPromotionEnvelope,
} from "../runtime/release/public-projection.js";
import {
  promotionOptions,
  resignApproval,
  schemaValidator,
  stageBFixture,
} from "./helpers/public-projection-fixtures.js";

describe("IMP-04b Stage B approval time contract", () => {
  it.each([
    "2026-07-27",
    "2026-02-30T00:00:00Z",
    "2025-02-29T00:00:00Z",
    "2026-07-27T24:00:00Z",
    "2026-07-27T00:00:60Z",
    "2026-07-27T00:00:00+24:00",
    "2026-07-27T00:00:00+00:60",
  ])("rejects timestamps outside the supported RFC 3339 subset %s during build and verify", (approvedAt) => {
    const fixture = stageBFixture();
    const validApprovedAt = fixture.approval.approved_at;
    resignApproval(fixture, (approval) => {
      approval.approved_at = approvedAt;
    });
    expect(() => buildPromotionEnvelope(promotionOptions(fixture))).toThrow(
      /supported RFC 3339 subset/i,
    );

    resignApproval(fixture, (approval) => {
      approval.approved_at = validApprovedAt;
    });
    const envelope = buildPromotionEnvelope(promotionOptions(fixture));
    envelope.approval.approved_at = approvedAt;
    const validate = schemaValidator("promotion-envelope.schema.json");
    expect(validate(envelope), JSON.stringify(validate.errors)).toBe(false);
    expect(() => verifyPromotionEnvelope({
      ...promotionOptions(fixture),
      envelopeBytes: canonicalJsonBytes(envelope),
    })).toThrow(/supported RFC 3339 subset/i);
  });

  it.each([
    "2024-02-29T23:59:59+14:00",
    "2026-07-27T00:00:00-05:30",
  ])("accepts calendar-valid timestamps in the supported RFC 3339 subset %s", (approvedAt) => {
    const fixture = stageBFixture();
    resignApproval(fixture, (approval) => {
      approval.approved_at = approvedAt;
    });
    const envelope = buildPromotionEnvelope(promotionOptions(fixture));
    expect(verifyPromotionEnvelope({
      ...promotionOptions(fixture),
      envelopeBytes: canonicalJsonBytes(envelope),
    }).approval.approved_at).toBe(approvedAt);
  });
});
