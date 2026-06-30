import { AttemptStatus, TestStatus, Prisma, QuestionType } from "@prisma/client";
import { prisma } from "../../../lib/prisma";
import { getRedis, RedisKeys, safeRedisSet, safeRedisDel } from "../../../lib/redis";
import { Errors, ErrorCode } from "../../../utils/errors";
import { createLogger } from "../../../lib/logger";
import { scoreAnswer, aggregateResults, ScoredAnswer } from "./scoring.service";
import type {
  SaveAnswerInput,
  MarkReviewInput,
  SubmitAttemptInput,
  TabSwitchInput,
} from "../schemas/attempt.schema";

const log = createLogger("attempt-engine");

// How many tab switches before we set the cheat flag
const TAB_SWITCH_FLAG_THRESHOLD = 3;

// Redis TTL for active attempt cache: 24 hours
const ATTEMPT_CACHE_TTL = 60 * 60 * 24;

// =============================================================================
// Test Attempt Engine Service
// =============================================================================

// ── Shared DB select shapes ───────────────────────────────────────────────────

const ATTEMPT_SUMMARY_SELECT = {
  id: true,
  userId: true,
  testId: true,
  status: true,
  startedAt: true,
  submittedAt: true,
  timeSpentSeconds: true,
  tabSwitchCount: true,
  cheatFlag: true,
  rawScore: true,
  totalMarks: true,
  correctCount: true,
  incorrectCount: true,
  unattemptedCount: true,
  accuracyPct: true,
  rank: true,
  percentile: true,
  sectionScores: true,
} satisfies Prisma.TestAttemptSelect;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function requireAttempt(attemptId: string, userId: string) {
  const attempt = await prisma.testAttempt.findUnique({
    where: { id: attemptId },
    select: { id: true, userId: true, testId: true, status: true, startedAt: true },
  });
  if (!attempt || attempt.userId !== userId) {
    throw Errors.notFound("Attempt", ErrorCode.ATTEMPT_NOT_FOUND);
  }
  return attempt;
}

async function requireInProgress(attemptId: string, userId: string) {
  const attempt = await requireAttempt(attemptId, userId);
  if (attempt.status !== AttemptStatus.IN_PROGRESS) {
    throw Errors.business("This attempt has already been submitted.", ErrorCode.ATTEMPT_ALREADY_SUBMITTED);
  }
  return attempt;
}

// Cache active attempt ID in Redis so we can auto-submit on timer expiry
async function cacheActiveAttempt(attemptId: string, testId: string, startedAt: Date, durationMinutes: number) {
  const expiresAt = new Date(startedAt.getTime() + durationMinutes * 60 * 1000);
  await safeRedisSet(
    RedisKeys.attemptAnswers(attemptId),
    JSON.stringify({ testId, expiresAt: expiresAt.toISOString() }),
    ATTEMPT_CACHE_TTL
  );
}

// ── Start Attempt ─────────────────────────────────────────────────────────────

