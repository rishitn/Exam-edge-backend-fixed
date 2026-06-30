import { z } from "zod";

// =============================================================================
// Bulk Upload — CSV/Excel Row Schema
//
// Admins download a template, fill it in, and upload.
// Each row = one question. Type-specific columns are used/ignored per type.
//
// Column layout (exact header names in the template):
//
//  exam | subject_code | chapter_name | topic_name | type | difficulty |
//  question_text | question_image_url |
//  option_a | option_b | option_c | option_d |
//  assertion | reason |
//  left_col_ids | left_col_texts | right_col_ids | right_col_texts |
//  correct_answer | solution_text | solution_image_url |
//  tags | source_year | source_exam
// =============================================================================

export const BulkUploadRowSchema = z
  .object({
    exam: z.enum(["NEET", "JEE_MAIN", "JEE_ADVANCED", "CUET"]),
    subject_code: z.string().min(1, "subject_code is required"),
    chapter_name: z.string().min(1, "chapter_name is required"),
    topic_name: z.string().optional(),
    type: z.enum(["MCQ_SINGLE", "MCQ_MULTIPLE", "INTEGER", "ASSERTION", "MATCH_COLUMN"]),
    difficulty: z.enum(["EASY", "MEDIUM", "HARD"]).default("MEDIUM"),

    // Question body
    question_text: z.string().min(1, "question_text is required"),
    question_image_url: z.string().url().optional().or(z.literal("")).transform(v => v || undefined),

    // MCQ options (used for MCQ_SINGLE, MCQ_MULTIPLE, ASSERTION)
    option_a: z.string().optional(),
    option_b: z.string().optional(),
    option_c: z.string().optional(),
    option_d: z.string().optional(),

    // Assertion-Reasoning specific
    assertion: z.string().optional(),
    reason: z.string().optional(),

    // Match column — pipe-separated values (e.g. "1|2|3" and "P|Q|R")
    left_col_ids: z.string().optional(),
    left_col_texts: z.string().optional(),
    right_col_ids: z.string().optional(),
    right_col_texts: z.string().optional(),

    // Answer
    // MCQ_SINGLE/ASSERTION: "A" | "B" | "C" | "D"
    // MCQ_MULTIPLE: "A,C" or "A,B,D"
    // INTEGER: "42" or "3.14"
    // MATCH_COLUMN: "1:P,2:Q,3:R"
    correct_answer: z.string().min(1, "correct_answer is required"),

    // Solution
    solution_text: z.string().min(1, "solution_text is required"),
    solution_image_url: z.string().url().optional().or(z.literal("")).transform(v => v || undefined),

    // Optional metadata
    tags: z.string().optional(),          // comma-separated
    source_year: z.coerce.number().int().min(1990).max(2030).optional().or(z.literal("")).transform(v => v || undefined),
    source_exam: z.string().max(100).optional(),
  })
  .superRefine((row, ctx) => {
    switch (row.type) {
      case "MCQ_SINGLE":
      case "MCQ_MULTIPLE":
        if (!row.option_a || !row.option_b || !row.option_c || !row.option_d) {
          ctx.addIssue({ code: "custom", message: "MCQ types require option_a, option_b, option_c, option_d" });
        }
        break;
      case "ASSERTION":
        if (!row.assertion || !row.reason) {
          ctx.addIssue({ code: "custom", message: "ASSERTION type requires assertion and reason columns" });
        }
        if (!row.option_a || !row.option_b || !row.option_c || !row.option_d) {
          ctx.addIssue({ code: "custom", message: "ASSERTION type requires 4 options" });
        }
        break;
      case "MATCH_COLUMN":
        if (!row.left_col_ids || !row.left_col_texts || !row.right_col_ids || !row.right_col_texts) {
          ctx.addIssue({ code: "custom", message: "MATCH_COLUMN requires left_col_ids, left_col_texts, right_col_ids, right_col_texts" });
        }
        break;
      case "INTEGER":
        if (isNaN(Number(row.correct_answer))) {
          ctx.addIssue({ code: "custom", message: "INTEGER type requires a numeric correct_answer" });
        }
        break;
    }
  });

export type BulkUploadRow = z.infer<typeof BulkUploadRowSchema>;

// =============================================================================
// Transform a validated CSV row into CreateQuestion-compatible shape
// =============================================================================
export function transformRowToQuestion(row: BulkUploadRow) {
  const content: Record<string, unknown> = {
    text: row.question_text,
    imageUrl: row.question_image_url ?? null,
    imageAlt: null,
  };

  if (row.type === "ASSERTION") {
    Object.assign(content, {
      assertion: row.assertion,
      reason: row.reason,
    });
  }

  let options: unknown = null;

  if (row.type === "MCQ_SINGLE" || row.type === "MCQ_MULTIPLE") {
    options = [
      { id: "A", text: row.option_a!, imageUrl: null },
      { id: "B", text: row.option_b!, imageUrl: null },
      { id: "C", text: row.option_c!, imageUrl: null },
      { id: "D", text: row.option_d!, imageUrl: null },
    ];
  }

  if (row.type === "ASSERTION") {
    options = [
      { id: "A", text: row.option_a! },
      { id: "B", text: row.option_b! },
      { id: "C", text: row.option_c! },
      { id: "D", text: row.option_d! },
    ];
  }

  if (row.type === "MATCH_COLUMN") {
    const leftIds = row.left_col_ids!.split("|").map((s) => s.trim());
    const leftTexts = row.left_col_texts!.split("|").map((s) => s.trim());
    const rightIds = row.right_col_ids!.split("|").map((s) => s.trim());
    const rightTexts = row.right_col_texts!.split("|").map((s) => s.trim());

    options = {
      leftCol: leftIds.map((id, i) => ({ id, text: leftTexts[i] ?? "" })),
      rightCol: rightIds.map((id, i) => ({ id, text: rightTexts[i] ?? "" })),
    };
  }

  // Parse correct answer
  let correctAnswer: unknown;
  if (row.type === "MCQ_SINGLE" || row.type === "ASSERTION") {
    correctAnswer = row.correct_answer.trim().toUpperCase();
  } else if (row.type === "MCQ_MULTIPLE") {
    correctAnswer = row.correct_answer.split(",").map((s) => s.trim().toUpperCase());
  } else if (row.type === "INTEGER") {
    correctAnswer = Number(row.correct_answer);
  } else if (row.type === "MATCH_COLUMN") {
    // Format: "1:P,2:Q,3:R"
    correctAnswer = Object.fromEntries(
      row.correct_answer.split(",").map((pair) => {
        const [left, right] = pair.split(":").map((s) => s.trim());
        return [left, right];
      })
    );
  }

  const solution = {
    text: row.solution_text,
    imageUrl: row.solution_image_url ?? null,
  };

  const tags = row.tags
    ? row.tags.split(",").map((t) => t.trim()).filter(Boolean)
    : [];

  return {
    exam: row.exam,
    subjectCode: row.subject_code,
    chapterName: row.chapter_name,
    topicName: row.topic_name,
    type: row.type,
    difficulty: row.difficulty,
    content,
    options,
    correctAnswer,
    solution,
    tags,
    sourceYear: row.source_year ? Number(row.source_year) : null,
    sourceExam: row.source_exam ?? null,
  };
}
