import { ExamType, AttemptStatus, OrderStatus, Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma";
import { getRedis, RedisKeys } from "../../../lib/redis";
import { Errors, ErrorCode } from "../../../utils/errors";
import { createLogger } from "../../../lib/logger";
import { buildPaginationMeta } from "../../../utils/response";
import type {
  LeaderboardQuery,
  AdminPlatformQuery,
  AdminRevenueQuery,
} from "../schemas/analytics.schema";

const log = createLogger("analytics-service");

// =============================================================================
// 1. LEADERBOARD — Real-time from Redis sorted set
// =============================================================================
export async function getLeaderboard(testId: string, query: LeaderboardQuery) {
  const test = await prisma.test.findUnique({
    where: { id: testId, deletedAt: null },
    select: { id: true, title: true, exam: true, type: true, totalQuestions: true },
  });
  if (!test) throw Errors.notFound("Test", ErrorCode.TEST_NOT_FOUND);

  const redis     = getRedis();
  const key       = RedisKeys.leaderboard(testId);
  const { page, pageSize } = query;
  const start     = (page - 1) * pageSize;
  const stop      = start + pageSize - 1;

  const [entries, totalCount] = await Promise.all([
    redis.zrevrange(key, start, stop, "WITHSCORES"),
    redis.zcard(key),
  ]);

  // Interleaved [member, score, member, score …]
  const ranked: { rank: number; userId: string; score: number }[] = [];
  for (let i = 0; i < entries.length; i += 2) {
    ranked.push({ rank: start + Math.floor(i / 2) + 1, userId: entries[i], score: parseFloat(entries[i + 1]) });
  }

  const userIds = ranked.map((r) => r.userId);
  const users   = await prisma.user.findMany({
    where:  { id: { in: userIds } },
    select: { id: true, name: true, avatarUrl: true },
  });
  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));

  const enriched = ranked.map((entry) => ({
    rank:       entry.rank,
    score:      entry.score,
    percentile: totalCount > 1
      ? parseFloat((((totalCount - entry.rank) / (totalCount - 1)) * 100).toFixed(2))
      : 100,
    user: userMap[entry.userId] ?? { id: entry.userId, name: "Unknown", avatarUrl: null },
  }));

  return { test, leaderboard: enriched, pagination: buildPaginationMeta(totalCount, page, pageSize) };
}

// =============================================================================
// 2. MY RANK on a specific test
// =============================================================================
export async function getMyRank(testId: string, userId: string) {
  const test = await prisma.test.findUnique({
    where:  { id: testId, deletedAt: null },
    select: { id: true, title: true },
  });
  if (!test) throw Errors.notFound("Test", ErrorCode.TEST_NOT_FOUND);

  const redis = getRedis();
  const key   = RedisKeys.leaderboard(testId);

  const [rankRaw, scoreRaw, totalCount] = await Promise.all([
    redis.zrevrank(key, userId),
    redis.zscore(key, userId),
    redis.zcard(key),
  ]);

  if (rankRaw === null || scoreRaw === null) {
    return { attempted: false, testId, testTitle: test.title };
  }

  const rank       = rankRaw + 1;
  const score      = parseFloat(scoreRaw);
  const percentile = totalCount > 1
    ? parseFloat((((totalCount - rank) / (totalCount - 1)) * 100).toFixed(2))
    : 100;

  return { attempted: true, testId, testTitle: test.title, rank, score, percentile, totalParticipants: totalCount };
}

