import { FastifyRequest, FastifyReply } from "fastify";
import { AdminRole, UserStatus, AdminStatus, ExamType } from "@prisma/client";
import { verifyAccessToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";
import { safeRedisGet, RedisKeys } from "../lib/redis";
import { Errors, ErrorCode } from "../utils/errors";
import { createLogger } from "../lib/logger";

const log = createLogger("auth-middleware");

// =============================================================================
// Authentication Middleware
// =============================================================================

// Authenticate student users
export const authenticate = async (
  request: FastifyRequest,
  _reply: FastifyReply
) => {
  const token = extractBearerToken(request);
  if (!token) throw Errors.unauthorized();

  const payload = verifyAccessToken(token);
  if (payload.type !== "user") throw Errors.unauthorized();

  // Check token blacklist (for logout)
  if (payload.jti) {
    const blacklisted = await safeRedisGet(RedisKeys.tokenBlacklist(payload.jti));
    if (blacklisted) throw Errors.unauthorized("Token has been revoked", ErrorCode.TOKEN_REVOKED);
  }

  // Load user from DB — verify they still exist and are active
  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: {
      id: true,
      email: true,
      mobile: true,
      status: true,
    },
  });

  if (!user) throw Errors.unauthorized();
  if (user.status === UserStatus.SUSPENDED) {
    throw Errors.forbidden("Your account has been suspended", ErrorCode.ACCOUNT_SUSPENDED);
  }
  if (user.status === UserStatus.DELETED) {
    throw Errors.unauthorized();
  }

  request.user = { ...user, type: "user" };
};

// Authenticate admins (ADMIN or SUPER_ADMIN)
export const authenticateAdmin = async (
  request: FastifyRequest,
  _reply: FastifyReply
) => {
  const token = extractBearerToken(request);
  if (!token) throw Errors.unauthorized();

  const payload = verifyAccessToken(token);
  if (payload.type !== "admin") throw Errors.unauthorized();

  if (payload.jti) {
    const blacklisted = await safeRedisGet(RedisKeys.tokenBlacklist(payload.jti));
    if (blacklisted) throw Errors.unauthorized("Token has been revoked", ErrorCode.TOKEN_REVOKED);
  }

  const admin = await prisma.admin.findUnique({
    where: { id: payload.sub },
    select: {
      id: true,
      email: true,
      role: true,
      assignedExams: true,
      status: true,
    },
  });

  if (!admin) throw Errors.unauthorized();

  if (admin.status === AdminStatus.SUSPENDED) {
    throw Errors.forbidden("Your admin account has been suspended", ErrorCode.ACCOUNT_SUSPENDED);
  }
  if (admin.status === AdminStatus.INACTIVE) {
    throw Errors.forbidden("Your admin account is inactive", ErrorCode.FORBIDDEN);
  }

  request.admin = { ...admin, type: "admin" };
};

// Require Super Admin role specifically
export const requireSuperAdmin = async (
  request: FastifyRequest,
  _reply: FastifyReply
) => {
  await authenticateAdmin(request, _reply);
  if (request.admin?.role !== AdminRole.SUPER_ADMIN) {
    throw Errors.forbidden("Super admin access required", ErrorCode.INSUFFICIENT_ROLE);
  }
};

// =============================================================================
// Authorization Helpers (used inside route handlers)
// =============================================================================

// Verify admin can manage the given exam
export function requireExamScope(admin: NonNullable<FastifyRequest["admin"]>, exam: ExamType): void {
  if (admin.role === AdminRole.SUPER_ADMIN) return; // Super admin bypasses all scope checks
  if (!admin.assignedExams.includes(exam)) {
    throw Errors.forbidden(
      `You don't have access to manage ${exam} content`,
      ErrorCode.EXAM_SCOPE_DENIED
    );
  }
}

// Require the request is from the resource owner or an admin
export function requireOwnerOrAdmin(
  request: FastifyRequest,
  ownerId: string
): void {
  if (request.admin) return; // Admins can access anything
  if (request.user?.id !== ownerId) {
    throw Errors.forbidden();
  }
}

// =============================================================================
// Utility
// =============================================================================

function extractBearerToken(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  return token || null;
}

// Optional auth — sets request.user if valid token present, doesn't throw if absent
export const optionalAuthenticate = async (
  request: FastifyRequest,
  reply: FastifyReply
) => {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return; // No token = continue as guest
  try {
    await authenticate(request, reply);
  } catch {
    // Invalid token on optional route = continue as guest
    log.debug("Optional auth: invalid token, continuing as guest");
  }
};
