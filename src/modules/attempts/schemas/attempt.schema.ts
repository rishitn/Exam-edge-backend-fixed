import { z } from "zod";

// =============================================================================
// Test Attempt Engine — Zod Schemas
// =============================================================================

// ── Start Attempt ─────────────────────────────────────────────────────────────

export const StartAttemptSchema = z.object({
  testId: z.string().cuid(),
});
export type StartAttemptInput = z.infer<typeof StartAttemptSchema>;

// ── Save Answer ───────────────────────────────────────────────────────────────
// Called when student clicks Next / Save on a question.
// studentAnswer shape mirrors correctAnswer on Question model:
//   MCQ_SINGLE / ASSERTION : "A" | "B" | "C" | "D"
//   MCQ_MULTIPLE            : ["A", "C"]
//   INTEGER                 : 42 | 3.14
//   MATCH_COLUMN            : { "1": "P", "2": "Q" }

const StudentAnswerSchema = z.union([
  z.string(),                          // MCQ_SINGLE, ASSERTION, INTEGER (string form)
  z.number(),                          // INTEGER (numeric form)
  z.array(z.string()),                 // MCQ_MULTIPLE
  z.record(z.string(), z.string()),    // MATCH_COLUMN
]);

export const SaveAnswerSchema = z.object({
  questionId: z.string().cuid(),
  studentAnswer: StudentAnswerSchema.nullable(), // null = clear/unattempt
  isMarkedReview: z.boolean().optional(),
  timeSpentSeconds: z.number().int().min(0).max(86400).optional(),
});
export type SaveAnswerInput = z.infer<typeof SaveAnswerSchema>;

// ── Mark for Review (toggle only, no answer change) ───────────────────────────

export const MarkReviewSchema = z.object({
  questionId: z.string().cuid(),
  isMarkedReview: z.boolean(),
});
export type MarkReviewInput = z.infer<typeof MarkReviewSchema>;

// ── Submit Attempt ────────────────────────────────────────────────────────────

export const SubmitAttemptSchema = z.object({
  timeSpentSeconds: z.number().int().min(0).max(86400).optional(),
});
export type SubmitAttemptInput = z.infer<typeof SubmitAttemptSchema>;

// ── Flag tab switch (proctoring event from client) ────────────────────────────

export const TabSwitchSchema = z.object({
  count: z.number().int().min(1),    // Total switches so far (client-tracked)
});
export type TabSwitchInput = z.infer<typeof TabSwitchSchema>;

// ── Auto-submit (called server-side from timer expiry) ────────────────────────

export const AutoSubmitSchema = z.object({
  attemptId: z.string().cuid(),
  reason: z.enum(["TIMER_EXPIRED"]),
});
export type AutoSubmitInput = z.infer<typeof AutoSubmitSchema>;
