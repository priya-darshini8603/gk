import { OPTION_KEYS, type Quiz } from "./types";

export interface Issue {
  level: "error" | "warning";
  message: string;
}

export function validateQuiz(quiz: Quiz): Issue[] {
  const issues: Issue[] = [];
  if (!quiz.question.trim()) issues.push({ level: "error", message: "Question cannot be empty." });
  for (const key of OPTION_KEYS) {
    if (!quiz.options[key].trim())
      issues.push({ level: "error", message: `Option ${key} is required.` });
  }
  if (!quiz.correct) issues.push({ level: "error", message: "Select the correct answer." });
  else if (!quiz.options[quiz.correct]?.trim())
    issues.push({ level: "error", message: `Correct answer ${quiz.correct} has no text.` });
  if (quiz.question.length > 110)
    issues.push({ level: "warning", message: "Question is quite long — it may be shown very small." });
  for (const key of OPTION_KEYS) {
    if (quiz.options[key].length > 32)
      issues.push({ level: "warning", message: `Option ${key} is long and will shrink to fit.` });
  }
  if (quiz.showExplanation && !quiz.explanation.trim())
    issues.push({ level: "warning", message: "Explanation is ON but empty — it will be skipped." });
  return issues;
}

export const hasErrors = (issues: Issue[]) => issues.some((i) => i.level === "error");