// =============================================================================
// 3. EXAM-LEVEL PERCENTILE — student across all attempts for an exam
// =============================================================================
export async function getExamPercentile(userId: string, exam: ExamType) {
  const myAttempts = await prisma.testAttempt.findMany({
    where: {
      userId,
      status: { in: [AttemptStatus.SUBMITTED, AttemptStatus.AUTO_SUBMITTED] },
      test:   { exam },
    },
    select: {
      id: true, rawScore: true, totalMarks: true,
      correctCount: true, incorrectCount: true, unattemptedCount: true,
      accuracyPct: true, submittedAt: true,
      test: { select: { id: true, title: true, totalQuestions: true } },
    },
    orderBy: { submittedAt: "desc" },
  });

  if (myAttempts.length === 0) return { exam, attempted: false, attempts: [] };

  const redis = getRedis();

  const enriched = await Promise.all(
    myAttempts.map(async (attempt) => {
      const key        = RedisKeys.leaderboard(attempt.test.id);
      const [rankRaw, totalCount] = await Promise.all([
        redis.zrevrank(key, userId),
        redis.zcard(key),
      ]);
      const rank       = rankRaw !== null ? rankRaw + 1 : null;
      const percentile = rank && totalCount > 1
        ? parseFloat((((totalCount - rank) / (totalCount - 1)) * 100).toFixed(2))
        : rank === 1 ? 100 : null;

      return {
        attemptId:        attempt.id,
        test:             attempt.test,
        score:            attempt.rawScore,
        totalMarks:       attempt.totalMarks,
        correctCount:     attempt.correctCount,
        incorrectCount:   attempt.incorrectCount,
        unattemptedCount: attempt.unattemptedCount,
        accuracyPct:      attempt.accuracyPct,
        rank,
        percentile,
        totalParticipants: totalCount,
        submittedAt:      attempt.submittedAt,
      };
    })
  );

  const avgAccuracy = enriched.reduce((s, a) => s + Number(a.accuracyPct ?? 0), 0) / enriched.length;
  const avgScore    = enriched.reduce((s, a) => s + Number(a.score ?? 0), 0) / enriched.length;
  const bestRank    = enriched
    .filter((a) => a.rank !== null)
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))[0]?.rank ?? null;

  return {
    exam, attempted: true,
    totalAttempts: enriched.length,
    avgAccuracy:   parseFloat(avgAccuracy.toFixed(2)),
    avgScore:      parseFloat(avgScore.toFixed(2)),
    bestRank,
    attempts:      enriched,
  };
}

// =============================================================================
// 4. STUDENT PERSONAL DASHBOARD
// =============================================================================
export async function getStudentDashboard(userId: string) {
  const attempts = await prisma.testAttempt.findMany({
    where: {
      userId,
      status: { in: [AttemptStatus.SUBMITTED, AttemptStatus.AUTO_SUBMITTED] },
    },
    select: {
      id: true, rawScore: true, correctCount: true, incorrectCount: true,
      unattemptedCount: true, accuracyPct: true, timeSpentSeconds: true,
      submittedAt: true, sectionScores: true,
      test: { select: { id: true, title: true, exam: true, type: true, totalQuestions: true } },
    },
    orderBy: { submittedAt: "desc" },
  });

  if (attempts.length === 0) {
    return { totalTests: 0, avgAccuracy: 0, avgScore: 0, totalTimeSpentSeconds: 0, byExam: {}, recentAttempts: [], scoreTrend: [] };
  }

  const totalTests     = attempts.length;
  const avgAccuracy    = attempts.reduce((s, a) => s + Number(a.accuracyPct ?? 0), 0) / totalTests;
  const avgScore       = attempts.reduce((s, a) => s + Number(a.rawScore ?? 0), 0) / totalTests;
  const totalTimeSpent = attempts.reduce((s, a) => s + (a.timeSpentSeconds ?? 0), 0);

  // Per-exam breakdown
  const byExam: Record<string, { attempts: number; avgAccuracy: number; avgScore: number; bestScore: number }> = {};
  for (const a of attempts) {
    const exam = a.test.exam;
    if (!byExam[exam]) byExam[exam] = { attempts: 0, avgAccuracy: 0, avgScore: 0, bestScore: 0 };
    byExam[exam].attempts++;
    byExam[exam].avgAccuracy += Number(a.accuracyPct ?? 0);
    byExam[exam].avgScore    += Number(a.rawScore ?? 0);
    byExam[exam].bestScore    = Math.max(byExam[exam].bestScore, Number(a.rawScore ?? 0));
  }
  for (const exam of Object.keys(byExam)) {
    byExam[exam].avgAccuracy = parseFloat((byExam[exam].avgAccuracy / byExam[exam].attempts).toFixed(2));
    byExam[exam].avgScore    = parseFloat((byExam[exam].avgScore    / byExam[exam].attempts).toFixed(2));
  }

  // Score trend — last 10 attempts oldest→newest for chart
  const scoreTrend = [...attempts]
    .reverse()
    .slice(-10)
    .map((a) => ({
      testTitle:   a.test.title,
      exam:        a.test.exam,
      score:       Number(a.rawScore ?? 0),
      accuracyPct: Number(a.accuracyPct ?? 0),
      submittedAt: a.submittedAt,
    }));

  return {
    totalTests,
    avgAccuracy:           parseFloat(avgAccuracy.toFixed(2)),
    avgScore:              parseFloat(avgScore.toFixed(2)),
    totalTimeSpentSeconds: totalTimeSpent,
    byExam,
    scoreTrend,
    recentAttempts:        attempts.slice(0, 10),
  };
}

