import Razorpay from "razorpay";
import crypto from "crypto";
import {
  OrderType,
  OrderStatus,
  SubscriptionStatus,
  CouponStatus,
  CouponApplicability,
  DiscountType,
  Prisma,
} from "@prisma/client";
import { prisma } from "../../../lib/prisma";
import { env } from "../../../config/env";
import { Errors, ErrorCode } from "../../../utils/errors";
import { createLogger } from "../../../lib/logger";
import type {
  CreateTestOrderInput,
  CreateSubscriptionOrderInput,
  VerifyPaymentInput,
  RazorpayWebhookPayload,
} from "../schemas/payment.schema";

const log = createLogger("payment-service");

// =============================================================================
// Razorpay client — lazy singleton so dev boots without keys
// =============================================================================

let _razorpay: Razorpay | null = null;

function getRazorpay(): Razorpay {
  if (!_razorpay) {
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
      throw Errors.internal("Razorpay is not configured");
    }
    _razorpay = new Razorpay({
      key_id: env.RAZORPAY_KEY_ID,
      key_secret: env.RAZORPAY_KEY_SECRET,
    });
  }
  return _razorpay;
}

// =============================================================================
// Types
// =============================================================================

export interface OrderCreatedResult {
  orderId: string;             // Our internal order ID
  razorpayOrderId: string;
  amount: number;              // In paise (Razorpay expects paise)
  currency: string;
  originalAmount: string;
  discountAmount: string;
  finalAmount: string;
  couponApplied: boolean;
  couponCode?: string;
  keyId: string;               // Frontend needs this to init Razorpay checkout
}

// =============================================================================
// Coupon helpers
// =============================================================================

interface CouponValidationContext {
  userId: string;
  couponCode: string;
  orderType: OrderType;
  testId?: string;
  planId?: string;
  originalAmount: Prisma.Decimal;
}

interface CouponResult {
  couponId: string;
  couponCode: string;
  discountAmount: Prisma.Decimal;
}

async function validateAndApplyCoupon(
  ctx: CouponValidationContext
): Promise<CouponResult> {
  const now = new Date();

  const coupon = await prisma.coupon.findUnique({
    where: { code: ctx.couponCode },
    include: { specificTests: true },
  });

  // ── Existence & status ────────────────────────────────────────────────────
  if (!coupon || coupon.status !== CouponStatus.ACTIVE) {
    throw Errors.badRequest("Invalid or inactive coupon", ErrorCode.INVALID_COUPON);
  }

  // ── Date validity ─────────────────────────────────────────────────────────
  if (coupon.validFrom > now) {
    throw Errors.badRequest("Coupon is not yet active", ErrorCode.INVALID_COUPON);
  }
  if (coupon.validUntil && coupon.validUntil < now) {
    throw Errors.badRequest("Coupon has expired", ErrorCode.COUPON_EXPIRED);
  }

  // ── Global usage limit ────────────────────────────────────────────────────
  if (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses) {
    throw Errors.badRequest("Coupon usage limit reached", ErrorCode.COUPON_USAGE_LIMIT);
  }

  // ── Per-user limit ────────────────────────────────────────────────────────
  const userUsageCount = await prisma.couponUsage.count({
    where: { couponId: coupon.id, userId: ctx.userId },
  });
  if (userUsageCount >= coupon.perUserLimit) {
    throw Errors.badRequest(
      "You have already used this coupon",
      ErrorCode.COUPON_USAGE_LIMIT
    );
  }

  // ── Applicability ─────────────────────────────────────────────────────────
  const applicable =
    coupon.applicableTo === CouponApplicability.ALL ||
    (coupon.applicableTo === CouponApplicability.ALL_TESTS &&
      ctx.orderType === OrderType.TEST_PURCHASE) ||
    (coupon.applicableTo === CouponApplicability.SUBSCRIPTION &&
      ctx.orderType === OrderType.SUBSCRIPTION) ||
    (coupon.applicableTo === CouponApplicability.SPECIFIC_TEST &&
      ctx.orderType === OrderType.TEST_PURCHASE &&
      ctx.testId !== undefined &&
      coupon.specificTests.some((ct) => ct.testId === ctx.testId));

  if (!applicable) {
    throw Errors.badRequest(
      "Coupon is not applicable to this purchase",
      ErrorCode.COUPON_NOT_APPLICABLE
    );
  }

  // ── Minimum order value ───────────────────────────────────────────────────
  if (
    coupon.minOrderValue !== null &&
    ctx.originalAmount.lessThan(coupon.minOrderValue)
  ) {
    throw Errors.badRequest(
      `Minimum order value for this coupon is ₹${coupon.minOrderValue}`,
      ErrorCode.INVALID_COUPON
    );
  }

  // ── Compute discount ──────────────────────────────────────────────────────
  let discountAmount: Prisma.Decimal;

  if (coupon.discountType === DiscountType.FLAT_INR) {
    discountAmount = Prisma.Decimal.min(
      coupon.discountValue,
      ctx.originalAmount
    );
  } else {
    // PERCENTAGE
    discountAmount = ctx.originalAmount
      .mul(coupon.discountValue)
      .div(100)
      .toDecimalPlaces(2);

    if (coupon.maxDiscountINR !== null) {
      discountAmount = Prisma.Decimal.min(discountAmount, coupon.maxDiscountINR);
    }
  }

  return {
    couponId: coupon.id,
    couponCode: coupon.code,
    discountAmount,
  };
}

