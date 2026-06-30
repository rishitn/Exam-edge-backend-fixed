import { SubscriptionStatus, Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma";
import { Errors, ErrorCode } from "../../../utils/errors";
import { createLogger } from "../../../lib/logger";
import type {
  CreatePlanInput,
  UpdatePlanInput,
  GrantSubscriptionInput,
  CancelSubscriptionInput,
  ListSubscriptionsQuery,
} from "../schemas/subscription.schema";

const log = createLogger("subscription-service");

// =============================================================================
// Shared select shapes
// =============================================================================

const PLAN_SELECT = {
  id: true,
  name: true,
  description: true,
  durationDays: true,
  price: true,
  originalPrice: true,
  isActive: true,
  isPopular: true,
  features: true,
  razorpayPlanId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SubscriptionPlanSelect;

const SUBSCRIPTION_SELECT = {
  id: true,
  userId: true,
  status: true,
  startedAt: true,
  expiresAt: true,
  cancelledAt: true,
  cancelReason: true,
  createdAt: true,
  plan: {
    select: {
      id: true,
      name: true,
      durationDays: true,
      price: true,
    },
  },
} satisfies Prisma.SubscriptionSelect;

// =============================================================================
// PLANS — Public & Admin
// =============================================================================

// List all active plans (public / student-facing)
export async function listActivePlans() {
  return prisma.subscriptionPlan.findMany({
    where: { isActive: true },
    orderBy: [{ isPopular: "desc" }, { price: "asc" }],
    select: PLAN_SELECT,
  });
}

// List all plans including inactive (admin-facing)
export async function listAllPlans() {
  return prisma.subscriptionPlan.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      ...PLAN_SELECT,
      _count: { select: { subscriptions: true } },
    },
  });
}

// Get single plan by ID
export async function getPlanById(planId: string) {
  const plan = await prisma.subscriptionPlan.findUnique({
    where: { id: planId },
    select: {
      ...PLAN_SELECT,
      _count: { select: { subscriptions: true } },
    },
  });
  if (!plan) throw Errors.notFound("Subscription plan", ErrorCode.NOT_FOUND);
  return plan;
}

// Create plan (super admin)
export async function createPlan(adminId: string, input: CreatePlanInput) {
  const plan = await prisma.subscriptionPlan.create({
    data: {
      name: input.name,
      description: input.description,
      durationDays: input.durationDays,
      price: new Prisma.Decimal(input.price),
      originalPrice: input.originalPrice
        ? new Prisma.Decimal(input.originalPrice)
        : undefined,
      isActive: input.isActive,
      isPopular: input.isPopular,
      features: input.features ?? Prisma.JsonNull,
      razorpayPlanId: input.razorpayPlanId,
      createdById: adminId,
    },
    select: PLAN_SELECT,
  });

  log.info({ planId: plan.id, adminId }, "Subscription plan created");
  return plan;
}

// Update plan (super admin)
export async function updatePlan(planId: string, input: UpdatePlanInput) {
  // Verify plan exists
  await getPlanById(planId);

  const plan = await prisma.subscriptionPlan.update({
    where: { id: planId },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.durationDays !== undefined && { durationDays: input.durationDays }),
      ...(input.price !== undefined && { price: new Prisma.Decimal(input.price) }),
      ...(input.originalPrice !== undefined && {
        originalPrice: new Prisma.Decimal(input.originalPrice),
      }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
      ...(input.isPopular !== undefined && { isPopular: input.isPopular }),
      ...(input.features !== undefined && { features: input.features }),
      ...(input.razorpayPlanId !== undefined && {
        razorpayPlanId: input.razorpayPlanId,
      }),
    },
    select: PLAN_SELECT,
  });

  log.info({ planId }, "Subscription plan updated");
  return plan;
}

// Toggle plan active status (super admin)
export async function togglePlanStatus(planId: string) {
  const plan = await getPlanById(planId);
  const updated = await prisma.subscriptionPlan.update({
    where: { id: planId },
    data: { isActive: !plan.isActive },
    select: PLAN_SELECT,
  });
  log.info({ planId, isActive: updated.isActive }, "Plan status toggled");
  return updated;
}

// =============================================================================
// SUBSCRIPTIONS — Student-facing
// =============================================================================

// Get the current user's subscription
export async function getMySubscription(userId: string) {
  const sub = await prisma.subscription.findUnique({
    where: { userId },
    select: {
      ...SUBSCRIPTION_SELECT,
      grantedById: true,
    },
  });

  if (!sub) return null;

  // Auto-expire: if past expiresAt but still marked ACTIVE, fix it in-place
  if (sub.status === SubscriptionStatus.ACTIVE && sub.expiresAt < new Date()) {
    await prisma.subscription.update({
      where: { userId },
      data: { status: SubscriptionStatus.EXPIRED },
    });
    return { ...sub, status: SubscriptionStatus.EXPIRED };
  }

  return sub;
}

// Check whether a user has an active subscription (used by other services)
export async function hasActiveSubscription(userId: string): Promise<boolean> {
  const sub = await prisma.subscription.findUnique({
    where: { userId },
    select: { status: true, expiresAt: true },
  });
  return (
    sub !== null &&
    sub.status === SubscriptionStatus.ACTIVE &&
    sub.expiresAt > new Date()
  );
}

