export type DialogueBoundary = "in" | "out" | "whole";
export type DialogueCompletenessSeverity = "hard" | "soft";

export interface DialogueCompletenessIssue {
  boundary: DialogueBoundary;
  code:
    | "dependent_opening"
    | "implicit_antecedent_opening"
    | "dependent_ending"
    | "continuative_ending"
    | "low_information_fragment";
  severity: DialogueCompletenessSeverity;
  excerpt: string;
}

export interface DialogueCompletenessAssessment {
  normalized_text: string;
  issues: DialogueCompletenessIssue[];
  hard_issue_count: number;
  soft_issue_count: number;
}

const HARD_DEPENDENT_OPENING = /^(?:ってことは|ということは|なので|ですので|ですが|けど|だけど|一方で)/;
const SOFT_IMPLICIT_ANTECEDENT_OPENING = /^(?:(?:両方|双方|どちらも|どっちも)(?:を|が|は|も|で|に|とも)?|(?:作って|使って|やって|なって|思って|言って|感じて)(?:い|た|き|しま|る|ま))/;
const HARD_DEPENDENT_ENDING = /(?:ってことは|ということは|けど|だけど|ですが|たり|とか|のと|のが|だけでなく|一方で|そして|それから|また|も)$/;
const SOFT_CONTINUATIVE_ENDING = /(?:ので|から|って|という|なって|思って|言って|感じて|使って|作って|やって|して)$/;
const LOW_INFORMATION_FRAGMENT = /^(?:はい|ええ|そうですね|そうなんです|なるほど|お願いします|ありがとうございます)$/;

/**
 * Conservative, deterministic boundary lint for speech-led selections.
 *
 * This does not try to solve Japanese semantic parsing. It catches only
 * high-signal dependent conjunctions plus softer signs that a clip begins
 * after its antecedent or ends on a continuative form. Soft findings remain a
 * human/LLM review signal so natural Japanese subject omission is not rejected
 * automatically.
 */
export function assessDialogueCompleteness(text: string): DialogueCompletenessAssessment {
  const normalized = normalizeDialogueText(text);
  const issues: DialogueCompletenessIssue[] = [];

  if (!normalized) {
    return {
      normalized_text: "",
      issues,
      hard_issue_count: 0,
      soft_issue_count: 0,
    };
  }

  if (HARD_DEPENDENT_OPENING.test(normalized)) {
    issues.push(issue("in", "dependent_opening", "hard", normalized));
  } else if (SOFT_IMPLICIT_ANTECEDENT_OPENING.test(normalized)) {
    issues.push(issue("in", "implicit_antecedent_opening", "soft", normalized));
  }

  if (HARD_DEPENDENT_ENDING.test(normalized)) {
    issues.push(issue("out", "dependent_ending", "hard", normalized));
  } else if (SOFT_CONTINUATIVE_ENDING.test(normalized)) {
    issues.push(issue("out", "continuative_ending", "soft", normalized));
  }

  if (LOW_INFORMATION_FRAGMENT.test(normalized)) {
    issues.push(issue("whole", "low_information_fragment", "soft", normalized));
  }

  return {
    normalized_text: normalized,
    issues,
    hard_issue_count: issues.filter((item) => item.severity === "hard").length,
    soft_issue_count: issues.filter((item) => item.severity === "soft").length,
  };
}

function normalizeDialogueText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\s　]+/g, "")
    .replace(/^[「『（(\[【]+|[」』）)\]】。、！？!?…・]+$/g, "")
    .replace(/^[「『（(\[【]+/, "")
    .replace(/[」』）)\]】。、！？!?…・]+$/, "")
    .trim();
}

function issue(
  boundary: DialogueBoundary,
  code: DialogueCompletenessIssue["code"],
  severity: DialogueCompletenessSeverity,
  text: string,
): DialogueCompletenessIssue {
  return {
    boundary,
    code,
    severity,
    excerpt: text.length <= 64 ? text : `${text.slice(0, 61)}...`,
  };
}