// =============================================================================
// Create Razorpay order for a single test purchase
// =============================================================================

export async function createTestOrder(
  userId: string,
  input: CreateTestOrderInput
): Promise<OrderCreatedResult> {
  // ── Fetch test ────────────────────────────────────────────────────────────
  const test = await prisma.test.findUnique({
    where: { id: input.testId },
    select: {
      id: true,
      title: true,
      isFree: true,
      price: true,
      status: true,
    },
  });

  if (!test) throw Errors.notFound("Test", ErrorCode.TEST_NOT_FOUND);

  if (test.status !== "PUBLISHED") {
    throw Errors.business("Test is not available", ErrorCode.TEST_NOT_PUBLISHED);
  }

  if (test.isFree) {
    throw Errors.badRequest(
      "This test is free — no payment required",
      ErrorCode.INVALID_INPUT
    );
  }

  if (!test.price) {
    throw Errors.internal("Test has no price configured");
  }

  // ── Check if user already purchased this test ─────────────────────────────
  const alreadyPurchased = await prisma.order.findFirst({
    where: {
      userId,
      testId: input.testId,
      status: OrderStatus.SUCCESS,
    },
  });
  if (alreadyPurchased) {
    throw Errors.conflict(
      "You have already purchased this test",
      ErrorCode.CONFLICT
    );
  }

  const originalAmount = test.price;
  let discountAmount = new Prisma.Decimal(0);
  let couponId: string | undefined;
  let couponCode: string | undefined;

  // ── Apply coupon if provided ───────────────────────────────────────────────
  if (input.couponCode) {
    const coupon = await validateAndApplyCoupon({
      userId,
      couponCode: input.couponCode,
      orderType: OrderType.TEST_PURCHASE,
      testId: input.testId,
      originalAmount,
    });
    discountAmount = coupon.discountAmount;
    couponId = coupon.couponId;
    couponCode = coupon.couponCode;
  }

  const finalAmount = Prisma.Decimal.max(
    originalAmount.sub(discountAmount),
    new Prisma.Decimal(0)
  );

  // ── Create Razorpay order ─────────────────────────────────────────────────
  // Amount in paise (1 INR = 100 paise)
  const amountPaise = finalAmount.mul(100).toNumber();

  // Create our DB order first so we have the receipt ID
  const dbOrder = await prisma.order.create({
    data: {
      userId,
      type: OrderType.TEST_PURCHASE,
      testId: input.testId,
      originalAmount,
      discountAmount,
      finalAmount,
      couponId,
      couponCode,
      status: OrderStatus.PENDING,
    },
  });

  try {
    const rzOrder = await getRazorpay().orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt: dbOrder.id,       // Used to look up our order in the webhook
      notes: {
        userId,
        testId: input.testId,
        orderId: dbOrder.id,
      },
    });

    // Save Razorpay order ID back to our order
    await prisma.order.update({
      where: { id: dbOrder.id },
      data: { razorpayOrderId: rzOrder.id },
    });

    log.info({ orderId: dbOrder.id, rzOrderId: rzOrder.id }, "Test order created");

    return {
      orderId: dbOrder.id,
      razorpayOrderId: rzOrder.id,
      amount: amountPaise,
      currency: "INR",
      originalAmount: originalAmount.toFixed(2),
      discountAmount: discountAmount.toFixed(2),
      finalAmount: finalAmount.toFixed(2),
      couponApplied: !!couponId,
      couponCode,
      keyId: env.RAZORPAY_KEY_ID!,
    };
  } catch (err) {
    // Roll back the pending order so it doesn't litter the DB
    await prisma.order.delete({ where: { id: dbOrder.id } }).catch(() => {});
    log.error({ err }, "Razorpay order creation failed");
    throw Errors.business(
      "Payment gateway error — please try again",
      ErrorCode.PAYMENT_GATEWAY_ERROR
    );
  }
}