// =============================================================================
// 5. CHAPTER-WISE BREAKDOWN — for a specific attempt result page
// =============================================================================
export async function getChapterBreakdown(attemptId: string, userId: string) {
  // Verify the attempt belongs to this user
  const attempt = await prisma.testAttempt.findUnique({
    where: { id: attemptId },
    select: { id: true, userId: true, status: true, testId: true },
  });

  if (!attempt || attempt.userId !== userId) {
    throw Errors.notFound("Attempt", ErrorCode.ATTEMPT_NOT_FOUND);
  }
  if (attempt.status === AttemptStatus.IN_PROGRESS) {
    throw Errors.business("Attempt is still in progress.", ErrorCode.ATTEMPT_IN_PROGRESS);
  }

  // Load all answers with chapter data
  const answers = await prisma.attemptAnswer.findMany({
    where:  { attemptId },
    select: {
      isCorrect:        true,
      isAttempted:      true,
      marksAwarded:     true,
      timeSpentSeconds: true,
      question: {
        select: {
          difficulty: true,
          type:       true,
          chapter:    { select: { id: true, name: true } },
          subject:    { select: { id: true, name: true } },
        },
      },
    },
  });

  // Group by chapter
  const chapterMap: Record<string, {
    chapterId:    string;
    chapterName:  string;
    subjectId:    string;
    subjectName:  string;
    total:        number;
    attempted:    number;
    correct:      number;
    incorrect:    number;
    unattempted:  number;
    totalMarks:   number;
    timeSpentSeconds: number;
    byDifficulty: Record<string, { total: number; correct: number }>;
  }> = {};

  for (const ans of answers) {
    const ch  = ans.question.chapter;
    const sub = ans.question.subject;
    const key = ch.id;

    if (!chapterMap[key]) {
      chapterMap[key] = {
        chapterId:   ch.id,
        chapterName: ch.name,
        subjectId:   sub.id,
        subjectName: sub.name,
        total: 0, attempted: 0, correct: 0, incorrect: 0, unattempted: 0,
        totalMarks: 0, timeSpentSeconds: 0,
        byDifficulty: { EASY: { total: 0, correct: 0 }, MEDIUM: { total: 0, correct: 0 }, HARD: { total: 0, correct: 0 } },
      };
    }

    const c = chapterMap[key];
    c.total++;
    c.timeSpentSeconds += ans.timeSpentSeconds ?? 0;
    c.totalMarks       += Number(ans.marksAwarded ?? 0);

    const diff = ans.question.difficulty as string;
    if (c.byDifficulty[diff]) {
      c.byDifficulty[diff].total++;
      if (ans.isCorrect) c.byDifficulty[diff].correct++;
    }

    if (!ans.isAttempted) {
      c.unattempted++;
    } else if (ans.isCorrect) {
      c.correct++;
      c.attempted++;
    } else {
      c.incorrect++;
      c.attempted++;
    }
  }

  const chapters = Object.values(chapterMap).map((c) => ({
    ...c,
    accuracyPct: c.attempted > 0 ? parseFloat(((c.correct / c.attempted) * 100).toFixed(2)) : 0,
  }));

  // Sort weakest chapters first
  chapters.sort((a, b) => a.accuracyPct - b.accuracyPct);

  return {
    attemptId,
    totalQuestions: answers.length,
    chapters,
    weakestChapters: chapters.slice(0, 3).map((c) => ({ chapterId: c.chapterId, chapterName: c.chapterName, accuracyPct: c.accuracyPct })),
  };
}

