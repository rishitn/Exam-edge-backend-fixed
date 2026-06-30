import { prisma } from "../../../lib/prisma";
import { getRedis, RedisKeys, safeRedisGet, safeRedisSet, safeRedisDel } from "../../../lib/redis";
import { signAccessToken, signRefreshToken, verifyRefreshToken, getTokenRemainingTtl, decodeToken } from "../../../lib/jwt";
import { hashPassword, comparePassword, generateOtp, hashToken, generateSecureToken } from "../../../utils/crypto";
import { sendOtpViaSms } from "../../../lib/msg91";
import { sendEmailVerification, sendPasswordResetEmail, sendWelcomeEmail } from "../../../lib/email";
import { Errors, ErrorCode } from "../../../utils/errors";
import { CONSTANTS } from "../../../config/constants";
import { env } from "../../../config/env";
import { createLogger } from "../../../lib/logger";
import type {
  RegisterWithEmailInput,
  LoginWithEmailInput,
  SendOtpInput,
  VerifyOtpInput,
  ForgotPasswordInput,
  ResetPasswordInput,
} from "../schemas/auth.schema";
import { AuthProvider, UserStatus } from "@prisma/client";

const log = createLogger("auth-service");

// =============================================================================
// Token pair returned on successful login/register
// =============================================================================
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // seconds
}

interface AuthResult {
  user: {
    id: string;
    name: string;
    email: string | null;
    mobile: string | null;
    emailVerified: boolean;
    mobileVerified: boolean;
    avatarUrl: string | null;
  };
  tokens: AuthTokens;
}

// =============================================================================
// REGISTER WITH EMAIL
// =============================================================================
export async function registerWithEmail(
  input: RegisterWithEmailInput,
  ip?: string
): Promise<AuthResult> {
  // Check existing user
  const existing = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  });

  if (existing) {
    throw Errors.conflict("An account with this email already exists", ErrorCode.EMAIL_ALREADY_EXISTS);
  }

  const passwordHash = await hashPassword(input.password);
  const emailVerifyToken = generateSecureToken();

  const user = await prisma.user.create({
    data: {
      name: input.name,
      email: input.email,
      passwordHash,
      authProvider: AuthProvider.EMAIL,
      emailVerified: false,
      emailVerifyToken: hashToken(emailVerifyToken),
      targetExams: input.targetExams ?? [],
      lastLoginIp: ip,
      lastLoginAt: new Date(),
    },
    select: {
      id: true,
      name: true,
      email: true,
      mobile: true,
      emailVerified: true,
      mobileVerified: true,
      avatarUrl: true,
    },
  });

  // Send verification email (non-blocking)
  const verifyUrl = `${env.FRONTEND_URL}/verify-email?token=${emailVerifyToken}`;
  sendEmailVerification(user.email!, user.name, verifyUrl).catch((err) =>
    log.error({ err }, "Failed to send verification email")
  );

  const tokens = await generateAndStoreTokens(user.id, "user", ip);

  log.info({ userId: user.id }, "User registered with email");
  return { user, tokens };
}

// =============================================================================
// LOGIN WITH EMAIL
// =============================================================================
export async function loginWithEmail(
  input: LoginWithEmailInput,
  ip?: string
): Promise<AuthResult> {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    select: {
      id: true,
      name: true,
      email: true,
      mobile: true,
      passwordHash: true,
      authProvider: true,
      emailVerified: true,
      mobileVerified: true,
      avatarUrl: true,
      status: true,
      loginAttempts: true,
      lockedUntil: true,
    },
  });

  // Use same error for "not found" and "wrong password" — prevents user enumeration
  if (!user || !user.passwordHash) {
    throw Errors.invalidCredentials();
  }

  // Check account status
  assertAccountActive(user);

  // Check lockout
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const minutesLeft = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
    throw Errors.forbidden(
      `Account locked. Try again in ${minutesLeft} minute(s).`,
      ErrorCode.ACCOUNT_LOCKED
    );
  }

  const passwordMatch = await comparePassword(input.password, user.passwordHash);

  if (!passwordMatch) {
    await handleFailedLogin(user.id, user.loginAttempts);
    throw Errors.invalidCredentials();
  }

  // Reset login attempts on success
  await prisma.user.update({
    where: { id: user.id },
    data: {
      loginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      lastLoginIp: ip,
    },
  });

  const tokens = await generateAndStoreTokens(user.id, "user", ip);

  log.info({ userId: user.id }, "User logged in with email");

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      mobile: user.mobile,
      emailVerified: user.emailVerified,
      mobileVerified: user.mobileVerified,
      avatarUrl: user.avatarUrl,
    },
    tokens,
  };
}