// =============================================================================
// Create Razorpay order for a subscription plan
// =============================================================================

export async function createSubscriptionOrder(
  userId: string,
  input: CreateSubscriptionOrderInput
): Promise<OrderCreatedResult> {
  // ── Fetch plan ────────────────────────────────────────────────────────────
  const plan = await prisma.subscriptionPlan.findUnique({
    where: { id: input.planId },
    select: { id: true, name: true, price: true, isActive: true },
  });

  if (!plan || !plan.isActive) {
    throw Errors.notFound("Subscription plan", ErrorCode.NOT_FOUND);
  }

  // ── Block if user already has an active subscription ──────────────────────
  const activeSub = await prisma.subscription.findUnique({
    where: { userId },
    select: { status: true, expiresAt: true },
  });
  if (
    activeSub &&
    activeSub.status === SubscriptionStatus.ACTIVE &&
    activeSub.expiresAt > new Date()
  ) {
    throw Errors.business(
      "You already have an active subscription",
      ErrorCode.SUBSCRIPTION_ALREADY_ACTIVE
    );
  }

  const originalAmount = plan.price;
  let discountAmount = new Prisma.Decimal(0);
  let couponId: string | undefined;
  let couponCode: string | undefined;

  if (input.couponCode) {
    const coupon = await validateAndApplyCoupon({
      userId,
      couponCode: input.couponCode,
      orderType: OrderType.SUBSCRIPTION,
      planId: input.planId,
      originalAmount,
    });
    discountAmount = coupon.discountAmount;
    couponId = coupon.couponId;
    couponCode = coupon.couponCode;
  }

  const finalAmount = Prisma.Decimal.max(
    originalAmount.sub(discountAmount),
    new Prisma.Decimal(0)
  );
  const amountPaise = finalAmount.mul(100).toNumber();

  const dbOrder = await prisma.order.create({
    data: {
      userId,
      type: OrderType.SUBSCRIPTION,
      planId: input.planId,
      originalAmount,
      discountAmount,
      finalAmount,
      couponId,
      couponCode,
      status: OrderStatus.PENDING,
    },
  });

  try {
    const rzOrder = await getRazorpay().orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt: dbOrder.id,
      notes: {
        userId,
        planId: input.planId,
        orderId: dbOrder.id,
      },
    });

    await prisma.order.update({
      where: { id: dbOrder.id },
      data: { razorpayOrderId: rzOrder.id },
    });

    log.info(
      { orderId: dbOrder.id, rzOrderId: rzOrder.id },
      "Subscription order created"
    );

    return {
      orderId: dbOrder.id,
      razorpayOrderId: rzOrder.id,
      amount: amountPaise,
      currency: "INR",
      originalAmount: originalAmount.toFixed(2),
      discountAmount: discountAmount.toFixed(2),
      finalAmount: finalAmount.toFixed(2),
      couponApplied: !!couponId,
      couponCode,
      keyId: env.RAZORPAY_KEY_ID!,
    };
  } catch (err) {
    await prisma.order.delete({ where: { id: dbOrder.id } }).catch(() => {});
    log.error({ err }, "Razorpay subscription order creation failed");
    throw Errors.business(
      "Payment gateway error — please try again",
      ErrorCode.PAYMENT_GATEWAY_ERROR
    );
  }
}

