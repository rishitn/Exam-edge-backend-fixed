import { z } from "zod";

// =============================================================================
// Coupon Schemas
// =============================================================================

// ── Admin: Create Coupon ──────────────────────────────────────────────────────

export const createCouponSchema = z
  .object({
    code: z
      .string()
      .min(3)
      .max(30)
      .toUpperCase()
      .regex(/^[A-Z0-9_-]+$/, "Code can only contain letters, numbers, _ and -"),
    description: z.string().max(300).optional(),
    discountType: z.enum(["PERCENTAGE", "FLAT_INR"]),
    discountValue: z.number().positive(),
    maxDiscountINR: z.number().positive().optional(), // cap for % discounts
    applicableTo: z.enum([
      "ALL_TESTS",
      "SPECIFIC_TEST",
      "SUBSCRIPTION",
      "ALL",
    ]),
    // Required when applicableTo === SPECIFIC_TEST
    testIds: z.array(z.string().cuid()).min(1).optional(),
    maxUses: z.number().int().positive().optional(),     // null = unlimited
    perUserLimit: z.number().int().min(1).default(1),
    validFrom: z.coerce.date().optional(),
    validUntil: z.coerce.date().optional(),
    minOrderValue: z.number().positive().optional(),
  })
  .refine(
    (d) => {
      if (d.discountType === "PERCENTAGE") {
        return d.discountValue > 0 && d.discountValue <= 100;
      }
      return true;
    },
    { message: "Percentage discount must be between 1 and 100", path: ["discountValue"] }
  )
  .refine(
    (d) => {
      if (d.applicableTo === "SPECIFIC_TEST") {
        return Array.isArray(d.testIds) && d.testIds.length > 0;
      }
      return true;
    },
    { message: "testIds are required when applicableTo is SPECIFIC_TEST", path: ["testIds"] }
  )
  .refine(
    (d) => {
      if (d.validFrom && d.validUntil) return d.validUntil > d.validFrom;
      return true;
    },
    { message: "validUntil must be after validFrom", path: ["validUntil"] }
  );

export type CreateCouponInput = z.infer<typeof createCouponSchema>;

// ── Admin: Update Coupon ──────────────────────────────────────────────────────

export const updateCouponSchema = z.object({
  description: z.string().max(300).optional(),
  maxUses: z.number().int().positive().nullable().optional(),
  perUserLimit: z.number().int().min(1).optional(),
  validUntil: z.coerce.date().nullable().optional(),
  minOrderValue: z.number().positive().nullable().optional(),
  maxDiscountINR: z.number().positive().nullable().optional(),
  // Note: code, discountType, discountValue, applicableTo are immutable after creation
});
export type UpdateCouponInput = z.infer<typeof updateCouponSchema>;

// ── Admin: List Coupons ───────────────────────────────────────────────────────

export const listCouponsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["ACTIVE", "INACTIVE", "EXPIRED"]).optional(),
  search: z.string().optional(), // search by code or description
  applicableTo: z
    .enum(["ALL_TESTS", "SPECIFIC_TEST", "SUBSCRIPTION", "ALL"])
    .optional(),
});
export type ListCouponsQuery = z.infer<typeof listCouponsQuerySchema>;

// ── Student: Validate Coupon ──────────────────────────────────────────────────

export const validateCouponSchema = z.object({
  code: z.string().min(1).toUpperCase(),
  orderType: z.enum(["TEST_PURCHASE", "SUBSCRIPTION"]),
  testId: z.string().cuid().optional(),   // required when orderType = TEST_PURCHASE
  planId: z.string().cuid().optional(),   // required when orderType = SUBSCRIPTION
  originalAmount: z.number().positive(),
});
export type ValidateCouponInput = z.infer<typeof validateCouponSchema>;
