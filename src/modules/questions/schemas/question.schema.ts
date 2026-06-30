import { z } from "zod";

// =============================================================================
// Question API Schemas — used at route level for input validation
// =============================================================================

export const CreateQuestionSchema = z.object({
  exam: z.enum(["NEET", "JEE_MAIN", "JEE_ADVANCED", "CUET"]),
  subjectId: z.string().cuid("Invalid subject ID"),
  chapterId: z.string().cuid("Invalid chapter ID"),
  topicId: z.string().cuid("Invalid topic ID").optional().nullable(),
  type: z.enum(["MCQ_SINGLE", "MCQ_MULTIPLE", "INTEGER", "ASSERTION", "MATCH_COLUMN"]),
  difficulty: z.enum(["EASY", "MEDIUM", "HARD"]).default("MEDIUM"),
  content: z.record(z.unknown()),       // Validated deeply in service via question-content.schema
  options: z.unknown().optional(),
  correctAnswer: z.unknown(),
  solution: z.record(z.unknown()),
  tags: z.array(z.string().max(50)).max(10).default([]),
  sourceYear: z.number().int().min(1990).max(2030).optional().nullable(),
  sourceExam: z.string().max(100).optional().nullable(),
});

export const UpdateQuestionSchema = CreateQuestionSchema.partial().omit({
  exam: true,    // Can't change exam after creation — would break test assignments
}).extend({
  status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]).optional(),
});

export const ListQuestionsSchema = z.object({
  exam: z.enum(["NEET", "JEE_MAIN", "JEE_ADVANCED", "CUET"]).optional(),
  subjectId: z.string().cuid().optional(),
  chapterId: z.string().cuid().optional(),
  topicId: z.string().cuid().optional(),
  type: z.enum(["MCQ_SINGLE", "MCQ_MULTIPLE", "INTEGER", "ASSERTION", "MATCH_COLUMN"]).optional(),
  difficulty: z.enum(["EASY", "MEDIUM", "HARD"]).optional(),
  status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]).optional(),
  search: z.string().max(200).optional(),
  tags: z.string().optional(),              // comma-separated tag filter
  isVerified: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.enum(["createdAt", "updatedAt", "difficulty", "usageCount"]).default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export const BulkDeleteSchema = z.object({
  questionIds: z
    .array(z.string().cuid())
    .min(1, "Provide at least one question ID")
    .max(100, "Maximum 100 questions per bulk delete"),
});

export const VerifyQuestionSchema = z.object({
  isVerified: z.boolean(),
});

export type CreateQuestionInput = z.infer<typeof CreateQuestionSchema>;
export type UpdateQuestionInput = z.infer<typeof UpdateQuestionSchema>;
export type ListQuestionsInput = z.infer<typeof ListQuestionsSchema>;
