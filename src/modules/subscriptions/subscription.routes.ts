import { FastifyInstance } from "fastify";
import { authenticate, authenticateAdmin, requireSuperAdmin } from "../../middleware/authenticate";
import { asyncHandler } from "../../utils/async-handler";
import {
  sendSuccess,
  sendCreated,
  sendPaginated,
  buildPaginationMeta,
} from "../../utils/response";
import {
  createPlanSchema,
  updatePlanSchema,
  grantSubscriptionSchema,
  cancelSubscriptionSchema,
  listSubscriptionsQuerySchema,
} from "./schemas/subscription.schema";
import * as SubscriptionService from "./services/subscription.service";

// =============================================================================
// Subscription Routes
//
// Public:
//   GET  /subscriptions/plans                     List active plans (student browse)
//   GET  /subscriptions/plans/:planId             Single plan detail
//
// Student (auth required):
//   GET  /subscriptions/me                        My current subscription
//   POST /subscriptions/me/cancel                 Cancel my subscription
//
// Admin:
//   GET  /subscriptions/admin/plans               All plans incl. inactive
//   POST /subscriptions/admin/plans               Create plan
//   PATCH /subscriptions/admin/plans/:planId      Update plan
//   PATCH /subscriptions/admin/plans/:planId/toggle-status
//   GET  /subscriptions/admin                     List all subscriptions
//   GET  /subscriptions/admin/stats               Dashboard stats
//   GET  /subscriptions/admin/users/:userId       Single user's subscription
//   POST /subscriptions/admin/grant               Manually grant subscription
//   POST /subscriptions/admin/users/:userId/revoke
// =============================================================================

export async function subscriptionRoutes(app: FastifyInstance): Promise<void> {

  // ==========================================================================
  // PUBLIC — no auth required
  // ==========================================================================

  // GET /plans — active plans for the pricing page
  app.get(
    "/plans",
    asyncHandler(async (_request, reply) => {
      const plans = await SubscriptionService.listActivePlans();
      return sendSuccess(reply, plans);
    })
  );

  // GET /plans/:planId
  app.get(
    "/plans/:planId",
    asyncHandler(async (request, reply) => {
      const { planId } = request.params as { planId: string };
      const plan = await SubscriptionService.getPlanById(planId);
      return sendSuccess(reply, plan);
    })
  );

  // ==========================================================================
  // STUDENT — auth required
  // ==========================================================================

  // GET /me — current subscription status
  app.get(
    "/me",
    { preHandler: [authenticate] },
    asyncHandler(async (request, reply) => {
      const sub = await SubscriptionService.getMySubscription(request.user!.id);
      return sendSuccess(reply, { subscription: sub });
    })
  );

  // POST /me/cancel
  app.post(
    "/me/cancel",
    { preHandler: [authenticate] },
    asyncHandler(async (request, reply) => {
      const input = cancelSubscriptionSchema.parse(request.body);
      const sub = await SubscriptionService.cancelMySubscription(
        request.user!.id,
        input
      );
      return sendSuccess(reply, { subscription: sub, message: "Subscription cancelled" });
    })
  );

  // ==========================================================================
  // ADMIN — admin auth required
  // ==========================================================================

  // GET /admin/plans — all plans including inactive
  app.get(
    "/admin/plans",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (_request, reply) => {
      const plans = await SubscriptionService.listAllPlans();
      return sendSuccess(reply, plans);
    })
  );

  // POST /admin/plans — create plan (super admin only)
  app.post(
    "/admin/plans",
    { preHandler: [requireSuperAdmin] },
    asyncHandler(async (request, reply) => {
      const input = createPlanSchema.parse(request.body);
      const plan = await SubscriptionService.createPlan(request.admin!.id, input);
      return sendCreated(reply, plan);
    })
  );

  // PATCH /admin/plans/:planId — update plan (super admin only)
  app.patch(
    "/admin/plans/:planId",
    { preHandler: [requireSuperAdmin] },
    asyncHandler(async (request, reply) => {
      const { planId } = request.params as { planId: string };
      const input = updatePlanSchema.parse(request.body);
      const plan = await SubscriptionService.updatePlan(planId, input);
      return sendSuccess(reply, plan);
    })
  );

  // PATCH /admin/plans/:planId/toggle-status (super admin only)
  app.patch(
    "/admin/plans/:planId/toggle-status",
    { preHandler: [requireSuperAdmin] },
    asyncHandler(async (request, reply) => {
      const { planId } = request.params as { planId: string };
      const plan = await SubscriptionService.togglePlanStatus(planId);
      return sendSuccess(reply, plan);
    })
  );

  // GET /admin — list all subscriptions with filters
  app.get(
    "/admin",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const query = listSubscriptionsQuerySchema.parse(request.query);
      const { subscriptions, total } = await SubscriptionService.listSubscriptions(query);
      const pagination = buildPaginationMeta(total, query.page, query.pageSize);
      return sendPaginated(reply, subscriptions, pagination);
    })
  );

  // GET /admin/stats — subscription dashboard stats
  app.get(
    "/admin/stats",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (_request, reply) => {
      const stats = await SubscriptionService.getSubscriptionStats();
      return sendSuccess(reply, stats);
    })
  );

  // GET /admin/users/:userId — single user's subscription
  app.get(
    "/admin/users/:userId",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const { userId } = request.params as { userId: string };
      const result = await SubscriptionService.getUserSubscription(userId);
      return sendSuccess(reply, result);
    })
  );

  // POST /admin/grant — manually grant subscription (super admin)
  app.post(
    "/admin/grant",
    { preHandler: [requireSuperAdmin] },
    asyncHandler(async (request, reply) => {
      const input = grantSubscriptionSchema.parse(request.body);
      const sub = await SubscriptionService.grantSubscription(
        request.admin!.id,
        input
      );
      return sendCreated(reply, { subscription: sub, message: "Subscription granted" });
    })
  );

  // POST /admin/users/:userId/revoke (super admin)
  app.post(
    "/admin/users/:userId/revoke",
    { preHandler: [requireSuperAdmin] },
    asyncHandler(async (request, reply) => {
      const { userId } = request.params as { userId: string };
      const sub = await SubscriptionService.revokeSubscription(
        request.admin!.id,
        userId
      );
      return sendSuccess(reply, { subscription: sub, message: "Subscription revoked" });
    })
  );
}