// =============================================================================
// Verify payment signature (called by frontend after checkout success)
// =============================================================================

export async function verifyPayment(
  userId: string,
  input: VerifyPaymentInput
): Promise<{ success: true; message: string }> {
  // ── Load our order ─────────────────────────────────────────────────────────
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    select: {
      id: true,
      userId: true,
      type: true,
      planId: true,
      couponId: true,
      status: true,
      razorpayOrderId: true,
      finalAmount: true,
    },
  });

  if (!order || order.userId !== userId) {
    throw Errors.notFound("Order", ErrorCode.ORDER_NOT_FOUND);
  }

  if (order.status === OrderStatus.SUCCESS) {
    // Idempotent — already verified (e.g. duplicate callback)
    return { success: true, message: "Payment already verified" };
  }

  if (order.status !== OrderStatus.PENDING) {
    throw Errors.business("Order is not in a verifiable state", ErrorCode.INVALID_INPUT);
  }

  if (order.razorpayOrderId !== input.razorpayOrderId) {
    throw Errors.badRequest("Razorpay order ID mismatch", ErrorCode.INVALID_INPUT);
  }

  // ── Verify HMAC signature ──────────────────────────────────────────────────
  // Razorpay docs: HMAC-SHA256 of "<razorpay_order_id>|<razorpay_payment_id>"
  const body = `${input.razorpayOrderId}|${input.razorpayPaymentId}`;
  const expectedSignature = crypto
    .createHmac("sha256", env.RAZORPAY_KEY_SECRET!)
    .update(body)
    .digest("hex");

  if (expectedSignature !== input.razorpaySignature) {
    log.warn({ orderId: order.id }, "Payment signature verification failed");
    await prisma.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.FAILED, failureReason: "Signature mismatch" },
    });
    throw Errors.badRequest("Payment verification failed", ErrorCode.INVALID_INPUT);
  }

  // ── Fulfil the order in a transaction ─────────────────────────────────────
  await fulfillOrder(order, input.razorpayPaymentId, input.razorpaySignature);

  log.info({ orderId: order.id }, "Payment verified and order fulfilled");
  return { success: true, message: "Payment successful" };
}

// =============================================================================
// Webhook handler — called by Razorpay server-to-server
// =============================================================================