// =============================================================================
// 6. ADMIN — FULL TEST ANALYTICS
// =============================================================================
export async function getTestAnalytics(testId: string) {
  const test = await prisma.test.findUnique({
    where:  { id: testId, deletedAt: null },
    select: {
      id: true, title: true, exam: true, type: true,
      totalQuestions: true, totalAttempts: true, isFree: true, price: true,
      sections: { select: { id: true, name: true } },
    },
  });
  if (!test) throw Errors.notFound("Test", ErrorCode.TEST_NOT_FOUND);

  const submittedFilter = {
    testId,
    status: { in: [AttemptStatus.SUBMITTED, AttemptStatus.AUTO_SUBMITTED] as AttemptStatus[] },
  };

  const [stats, inProgress, autoSubmitted, cheaters, scoreDistribution, completionOverTime] =
    await Promise.all([
      // Aggregate score/time stats
      prisma.testAttempt.aggregate({
        where: submittedFilter,
        _count: { id: true },
        _avg:   { rawScore: true, accuracyPct: true, timeSpentSeconds: true },
        _max:   { rawScore: true },
        _min:   { rawScore: true },
      }),

      // In-progress count
      prisma.testAttempt.count({ where: { testId, status: AttemptStatus.IN_PROGRESS } }),

      // Auto-submitted (timer ran out)
      prisma.testAttempt.count({ where: { testId, status: AttemptStatus.AUTO_SUBMITTED } }),

      // Cheating flags
      prisma.testAttempt.count({ where: { testId, cheatFlag: true } }),

      // Score distribution
      getScoreDistribution(testId),

      // Completion over time (last 14 days, grouped by day)
      getCompletionOverTime(testId, 14),
    ]);

  // Per-question correct rate
  const questionStats = await prisma.attemptAnswer.groupBy({
    by:    ["questionId"],
    where: { attempt: submittedFilter },
    _count: { id: true },
  });

  // Get correct counts separately
  const correctStats = await prisma.attemptAnswer.groupBy({
    by:    ["questionId"],
    where: { attempt: submittedFilter, isCorrect: true },
    _count: { id: true },
  });
  const correctMap = Object.fromEntries(correctStats.map((r) => [r.questionId, r._count.id]));

  // Hydrate question metadata
  const questionIds = questionStats.map((q) => q.questionId);
  const questions   = await prisma.question.findMany({
    where:  { id: { in: questionIds } },
    select: { id: true, type: true, difficulty: true, chapter: { select: { id: true, name: true } } },
  });
  const questionMeta = Object.fromEntries(questions.map((q) => [q.id, q]));

  const perQuestion = questionStats.map((q) => {
    const total   = q._count.id;
    const correct = correctMap[q.questionId] ?? 0;
    const meta    = questionMeta[q.questionId];
    return {
      questionId:    q.questionId,
      totalAnswered: total,
      correctCount:  correct,
      correctPct:    total > 0 ? parseFloat(((correct / total) * 100).toFixed(2)) : 0,
      difficulty:    meta?.difficulty ?? null,
      chapterName:   meta?.chapter?.name ?? null,
      type:          meta?.type ?? null,
    };
  }).sort((a, b) => a.correctPct - b.correctPct);

  const redis              = getRedis();
  const totalOnLeaderboard = await redis.zcard(RedisKeys.leaderboard(testId));

  log.info({ testId }, "Test analytics generated");

  return {
    test,
    overview: {
      totalAttempts:      test.totalAttempts,
      submittedAttempts:  stats._count.id,
      inProgressAttempts: inProgress,
      autoSubmitted,
      cheaters,
      completionRate:     test.totalAttempts > 0
        ? parseFloat(((stats._count.id / test.totalAttempts) * 100).toFixed(2))
        : 0,
    },
    scores: {
      avg:      stats._avg.rawScore    ? parseFloat(Number(stats._avg.rawScore).toFixed(2))    : null,
      high:     stats._max.rawScore    ? Number(stats._max.rawScore)    : null,
      low:      stats._min.rawScore    ? Number(stats._min.rawScore)    : null,
      avgAccuracy: stats._avg.accuracyPct ? parseFloat(Number(stats._avg.accuracyPct).toFixed(2)) : null,
      avgTimeSecs: stats._avg.timeSpentSeconds ? Math.round(Number(stats._avg.timeSpentSeconds)) : null,
    },
    totalOnLeaderboard,
    scoreDistribution,
    completionOverTime,
    hardestQuestions:  perQuestion.slice(0, 10),
    easiestQuestions:  perQuestion.slice(-10).reverse(),
  };
}

