import {
  CouponStatus,
  CouponApplicability,
  DiscountType,
  OrderType,
  Prisma,
} from "@prisma/client";
import { prisma } from "../../../lib/prisma";
import { Errors, ErrorCode } from "../../../utils/errors";
import { createLogger } from "../../../lib/logger";
import type {
  CreateCouponInput,
  UpdateCouponInput,
  ListCouponsQuery,
  ValidateCouponInput,
} from "../schemas/coupon.schema";

const log = createLogger("coupon-service");

// =============================================================================
// Shared select shape
// =============================================================================

const COUPON_SELECT = {
  id: true,
  code: true,
  description: true,
  discountType: true,
  discountValue: true,
  maxDiscountINR: true,
  applicableTo: true,
  status: true,
  maxUses: true,
  usedCount: true,
  perUserLimit: true,
  validFrom: true,
  validUntil: true,
  minOrderValue: true,
  createdAt: true,
  updatedAt: true,
  specificTests: {
    select: {
      test: { select: { id: true, title: true } },
    },
  },
  createdBy: { select: { id: true, name: true, email: true } },
} satisfies Prisma.CouponSelect;

// =============================================================================
// Admin — CRUD
// =============================================================================

export async function createCoupon(adminId: string, input: CreateCouponInput) {
  // ── Check code uniqueness ──────────────────────────────────────────────────
  const existing = await prisma.coupon.findUnique({
    where: { code: input.code },
    select: { id: true },
  });
  if (existing) {
    throw Errors.conflict(
      `Coupon code "${input.code}" already exists`,
      ErrorCode.CONFLICT
    );
  }

  // ── Validate testIds exist when SPECIFIC_TEST ──────────────────────────────
  if (
    input.applicableTo === "SPECIFIC_TEST" &&
    input.testIds &&
    input.testIds.length > 0
  ) {
    const foundTests = await prisma.test.findMany({
      where: { id: { in: input.testIds } },
      select: { id: true },
    });
    if (foundTests.length !== input.testIds.length) {
      throw Errors.badRequest(
        "One or more testIds are invalid",
        ErrorCode.INVALID_INPUT
      );
    }
  }

  const coupon = await prisma.coupon.create({
    data: {
      code: input.code,
      description: input.description,
      discountType: input.discountType as DiscountType,
      discountValue: new Prisma.Decimal(input.discountValue),
      maxDiscountINR: input.maxDiscountINR
        ? new Prisma.Decimal(input.maxDiscountINR)
        : null,
      applicableTo: input.applicableTo as CouponApplicability,
      maxUses: input.maxUses ?? null,
      perUserLimit: input.perUserLimit,
      validFrom: input.validFrom ?? new Date(),
      validUntil: input.validUntil ?? null,
      minOrderValue: input.minOrderValue
        ? new Prisma.Decimal(input.minOrderValue)
        : null,
      createdById: adminId,
      // Create CouponTest join rows for specific tests
      specificTests:
        input.applicableTo === "SPECIFIC_TEST" && input.testIds
          ? {
              create: input.testIds.map((testId) => ({ testId })),
            }
          : undefined,
    },
    select: COUPON_SELECT,
  });

  log.info({ couponId: coupon.id, code: coupon.code, adminId }, "Coupon created");
  return coupon;
}

export async function listCoupons(query: ListCouponsQuery) {
  const { page, pageSize, status, search, applicableTo } = query;
  const now = new Date();

  // Auto-expire coupons whose validUntil has passed — bulk update
  await prisma.coupon.updateMany({
    where: {
      status: CouponStatus.ACTIVE,
      validUntil: { lt: now },
    },
    data: { status: CouponStatus.EXPIRED },
  });

  const where: Prisma.CouponWhereInput = {
    ...(status && { status: status as CouponStatus }),
    ...(applicableTo && {
      applicableTo: applicableTo as CouponApplicability,
    }),
    ...(search && {
      OR: [
        { code: { contains: search.toUpperCase() } },
        { description: { contains: search, mode: "insensitive" } },
      ],
    }),
  };

  const [coupons, total] = await Promise.all([
    prisma.coupon.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: COUPON_SELECT,
    }),
    prisma.coupon.count({ where }),
  ]);

  return { coupons, total };
}

