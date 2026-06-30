import { z } from "zod";

// =============================================================================
// Payment Schemas — Zod validation for all payment routes
// =============================================================================

// ── Create Order ──────────────────────────────────────────────────────────────

export const createTestOrderSchema = z.object({
  testId: z.string().cuid("Invalid test ID"),
  couponCode: z.string().trim().toUpperCase().optional(),
});
export type CreateTestOrderInput = z.infer<typeof createTestOrderSchema>;

export const createSubscriptionOrderSchema = z.object({
  planId: z.string().cuid("Invalid plan ID"),
  couponCode: z.string().trim().toUpperCase().optional(),
});
export type CreateSubscriptionOrderInput = z.infer<typeof createSubscriptionOrderSchema>;

// ── Verify Payment ────────────────────────────────────────────────────────────

export const verifyPaymentSchema = z.object({
  orderId: z.string().min(1, "orderId is required"),           // Our internal order ID
  razorpayOrderId: z.string().min(1),
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().min(1),
});
export type VerifyPaymentInput = z.infer<typeof verifyPaymentSchema>;

// ── Webhook ───────────────────────────────────────────────────────────────────
// Raw body is verified by HMAC — no Zod needed for the body itself,
// but we type the events we handle.

export interface RazorpayWebhookPayload {
  event: string;
  payload: {
    payment?: {
      entity: {
        id: string;
        order_id: string;
        amount: number;
        status: string;
        error_code?: string;
        error_description?: string;
      };
    };
    order?: {
      entity: {
        id: string;
        receipt: string; // Our internal order ID
        status: string;
      };
    };
  };
}

// ── Order History ─────────────────────────────────────────────────────────────

export const orderHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(10),
});
export type OrderHistoryQuery = z.infer<typeof orderHistoryQuerySchema>;
