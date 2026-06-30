import Redis from "ioredis";
import { env } from "../config/env";
import { logger } from "./logger";

// =============================================================================
// Redis Client — singleton with reconnect strategy
// =============================================================================

let redisInstance: Redis | null = null;

export function getRedis(): Redis {
  if (redisInstance) return redisInstance;

  redisInstance = new Redis(env.REDIS_URL, {
    password: env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      if (times > 10) {
        logger.error("Redis: Max retries reached. Giving up.");
        return null; // Stop retrying
      }
      const delay = Math.min(times * 100, 3000);
      logger.warn(`Redis: Retrying connection in ${delay}ms (attempt ${times})`);
      return delay;
    },
    reconnectOnError(err) {
      const targetErrors = ["READONLY", "ECONNRESET", "ETIMEDOUT"];
      return targetErrors.some((e) => err.message.includes(e));
    },
    lazyConnect: false,
    keepAlive: 30000,
    connectTimeout: 10000,
    commandTimeout: 5000,
    enableReadyCheck: true,
  });

  redisInstance.on("connect", () => logger.info("Redis: Connected"));
  redisInstance.on("ready", () => logger.info("Redis: Ready"));
  redisInstance.on("error", (err) => logger.error({ err }, "Redis: Error"));
  redisInstance.on("close", () => logger.warn("Redis: Connection closed"));
  redisInstance.on("reconnecting", () => logger.info("Redis: Reconnecting..."));

  return redisInstance;
}

export async function disconnectRedis(): Promise<void> {
  if (redisInstance) {
    await redisInstance.quit();
    redisInstance = null;
  }
}

// =============================================================================
// Typed Redis Helpers — all keys in one place, no raw strings scattered around
// =============================================================================

export const RedisKeys = {
  // OTP
  otp: (mobile: string, purpose: string) => `otp:${mobile}:${purpose}`,
  otpAttempts: (mobile: string) => `otp_attempts:${mobile}`,

  // Rate limiting
  rateLimitLogin: (ip: string) => `ratelimit:login:${ip}`,
  rateLimitOtp: (mobile: string) => `ratelimit:otp:${mobile}`,
  rateLimitApi: (ip: string) => `ratelimit:api:${ip}`,

  // Account lockout
  loginLockout: (identifier: string) => `lockout:${identifier}`,
  loginAttempts: (identifier: string) => `login_attempts:${identifier}`,

  // Session / token blacklist
  tokenBlacklist: (jti: string) => `blacklist:token:${jti}`,

  // Leaderboard
  leaderboard: (testId: string) => `leaderboard:${testId}`,
  leaderboardRank: (testId: string, userId: string) => `leaderboard:${testId}:user:${userId}`,

  // Test attempt (auto-save buffer)
  attemptAnswers: (attemptId: string) => `attempt:${attemptId}:answers`,
  activeAttempts: () => `active_attempts`,

  // Cached metadata
  testMeta: (testId: string) => `test:meta:${testId}`,
  platformSettings: () => `platform:settings`,

  // Email verify / password reset tokens
  emailVerify: (token: string) => `email_verify:${token}`,
  passwordReset: (token: string) => `password_reset:${token}`,
} as const;

// =============================================================================
// Safe Redis Operations — never throw, always return null on failure
// =============================================================================

export async function safeRedisGet(key: string): Promise<string | null> {
  try {
    return await getRedis().get(key);
  } catch (err) {
    logger.error({ err, key }, "Redis: GET failed");
    return null;
  }
}

export async function safeRedisSet(
  key: string,
  value: string,
  ttlSeconds?: number
): Promise<boolean> {
  try {
    const redis = getRedis();
    if (ttlSeconds) {
      await redis.set(key, value, "EX", ttlSeconds);
    } else {
      await redis.set(key, value);
    }
    return true;
  } catch (err) {
    logger.error({ err, key }, "Redis: SET failed");
    return false;
  }
}

export async function safeRedisDel(key: string): Promise<boolean> {
  try {
    await getRedis().del(key);
    return true;
  } catch (err) {
    logger.error({ err, key }, "Redis: DEL failed");
    return false;
  }
}

export async function safeRedisIncr(key: string, ttlSeconds?: number): Promise<number | null> {
  try {
    const redis = getRedis();
    const val = await redis.incr(key);
    if (val === 1 && ttlSeconds) {
      await redis.expire(key, ttlSeconds);
    }
    return val;
  } catch (err) {
    logger.error({ err, key }, "Redis: INCR failed");
    return null;
  }
}