export async function getCouponById(couponId: string) {
  const coupon = await prisma.coupon.findUnique({
    where: { id: couponId },
    select: {
      ...COUPON_SELECT,
      _count: { select: { usages: true, orders: true } },
    },
  });
  if (!coupon) throw Errors.notFound("Coupon", ErrorCode.NOT_FOUND);
  return coupon;
}

export async function updateCoupon(couponId: string, input: UpdateCouponInput) {
  await getCouponById(couponId); // existence check

  const coupon = await prisma.coupon.update({
    where: { id: couponId },
    data: {
      ...(input.description !== undefined && { description: input.description }),
      ...(input.maxUses !== undefined && { maxUses: input.maxUses }),
      ...(input.perUserLimit !== undefined && { perUserLimit: input.perUserLimit }),
      ...(input.validUntil !== undefined && { validUntil: input.validUntil }),
      ...(input.minOrderValue !== undefined && {
        minOrderValue:
          input.minOrderValue !== null
            ? new Prisma.Decimal(input.minOrderValue)
            : null,
      }),
      ...(input.maxDiscountINR !== undefined && {
        maxDiscountINR:
          input.maxDiscountINR !== null
            ? new Prisma.Decimal(input.maxDiscountINR)
            : null,
      }),
    },
    select: COUPON_SELECT,
  });

  log.info({ couponId }, "Coupon updated");
  return coupon;
}

export async function toggleCouponStatus(couponId: string) {
  const coupon = await getCouponById(couponId);

  // Can't re-activate an expired coupon — admin must update validUntil first
  if (coupon.status === CouponStatus.EXPIRED) {
    throw Errors.business(
      "Cannot activate an expired coupon — update validUntil first",
      ErrorCode.INVALID_INPUT
    );
  }

  const newStatus =
    coupon.status === CouponStatus.ACTIVE
      ? CouponStatus.INACTIVE
      : CouponStatus.ACTIVE;

  const updated = await prisma.coupon.update({
    where: { id: couponId },
    data: { status: newStatus },
    select: COUPON_SELECT,
  });

  log.info({ couponId, status: newStatus }, "Coupon status toggled");
  return updated;
}

export async function deleteCoupon(couponId: string) {
  const coupon = await getCouponById(couponId);

  // Prevent deleting coupons that have been used — deactivate instead
  if (coupon.usedCount > 0) {
    throw Errors.business(
      "Cannot delete a coupon that has been used. Deactivate it instead.",
      ErrorCode.INVALID_INPUT
    );
  }

  await prisma.coupon.delete({ where: { id: couponId } });
  log.info({ couponId }, "Coupon deleted");
}

export async function getCouponUsages(couponId: string, page: number, pageSize: number) {
  await getCouponById(couponId); // existence check

  const [usages, total] = await Promise.all([
    prisma.couponUsage.findMany({
      where: { couponId },
      orderBy: { usedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        usedAt: true,
        user: { select: { id: true, name: true, email: true } },
        order: {
          select: {
            id: true,
            finalAmount: true,
            discountAmount: true,
            status: true,
            type: true,
          },
        },
      } as any,
    }),
    prisma.couponUsage.count({ where: { couponId } }),
  ]);

  return { usages, total };
}

// Coupon stats for dashboard
export async function getCouponStats() {
  const now = new Date();

  const [active, inactive, expired, totalSavings] = await Promise.all([
    prisma.coupon.count({ where: { status: CouponStatus.ACTIVE } }),
    prisma.coupon.count({ where: { status: CouponStatus.INACTIVE } }),
    prisma.coupon.count({ where: { status: CouponStatus.EXPIRED } }),
    prisma.order.aggregate({
      where: { status: "SUCCESS", discountAmount: { gt: 0 } },
      _sum: { discountAmount: true },
    }),
  ]);

  // Top 5 most used coupons
  const topCoupons = await prisma.coupon.findMany({
    where: { usedCount: { gt: 0 } },
    orderBy: { usedCount: "desc" },
    take: 5,
    select: { id: true, code: true, usedCount: true, discountType: true, discountValue: true },
  });

  return {
    active,
    inactive,
    expired,
    totalSavingsGranted: totalSavings._sum.discountAmount ?? new Prisma.Decimal(0),
    topCoupons,
  };
}

