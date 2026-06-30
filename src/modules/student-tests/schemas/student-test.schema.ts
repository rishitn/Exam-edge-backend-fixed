import { z } from "zod";
import { ExamType, TestType } from "@prisma/client";

// =============================================================================
// Student Test Listing — Zod Schemas
//
// These are the public / student-facing schemas.  Admins have their own
// richer schemas in src/modules/tests/schemas/test.schema.ts.
// =============================================================================

// ── List / Browse ─────────────────────────────────────────────────────────────

export const listTestsQuerySchema = z.object({
  // Filters
  exam:   z.nativeEnum(ExamType).optional(),
  type:   z.nativeEnum(TestType).optional(),
  search: z.string().trim().max(100).optional(),

  // Access filters
  free:   z.coerce.boolean().optional(),   // true = only free tests

  // Sorting
  sortBy:    z.enum(["createdAt", "publishedAt", "price", "totalAttempts"]).default("publishedAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),

  // Pagination
  page:     z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export type ListTestsQuery = z.infer<typeof listTestsQuerySchema>;

// ── Single test detail params ─────────────────────────────────────────────────

export const testParamsSchema = z.object({
  testId: z.string().cuid(),
});

export type TestParams = z.infer<typeof testParamsSchema>;