export async function startAttempt(testId: string, userId: string, meta: { ip?: string; userAgent?: string }) {
  // 1. Load test — must be published and within scheduling window
  const test = await prisma.test.findUnique({
    where: { id: testId, deletedAt: null },
    select: {
      id: true,
      status: true,
      durationMinutes: true,
      scheduledFrom: true,
      scheduledUntil: true,
      isFree: true,
      subscriptionInclusive: true,
      sections: {
        orderBy: { order: "asc" },
        select: {
          id: true,
          name: true,
          order: true,
          exam: true,
          subjectId: true,
          description: true,
          totalQuestions: true,
          requiredAttempts: true,
          testQuestions: {
            orderBy: { order: "asc" },
            select: {
              id: true,
              order: true,
              questionId: true,
              question: {
                select: {
                  id: true,
                  type: true,
                  difficulty: true,
                  content: true,
                  subject: { select: { id: true, name: true } },
                  chapter: { select: { id: true, name: true } },
                  topic: { select: { id: true, name: true } },
                  // NOTE: correctAnswer intentionally excluded — never sent to client
                },
              },
            },
          },
        },
      },
    },
  });

  if (!test) throw Errors.notFound("Test", ErrorCode.TEST_NOT_FOUND);
  if (test.status !== TestStatus.PUBLISHED) {
    throw Errors.business("This test is not available.", ErrorCode.TEST_NOT_PUBLISHED);
  }

  // Check scheduling window
  const now = new Date();
  if (test.scheduledFrom && now < test.scheduledFrom) {
    throw Errors.business("This test has not started yet.", ErrorCode.TEST_WINDOW_CLOSED);
  }
  if (test.scheduledUntil && now > test.scheduledUntil) {
    throw Errors.business("This test window has closed.", ErrorCode.TEST_WINDOW_CLOSED);
  }

  // 2. Check for existing attempt (one per user per test)
  const existing = await prisma.testAttempt.findUnique({
    where: { userId_testId: { userId, testId } },
    select: { id: true, status: true },
  });

  if (existing) {
    if (existing.status === AttemptStatus.IN_PROGRESS) {
      // Resume existing attempt — return current state
      return resumeAttempt(existing.id, userId, test as any);
    }
    throw Errors.conflict("You have already attempted this test.", ErrorCode.ALREADY_ATTEMPTED);
  }

  // 3. Create attempt + pre-populate answer rows for every question
  const allQuestions = test.sections.flatMap((s) => s.testQuestions);

  const attempt = await prisma.$transaction(async (tx) => {
    const newAttempt = await tx.testAttempt.create({
      data: {
        userId,
        testId,
        status: AttemptStatus.IN_PROGRESS,
        ipAddress: meta.ip,
        userAgent: meta.userAgent,
      },
    });

    // Pre-create answer rows so saving/tracking works without upserts
    await tx.attemptAnswer.createMany({
      data: allQuestions.map((tq) => ({
        attemptId: newAttempt.id,
        questionId: tq.questionId,
        testQuestionId: tq.id,
      })),
    });

    return newAttempt;
  });

  // 4. Cache in Redis for timer expiry tracking
  if (test.durationMinutes) {
    await cacheActiveAttempt(attempt.id, testId, attempt.startedAt, test.durationMinutes);
  }

  // Increment attempt counter on test (fire-and-forget)
  prisma.test.update({
    where: { id: testId },
    data: { totalAttempts: { increment: 1 } },
  }).catch((err) => log.warn({ err, testId }, "Failed to increment totalAttempts"));

  log.info({ attemptId: attempt.id, userId, testId }, "Attempt started");

  return buildAttemptPayload(attempt.id, attempt.startedAt, test);
}

// ── Resume ────────────────────────────────────────────────────────────────────

async function resumeAttempt(
  attemptId: string,
  userId: string,
  test: Awaited<ReturnType<typeof prisma.test.findUnique>> & { sections: unknown[] }
) {
  const attempt = await prisma.testAttempt.findUnique({
    where: { id: attemptId },
    select: { startedAt: true },
  });
  log.info({ attemptId, userId }, "Attempt resumed");
  return buildAttemptPayload(attemptId, attempt!.startedAt, test as any);
}

// ── Build attempt payload (start + resume) ────────────────────────────────────

async function buildAttemptPayload(
  attemptId: string,
  startedAt: Date,
  test: any
) {
  // Load saved answers for this attempt
  const savedAnswers = await prisma.attemptAnswer.findMany({
    where: { attemptId },
    select: {
      questionId: true,
      studentAnswer: true,
      isMarkedReview: true,
      isAttempted: true,
      timeSpentSeconds: true,
    },
  });

  const answerMap = Object.fromEntries(savedAnswers.map((a) => [a.questionId, a]));

  return {
    attemptId,
    testId: test.id,
    startedAt,
    durationMinutes: test.durationMinutes,
    sections: test.sections.map((section: any) => ({
      id: section.id,
      name: section.name,
      order: section.order,
      totalQuestions: section.totalQuestions,
      requiredAttempts: section.requiredAttempts,
      questions: section.testQuestions.map((tq: any) => ({
        testQuestionId: tq.id,
        order: tq.order,
        ...tq.question,
        // Merge in student's saved answer state
        studentAnswer: answerMap[tq.questionId]?.studentAnswer ?? null,
        isMarkedReview: answerMap[tq.questionId]?.isMarkedReview ?? false,
        isAttempted: answerMap[tq.questionId]?.isAttempted ?? false,
        timeSpentSeconds: answerMap[tq.questionId]?.timeSpentSeconds ?? 0,
      })),
    })),
  };
}

// ── Save Answer ───────────────────────────────────────────────────────────────

