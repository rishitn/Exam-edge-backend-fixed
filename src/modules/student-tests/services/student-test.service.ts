import { TestStatus, OrderStatus, OrderType, SubscriptionStatus, Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma";
import { Errors, ErrorCode } from "../../../utils/errors";
import { parsePagination } from "../../../utils/pagination";
import { buildPaginationMeta } from "../../../utils/response";
import { createLogger } from "../../../lib/logger";
import type { ListTestsQuery } from "../schemas/student-test.schema";

const log = createLogger("student-test-service");

// =============================================================================
// Select shapes — only expose fields students need.
// Sensitive admin fields (randomizeOptions, draft info, creator) are omitted.
// =============================================================================

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
  avgScore: true,
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
    where: { deletedAt: null },
    orderBy: { order: "asc" as const },
    select: {
      id: true,
      name: true,
      order: true,
      exam: true,
      description: true,
      timeLimitMinutes: true,
      totalQuestions: true,
      requiredAttempts: true,
    },
  },
} satisfies Prisma.TestSelect;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Check whether a student has purchased a specific test (paid, non-subscription route).
 */
async function hasTestPurchase(userId: string, testId: string): Promise<boolean> {
  const order = await prisma.order.findFirst({
    where: {
      userId,
      testId,
      type: OrderType.TEST_PURCHASE,
      status: OrderStatus.SUCCESS,
    },
    select: { id: true },
  });
  return order !== null;
}

/**
 * Check whether a student has an active subscription right now.
 */
async function hasActiveSubscription(userId: string): Promise<boolean> {
  const now = new Date();
  const sub = await prisma.subscription.findFirst({
    where: {
      userId,
      status: SubscriptionStatus.ACTIVE,
      expiresAt: { gt: now },
    },
    select: { id: true },
  });
  return sub !== null;
}

/**
 * Resolve what access status a student has for a given test object.
 *
 * Returns one of:
 *   "free"         — no payment required
 *   "subscribed"   — user has active subscription and test is subscription-inclusive
 *   "purchased"    — user has a direct order for this test
 *   "locked"       — user must pay or subscribe
 *   "guest"        — not logged in; always locked on paid tests
 */
type AccessStatus = "free" | "subscribed" | "purchased" | "locked" | "guest";

