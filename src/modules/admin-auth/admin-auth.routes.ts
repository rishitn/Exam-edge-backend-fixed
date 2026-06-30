import { FastifyInstance } from "fastify";
import {
  AdminLoginSchema,
  AdminRefreshTokenSchema,
  CreateAdminSchema,
  UpdateAdminSchema,
} from "./schemas/admin-auth.schema";
import * as AdminAuthService from "./services/admin-auth.service";
import { authenticateAdmin, requireSuperAdmin } from "../../middleware/authenticate";
import { sendSuccess, sendCreated } from "../../utils/response";
import { asyncHandler } from "../../utils/async-handler";
import { RateLimits } from "../../plugins/rate-limiter";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../utils/errors";

// =============================================================================
// Admin Auth Routes — /api/v1/admin/auth/*
// =============================================================================

export async function adminAuthRoutes(app: FastifyInstance): Promise<void> {

  // POST /admin/auth/login
  app.post(
    "/login",
    { config: { rateLimit: RateLimits.login } },
    asyncHandler(async (request, reply) => {
      const body = AdminLoginSchema.parse(request.body);
      const result = await AdminAuthService.adminLogin(body, request.ip);
      return sendSuccess(reply, result);
    })
  );

  // POST /admin/auth/refresh
  app.post(
    "/refresh",
    asyncHandler(async (request, reply) => {
      const body = AdminRefreshTokenSchema.parse(request.body);
      const tokens = await AdminAuthService.refreshAdminTokens(body.refreshToken, request.ip);
      return sendSuccess(reply, { tokens });
    })
  );

  // POST /admin/auth/logout  (requires admin auth)
  app.post(
    "/logout",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const accessToken = request.headers.authorization!.slice(7);
      const body = request.body as { refreshToken?: string };
      await AdminAuthService.adminLogout(request.admin!.id, accessToken, body?.refreshToken);
      return sendSuccess(reply, { message: "Logged out successfully" });
    })
  );

  // GET /admin/auth/me
  app.get(
    "/me",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const admin = await prisma.admin.findUnique({
        where: { id: request.admin!.id },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          assignedExams: true,
          status: true,
          totpEnabled: true,
          lastLoginAt: true,
          createdAt: true,
        },
      });
      if (!admin) throw Errors.notFound("Admin");
      return sendSuccess(reply, { admin });
    })
  );

  // ==========================================================================
  // Super Admin — Admin Management
  // ==========================================================================

  // POST /admin/auth/admins  (Super Admin only — create new admin)
  app.post(
    "/admins",
    { preHandler: [requireSuperAdmin] },
    asyncHandler(async (request, reply) => {
      const body = CreateAdminSchema.parse(request.body);
      const result = await AdminAuthService.createAdmin(body, request.admin!.id);
      return sendCreated(reply, result);
    })
  );

  // GET /admin/auth/admins  (Super Admin only — list all admins)
  app.get(
    "/admins",
    { preHandler: [requireSuperAdmin] },
    asyncHandler(async (request, reply) => {
      const admins = await prisma.admin.findMany({
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          assignedExams: true,
          status: true,
          lastLoginAt: true,
          createdAt: true,
          _count: { select: { tests: true, questions: true } },
        },
        orderBy: { createdAt: "desc" },
      });
      return sendSuccess(reply, { admins });
    })
  );

  // PATCH /admin/auth/admins/:id  (Super Admin only — update admin)
  app.patch(
    "/admins/:id",
    { preHandler: [requireSuperAdmin] },
    asyncHandler(async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = UpdateAdminSchema.parse(request.body);

      const admin = await prisma.admin.findUnique({ where: { id }, select: { id: true, role: true } });
      if (!admin) throw Errors.notFound("Admin");

      // Prevent editing own account role
      if (id === request.admin!.id && body.status) {
        throw Errors.forbidden("Cannot modify your own account status");
      }

      const updated = await prisma.admin.update({
        where: { id },
        data: body as any,
        select: {
          id: true, name: true, email: true, role: true,
          assignedExams: true, status: true,
        },
      });

      return sendSuccess(reply, { admin: updated });
    })
  );

  // DELETE /admin/auth/admins/:id  (Super Admin only)
  app.delete(
    "/admins/:id",
    { preHandler: [requireSuperAdmin] },
    asyncHandler(async (request, reply) => {
      const { id } = request.params as { id: string };
      if (id === request.admin!.id) throw Errors.forbidden("Cannot delete your own account");

      await prisma.admin.update({
        where: { id },
        data: { status: "INACTIVE" as any },
      });

      return sendSuccess(reply, { message: "Admin deactivated" });
    })
  );
}
