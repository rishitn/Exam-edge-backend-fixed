import { z } from "zod";
import { ExamType } from "@prisma/client";

// =============================================================================
// Analytics & Results — Zod Schemas
// =============================================================================

export const LeaderboardQuerySchema = z.object({
  page:     z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type LeaderboardQuery = z.infer<typeof LeaderboardQuerySchema>;

export const ExamStatsQuerySchema = z.object({
  exam: z.nativeEnum(ExamType),
});
export type ExamStatsQuery = z.infer<typeof ExamStatsQuerySchema>;

export const AdminPlatformQuerySchema = z.object({
  from: z.string().datetime().optional(),   // ISO date filter start
  to:   z.string().datetime().optional(),   // ISO date filter end
  exam: z.nativeEnum(ExamType).optional(),
});
export type AdminPlatformQuery = z.infer<typeof AdminPlatformQuerySchema>;

export const AdminRevenueQuerySchema = z.object({
  from:     z.string().datetime().optional(),
  to:       z.string().datetime().optional(),
  groupBy:  z.enum(["day", "week", "month"]).default("day"),
});
export type AdminRevenueQuery = z.infer<typeof AdminRevenueQuerySchema>;

export const ChapterBreakdownQuerySchema = z.object({
  attemptId: z.string().cuid("Invalid attempt ID"),
});
export type ChapterBreakdownQuery = z.infer<typeof ChapterBreakdownQuerySchema>;
