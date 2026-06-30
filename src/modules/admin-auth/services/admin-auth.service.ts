import { prisma } from "../../../lib/prisma";
import { signAccessToken, signRefreshToken, verifyRefreshToken, getTokenRemainingTtl, decodeToken } from "../../../lib/jwt";
import { hashPassword, comparePassword, generateSecureToken, hashToken, generateOtp } from "../../../utils/crypto";
import { sendAdminCredentialsEmail } from "../../../lib/email";
import { safeRedisGet, safeRedisSet, RedisKeys } from "../../../lib/redis";
import { Errors, ErrorCode } from "../../../utils/errors";
import { CONSTANTS } from "../../../config/constants";
import { createLogger } from "../../../lib/logger";
import type { AdminLoginInput, CreateAdminInput } from "../schemas/admin-auth.schema";
import { AdminRole, AdminStatus } from "@prisma/client";
import { authenticator } from "otplib";
import type { AuthTokens } from "../../auth/services/auth.service";

const log = createLogger("admin-auth-service");

// =============================================================================
// ADMIN LOGIN
// =============================================================================
export async function adminLogin(
  input: AdminLoginInput,
  ip?: string
): Promise<{ admin: object; tokens: AuthTokens }> {
  const admin = await prisma.admin.findUnique({
    where: { email: input.email },
    select: {
      id: true,
      name: true,
      email: true,
      passwordHash: true,
      role: true,
      assignedExams: true,
      status: true,
      totpEnabled: true,
      totpSecret: true,
      loginAttempts: true,
      lockedUntil: true,
    },
  });

  if (!admin) throw Errors.invalidCredentials();

  // Status check
  if (admin.status === AdminStatus.SUSPENDED) {
    throw Errors.forbidden("Admin account suspended", ErrorCode.ACCOUNT_SUSPENDED);
  }
  if (admin.status === AdminStatus.INACTIVE) {
    throw Errors.forbidden("Admin account inactive", ErrorCode.FORBIDDEN);
  }

  // Lockout check
  if (admin.lockedUntil && admin.lockedUntil > new Date()) {
    const minutesLeft = Math.ceil((admin.lockedUntil.getTime() - Date.now()) / 60000);
    throw Errors.forbidden(
      `Account locked. Try again in ${minutesLeft} minute(s).`,
      ErrorCode.ACCOUNT_LOCKED
    );
  }

  const passwordMatch = await comparePassword(input.password, admin.passwordHash);
  if (!passwordMatch) {
    await handleAdminFailedLogin(admin.id, admin.loginAttempts);
    throw Errors.invalidCredentials();
  }

  // TOTP check (mandatory for SUPER_ADMIN, optional for ADMIN if enabled)
  if (admin.totpEnabled && admin.totpSecret) {
    if (!input.totpCode) {
      throw Errors.badRequest("2FA code required", ErrorCode.UNAUTHORIZED);
    }
    const valid = authenticator.verify({
      token: input.totpCode,
      secret: admin.totpSecret,
    });
    if (!valid) {
      throw Errors.badRequest("Invalid 2FA code", ErrorCode.INVALID_OTP);
    }
  }

  // Reset attempts
  await prisma.admin.update({
    where: { id: admin.id },
    data: {
      loginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      lastLoginIp: ip,
    },
  });

  const tokens = await generateAdminTokens(admin.id, admin.role, admin.assignedExams, ip);

  log.info({ adminId: admin.id, role: admin.role }, "Admin logged in");

  return {
    admin: {
      id: admin.id,
      name: admin.name,
      email: admin.email,
      role: admin.role,
      assignedExams: admin.assignedExams,
      totpEnabled: admin.totpEnabled,
    },
    tokens,
  };
}

