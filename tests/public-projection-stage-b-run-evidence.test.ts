import { describe, expect, it } from "vitest";
import { buildPromotionEnvelope } from "../runtime/release/public-projection.js";
import {
  promotionOptions,
  resignCi,
  stageBFixture,
  type StageBFixture,
} from "./helpers/public-projection-fixtures.js";

describe("IMP-04b Stage B CI run evidence bindings", () => {
  it.each([
    ["run event", (fixture: StageBFixture) => resignCi(fixture, (ci) => { ci.run.event = "workflow_dispatch"; })],
    ["run conclusion", (fixture: StageBFixture) => resignCi(fixture, (ci) => { ci.run.conclusion = "failure"; })],
    ["missing job", (fixture: StageBFixture) => resignCi(fixture, (ci) => { ci.required_jobs.pop(); })],
    ["extra job", (fixture: StageBFixture) => resignCi(fixture, (ci) => { ci.required_jobs.push({ name: "extra", result: "success" }); })],
    ["duplicate job", (fixture: StageBFixture) => resignCi(fixture, (ci) => { ci.required_jobs.push(structuredClone(ci.required_jobs[0])); })],
    ["failed job", (fixture: StageBFixture) => resignCi(fixture, (ci) => { ci.required_jobs[0].result = "cancelled"; })],
    ["product gate", (fixture: StageBFixture) => resignCi(fixture, (ci) => { ci.product_gate.result = "skipped"; })],
  ])("rejects CI/destination binding drift: %s", (_label, mutate) => {
    const fixture = stageBFixture();
    mutate(fixture);
    expect(() => buildPromotionEnvelope(promotionOptions(fixture))).toThrow(
      /CI|repository|branch|workflow|attempt|event|job|product-gate|conclusion/i,
    );
  });
});