async function resolveAccess(
  test: { id: string; isFree: boolean; subscriptionInclusive: boolean },
  userId: string | null
): Promise<AccessStatus> {
  if (test.isFree) return "free";

  if (!userId) return "guest";

  // Check subscription first (cheaper — single row lookup)
  if (test.subscriptionInclusive && await hasActiveSubscription(userId)) {
    return "subscribed";
  }

  // Check direct purchase
  if (await hasTestPurchase(userId, test.id)) {
    return "purchased";
  }

  return "locked";
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Browse published tests.
 * Available to guests and authenticated students alike.
 * Access status is included per test when userId is provided.
 */
export async function browseTests(query: ListTestsQuery, userId: string | null) {
  const { page, pageSize, skip, take } = parsePagination(query.page, query.pageSize);

  const now = new Date();

  const where: Prisma.TestWhereInput = {
    status: TestStatus.PUBLISHED,
    deletedAt: null,
    // Only show tests within their scheduling window (or unscheduled)
    OR: [
      { scheduledFrom: null },
      {
        scheduledFrom: { lte: now },
        OR: [
          { scheduledUntil: null },
          { scheduledUntil: { gte: now } },
        ],
      },
    ],
    ...(query.exam && { exam: query.exam }),
    ...(query.type && { type: query.type }),
    ...(query.free === true && { isFree: true }),
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

  // Resolve per-test access status in parallel when user is logged in
  let testsWithAccess;
  if (userId) {
    const [subscribed, purchasedTestIds] = await Promise.all([
      hasActiveSubscription(userId),
      // Batch-fetch all purchased test IDs in this page to avoid N+1
      prisma.order.findMany({
        where: {
          userId,
          testId: { in: tests.map((t) => t.id) },
          type: OrderType.TEST_PURCHASE,
          status: OrderStatus.SUCCESS,
        },
        select: { testId: true },
      }).then((rows) => new Set(rows.map((r) => r.testId))),
    ]);

    testsWithAccess = tests.map((test) => {
      let access: AccessStatus;
      if (test.isFree) {
        access = "free";
      } else if (test.subscriptionInclusive && subscribed) {
        access = "subscribed";
      } else if (purchasedTestIds.has(test.id)) {
        access = "purchased";
      } else {
        access = "locked";
      }
      return { ...test, access };
    });
  } else {
    testsWithAccess = tests.map((test) => ({
      ...test,
      access: (test.isFree ? "free" : "guest") as AccessStatus,
    }));
  }

  log.debug({ total, page, pageSize, userId }, "browseTests");

  return {
    tests: testsWithAccess,
    pagination: buildPaginationMeta(total, page, pageSize),
  };
}

/**
 * Get full detail for a single published test.
 * Includes sections (without question content — that's the attempt engine's job).
 * Also returns the student's access status.
 */
export async function getTestDetail(testId: string, userId: string | null) {
  const now = new Date();

  const test = await prisma.test.findFirst({
    where: {
      id: testId,
      status: TestStatus.PUBLISHED,
      deletedAt: null,
      OR: [
        { scheduledFrom: null },
        {
          scheduledFrom: { lte: now },
          OR: [
            { scheduledUntil: null },
            { scheduledUntil: { gte: now } },
          ],
        },
      ],
    },
    select: TEST_DETAIL_SELECT,
  });

  if (!test) {
    throw Errors.notFound("Test not found", ErrorCode.TEST_NOT_FOUND);
  }

  // Extract only the fields needed by resolveAccess to avoid type mismatch
  const access = await resolveAccess({
    id: test.id,
    isFree: test.isFree,
    subscriptionInclusive: test.subscriptionInclusive,
  }, userId);

  log.debug({ testId, userId, access }, "getTestDetail");

  return { ...test, access };
}

/**
 * Return the list of tests the authenticated student can currently access
 * (free tests + subscription-inclusive tests if subscribed + individually purchased tests).
 * Useful for "My Tests" / dashboard view.
 */
export async function getMyTests(userId: string) {
  const now = new Date();

  const [subscribed, purchasedOrders] = await Promise.all([
    hasActiveSubscription(userId),
    prisma.order.findMany({
      where: {
        userId,
        type: OrderType.TEST_PURCHASE,
        status: OrderStatus.SUCCESS,
        test: { status: TestStatus.PUBLISHED, deletedAt: null },
      },
      select: { testId: true },
    }),
  ]);

  const purchasedTestIds = purchasedOrders.map((o) => o.testId).filter(Boolean) as string[];

  // Build OR conditions for accessible tests
  const accessConditions: Prisma.TestWhereInput[] = [
    { isFree: true },
    ...(purchasedTestIds.length > 0 ? [{ id: { in: purchasedTestIds } }] : []),
    ...(subscribed ? [{ subscriptionInclusive: true }] : []),
  ];

  const tests = await prisma.test.findMany({
    where: {
      status: TestStatus.PUBLISHED,
      deletedAt: null,
      AND: [
        {
          OR: [
            { scheduledFrom: null },
            {
              scheduledFrom: { lte: now },
              OR: [
                { scheduledUntil: null },
                { scheduledUntil: { gte: now } },
              ],
            },
          ],
        },
        { OR: accessConditions },
      ],
    },
    select: TEST_CARD_SELECT,
    orderBy: { publishedAt: "desc" },
  });

  // Tag each test with why the student has access
  const taggedTests = tests.map((test) => {
    let access: AccessStatus;
    if (test.isFree) {
      access = "free";
    } else if (test.subscriptionInclusive && subscribed) {
      access = "subscribed";
    } else {
      access = "purchased"; // Must be in purchasedTestIds then
    }
    return { ...test, access };
  });

  log.debug({ userId, count: taggedTests.length, subscribed }, "getMyTests");

  return taggedTests;
}

/**
 * Return how many attempts a student has made on a specific test,
 * and whether they have a completed result.
 * Used to drive "Start Test" vs "Resume" vs "View Results" CTAs.
 */
export async function getTestAttemptSummary(testId: string, userId: string) {
  const attempts = await prisma.testAttempt.findMany({
    where: { testId, userId },
    select: {
      id: true,
      status: true,
      score: true,
      percentile: true,
      startedAt: true,
      submittedAt: true,
    },
    orderBy: { startedAt: "desc" },
  });

  const inProgress = attempts.find((a) => a.status === "IN_PROGRESS") ?? null;
  const completed = attempts.filter((a) => a.status !== "IN_PROGRESS");

  return {
    totalAttempts: attempts.length,
    inProgressAttemptId: inProgress?.id ?? null,
    completedAttempts: completed,
  };
}