// =============================================================================
// 7. ADMIN — PLATFORM-WIDE ANALYTICS (Super Admin)
// =============================================================================
export async function getPlatformAnalytics(query: AdminPlatformQuery) {
  const dateFilter = buildDateFilter(query.from, query.to);
  const examFilter = query.exam ? { exam: query.exam } : {};

  const [
    totalUsers,
    newUsersToday,
    newUsersThisWeek,
    totalAttempts,
    attemptsThisWeek,
    totalTests,
    publishedTests,
    totalQuestions,
    activeSubscriptions,
    usersByExam,
    attemptsByExam,
    topTests,
    registrationTrend,
  ] = await Promise.all([
    // User counts
    prisma.user.count({ where: { deletedAt: null } }),
    prisma.user.count({ where: { deletedAt: null, createdAt: { gte: startOfToday() } } }),
    prisma.user.count({ where: { deletedAt: null, createdAt: { gte: daysAgo(7) } } }),

    // Attempt counts
    prisma.testAttempt.count({ where: { ...dateFilter } }),
    prisma.testAttempt.count({ where: { startedAt: { gte: daysAgo(7) } } }),

    // Test counts
    prisma.test.count({ where: { deletedAt: null, ...examFilter } }),
    prisma.test.count({ where: { deletedAt: null, status: "PUBLISHED", ...examFilter } }),

    // Question count
    prisma.question.count({ where: { deletedAt: null, ...examFilter } }),

    // Active subscriptions
    prisma.subscription.count({ where: { status: "ACTIVE" } }),

    // Users per exam (from targetExams array — approximate via attempts)
    prisma.testAttempt.groupBy({
      by: ["testId"],
      _count: { id: true },
      where: dateFilter,
      take: 100,
      orderBy: { testId: "asc" },
    }),

    // Attempts by exam
    getAttemptsByExam(dateFilter),

    // Top 5 most-attempted tests
    prisma.test.findMany({
      where:   { deletedAt: null, status: "PUBLISHED", ...examFilter },
      select:  { id: true, title: true, exam: true, totalAttempts: true, isFree: true },
      orderBy: { totalAttempts: "desc" },
      take:    5,
    }),

    // New registrations last 14 days
    getRegistrationTrend(14),
  ]);

  return {
    users: {
      total:          totalUsers,
      newToday:       newUsersToday,
      newThisWeek:    newUsersThisWeek,
      activeSubscriptions,
    },
    tests: {
      total:          totalTests,
      published:      publishedTests,
      draft:          totalTests - publishedTests,
    },
    questions: {
      total:          totalQuestions,
    },
    attempts: {
      total:          totalAttempts,
      thisWeek:       attemptsThisWeek,
      byExam:         attemptsByExam,
    },
    topTests,
    registrationTrend,
  };
}

// =============================================================================
// 8. ADMIN — REVENUE ANALYTICS (Super Admin)
// =============================================================================
export async function getRevenueAnalytics(query: AdminRevenueQuery) {
  const dateFilter = buildDateFilter(query.from, query.to);

  const [
    totalRevenue,
    totalOrders,
    successfulOrders,
    failedOrders,
    revByType,
    revBySeries,
    recentOrders,
  ] = await Promise.all([
    // Total GMV
    prisma.order.aggregate({
      where:  { status: OrderStatus.SUCCESS } as any,
      _sum:   { finalAmount: true },
      _count: { id: true },
    }),

    // Order counts
    prisma.order.count({ where: { ...(dateFilter as any) } }),
    prisma.order.count({ where: { status: OrderStatus.SUCCESS, ...(dateFilter as any) } }),
    prisma.order.count({ where: { status: OrderStatus.FAILED, ...(dateFilter as any) } }),

    // Revenue by order type
    prisma.order.groupBy({
      by:     ["type"],
      where:  { status: OrderStatus.SUCCESS },
      _sum:   { finalAmount: true },
      _count: { id: true },
    }),

    // Revenue trend grouped by day/week/month
    getRevenueTrend(query.groupBy, query.from, query.to),

    // Recent successful orders
    prisma.order.findMany({
      where:   { status: OrderStatus.SUCCESS },
      select: {
        id: true, finalAmount: true, type: true, paidAt: true,
        user: { select: { id: true, name: true, email: true } },
        test: { select: { id: true, title: true } },
        plan: { select: { id: true, name: true } },
      },
      orderBy: { paidAt: "desc" },
      take:    20,
    }),
  ]);

  const gmv            = Number(totalRevenue._sum.finalAmount ?? 0);
  const successRate    = totalOrders > 0 ? parseFloat(((successfulOrders / totalOrders) * 100).toFixed(2)) : 0;

  return {
    summary: {
      gmv:            parseFloat(gmv.toFixed(2)),
      totalOrders,
      successfulOrders,
      failedOrders,
      successRate,
      avgOrderValue:  successfulOrders > 0 ? parseFloat((gmv / successfulOrders).toFixed(2)) : 0,
    },
    byType: revByType.map((r) => ({
      type:    r.type,
      revenue: Number(r._sum.finalAmount ?? 0),
      orders:  r._count.id,
    })),
    trend:        revBySeries,
    recentOrders,
  };
}

