import { describe, expect, it } from "vitest";
import { assessDialogueCompleteness } from "../runtime/editorial/dialogue-completeness.js";

describe("dialogue completeness", () => {
  it.each([
    ["ってことは、会社全体にも", ["dependent_opening", "dependent_ending"]],
    ["判断の質も", ["dependent_ending"]],
    ["使ってましたけど", ["implicit_antecedent_opening", "dependent_ending"]],
    ["作ってたんですよ", ["implicit_antecedent_opening"]],
    ["両方を変える必要があります", ["implicit_antecedent_opening"]],
    ["どちらも大切です", ["implicit_antecedent_opening"]],
  ])("flags context-dependent Japanese boundary: %s", (text, expectedCodes) => {
    const result = assessDialogueCompleteness(text);
    expect(result.issues.map((item) => item.code)).toEqual(expectedCodes);
  });

  it.each([
    "受講前は、資料を作るときだけAIを使っていました",
    "自分で実践した結果、判断の速度と質が上がりました",
    "3か月後には5つの事業部へ展開したいと思います",
  ])("accepts a self-contained assertion: %s", (text) => {
    expect(assessDialogueCompleteness(text).issues).toEqual([]);
  });

  it("keeps a short acknowledgement as a soft review signal", () => {
    expect(assessDialogueCompleteness("そうですね")).toMatchObject({
      hard_issue_count: 0,
      soft_issue_count: 1,
      issues: [{ code: "low_information_fragment", severity: "soft" }],
    });
  });
});
