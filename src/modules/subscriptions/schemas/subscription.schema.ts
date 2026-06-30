import { z } from "zod";

// =============================================================================
// Subscription Schemas
// =============================================================================

// ── Admin: Create Plan ────────────────────────────────────────────────────────

export const createPlanSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  durationDays: z.number().int().min(1),
  price: z.number().positive(),
  originalPrice: z.number().positive().optional(),
  isActive: z.boolean().default(true),
  isPopular: z.boolean().default(false),
  features: z.array(z.string().min(1)).min(1).optional(),
  razorpayPlanId: z.string().optional(),
});
export type CreatePlanInput = z.infer<typeof createPlanSchema>;

// ── Admin: Update Plan ────────────────────────────────────────────────────────

export const updatePlanSchema = createPlanSchema.partial();
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;

// ── Admin: Grant Subscription ─────────────────────────────────────────────────

export const grantSubscriptionSchema = z.object({
  userId: z.string().cuid("Invalid user ID"),
  planId: z.string().cuid("Invalid plan ID"),
  durationDays: z.number().int().min(1).optional(), // override plan duration
  reason: z.string().max(500).optional(),
});
export type GrantSubscriptionInput = z.infer<typeof grantSubscriptionSchema>;

// ── Student: Cancel ───────────────────────────────────────────────────────────

export const cancelSubscriptionSchema = z.object({
  reason: z.string().max(500).optional(),
});
export type CancelSubscriptionInput = z.infer<typeof cancelSubscriptionSchema>;

// ── Admin: List Subscriptions ─────────────────────────────────────────────────

export const listSubscriptionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["ACTIVE", "EXPIRED", "CANCELLED", "PAUSED"]).optional(),
  search: z.string().optional(), // search by user email/name
});
export type ListSubscriptionsQuery = z.infer<typeof listSubscriptionsQuerySchema>;
