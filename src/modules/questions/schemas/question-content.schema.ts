import { z } from "zod";

// =============================================================================
// Question Content Schemas
// Each question type has a different JSON shape for content, options,
// correctAnswer, and solution. These schemas validate and type them all.
// =============================================================================

// ── Shared ────────────────────────────────────────────────────────────────────

const ContentSchema = z.object({
  text: z.string().min(1, "Question text is required").max(5000),
  imageUrl: z.string().url().optional().nullable(),
  imageAlt: z.string().max(500).optional().nullable(),
});

const SolutionSchema = z.object({
  text: z.string().min(1, "Solution explanation is required").max(10000),
  imageUrl: z.string().url().optional().nullable(),
});

// ── MCQ Option ────────────────────────────────────────────────────────────────

const McqOptionSchema = z.object({
  id: z.enum(["A", "B", "C", "D"]),
  text: z.string().min(1, "Option text is required").max(2000),
  imageUrl: z.string().url().optional().nullable(),
});

const FourMcqOptionsSchema = z
  .array(McqOptionSchema)
  .length(4, "MCQ must have exactly 4 options")
  .refine(
    (opts) => {
      const ids = opts.map((o) => o.id);
      return (
        ids.includes("A") &&
        ids.includes("B") &&
        ids.includes("C") &&
        ids.includes("D")
      );
    },
    { message: "Options must have ids A, B, C, D" }
  );

// ── MCQ Single ────────────────────────────────────────────────────────────────

export const McqSingleOptionsSchema = FourMcqOptionsSchema;

export const McqSingleAnswerSchema = z.enum(["A", "B", "C", "D"], {
  errorMap: () => ({ message: "Correct answer must be A, B, C, or D" }),
});

// ── MCQ Multiple ──────────────────────────────────────────────────────────────

export const McqMultipleOptionsSchema = FourMcqOptionsSchema;

export const McqMultipleAnswerSchema = z
  .array(z.enum(["A", "B", "C", "D"]))
  .min(1, "Select at least one correct answer")
  .max(4)
  .refine((arr) => new Set(arr).size === arr.length, {
    message: "Duplicate answer options not allowed",
  });

// ── Integer / Numerical ───────────────────────────────────────────────────────

export const IntegerAnswerSchema = z.union([
  z.number().finite("Answer must be a finite number"),
  z
    .string()
    .regex(/^-?\d+(\.\d+)?$/, "Answer must be a valid number")
    .transform(Number),
]);

// ── Assertion-Reasoning ───────────────────────────────────────────────────────
// Standard assertion-reasoning options:
// A: Both A and R are true, R is the correct explanation of A
// B: Both A and R are true, R is NOT the correct explanation of A
// C: A is true, R is false
// D: A is false, R is true  (or both false depending on institution)

export const AssertionContentSchema = z.object({
  text: z.string().max(2000).optional().nullable(),       // Optional preamble
  imageUrl: z.string().url().optional().nullable(),
  imageAlt: z.string().max(500).optional().nullable(),
  assertion: z.string().min(1, "Assertion (A) text is required").max(2000),
  reason: z.string().min(1, "Reason (R) text is required").max(2000),
});

export const AssertionOptionsSchema = z
  .array(McqOptionSchema)
  .length(4, "Assertion-Reasoning must have exactly 4 options");

export const AssertionAnswerSchema = z.enum(["A", "B", "C", "D"]);

// ── Match the Column ──────────────────────────────────────────────────────────

const MatchColumnItemSchema = z.object({
  id: z.string().min(1).max(5),
  text: z.string().min(1).max(1000),
  imageUrl: z.string().url().optional().nullable(),
});

export const MatchColumnOptionsSchema = z.object({
  leftCol: z
    .array(MatchColumnItemSchema)
    .min(2)
    .max(6, "Match column: max 6 items per column"),
  rightCol: z
    .array(MatchColumnItemSchema)
    .min(2)
    .max(6, "Match column: max 6 items per column"),
});

export const MatchColumnAnswerSchema = z
  .record(z.string(), z.string())
  .refine((obj) => Object.keys(obj).length >= 2, {
    message: "Match answer must map at least 2 pairs",
  });

// =============================================================================
// Master validator — validates options + answer for a given question type
// Call this from the question service before saving
// =============================================================================

export interface ValidatedQuestionContent {
  content: z.infer<typeof ContentSchema> | z.infer<typeof AssertionContentSchema>;
  options: unknown;
  correctAnswer: unknown;
  solution: z.infer<typeof SolutionSchema>;
}

export function validateQuestionByType(
  type: string,
  rawContent: unknown,
  rawOptions: unknown,
  rawAnswer: unknown,
  rawSolution: unknown
): ValidatedQuestionContent {
  const solution = SolutionSchema.parse(rawSolution);

  switch (type) {
    case "MCQ_SINGLE": {
      const content = ContentSchema.parse(rawContent);
      const options = McqSingleOptionsSchema.parse(rawOptions);
      const correctAnswer = McqSingleAnswerSchema.parse(rawAnswer);
      return { content, options, correctAnswer, solution };
    }

    case "MCQ_MULTIPLE": {
      const content = ContentSchema.parse(rawContent);
      const options = McqMultipleOptionsSchema.parse(rawOptions);
      const correctAnswer = McqMultipleAnswerSchema.parse(rawAnswer);
      return { content, options, correctAnswer, solution };
    }

    case "INTEGER": {
      const content = ContentSchema.parse(rawContent);
      const correctAnswer = IntegerAnswerSchema.parse(rawAnswer);
      return { content, options: null, correctAnswer, solution };
    }

    case "ASSERTION": {
      const content = AssertionContentSchema.parse(rawContent);
      const options = AssertionOptionsSchema.parse(rawOptions);
      const correctAnswer = AssertionAnswerSchema.parse(rawAnswer);
      return { content, options, correctAnswer, solution };
    }

    case "MATCH_COLUMN": {
      const content = ContentSchema.parse(rawContent);
      const options = MatchColumnOptionsSchema.parse(rawOptions);
      const correctAnswer = MatchColumnAnswerSchema.parse(rawAnswer);

      // Verify all left column IDs have an answer mapping
      const leftIds = (options as z.infer<typeof MatchColumnOptionsSchema>).leftCol.map(
        (i) => i.id
      );
      const answerKeys = Object.keys(
        correctAnswer as Record<string, string>
      );
      const missingMappings = leftIds.filter((id) => !answerKeys.includes(id));
      if (missingMappings.length > 0) {
        throw new Error(
          `Match column: missing answer mapping for left column items: ${missingMappings.join(", ")}`
        );
      }

      return { content, options, correctAnswer, solution };
    }

    default:
      throw new Error(`Unknown question type: ${type}`);
  }
}

export { ContentSchema, SolutionSchema };
