import { FastifyInstance } from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import { getRedis } from "../lib/redis";
import { env } from "../config/env";
import { ErrorCode } from "../utils/errors";

// =============================================================================
// Rate Limiter Plugin — Redis-backed, per-IP by default
// Individual routes can override with their own limits
// =============================================================================

export async function rateLimiterPlugin(app: FastifyInstance): Promise<void> {
  await app.register(fastifyRateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    redis: getRedis(),
    keyGenerator: (request: any) => {
      return (
        request.user?.id ||
        request.admin?.id ||
        request.ip
      );
    },
    errorResponseBuilder: () => ({
      success: false,
      error: {
        code: ErrorCode.RATE_LIMIT_EXCEEDED,
        message: "Too many requests. Please slow down.",
      },
    }),
  } as any);
}

// =============================================================================
// Per-route rate limit configs (import and use in specific routes)
// =============================================================================

export const RateLimits = {
  // Auth endpoints — strict
  login: { max: 5, timeWindow: 15 * 60 * 1000 },           // 5 per 15 min
  register: { max: 3, timeWindow: 60 * 60 * 1000 },         // 3 per hour
  otpSend: { max: 3, timeWindow: 10 * 60 * 1000 },          // 3 per 10 min
  otpVerify: { max: 5, timeWindow: 10 * 60 * 1000 },        // 5 per 10 min
  passwordReset: { max: 3, timeWindow: 60 * 60 * 1000 },    // 3 per hour

  // General API
  default: { max: env.RATE_LIMIT_MAX, timeWindow: env.RATE_LIMIT_WINDOW_MS },
  standard: { max: 60, timeWindow: 60 * 1000 },            // 60 per min (standard routes)
  relaxed: { max: 300, timeWindow: 60 * 1000 },             // 300 per min (for listing)
} as const;