// =============================================================================
// OTP — SEND
// =============================================================================
export async function sendOtp(input: SendOtpInput): Promise<{ message: string }> {
  // Rate limit: max 3 OTP sends per 10 minutes per mobile
  const rateLimitKey = RedisKeys.rateLimitOtp(input.mobile);
  const redis = getRedis();
  const attempts = await redis.incr(rateLimitKey);
  if (attempts === 1) {
    await redis.expire(rateLimitKey, CONSTANTS.REDIS_TTL.OTP);
  }
  if (attempts > CONSTANTS.OTP_MAX_ATTEMPTS) {
    throw Errors.rateLimited(
      "Too many OTP requests. Wait 10 minutes and try again.",
      ErrorCode.TOO_MANY_OTP_REQUESTS
    );
  }

  const otp = generateOtp();
  const otpKey = RedisKeys.otp(input.mobile, input.purpose);

  // Store hashed OTP in Redis with TTL
  await safeRedisSet(
    otpKey,
    JSON.stringify({ hash: hashToken(otp), attempts: 0 }),
    CONSTANTS.REDIS_TTL.OTP
  );

  // Store in DB for audit trail
  await prisma.otpRequest.create({
    data: {
      mobile: input.mobile,
      otp: hashToken(otp),
      purpose: input.purpose,
      expiresAt: new Date(Date.now() + CONSTANTS.OTP_EXPIRY_MINUTES * 60 * 1000),
    },
  });

  await sendOtpViaSms(input.mobile, otp);

  log.info({ mobile: input.mobile.slice(0, 6) + "****", purpose: input.purpose }, "OTP sent");
  return { message: "OTP sent successfully" };
}

// =============================================================================
// OTP — VERIFY (LOGIN OR REGISTER)
// =============================================================================
export async function verifyOtp(
  input: VerifyOtpInput,
  ip?: string
): Promise<AuthResult> {
  const otpKey = RedisKeys.otp(input.mobile, input.purpose);
  const stored = await safeRedisGet(otpKey);

  if (!stored) {
    throw Errors.badRequest("OTP expired or not found. Request a new one.", ErrorCode.OTP_EXPIRED);
  }

  const { hash, attempts } = JSON.parse(stored) as { hash: string; attempts: number };

  if (attempts >= CONSTANTS.OTP_MAX_ATTEMPTS) {
    await safeRedisDel(otpKey);
    throw Errors.badRequest(
      "Too many incorrect attempts. Request a new OTP.",
      ErrorCode.OTP_MAX_ATTEMPTS
    );
  }

  if (hashToken(input.otp) !== hash) {
    // Increment attempt counter
    await safeRedisSet(
      otpKey,
      JSON.stringify({ hash, attempts: attempts + 1 }),
      CONSTANTS.REDIS_TTL.OTP
    );
    throw Errors.badRequest("Incorrect OTP", ErrorCode.INVALID_OTP);
  }

  // OTP verified — delete it (one-time use)
  await safeRedisDel(otpKey);

  // Find or create user
  let user = await prisma.user.findUnique({
    where: { mobile: input.mobile },
    select: {
      id: true,
      name: true,
      email: true,
      mobile: true,
      emailVerified: true,
      mobileVerified: true,
      avatarUrl: true,
      status: true,
    },
  });

  if (!user) {
    // REGISTER: create new user
    if (input.purpose === "REGISTER" || !input.name) {
      if (!input.name) {
        throw Errors.badRequest("Name is required for registration", ErrorCode.INVALID_INPUT);
      }
    }
    user = await prisma.user.create({
      data: {
        name: input.name ?? "Student",
        mobile: input.mobile,
        authProvider: AuthProvider.PHONE_OTP,
        mobileVerified: true,
        lastLoginAt: new Date(),
        lastLoginIp: ip,
      },
      select: {
        id: true,
        name: true,
        email: true,
        mobile: true,
        emailVerified: true,
        mobileVerified: true,
        avatarUrl: true,
        status: true,
      },
    });
    log.info({ userId: user.id }, "User registered via OTP");
  } else {
    assertAccountActive(user);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        mobileVerified: true,
        lastLoginAt: new Date(),
        lastLoginIp: ip,
        loginAttempts: 0,
      },
    });
    log.info({ userId: user.id }, "User logged in via OTP");
  }

  const tokens = await generateAndStoreTokens(user.id, "user", ip);
  return { user, tokens };
}

// =============================================================================
// REFRESH TOKEN
// =============================================================================
export async function refreshTokens(
  rawRefreshToken: string,
  ip?: string
): Promise<AuthTokens> {
  const payload = verifyRefreshToken(rawRefreshToken);

  // Look up stored token
  const stored = await prisma.refreshToken.findUnique({
    where: { token: hashToken(rawRefreshToken) },
    include: { user: { select: { id: true, status: true } } },
  });

  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    // Possible token reuse attack — revoke all tokens for this user
    if (stored) {
      log.warn({ userId: stored.userId }, "Refresh token reuse detected — revoking all tokens");
      await prisma.refreshToken.updateMany({
        where: { userId: stored.userId },
        data: { revokedAt: new Date() },
      });
    }
    throw Errors.unauthorized("Invalid refresh token", ErrorCode.TOKEN_REVOKED);
  }

  assertAccountActive(stored.user);

  // Rotate: revoke old token, issue new pair
  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { revokedAt: new Date() },
  });

  return generateAndStoreTokens(stored.userId, "user", ip);
}

