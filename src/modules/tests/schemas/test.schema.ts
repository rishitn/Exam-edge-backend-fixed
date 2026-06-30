import { z } from "zod";
import { ExamType, TestType, TestStatus } from "@prisma/client";

// =============================================================================
// Test Builder — Zod Schemas
// =============================================================================

// ── Reusable sub-schemas ─────────────────────────────────────────────────────

export const SectionSchema = z.object({
  name: z.string().min(1).max(100),
  order: z.number().int().min(0).default(0),
  exam: z.nativeEnum(ExamType),
  subjectId: z.string().cuid().optional(),
  description: z.string().max(500).optional(),
  timeLimitMinutes: z.number().int().min(1).optional(), // null = use test-level limit
  totalQuestions: z.number().int().min(1).optional(),
  requiredAttempts: z.number().int().min(1).optional(),
});

export const QuestionInSectionSchema = z.object({
  questionId: z.string().cuid(),
  order: z.number().int().min(0).default(0),
});

// ── Create Test ──────────────────────────────────────────────────────────────

export const CreateTestSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(2000).optional(),
  instructions: z.string().max(5000).optional(),
  exam: z.nativeEnum(ExamType),
  type: z.nativeEnum(TestType),

  // Duration — at least one of test-level or per-section must be configured
  durationMinutes: z.number().int().min(1).max(600).optional(),

  // Scheduling
  scheduledFrom: z.coerce.date().optional(),
  scheduledUntil: z.coerce.date().optional(),

  // Access
  isFree: z.boolean().default(false),
  price: z.number().min(0).optional(),
  subscriptionInclusive: z.boolean().default(true),

  // Randomization
  randomizeQuestions: z.boolean().default(false),
  randomizeOptions: z.boolean().default(false),

  // Discovery
  tags: z.array(z.string().min(1).max(50)).max(20).default([]),
  thumbnailUrl: z.string().url().optional(),
}).refine(
  (data) => {
    if (data.scheduledFrom && data.scheduledUntil) {
      return data.scheduledUntil > data.scheduledFrom;
    }
    return true;
  },
  { message: "scheduledUntil must be after scheduledFrom", path: ["scheduledUntil"] }
);

export type CreateTestInput = z.infer<typeof CreateTestSchema>;

// ── Update Test ──────────────────────────────────────────────────────────────

export const UpdateTestSchema = z.object({
  title: z.string().min(3).max(200).optional(),
  description: z.string().max(2000).optional(),
  instructions: z.string().max(5000).optional(),
  durationMinutes: z.number().int().min(1).max(600).optional(),
  scheduledFrom: z.coerce.date().optional(),
  scheduledUntil: z.coerce.date().optional(),
  isFree: z.boolean().optional(),
  price: z.number().min(0).optional(),
  subscriptionInclusive: z.boolean().optional(),
  randomizeQuestions: z.boolean().optional(),
  randomizeOptions: z.boolean().optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
  thumbnailUrl: z.string().url().optional(),
});

export type UpdateTestInput = z.infer<typeof UpdateTestSchema>;

// ── Sections ─────────────────────────────────────────────────────────────────

export const CreateSectionSchema = SectionSchema;
export type CreateSectionInput = z.infer<typeof CreateSectionSchema>;

export const UpdateSectionSchema = SectionSchema.partial();
export type UpdateSectionInput = z.infer<typeof UpdateSectionSchema>;

export const ReorderSectionsSchema = z.object({
  sections: z.array(
    z.object({
      id: z.string().cuid(),
      order: z.number().int().min(0),
    })
  ).min(1),
});
export type ReorderSectionsInput = z.infer<typeof ReorderSectionsSchema>;

// ── Questions ────────────────────────────────────────────────────────────────

export const AddQuestionsSchema = z.object({
  questions: z.array(QuestionInSectionSchema).min(1).max(500),
});
export type AddQuestionsInput = z.infer<typeof AddQuestionsSchema>;

export const ReorderQuestionsSchema = z.object({
  questions: z.array(
    z.object({
      id: z.string().cuid(),       // TestQuestion.id
      order: z.number().int().min(0),
    })
  ).min(1),
});
export type ReorderQuestionsInput = z.infer<typeof ReorderQuestionsSchema>;

// ── Publish ──────────────────────────────────────────────────────────────────

// No body needed — action is idempotent based on test state

// ── Query / List ─────────────────────────────────────────────────────────────

export const ListTestsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  exam: z.nativeEnum(ExamType).optional(),
  type: z.nativeEnum(TestType).optional(),
  status: z.nativeEnum(TestStatus).optional(),
  search: z.string().min(1).max(100).optional(),
  sortBy: z.enum(["createdAt", "updatedAt", "title", "totalAttempts"]).default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export type ListTestsQuery = z.infer<typeof ListTestsQuerySchema>;