export async function saveAnswer(attemptId: string, userId: string, input: SaveAnswerInput) {
  await requireInProgress(attemptId, userId);

  const isAttempted = input.studentAnswer !== null;

  await prisma.attemptAnswer.updateMany({
    where: { attemptId, questionId: input.questionId },
    data: {
      studentAnswer: input.studentAnswer as Prisma.InputJsonValue ?? Prisma.JsonNull,
      isAttempted,
      isMarkedReview: input.isMarkedReview ?? undefined,
      timeSpentSeconds: input.timeSpentSeconds ?? undefined,
      lastSavedAt: new Date(),
      savedCount: { increment: 1 },
    },
  });

  return { saved: true };
}

// ── Mark for Review ───────────────────────────────────────────────────────────

export async function toggleMarkReview(attemptId: string, userId: string, input: MarkReviewInput) {
  await requireInProgress(attemptId, userId);

  await prisma.attemptAnswer.updateMany({
    where: { attemptId, questionId: input.questionId },
    data: { isMarkedReview: input.isMarkedReview },
  });

  return { isMarkedReview: input.isMarkedReview };
}

// ── Tab Switch Proctoring ─────────────────────────────────────────────────────

export async function recordTabSwitch(attemptId: string, userId: string, input: TabSwitchInput) {
  await requireInProgress(attemptId, userId);

  const shouldFlag = input.count >= TAB_SWITCH_FLAG_THRESHOLD;

  await prisma.testAttempt.update({
    where: { id: attemptId },
    data: {
      tabSwitchCount: input.count,
      ...(shouldFlag && {
        cheatFlag: true,
        cheatReason: `TAB_SWITCH_LIMIT:${input.count}`,
      }),
    },
  });

  log.warn({ attemptId, userId, count: input.count, flagged: shouldFlag }, "Tab switch recorded");

  return { flagged: shouldFlag, count: input.count };
}

// ── Submit Attempt ────────────────────────────────────────────────────────────

export async function submitAttempt(
  attemptId: string,
  userId: string,
  input: SubmitAttemptInput,
  status: AttemptStatus = AttemptStatus.SUBMITTED
) {
  const attempt = await requireInProgress(attemptId, userId);

  // Load all answers with question metadata needed for scoring
  const answers = await prisma.attemptAnswer.findMany({
    where: { attemptId },
    select: {
      questionId: true,
      studentAnswer: true,
      isAttempted: true,
      testQuestionId: true,
      question: {
        select: {
          type: true,
          correctAnswer: true,
        },
      },
    },
  });

  // Load section info for each testQuestion
  const testQuestions = await prisma.testQuestion.findMany({
    where: { testId: attempt.testId },
    select: {
      id: true,
      questionId: true,
      section: { select: { id: true, name: true } },
    },
  });
  const tqMap = Object.fromEntries(testQuestions.map((tq) => [tq.questionId, tq]));

  // Score every answer
  const scoredAnswers: ScoredAnswer[] = answers.map((ans) => {
    const result = scoreAnswer(
      ans.question.type as QuestionType,
      ans.question.correctAnswer,
      ans.studentAnswer
    );
    const tq = tqMap[ans.questionId];
    return {
      questionId: ans.questionId,
      sectionId: tq?.section.id ?? "unknown",
      sectionName: tq?.section.name ?? "Unknown",
      questionType: ans.question.type as QuestionType,
      correctAnswer: ans.question.correctAnswer,
      studentAnswer: ans.studentAnswer,
      ...result,
    };
  });

  const { aggregate, sectionScores } = aggregateResults(scoredAnswers);

  const timeSpent = input.timeSpentSeconds ??
    Math.floor((Date.now() - attempt.startedAt.getTime()) / 1000);

  // Persist scored answers + attempt result in a single transaction
  const updated = await prisma.$transaction(async (tx) => {
    // Update each answer with scoring result
    await Promise.all(
      scoredAnswers.map((ans) =>
        tx.attemptAnswer.updateMany({
          where: { attemptId, questionId: ans.questionId },
          data: {
            isCorrect: ans.isCorrect,
            isPartiallyCorrect: ans.isPartiallyCorrect,
            marksAwarded: new Prisma.Decimal(ans.marksAwarded),
          },
        })
      )
    );

    // Finalise attempt
    return tx.testAttempt.update({
      where: { id: attemptId },
      data: {
        status,
        submittedAt: new Date(),
        timeSpentSeconds: timeSpent,
        rawScore: new Prisma.Decimal(aggregate.rawScore),
        totalMarks: new Prisma.Decimal(aggregate.rawScore), // same for correct/wrong/unattempted
        correctCount: aggregate.correctCount,
        incorrectCount: aggregate.incorrectCount,
        unattemptedCount: aggregate.unattemptedCount,
        accuracyPct: new Prisma.Decimal(aggregate.accuracyPct.toFixed(2)),
        sectionScores: sectionScores as unknown as Prisma.InputJsonValue,
      },
      select: ATTEMPT_SUMMARY_SELECT,
    });
  });

  // Update leaderboard in Redis (sorted set by score desc)
  try {
    const redis = getRedis();
    await redis.zadd(
      RedisKeys.leaderboard(attempt.testId),
      aggregate.rawScore,
      userId
    );
  } catch (err) {
    log.warn({ err, attemptId }, "Failed to update Redis leaderboard");
  }

  // Clean up active attempt cache
  await safeRedisDel(RedisKeys.attemptAnswers(attemptId));

  log.info(
    { attemptId, userId, status, score: aggregate.rawScore, correct: aggregate.correctCount },
    "Attempt submitted"
  );

  // Return result with full answer review
  return buildResultPayload(updated, scoredAnswers);
}