// =============================================================================
// 9. ADMIN — QUESTION BANK ANALYTICS
// =============================================================================
export async function getQuestionBankAnalytics(exam?: string) {
  const where: Prisma.QuestionWhereInput = {
    deletedAt: null,
    ...(exam && { exam: exam as any }),
  };

  const [byExam, byType, byDifficulty, bySubject, lowPerformers, recentlyAdded] = await Promise.all([
    prisma.question.groupBy({ by: ["exam"],       where, _count: { _all: true } }),
    prisma.question.groupBy({ by: ["type"],       where, _count: { _all: true } }),
    prisma.question.groupBy({ by: ["difficulty"], where, _count: { _all: true } }),

    // By subject with question counts
    prisma.subject.findMany({
      where:   { isActive: true, ...(exam && { exam: exam as any }) },
      select: {
        id: true, name: true, exam: true,
        _count: { select: { questions: { where: { deletedAt: null } } } },
      },
      orderBy: { exam: "asc" },
    }),

    // Questions with highest wrong rate (used in ≥10 attempts, <40% correct)
    getLowPerformingQuestions(exam),

    // Added in last 7 days
    prisma.question.count({ where: { ...where, createdAt: { gte: daysAgo(7) } } }),
  ]);

  return {
    byExam:        byExam.map((r)       => ({ exam: r.exam,             count: r._count._all })),
    byType:        byType.map((r)       => ({ type: r.type,             count: r._count._all })),
    byDifficulty:  byDifficulty.map((r) => ({ difficulty: r.difficulty, count: r._count._all })),
    bySubject:     bySubject.map((s)    => ({ subjectId: s.id, name: s.name, exam: s.exam, count: s._count.questions })),
    lowPerformers,
    recentlyAdded,
  };
}

// =============================================================================
// 10. ADMIN — COUPON ANALYTICS
// =============================================================================
export async function getCouponAnalytics() {
  const coupons = await prisma.coupon.findMany({
    select: {
      id: true, code: true, discountType: true, discountValue: true,
      maxUses: true, usedCount: true, status: true, validUntil: true, createdAt: true,
      _count: { select: { usages: true, orders: true } },
    },
    orderBy: { usedCount: "desc" },
    take:    50,
  });

  const totalDiscountGiven = await prisma.order.aggregate({
    where: { couponId: { not: null }, status: OrderStatus.SUCCESS },
    _sum:  { discountAmount: true },
  });

  return {
    totalDiscountGiven: Number(totalDiscountGiven._sum.discountAmount ?? 0),
    coupons: coupons.map((c) => ({
      ...c,
      usageRate: c.maxUses ? parseFloat(((c.usedCount / c.maxUses) * 100).toFixed(2)) : null,
    })),
  };
}

// =============================================================================
// Private Helpers
// =============================================================================

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
}

function buildDateFilter(from?: string, to?: string): any {
  if (!from && !to) return {};
  return {
    startedAt: {
      ...(from && { gte: new Date(from) }),
      ...(to   && { lte: new Date(to)   }),
    },
  };
}

async function getScoreDistribution(testId: string) {
  const attempts = await prisma.testAttempt.findMany({
    where:  { testId, status: { in: [AttemptStatus.SUBMITTED, AttemptStatus.AUTO_SUBMITTED] }, rawScore: { not: null }, totalMarks: { not: null } },
    select: { rawScore: true, totalMarks: true },
  });

  const buckets = [
    { label: "0–20%",   min: 0,   max: 20,  count: 0 },
    { label: "20–40%",  min: 20,  max: 40,  count: 0 },
    { label: "40–60%",  min: 40,  max: 60,  count: 0 },
    { label: "60–80%",  min: 60,  max: 80,  count: 0 },
    { label: "80–100%", min: 80,  max: 101, count: 0 },
  ];

  for (const a of attempts) {
    const total = Number(a.totalMarks);
    if (!total) continue;
    const pct    = (Number(a.rawScore) / total) * 100;
    const bucket = buckets.find((b) => pct >= b.min && pct < b.max);
    if (bucket) bucket.count++;
  }

  return buckets.map(({ label, count }) => ({ label, count }));
}