// =============================================================================
// CREATE ADMIN (Super Admin only)
// =============================================================================
export async function createAdmin(
  input: CreateAdminInput,
  createdById: string
): Promise<{ admin: object }> {
  const existing = await prisma.admin.findUnique({
    where: { email: input.email },
    select: { id: true },
  });

  if (existing) {
    throw Errors.conflict("Admin with this email already exists", ErrorCode.EMAIL_ALREADY_EXISTS);
  }

  // Generate temporary password
  const tempPassword = `Exam${generateOtp(4 as any)}@${generateSecureToken(4)}`;
  const passwordHash = await hashPassword(tempPassword);

  const admin = await prisma.admin.create({
    data: {
      name: input.name,
      email: input.email,
      passwordHash,
      role: AdminRole.ADMIN,
      status: AdminStatus.ACTIVE,
      assignedExams: input.assignedExams as any,
      createdById,
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      assignedExams: true,
      status: true,
      createdAt: true,
    },
  });

  // Email credentials (non-blocking)
  sendAdminCredentialsEmail(admin.email, admin.name, tempPassword).catch((err) =>
    log.error({ err }, "Failed to send admin credentials email")
  );

  log.info({ adminId: admin.id, createdById }, "Admin created");
  return { admin };
}

// =============================================================================
// REFRESH ADMIN TOKENS
// =============================================================================
export async function refreshAdminTokens(
  rawRefreshToken: string,
  ip?: string
): Promise<AuthTokens> {
  const payload = verifyRefreshToken(rawRefreshToken);
  if (payload.type !== "admin") throw Errors.tokenInvalid();

  const stored = await prisma.adminRefreshToken.findUnique({
    where: { token: hashToken(rawRefreshToken) },
    include: {
      admin: {
        select: { id: true, role: true, assignedExams: true, status: true },
      },
    },
  });

  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    if (stored) {
      log.warn({ adminId: stored.adminId }, "Admin refresh token reuse — revoking all");
      await prisma.adminRefreshToken.updateMany({
        where: { adminId: stored.adminId },
        data: { revokedAt: new Date() },
      });
    }
    throw Errors.unauthorized("Invalid refresh token", ErrorCode.TOKEN_REVOKED);
  }

  // Rotate token
  await prisma.adminRefreshToken.update({
    where: { id: stored.id },
    data: { revokedAt: new Date() },
  });

  return generateAdminTokens(
    stored.adminId,
    stored.admin.role,
    stored.admin.assignedExams,
    ip
  );
}

// =============================================================================
// ADMIN LOGOUT
// =============================================================================
export async function adminLogout(
  adminId: string,
  accessToken: string,
  refreshToken?: string
): Promise<void> {
  const ttl = getTokenRemainingTtl(accessToken);
  const decoded = decodeToken(accessToken);
  if (decoded?.jti && ttl > 0) {
    await safeRedisSet(RedisKeys.tokenBlacklist(decoded.jti), "1", ttl);
  }

  if (refreshToken) {
    await prisma.adminRefreshToken.updateMany({
      where: { token: hashToken(refreshToken), adminId },
      data: { revokedAt: new Date() },
    });
  }

  log.info({ adminId }, "Admin logged out");
}

// =============================================================================
// Private Helpers
// =============================================================================

async function generateAdminTokens(
  adminId: string,
  role: AdminRole,
  assignedExams: any[],
  ip?: string
): Promise<AuthTokens> {
  const payload = { sub: adminId, role, assignedExams, type: "admin" as const };
  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  await prisma.adminRefreshToken.create({
    data: {
      adminId,
      token: hashToken(refreshToken),
      ipAddress: ip,
      expiresAt,
    },
  });

  return { accessToken, refreshToken, expiresIn: 15 * 60 };
}

async function handleAdminFailedLogin(adminId: string, currentAttempts: number): Promise<void> {
  const newAttempts = currentAttempts + 1;
  const shouldLock = newAttempts >= CONSTANTS.MAX_LOGIN_ATTEMPTS;

  await prisma.admin.update({
    where: { id: adminId },
    data: {
      loginAttempts: newAttempts,
      ...(shouldLock && {
        lockedUntil: new Date(Date.now() + CONSTANTS.LOCKOUT_DURATION_MINUTES * 60 * 1000),
      }),
    },
  });
}