// =============================================================================
// LOGOUT
// =============================================================================
export async function logout(userId: string, accessToken: string, refreshToken?: string): Promise<void> {
  // Blacklist access token in Redis until it expires
  const ttl = getTokenRemainingTtl(accessToken);
  if (ttl > 0) {
    const decoded = decodeToken(accessToken);
    if (decoded?.jti) {
      await safeRedisSet(RedisKeys.tokenBlacklist(decoded.jti), "1", ttl);
    }
  }

  // Revoke refresh token if provided
  if (refreshToken) {
    await prisma.refreshToken.updateMany({
      where: { token: hashToken(refreshToken), userId },
      data: { revokedAt: new Date() },
    });
  }

  log.info({ userId }, "User logged out");
}

// =============================================================================
// VERIFY EMAIL
// =============================================================================
export async function verifyEmail(token: string): Promise<{ message: string }> {
  const hashedToken = hashToken(token);

  const user = await prisma.user.findFirst({
    where: { emailVerifyToken: hashedToken },
    select: { id: true, emailVerified: true, name: true, email: true },
  });

  if (!user) {
    throw Errors.badRequest("Invalid or expired verification link");
  }

  if (user.emailVerified) {
    return { message: "Email already verified" };
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerified: true,
      emailVerifyToken: null,
    },
  });

  // Welcome email
  sendWelcomeEmail(user.email!, user.name).catch(() => {});

  return { message: "Email verified successfully" };
}

// =============================================================================
// FORGOT PASSWORD
// =============================================================================
export async function forgotPassword(input: ForgotPasswordInput): Promise<{ message: string }> {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true, name: true, email: true },
  });

  // Always return same message — prevents email enumeration
  const successMessage = "If an account exists with this email, you'll receive a reset link.";
  if (!user) return { message: successMessage };

  const resetToken = generateSecureToken();
  const hashedToken = hashToken(resetToken);

  // Store in Redis with 30-min TTL
  await safeRedisSet(
    RedisKeys.passwordReset(hashedToken),
    user.id,
    CONSTANTS.PASSWORD_RESET_TOKEN_EXPIRY_MINUTES * 60
  );

  const resetUrl = `${env.FRONTEND_URL}/reset-password?token=${resetToken}`;
  await sendPasswordResetEmail(user.email!, user.name, resetUrl);

  return { message: successMessage };
}

// =============================================================================
// RESET PASSWORD
// =============================================================================
export async function resetPassword(input: ResetPasswordInput): Promise<{ message: string }> {
  const hashedToken = hashToken(input.token);
  const userId = await safeRedisGet(RedisKeys.passwordReset(hashedToken));

  if (!userId) {
    throw Errors.badRequest("Invalid or expired reset link. Please request a new one.");
  }

  const passwordHash = await hashPassword(input.password);

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash },
  });

  // Invalidate the token
  await safeRedisDel(RedisKeys.passwordReset(hashedToken));

  // Revoke all refresh tokens (force re-login everywhere)
  await prisma.refreshToken.updateMany({
    where: { userId },
    data: { revokedAt: new Date() },
  });

  log.info({ userId }, "Password reset");
  return { message: "Password reset successfully. Please log in." };
}

// =============================================================================
// Private Helpers
// =============================================================================

async function generateAndStoreTokens(
  userId: string,
  type: "user",
  ip?: string
): Promise<AuthTokens> {
  const payload = { sub: userId, type } as const;
  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  await prisma.refreshToken.create({
    data: {
      userId,
      token: hashToken(refreshToken),
      ipAddress: ip,
      expiresAt,
    },
  });

  return {
    accessToken,
    refreshToken,
    expiresIn: 15 * 60, // 15 minutes in seconds
  };
}

function assertAccountActive(user: { status: UserStatus }): void {
  if (user.status === UserStatus.SUSPENDED) {
    throw Errors.forbidden("Your account has been suspended.", ErrorCode.ACCOUNT_SUSPENDED);
  }
  if (user.status === UserStatus.DELETED) {
    throw Errors.unauthorized();
  }
}

async function handleFailedLogin(userId: string, currentAttempts: number): Promise<void> {
  const newAttempts = currentAttempts + 1;
  const shouldLock = newAttempts >= CONSTANTS.MAX_LOGIN_ATTEMPTS;

  await prisma.user.update({
    where: { id: userId },
    data: {
      loginAttempts: newAttempts,
      ...(shouldLock && {
        lockedUntil: new Date(Date.now() + CONSTANTS.LOCKOUT_DURATION_MINUTES * 60 * 1000),
      }),
    },
  });

  if (shouldLock) {
    log.warn({ userId }, `Account locked after ${newAttempts} failed login attempts`);
  }
}