async function getCompletionOverTime(testId: string, days: number) {
  const since = daysAgo(days);
  const rows   = await prisma.testAttempt.findMany({
    where:   { testId, submittedAt: { gte: since }, status: { in: [AttemptStatus.SUBMITTED, AttemptStatus.AUTO_SUBMITTED] } },
    select:  { submittedAt: true },
    orderBy: { submittedAt: "asc" },
  });

  const grouped: Record<string, number> = {};
  for (const r of rows) {
    const day = r.submittedAt!.toISOString().split("T")[0];
    grouped[day] = (grouped[day] ?? 0) + 1;
  }

  return Object.entries(grouped).map(([date, count]) => ({ date, count }));
}

async function getAttemptsByExam(dateFilter: any) {
  const rows = await prisma.testAttempt.findMany({
    where:  dateFilter,
    select: { test: { select: { exam: true } } },
  });

  const map: Record<string, number> = {};
  for (const r of rows) {
    const e = r.test.exam;
    map[e]  = (map[e] ?? 0) + 1;
  }
  return Object.entries(map).map(([exam, count]) => ({ exam, count }));
}

async function getRegistrationTrend(days: number) {
  const since = daysAgo(days);
  const rows   = await prisma.user.findMany({
    where:   { createdAt: { gte: since }, deletedAt: null },
    select:  { createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const grouped: Record<string, number> = {};
  for (const r of rows) {
    const day = r.createdAt.toISOString().split("T")[0];
    grouped[day] = (grouped[day] ?? 0) + 1;
  }
  return Object.entries(grouped).map(([date, count]) => ({ date, count }));
}

async function getRevenueTrend(groupBy: "day" | "week" | "month", from?: string, to?: string) {
  const orders = await prisma.order.findMany({
    where: {
      status:  OrderStatus.SUCCESS,
      paidAt:  { not: null, ...(from && { gte: new Date(from) }), ...(to && { lte: new Date(to) }) },
    },
    select:  { finalAmount: true, paidAt: true },
    orderBy: { paidAt: "asc" },
  });

  const grouped: Record<string, number> = {};
  for (const o of orders) {
    if (!o.paidAt) continue;
    let key: string;
    if (groupBy === "day") {
      key = o.paidAt.toISOString().split("T")[0];
    } else if (groupBy === "week") {
      const d = new Date(o.paidAt);
      d.setDate(d.getDate() - d.getDay());
      key = d.toISOString().split("T")[0];
    } else {
      key = `${o.paidAt.getFullYear()}-${String(o.paidAt.getMonth() + 1).padStart(2, "0")}`;
    }
    grouped[key] = (grouped[key] ?? 0) + Number(o.finalAmount);
  }

  return Object.entries(grouped).map(([period, revenue]) => ({
    period,
    revenue: parseFloat(revenue.toFixed(2)),
  }));
}

async function getLowPerformingQuestions(exam?: string) {
  // Questions where >10 students answered, <40% got correct
  const rows = await prisma.attemptAnswer.groupBy({
    by:    ["questionId"],
    where: {
      isAttempted: true,
      attempt: { status: { in: [AttemptStatus.SUBMITTED, AttemptStatus.AUTO_SUBMITTED] } },
      ...(exam && { question: { exam: exam as any } }),
    },
    _count: { id: true },
    having: { id: { _count: { gt: 10 } } },
  });

  const correctRows = await prisma.attemptAnswer.groupBy({
    by:    ["questionId"],
    where: { isCorrect: true, isAttempted: true },
    _count: { id: true },
  });
  const correctMap = Object.fromEntries(correctRows.map((r) => [r.questionId, r._count.id]));

  const qIds = rows
    .filter((r) => {
      const total   = r._count.id;
      const correct = correctMap[r.questionId] ?? 0;
      return total > 0 && (correct / total) < 0.4;
    })
    .map((r) => r.questionId)
    .slice(0, 10);

  if (qIds.length === 0) return [];

  return prisma.question.findMany({
    where:  { id: { in: qIds } },
    select: {
      id: true, type: true, difficulty: true,
      content:  true,
      chapter:  { select: { id: true, name: true } },
      subject:  { select: { id: true, name: true } },
    },
  });
}
