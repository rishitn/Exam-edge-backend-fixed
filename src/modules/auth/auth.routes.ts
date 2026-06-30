import { FastifyInstance } from "fastify";
import {
  RegisterWithEmailSchema,
  LoginWithEmailSchema,
  SendOtpSchema,
  VerifyOtpSchema,
  RefreshTokenSchema,
  ForgotPasswordSchema,
  ResetPasswordSchema,
  VerifyEmailSchema,
} from "./schemas/auth.schema";
import * as AuthService from "./services/auth.service";
import { authenticate } from "../../middleware/authenticate";
import { sendSuccess, sendCreated } from "../../utils/response";
import { asyncHandler } from "../../utils/async-handler";
import { RateLimits } from "../../plugins/rate-limiter";

// =============================================================================
// Student Auth Routes — /api/v1/auth/*
// =============================================================================

export async function authRoutes(app: FastifyInstance): Promise<void> {

  // POST /auth/register
  app.post(
    "/register",
    { config: { rateLimit: RateLimits.register } },
    asyncHandler(async (request, reply) => {
      const body = RegisterWithEmailSchema.parse(request.body);
      const result = await AuthService.registerWithEmail(body, request.ip);
      return sendCreated(reply, result);
    })
  );

  // POST /auth/login
  app.post(
    "/login",
    { config: { rateLimit: RateLimits.login } },
    asyncHandler(async (request, reply) => {
      const body = LoginWithEmailSchema.parse(request.body);
      const result = await AuthService.loginWithEmail(body, request.ip);
      return sendSuccess(reply, result);
    })
  );

  // POST /auth/otp/send
  app.post(
    "/otp/send",
    { config: { rateLimit: RateLimits.otpSend } },
    asyncHandler(async (request, reply) => {
      const body = SendOtpSchema.parse(request.body);
      const result = await AuthService.sendOtp(body);
      return sendSuccess(reply, result);
    })
  );

  // POST /auth/otp/verify
  app.post(
    "/otp/verify",
    { config: { rateLimit: RateLimits.otpVerify } },
    asyncHandler(async (request, reply) => {
      const body = VerifyOtpSchema.parse(request.body);
      const result = await AuthService.verifyOtp(body, request.ip);
      return sendSuccess(reply, result);
    })
  );

  // POST /auth/refresh
  app.post(
    "/refresh",
    asyncHandler(async (request, reply) => {
      const body = RefreshTokenSchema.parse(request.body);
      const tokens = await AuthService.refreshTokens(body.refreshToken, request.ip);
      return sendSuccess(reply, { tokens });
    })
  );

  // POST /auth/logout  (requires auth)
  app.post(
    "/logout",
    { preHandler: [authenticate] },
    asyncHandler(async (request, reply) => {
      const authHeader = request.headers.authorization!;
      const accessToken = authHeader.slice(7);
      const body = request.body as { refreshToken?: string };
      await AuthService.logout(request.user!.id, accessToken, body?.refreshToken);
      return sendSuccess(reply, { message: "Logged out successfully" });
    })
  );

  // POST /auth/forgot-password
  app.post(
    "/forgot-password",
    { config: { rateLimit: RateLimits.passwordReset } },
    asyncHandler(async (request, reply) => {
      const body = ForgotPasswordSchema.parse(request.body);
      const result = await AuthService.forgotPassword(body);
      return sendSuccess(reply, result);
    })
  );

  // POST /auth/reset-password
  app.post(
    "/reset-password",
    asyncHandler(async (request, reply) => {
      const body = ResetPasswordSchema.parse(request.body);
      const result = await AuthService.resetPassword(body);
      return sendSuccess(reply, result);
    })
  );

  // GET /auth/verify-email?token=...
  app.get(
    "/verify-email",
    asyncHandler(async (request, reply) => {
      const { token } = VerifyEmailSchema.parse(request.query);
      const result = await AuthService.verifyEmail(token);
      return sendSuccess(reply, result);
    })
  );

  // GET /auth/me  (requires auth — returns current user)
  app.get(
    "/me",
    { preHandler: [authenticate] },
    asyncHandler(async (request, reply) => {
      const user = await import("../../lib/prisma").then(({ prisma }) =>
        prisma.user.findUnique({
          where: { id: request.user!.id },
          select: {
            id: true,
            name: true,
            email: true,
            mobile: true,
            emailVerified: true,
            mobileVerified: true,
            avatarUrl: true,
            targetExams: true,
            city: true,
            state: true,
            preparationYear: true,
            createdAt: true,
            subscription: {
              select: {
                status: true,
                expiresAt: true,
                plan: { select: { name: true } },
              },
            },
          },
        })
      );
      if (!user) throw (await import("../../utils/errors")).Errors.notFound("User");
      return sendSuccess(reply, { user });
    })
  );
}
