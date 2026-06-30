import { FastifyInstance } from "fastify";
import {
  authenticate,
  authenticateAdmin,
  requireSuperAdmin,
} from "../../middleware/authenticate";
import { asyncHandler } from "../../utils/async-handler";
import {
  sendSuccess,
  sendCreated,
  sendNoContent,
  sendPaginated,
  buildPaginationMeta,
} from "../../utils/response";
import {
  createCouponSchema,
  updateCouponSchema,
  listCouponsQuerySchema,
  validateCouponSchema,
} from "./schemas/coupon.schema";
import * as CouponService from "./services/coupon.service";

// =============================================================================
// Coupon Routes
//
// Student (auth required):
//   POST /coupons/validate            Preview discount before checkout
//
// Admin:
//   GET  /coupons/admin               List all coupons (paginated + filters)
//   GET  /coupons/admin/stats         Dashboard stats
//   POST /coupons/admin               Create coupon
//   GET  /coupons/admin/:couponId     Single coupon detail
//   PATCH /coupons/admin/:couponId    Update coupon
//   PATCH /coupons/admin/:couponId/toggle-status
//   DELETE /coupons/admin/:couponId   Delete coupon (only if unused)
//   GET  /coupons/admin/:couponId/usages  Usage history
// =============================================================================

export async function couponRoutes(app: FastifyInstance): Promise<void> {

  // ==========================================================================
  // STUDENT
  // ==========================================================================

  // POST /coupons/validate
  // Called when user types a coupon code at checkout — returns discount preview.
  // Does NOT consume the coupon; actual application happens at order creation.
  app.post(
    "/validate",
    { preHandler: [authenticate] },
    asyncHandler(async (request, reply) => {
      const input = validateCouponSchema.parse(request.body);
      const result = await CouponService.validateCoupon(request.user!.id, input);
      return sendSuccess(reply, result);
    })
  );

  // ==========================================================================
  // ADMIN
  // ==========================================================================

  // GET /admin/stats
  app.get(
    "/admin/stats",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (_request, reply) => {
      const stats = await CouponService.getCouponStats();
      return sendSuccess(reply, stats);
    })
  );

  // GET /admin — list with filters
  app.get(
    "/admin",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const query = listCouponsQuerySchema.parse(request.query);
      const { coupons, total } = await CouponService.listCoupons(query);
      const pagination = buildPaginationMeta(total, query.page, query.pageSize);
      return sendPaginated(reply, coupons, pagination);
    })
  );

  // POST /admin — create coupon (super admin)
  app.post(
    "/admin",
    { preHandler: [requireSuperAdmin] },
    asyncHandler(async (request, reply) => {
      const input = createCouponSchema.parse(request.body);
      const coupon = await CouponService.createCoupon(request.admin!.id, input);
      return sendCreated(reply, coupon);
    })
  );

  // GET /admin/:couponId — single coupon detail with usage count
  app.get(
    "/admin/:couponId",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const { couponId } = request.params as { couponId: string };
      const coupon = await CouponService.getCouponById(couponId);
      return sendSuccess(reply, coupon);
    })
  );

  // PATCH /admin/:couponId — update coupon (super admin)
  // Note: code, discountType, discountValue, applicableTo are intentionally immutable
  app.patch(
    "/admin/:couponId",
    { preHandler: [requireSuperAdmin] },
    asyncHandler(async (request, reply) => {
      const { couponId } = request.params as { couponId: string };
      const input = updateCouponSchema.parse(request.body);
      const coupon = await CouponService.updateCoupon(couponId, input);
      return sendSuccess(reply, coupon);
    })
  );

  // PATCH /admin/:couponId/toggle-status (super admin)
  app.patch(
    "/admin/:couponId/toggle-status",
    { preHandler: [requireSuperAdmin] },
    asyncHandler(async (request, reply) => {
      const { couponId } = request.params as { couponId: string };
      const coupon = await CouponService.toggleCouponStatus(couponId);
      return sendSuccess(reply, coupon);
    })
  );

  // DELETE /admin/:couponId (super admin — only if never used)
  app.delete(
    "/admin/:couponId",
    { preHandler: [requireSuperAdmin] },
    asyncHandler(async (request, reply) => {
      const { couponId } = request.params as { couponId: string };
      await CouponService.deleteCoupon(couponId);
      return sendNoContent(reply);
    })
  );

  // GET /admin/:couponId/usages — paginated usage history
  app.get(
    "/admin/:couponId/usages",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const { couponId } = request.params as { couponId: string };
      const page = Number((request.query as Record<string, string>).page ?? 1);
      const pageSize = Number((request.query as Record<string, string>).pageSize ?? 20);
      const { usages, total } = await CouponService.getCouponUsages(couponId, page, pageSize);
      const pagination = buildPaginationMeta(total, page, pageSize);
      return sendPaginated(reply, usages, pagination);
    })
  );
}