// Cancel subscription (student request — marks as CANCELLED, doesn't delete)
export async function cancelMySubscription(
  userId: string,
  input: CancelSubscriptionInput
) {
  const sub = await prisma.subscription.findUnique({
    where: { userId },
    select: { id: true, status: true, expiresAt: true },
  });

  if (!sub) throw Errors.notFound("Subscription", ErrorCode.NOT_FOUND);

  if (sub.status !== SubscriptionStatus.ACTIVE) {
    throw Errors.business(
      "Only an active subscription can be cancelled",
      ErrorCode.INVALID_INPUT
    );
  }

  const updated = await prisma.subscription.update({
    where: { userId },
    data: {
      status: SubscriptionStatus.CANCELLED,
      cancelledAt: new Date(),
      cancelReason: input.reason,
    },
    select: SUBSCRIPTION_SELECT,
  });

  log.info({ userId }, "Subscription cancelled by user");
  return updated;
}

// =============================================================================
// SUBSCRIPTIONS — Admin-facing
// =============================================================================

// List all subscriptions with filters (admin)
export async function listSubscriptions(query: ListSubscriptionsQuery) {
  const { page, pageSize, status, search } = query;

  const where: Prisma.SubscriptionWhereInput = {
    ...(status && { status: status as SubscriptionStatus }),
    ...(search && {
      user: {
        OR: [
          { email: { contains: search, mode: "insensitive" } },
          { name: { contains: search, mode: "insensitive" } },
        ],
      },
    }),
  };

  const [subscriptions, total] = await Promise.all([
    prisma.subscription.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        ...SUBSCRIPTION_SELECT,
        user: {
          select: { id: true, name: true, email: true, mobile: true },
        },
        grantedById: true,
      },
    }),
    prisma.subscription.count({ where }),
  ]);

  return { subscriptions, total };
}

// Get a specific user's subscription (admin)
export async function getUserSubscription(userId: string) {
  // Verify user exists
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true },
  });
  if (!user) throw Errors.notFound("User", ErrorCode.USER_NOT_FOUND);

  const sub = await prisma.subscription.findUnique({
    where: { userId },
    select: {
      ...SUBSCRIPTION_SELECT,
      grantedById: true,
    },
  });

  return { user, subscription: sub };
}

// Grant subscription manually (super admin — e.g. for scholarships, support)
export async function grantSubscription(
  adminId: string,
  input: GrantSubscriptionInput
) {
  // Verify plan exists and is active
  const plan = await prisma.subscriptionPlan.findUnique({
    where: { id: input.planId },
    select: { id: true, durationDays: true, isActive: true },
  });
  if (!plan || !plan.isActive) {
    throw Errors.notFound("Subscription plan", ErrorCode.NOT_FOUND);
  }

  // Verify user exists
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true },
  });
  if (!user) throw Errors.notFound("User", ErrorCode.USER_NOT_FOUND);

  const durationDays = input.durationDays ?? plan.durationDays;
  const now = new Date();
  const expiresAt = new Date(now);
  expiresAt.setDate(expiresAt.getDate() + durationDays);

  // Upsert — overrides any existing subscription
  const sub = await prisma.subscription.upsert({
    where: { userId: input.userId },
    create: {
      userId: input.userId,
      planId: input.planId,
      status: SubscriptionStatus.ACTIVE,
      startedAt: now,
      expiresAt,
      grantedById: adminId,
    },
    update: {
      planId: input.planId,
      status: SubscriptionStatus.ACTIVE,
      startedAt: now,
      expiresAt,
      cancelledAt: null,
      cancelReason: null,
      grantedById: adminId,
    },
    select: SUBSCRIPTION_SELECT,
  });

  log.info(
    { userId: input.userId, planId: input.planId, adminId, durationDays },
    "Subscription granted by admin"
  );
  return sub;
}

// Revoke subscription (super admin)
export async function revokeSubscription(adminId: string, userId: string) {
  const sub = await prisma.subscription.findUnique({
    where: { userId },
    select: { id: true, status: true },
  });

  if (!sub) throw Errors.notFound("Subscription", ErrorCode.NOT_FOUND);

  if (sub.status !== SubscriptionStatus.ACTIVE) {
    throw Errors.business(
      "Subscription is not active",
      ErrorCode.INVALID_INPUT
    );
  }

  const updated = await prisma.subscription.update({
    where: { userId },
    data: {
      status: SubscriptionStatus.CANCELLED,
      cancelledAt: new Date(),
      cancelReason: "Revoked by admin",
    },
    select: SUBSCRIPTION_SELECT,
  });

  log.info({ userId, adminId }, "Subscription revoked by admin");
  return updated;
}

// Subscription stats for dashboard (admin)
export async function getSubscriptionStats() {
  const now = new Date();

  const [active, expired, cancelled, expiringIn7Days, revenue] =
    await Promise.all([
      prisma.subscription.count({ where: { status: SubscriptionStatus.ACTIVE } }),
      prisma.subscription.count({ where: { status: SubscriptionStatus.EXPIRED } }),
      prisma.subscription.count({ where: { status: SubscriptionStatus.CANCELLED } }),
      prisma.subscription.count({
        where: {
          status: SubscriptionStatus.ACTIVE,
          expiresAt: {
            gte: now,
            lte: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
          },
        },
      }),
      prisma.order.aggregate({
        where: { type: "SUBSCRIPTION", status: "SUCCESS" },
        _sum: { finalAmount: true },
      }),
    ]);

  return {
    active,
    expired,
    cancelled,
    expiringIn7Days,
    totalRevenue: revenue._sum.finalAmount ?? new Prisma.Decimal(0),
  };
}