// ── Auto-submit (timer expired) ───────────────────────────────────────────────

export async function autoSubmitAttempt(attemptId: string) {
  // Look up attempt without user auth (called by server timer)
  const attempt = await prisma.testAttempt.findUnique({
    where: { id: attemptId },
    select: { id: true, userId: true, testId: true, status: true, startedAt: true },
  });

  if (!attempt) {
    log.warn({ attemptId }, "Auto-submit: attempt not found");
    return;
  }
  if (attempt.status !== AttemptStatus.IN_PROGRESS) {
    log.info({ attemptId }, "Auto-submit: already submitted, skipping");
    return;
  }

  await submitAttempt(attemptId, attempt.userId, {}, AttemptStatus.AUTO_SUBMITTED);
  log.info({ attemptId }, "Attempt auto-submitted on timer expiry");
}

// ── Get Attempt Result ────────────────────────────────────────────────────────

export async function getAttemptResult(attemptId: string, userId: string) {
  const attempt = await requireAttempt(attemptId, userId);

  if (attempt.status === AttemptStatus.IN_PROGRESS) {
    throw Errors.business("Attempt is still in progress.", ErrorCode.ATTEMPT_IN_PROGRESS);
  }

  const [summary, answers] = await Promise.all([
    prisma.testAttempt.findUnique({
      where: { id: attemptId },
      select: ATTEMPT_SUMMARY_SELECT,
    }),
    prisma.attemptAnswer.findMany({
      where: { attemptId },
      select: {
        questionId: true,
        studentAnswer: true,
        isAttempted: true,
        isCorrect: true,
        isPartiallyCorrect: true,
        isMarkedReview: true,
        marksAwarded: true,
        timeSpentSeconds: true,
        question: {
          select: {
            id: true,
            type: true,
            content: true,
            correctAnswer: true,
            solution: true,
            difficulty: true,
            subject: { select: { id: true, name: true } },
            chapter: { select: { id: true, name: true } },
          },
        },
      },
    }),
  ]);

  return { ...summary, answers };
}

// ── List user's attempts ──────────────────────────────────────────────────────

export async function listUserAttempts(userId: string) {
  return prisma.testAttempt.findMany({
    where: { userId },
    select: {
      ...ATTEMPT_SUMMARY_SELECT,
      test: {
        select: { id: true, title: true, exam: true, type: true, totalQuestions: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

// ── Internal helper: build result payload ─────────────────────────────────────

function buildResultPayload(
  attempt: Prisma.TestAttemptGetPayload<{ select: typeof ATTEMPT_SUMMARY_SELECT }>,
  scoredAnswers: ScoredAnswer[]
) {
  return {
    attempt,
    summary: {
      score: attempt.rawScore,
      correctCount: attempt.correctCount,
      incorrectCount: attempt.incorrectCount,
      unattemptedCount: attempt.unattemptedCount,
      accuracyPct: attempt.accuracyPct,
      timeSpentSeconds: attempt.timeSpentSeconds,
      sectionScores: attempt.sectionScores,
    },
    answers: scoredAnswers.map((a) => ({
      questionId: a.questionId,
      sectionId: a.sectionId,
      isCorrect: a.isCorrect,
      isPartiallyCorrect: a.isPartiallyCorrect,
      isAttempted: a.isAttempted,
      marksAwarded: a.marksAwarded,
      correctAnswer: a.correctAnswer,
      studentAnswer: a.studentAnswer,
    })),
  };
}