export async function handleWebhook(
  rawBody: Buffer,
  signature: string
): Promise<void> {
  // ── Verify webhook signature ───────────────────────────────────────────────
  if (!env.RAZORPAY_WEBHOOK_SECRET) {
    throw Errors.internal("Webhook secret not configured");
  }

  const expectedSig = crypto
    .createHmac("sha256", env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");

  if (expectedSig !== signature) {
    log.warn("Webhook signature mismatch — ignoring");
    throw Errors.badRequest("Invalid webhook signature", ErrorCode.INVALID_INPUT);
  }

  const event: RazorpayWebhookPayload = JSON.parse(rawBody.toString("utf8"));
  log.info({ event: event.event }, "Razorpay webhook received");

  switch (event.event) {
    case "payment.captured": {
      await handlePaymentCaptured(event);
      break;
    }
    case "payment.failed": {
      await handlePaymentFailed(event);
      break;
    }
    default:
      // Unhandled event — acknowledge to avoid Razorpay retries
      log.debug({ event: event.event }, "Unhandled webhook event");
  }
}

async function handlePaymentCaptured(
  event: RazorpayWebhookPayload
): Promise<void> {
  const payment = event.payload.payment?.entity;
  if (!payment) return;

  const order = await prisma.order.findUnique({
    where: { razorpayOrderId: payment.order_id },
    select: {
      id: true,
      userId: true,
      type: true,
      planId: true,
      couponId: true,
      status: true,
      razorpayOrderId: true,
      finalAmount: true,
    },
  });

  if (!order) {
    log.warn({ rzOrderId: payment.order_id }, "Webhook: order not found");
    return;
  }

  if (order.status === OrderStatus.SUCCESS) {
    log.debug({ orderId: order.id }, "Webhook: order already fulfilled");
    return;
  }

  await fulfillOrder(order, payment.id, undefined);
}

async function handlePaymentFailed(
  event: RazorpayWebhookPayload
): Promise<void> {
  const payment = event.payload.payment?.entity;
  if (!payment) return;

  const order = await prisma.order.findFirst({
    where: { razorpayOrderId: payment.order_id },
    select: { id: true, status: true },
  });

  if (!order || order.status !== OrderStatus.PENDING) return;

  await prisma.order.update({
    where: { id: order.id },
    data: {
      status: OrderStatus.FAILED,
      failureReason: payment.error_description ?? "Payment failed",
    },
  });

  log.info({ orderId: order.id }, "Webhook: order marked as failed");
}

// =============================================================================
// Fulfill order — runs in a DB transaction
// Called from both verifyPayment (client-side) and webhook (server-side)
// =============================================================================

type FulfillableOrder = {
  id: string;
  userId: string;
  type: OrderType;
  planId: string | null;
  couponId: string | null;
  finalAmount: Prisma.Decimal;
};

async function fulfillOrder(
  order: FulfillableOrder,
  razorpayPaymentId: string,
  razorpaySignature: string | undefined
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // 1. Mark order as SUCCESS
    await tx.order.update({
      where: { id: order.id },
      data: {
        status: OrderStatus.SUCCESS,
        razorpayPaymentId,
        ...(razorpaySignature && { razorpaySignature }),
        paidAt: new Date(),
      },
    });

    // 2. If subscription purchase — create/renew subscription
    if (order.type === OrderType.SUBSCRIPTION && order.planId) {
      const plan = await tx.subscriptionPlan.findUnique({
        where: { id: order.planId },
        select: { durationDays: true },
      });
      if (!plan) throw Errors.internal("Plan not found during fulfillment");

      const now = new Date();
      const expiresAt = new Date(now);
      expiresAt.setDate(expiresAt.getDate() + plan.durationDays);

      // Upsert — handles both new subscriptions and renewals
      await tx.subscription.upsert({
        where: { userId: order.userId },
        create: {
          userId: order.userId,
          planId: order.planId,
          status: SubscriptionStatus.ACTIVE,
          startedAt: now,
          expiresAt,
        },
        update: {
          planId: order.planId,
          status: SubscriptionStatus.ACTIVE,
          startedAt: now,
          expiresAt,
          cancelledAt: null,
          cancelReason: null,
        },
      });

      // Link order → subscription
      const sub = await tx.subscription.findUnique({
        where: { userId: order.userId },
        select: { id: true },
      });
      if (sub) {
        await tx.order.update({
          where: { id: order.id },
          data: { subscriptionId: sub.id },
        });
      }
    }

    // 3. Increment coupon usage counter
    if (order.couponId) {
      await tx.coupon.update({
        where: { id: order.couponId },
        data: { usedCount: { increment: 1 } },
      });

      await tx.couponUsage.create({
        data: {
          couponId: order.couponId,
          userId: order.userId,
          orderId: order.id,
        },
      });
    }
  });
}

// =============================================================================
// Order history (student-facing)
// =============================================================================

export async function getOrderHistory(
  userId: string,
  page: number,
  pageSize: number
) {
  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        type: true,
        status: true,
        originalAmount: true,
        discountAmount: true,
        finalAmount: true,
        couponCode: true,
        razorpayPaymentId: true,
        paidAt: true,
        createdAt: true,
        test: { select: { id: true, title: true } },
        plan: { select: { id: true, name: true, durationDays: true } },
      },
    }),
    prisma.order.count({ where: { userId } }),
  ]);

  return { orders, total };
}

// =============================================================================
// Single order detail (student-facing)
// =============================================================================

export async function getOrderById(userId: string, orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      userId: true,
      type: true,
      status: true,
      originalAmount: true,
      discountAmount: true,
      finalAmount: true,
      couponCode: true,
      razorpayOrderId: true,
      razorpayPaymentId: true,
      failureReason: true,
      paidAt: true,
      createdAt: true,
      test: { select: { id: true, title: true } },
      plan: { select: { id: true, name: true, durationDays: true } },
    },
  });

  if (!order || order.userId !== userId) {
    throw Errors.notFound("Order", ErrorCode.ORDER_NOT_FOUND);
  }

  return order;
}