// =============================================================================
// Student — validate a coupon code before checkout
// Returns the discount amount so the frontend can show a preview
// Does NOT apply or consume the coupon — that happens at order creation
// =============================================================================

export async function validateCoupon(userId: string, input: ValidateCouponInput) {
  const now = new Date();
  const originalAmount = new Prisma.Decimal(input.originalAmount);

  const coupon = await prisma.coupon.findUnique({
    where: { code: input.code },
    include: { specificTests: true },
  });

  // ── Existence & status ─────────────────────────────────────────────────────
  if (!coupon || coupon.status !== CouponStatus.ACTIVE) {
    throw Errors.badRequest("Invalid or inactive coupon code", ErrorCode.INVALID_COUPON);
  }

  // ── Date validity ──────────────────────────────────────────────────────────
  if (coupon.validFrom > now) {
    throw Errors.badRequest("Coupon is not yet active", ErrorCode.INVALID_COUPON);
  }
  if (coupon.validUntil && coupon.validUntil < now) {
    throw Errors.badRequest("Coupon has expired", ErrorCode.COUPON_EXPIRED);
  }

  // ── Global usage limit ─────────────────────────────────────────────────────
  if (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses) {
    throw Errors.badRequest("Coupon usage limit reached", ErrorCode.COUPON_USAGE_LIMIT);
  }

  // ── Per-user limit ─────────────────────────────────────────────────────────
  const userUsageCount = await prisma.couponUsage.count({
    where: { couponId: coupon.id, userId },
  });
  if (userUsageCount >= coupon.perUserLimit) {
    throw Errors.badRequest(
      "You have already used this coupon the maximum number of times",
      ErrorCode.COUPON_USAGE_LIMIT
    );
  }

  // ── Applicability ──────────────────────────────────────────────────────────
  const orderType =
    input.orderType === "TEST_PURCHASE" ? OrderType.TEST_PURCHASE : OrderType.SUBSCRIPTION;

  const applicable =
    coupon.applicableTo === CouponApplicability.ALL ||
    (coupon.applicableTo === CouponApplicability.ALL_TESTS &&
      orderType === OrderType.TEST_PURCHASE) ||
    (coupon.applicableTo === CouponApplicability.SUBSCRIPTION &&
      orderType === OrderType.SUBSCRIPTION) ||
    (coupon.applicableTo === CouponApplicability.SPECIFIC_TEST &&
      orderType === OrderType.TEST_PURCHASE &&
      input.testId !== undefined &&
      coupon.specificTests.some((ct) => ct.testId === input.testId));

  if (!applicable) {
    throw Errors.badRequest(
      "This coupon is not applicable to your purchase",
      ErrorCode.COUPON_NOT_APPLICABLE
    );
  }

  // ── Minimum order value ────────────────────────────────────────────────────
  if (coupon.minOrderValue !== null && originalAmount.lessThan(coupon.minOrderValue)) {
    throw Errors.badRequest(
      `Minimum order value for this coupon is ₹${coupon.minOrderValue}`,
      ErrorCode.INVALID_COUPON
    );
  }

  // ── Compute discount ───────────────────────────────────────────────────────
  let discountAmount: Prisma.Decimal;

  if (coupon.discountType === DiscountType.FLAT_INR) {
    discountAmount = Prisma.Decimal.min(coupon.discountValue, originalAmount);
  } else {
    discountAmount = originalAmount
      .mul(coupon.discountValue)
      .div(100)
      .toDecimalPlaces(2);
    if (coupon.maxDiscountINR !== null) {
      discountAmount = Prisma.Decimal.min(discountAmount, coupon.maxDiscountINR);
    }
  }

  const finalAmount = originalAmount.sub(discountAmount);

  return {
    valid: true,
    code: coupon.code,
    description: coupon.description,
    discountType: coupon.discountType,
    discountValue: coupon.discountValue,
    discountAmount: discountAmount.toFixed(2),
    originalAmount: originalAmount.toFixed(2),
    finalAmount: finalAmount.toFixed(2),
    // Expiry info for UI display
    validUntil: coupon.validUntil,
  };
}
