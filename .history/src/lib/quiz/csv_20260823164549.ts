import { DEFAULT_QUIZ, type Quiz } from "./types";

export interface CsvQuizRow {
  question: string;
  options: Quiz["options"];
  correct: Quiz["correct"];
  explanation: string;
}

export interface CsvParseResult {
  rows: CsvQuizRow[];
  errors: string[];
}

const REQUIRED_COLUMNS = [
  "question",
  "option_a",
  "option_b",
  "option_c",
  "option_d",
  "answer",
  "explanation",
] as const;

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (character === '"') {
      if (quoted && next === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && next === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (field || row.length) {
    row.push(field);
    if (row.some((value) => value.trim())) rows.push(row);
  }
  return rows;
}

export function parseQuizCsv(text: string): CsvParseResult {
  const parsed = parseCsv(text);
  if (parsed.length === 0) return { rows: [], errors: ["The CSV file is empty."] };

  const headers = parsed[0]!.map((header) => header.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((column) => !headers.includes(column));
  if (missing.length) return { rows: [], errors: [`Missing required columns: ${missing.join(", ")}.`] };

  const column = (name: string) => headers.indexOf(name);
  const rows: CsvQuizRow[] = [];
  const errors: string[] = [];
  parsed.slice(1).forEach((values, index) => {
    const rowNumber = index + 2;
    const get = (name: string) => (values[column(name)] ?? "").trim();
    const answer = get("answer").toUpperCase();
    const rowErrors: string[] = [];
    if (!get("question")) rowErrors.push("question is required");
    for (const option of ["a", "b", "c", "d"]) {
      if (!get(`option_${option}`)) rowErrors.push(`option_${option} is required`);
    }
    if (!["A", "B", "C", "D"].includes(answer)) rowErrors.push("answer must be A, B, C, or D");
    if (!get("explanation")) rowErrors.push("explanation is required");
    if (rowErrors.length) {
      errors.push(`Row ${rowNumber}: ${rowErrors.join("; ")}.`);
      return;
    }
    rows.push({
      question: get("question"),
      options: { A: get("option_a"), B: get("option_b"), C: get("option_c"), D: get("option_d") },
      correct: answer as CsvQuizRow["correct"],
      explanation: get("explanation"),
    });
  });
  if (!rows.length && !errors.length) errors.push("The CSV contains no question rows.");
  return { rows, errors };
}

export function csvRowToQuiz(row: CsvQuizRow, base: Quiz): Quiz {
  return {
    ...DEFAULT_QUIZ,
    ...base,
    question: row.question,
    options: row.options,
    correct: row.correct,
    explanation: row.explanation,
    showExplanation: true,
  };
}