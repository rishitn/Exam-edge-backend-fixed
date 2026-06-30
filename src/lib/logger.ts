import pino from "pino";
import { env } from "../config/env";

// =============================================================================
// Logger — Pino for structured JSON logging in production
// Pretty-printed in development for readability
// =============================================================================

export const logger = pino({
  level: env.NODE_ENV === "production" ? "info" : "debug",
  ...(env.NODE_ENV !== "production" && {
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:HH:MM:ss",
        ignore: "pid,hostname",
        messageFormat: "{msg}",
        levelFirst: true,
      },
    },
  }),
  base: {
    env: env.NODE_ENV,
    version: env.API_VERSION,
  },
  serializers: {
    req(req) {
      return {
        method: req.method,
        url: req.url,
        ip: req.ip,
        userAgent: req.headers?.["user-agent"],
      };
    },
    res(res) {
      return {
        statusCode: res.statusCode,
      };
    },
    err: pino.stdSerializers.err,
  },
  redact: {
    // Never log sensitive fields
    paths: [
      "password",
      "passwordHash",
      "token",
      "refreshToken",
      "otp",
      "totpSecret",
      "*.passwordHash",
      "*.token",
      "req.headers.authorization",
      "req.headers.cookie",
    ],
    censor: "[REDACTED]",
  },
});

// Child loggers for different modules — include module context automatically
export const createLogger = (module: string) => logger.child({ module });
