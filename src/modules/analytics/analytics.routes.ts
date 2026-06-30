import { FastifyInstance } from "fastify";
import { authenticate, authenticateAdmin, requireSuperAdmin } from "../../middleware/authenticate";
import { sendSuccess } from "../../utils/response";
import { asyncHandler } from "../../utils/async-handler";
import {
  LeaderboardQuerySchema,
  ExamStatsQuerySchema,
  AdminPlatformQuerySchema,
  AdminRevenueQuerySchema,
  ChapterBreakdownQuerySchema,
} from "./schemas/analytics.schema";
import * as AnalyticsService from "./services/analytics.service";

// =============================================================================
// Analytics Routes — /api/v1/analytics/*
//
// Student (authenticated):
//   GET /analytics/dashboard                       personal dashboard
//   GET /analytics/exam?exam=NEET                  exam-level percentile
//   GET /analytics/leaderboard/:testId             test leaderboard
//   GET /analytics/leaderboard/:testId/me          my rank on a test
//   GET /analytics/attempts/:attemptId/chapters    chapter-wise breakdown
//
// Admin:
//   GET /analytics/admin/tests/:testId             full test analytics
//   GET /analytics/admin/questions?exam=NEET       question bank analytics
//   GET /analytics/admin/coupons                   coupon analytics
//
// Super Admin only:
//   GET /analytics/superadmin/platform             platform-wide analytics
//   GET /analytics/superadmin/revenue              revenue analytics
// =============================================================================

export async function analyticsRoutes(app: FastifyInstance) {

  // ── Student: Personal Dashboard ─────────────────────────────────────────────
  app.get(
    "/dashboard",
    { preHandler: [authenticate] },
    asyncHandler(async (request, reply) => {
      const result = await AnalyticsService.getStudentDashboard(request.user!.id);
      return sendSuccess(reply, result);
    })
  );

  // ── Student: Exam-level percentile ──────────────────────────────────────────
  app.get(
    "/exam",
    { preHandler: [authenticate] },
    asyncHandler(async (request, reply) => {
      const { exam } = ExamStatsQuerySchema.parse(request.query);
      const result = await AnalyticsService.getExamPercentile(request.user!.id, exam);
      return sendSuccess(reply, result);
    })
  );

  // ── Student: Test leaderboard ────────────────────────────────────────────────
  app.get(
    "/leaderboard/:testId",
    { preHandler: [authenticate] },
    asyncHandler(async (request, reply) => {
      const { testId } = request.params as { testId: string };
      const query      = LeaderboardQuerySchema.parse(request.query);
      const result     = await AnalyticsService.getLeaderboard(testId, query);
      return sendSuccess(reply, result);
    })
  );

  // ── Student: My rank on a test ───────────────────────────────────────────────
  app.get(
    "/leaderboard/:testId/me",
    { preHandler: [authenticate] },
    asyncHandler(async (request, reply) => {
      const { testId } = request.params as { testId: string };
      const result     = await AnalyticsService.getMyRank(testId, request.user!.id);
      return sendSuccess(reply, result);
    })
  );

  // ── Student: Chapter-wise breakdown for an attempt ──────────────────────────
  app.get(
    "/attempts/:attemptId/chapters",
    { preHandler: [authenticate] },
    asyncHandler(async (request, reply) => {
      const { attemptId } = ChapterBreakdownQuerySchema.parse(request.params);
      const result        = await AnalyticsService.getChapterBreakdown(attemptId, request.user!.id);
      return sendSuccess(reply, result);
    })
  );

  // ── Admin: Full test analytics ───────────────────────────────────────────────
  app.get(
    "/admin/tests/:testId",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const { testId } = request.params as { testId: string };
      const result     = await AnalyticsService.getTestAnalytics(testId);
      return sendSuccess(reply, result);
    })
  );

  // ── Admin: Question bank analytics ──────────────────────────────────────────
  app.get(
    "/admin/questions",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const { exam } = request.query as { exam?: string };
      const result   = await AnalyticsService.getQuestionBankAnalytics(exam);
      return sendSuccess(reply, result);
    })
  );

  // ── Admin: Coupon analytics ──────────────────────────────────────────────────
  app.get(
    "/admin/coupons",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const result = await AnalyticsService.getCouponAnalytics();
      return sendSuccess(reply, result);
    })
  );

  // ── Super Admin: Platform-wide analytics ─────────────────────────────────────
  app.get(
    "/superadmin/platform",
    { preHandler: [requireSuperAdmin] },
    asyncHandler(async (request, reply) => {
      const query  = AdminPlatformQuerySchema.parse(request.query);
      const result = await AnalyticsService.getPlatformAnalytics(query);
      return sendSuccess(reply, result);
    })
  );

  // ── Super Admin: Revenue analytics ──────────────────────────────────────────
  app.get(
    "/superadmin/revenue",
    { preHandler: [requireSuperAdmin] },
    asyncHandler(async (request, reply) => {
      const query  = AdminRevenueQuerySchema.parse(request.query);
      const result = await AnalyticsService.getRevenueAnalytics(query);
      return sendSuccess(reply, result);
    })
  );
}
