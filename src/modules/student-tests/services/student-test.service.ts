import { TestStatus, AttemptStatus, OrderStatus, OrderType, SubscriptionStatus, Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma";
import { Errors, ErrorCode } from "../../../utils/errors";
import { createLogger } from "../../../lib/logger";
import { parsePagination } from "../../../utils/pagination";
import { buildPaginationMeta } from "../../../utils/response";
import type { ListTestsQuery } from "../schemas/student-test.schema";

const log = createLogger("student-test-service");

// =============================================================================
// Student Test Listing Service
// Public / student-facing read operations — no mutation of tests.
// Admin CRUD for tests lives in the separate test-builder module.
// =============================================================================

// ── Access status ─────────────────────────────────────────────────────────────

export type TestAccessStatus = "FREE" | "SUBSCRIBED" | "PURCHASED" | "LOCKED" | "GUEST";

interface AccessInputTest {
  id: string;
  isFree: boolean;
  subscriptionInclusive: boolean;
}

// ── Shared select shapes ────────────────────────────────────────────────────

const TEST_CARD_SELECT = {
  id: true,
  title: true,
  description: true,
  exam: true,
  type: true,
  durationMinutes: true,
  isFree: true,
  price: true,
  subscriptionInclusive: true,
  totalQuestions: true,
  totalMarks: true,
  totalAttempts: true,
  tags: true,
  thumbnailUrl: true,
  scheduledFrom: true,
  scheduledUntil: true,
  publishedAt: true,
} satisfies Prisma.TestSelect;

const TEST_DETAIL_SELECT = {
  ...TEST_CARD_SELECT,
  instructions: true,
  sections: {
    orderBy: { order: "asc" as const },
    select: {
      id: true,
      name: true,
      order: true,
      exam: true,
      subjectId: true,
      description: true,
      totalQuestions: true,
      requiredAttempts: true,
      testQuestions: { select: { id: true } }, // used only for a per-section count
    },
  },
} satisfies Prisma.TestSelect;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function requirePublishedTest(testId: string) {
  const test = await prisma.test.findUnique({
    where: { id: testId, deletedAt: null },
    select: { id: true, status: true },
  });
  if (!test || test.status !== TestStatus.PUBLISHED) {
    throw Errors.notFound("Test", ErrorCode.TEST_NOT_FOUND);
  }
  return test;
}

// Returns whether the user currently has an active subscription
async function hasActiveSubscription(userId: string): Promise<boolean> {
  const subscription = await prisma.subscription.findUnique({
    where: { userId },
    select: { status: true, expiresAt: true },
  });
  if (!subscription) return false;
  return subscription.status === SubscriptionStatus.ACTIVE && subscription.expiresAt > new Date();
}

// Returns the set of testIds the user has individually purchased
async function getPurchasedTestIds(userId: string, testIds?: string[]): Promise<Set<string>> {
  const orders = await prisma.order.findMany({
    where: {
      userId,
      type: OrderType.TEST_PURCHASE,
      status: OrderStatus.SUCCESS,
      testId: testIds ? { in: testIds } : { not: null },
    },
    select: { testId: true },
  });
  return new Set(orders.map((o) => o.testId as string));
}

// Computes access status for a batch of tests for a single user (or guest)
async function computeAccessMap(
  tests: AccessInputTest[],
  userId: string | null
): Promise<Map<string, TestAccessStatus>> {
  const accessMap = new Map<string, TestAccessStatus>();

  if (!userId) {
    for (const t of tests) {
      accessMap.set(t.id, t.isFree ? "FREE" : "GUEST");
    }
    return accessMap;
  }

  const [hasSub, purchasedIds] = await Promise.all([
    hasActiveSubscription(userId),
    getPurchasedTestIds(
      userId,
      tests.map((t) => t.id)
    ),
  ]);

  for (const t of tests) {
    if (t.isFree) {
      accessMap.set(t.id, "FREE");
    } else if (t.subscriptionInclusive && hasSub) {
      accessMap.set(t.id, "SUBSCRIBED");
    } else if (purchasedIds.has(t.id)) {
      accessMap.set(t.id, "PURCHASED");
    } else {
      accessMap.set(t.id, "LOCKED");
    }
  }

  return accessMap;
}

// ── Browse ───────────────────────────────────────────────────────────────────

export async function browseTests(query: ListTestsQuery, userId: string | null) {
  const { page, pageSize, skip, take } = parsePagination(query.page, query.pageSize);

  const where: Prisma.TestWhereInput = {
    deletedAt: null,
    status: TestStatus.PUBLISHED,
    ...(query.exam && { exam: query.exam }),
    ...(query.type && { type: query.type }),
    ...(query.free !== undefined && { isFree: query.free }),
    ...(query.search && {
      OR: [
        { title: { contains: query.search, mode: "insensitive" } },
        { description: { contains: query.search, mode: "insensitive" } },
        { tags: { has: query.search } },
      ],
    }),
  };

  const [tests, total] = await Promise.all([
    prisma.test.findMany({
      where,
      select: TEST_CARD_SELECT,
      orderBy: { [query.sortBy]: query.sortOrder },
      skip,
      take,
    }),
    prisma.test.count({ where }),
  ]);

  const accessMap = await computeAccessMap(tests, userId);
  const withAccess = tests.map((t) => ({ ...t, access: accessMap.get(t.id)! }));

  log.debug({ userId, count: tests.length, total }, "Browsed tests");
  return { tests: withAccess, pagination: buildPaginationMeta(total, page, pageSize) };
}

// ── My tests ─────────────────────────────────────────────────────────────────

export async function getMyTests(userId: string) {
  const [hasSub, purchasedIds] = await Promise.all([
    hasActiveSubscription(userId),
    getPurchasedTestIds(userId),
  ]);

  const where: Prisma.TestWhereInput = {
    deletedAt: null,
    status: TestStatus.PUBLISHED,
    OR: [
      { isFree: true },
      ...(hasSub ? [{ subscriptionInclusive: true }] : []),
      ...(purchasedIds.size > 0 ? [{ id: { in: Array.from(purchasedIds) } }] : []),
    ],
  };

  const tests = await prisma.test.findMany({
    where,
    select: TEST_CARD_SELECT,
    orderBy: { publishedAt: "desc" },
  });

  const accessMap = await computeAccessMap(tests, userId);
  const withAccess = tests.map((t) => ({ ...t, access: accessMap.get(t.id)! }));

  log.debug({ userId, count: withAccess.length }, "Fetched my tests");
  return withAccess;
}

// ── Single test detail ────────────────────────────────────────────────────────

export async function getTestDetail(testId: string, userId: string | null) {
  await requirePublishedTest(testId);

  const test = await prisma.test.findUnique({
    where: { id: testId },
    select: TEST_DETAIL_SELECT,
  });
  if (!test) throw Errors.notFound("Test", ErrorCode.TEST_NOT_FOUND);

  const accessMap = await computeAccessMap([test], userId);

  const sections = test.sections.map(({ testQuestions, ...section }) => ({
    ...section,
    questionCount: testQuestions.length,
  }));

  log.debug({ testId, userId }, "Fetched test detail");
  return { ...test, sections, access: accessMap.get(test.id)! };
}

// ── My attempt summary for a test ────────────────────────────────────────────

export async function getTestAttemptSummary(testId: string, userId: string) {
  await requirePublishedTest(testId);

  const attempt = await prisma.testAttempt.findUnique({
    where: { userId_testId: { userId, testId } },
    select: {
      id: true,
      status: true,
      startedAt: true,
      submittedAt: true,
      rawScore: true,
      totalMarks: true,
      correctCount: true,
      incorrectCount: true,
      unattemptedCount: true,
      accuracyPct: true,
      rank: true,
      percentile: true,
    },
  });

  if (!attempt) {
    return { hasAttempted: false, action: "START" as const, attempt: null };
  }

  const isInProgress = attempt.status === AttemptStatus.IN_PROGRESS;

  return {
    hasAttempted: true,
    action: isInProgress ? ("RESUME" as const) : ("VIEW_RESULTS" as const),
    attempt,
  };
}
