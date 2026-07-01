import Fastify, { FastifyInstance } from "fastify";
import { env } from "./config/env";
import { logger } from "./lib/logger";

// Plugins
import { errorHandlerPlugin } from "./plugins/error-handler";
import { securityPlugin } from "./plugins/security";
import { rateLimiterPlugin } from "./plugins/rate-limiter";
import { requestContextPlugin } from "./plugins/request-context";
import cors from "@fastify/cors";
// Routes
import { healthRoutes } from "./modules/health/health.routes";
import { authRoutes } from "./modules/auth/auth.routes";
import { adminAuthRoutes } from "./modules/admin-auth/admin-auth.routes";
import { questionRoutes } from "./modules/questions/question.routes";
import { testRoutes } from "./modules/tests/test.routes";
import { attemptRoutes } from "./modules/attempts/attempt.routes";
import { analyticsRoutes } from "./modules/analytics/analytics.routes";
import { paymentRoutes } from "./modules/payments/payment.routes";
import { subscriptionRoutes } from "./modules/subscriptions/subscription.routes";
import { couponRoutes } from "./modules/coupons/coupon.routes";
import { studentTestRoutes } from "./modules/student-tests/student-test.routes";

// =============================================================================
// App Factory — creates and configures the Fastify instance
// Exported separately from server start so it can be tested in isolation
// =============================================================================

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // We use our own Pino logger
    requestIdHeader: "x-request-id",
    requestIdLogLabel: "requestId",
    trustProxy: true, // Trust X-Forwarded-For from load balancer
    ajv: {
      customOptions: {
        removeAdditional: false,
        coerceTypes: false,
        allErrors: true,
      },
    },
  });
// Enable CORS for the Vercel frontend
  await app.register(cors, {
    origin: "https://exam-edge-frontend.vercel.app",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    credentials: true,
  });
  // ── Plugins (order matters) ─────────────────────────────────────────────────
  await app.register(requestContextPlugin);
  await app.register(securityPlugin);
  await app.register(rateLimiterPlugin);
  await app.register(errorHandlerPlugin);

  // ── Routes ──────────────────────────────────────────────────────────────────
  const apiPrefix = `/api/${env.API_VERSION}`;

  // Health (no prefix — used by load balancers)
  await app.register(healthRoutes, { prefix: "/health" });

  // Student auth
  await app.register(authRoutes, { prefix: `${apiPrefix}/auth` });

  // Admin auth + admin management
  await app.register(adminAuthRoutes, { prefix: `${apiPrefix}/admin/auth` });

  // Question bank (admin only)
  await app.register(questionRoutes, { prefix: `${apiPrefix}/admin/questions` });

  // Test builder (admin only)
  await app.register(testRoutes, { prefix: `${apiPrefix}/admin/tests` });
  await app.register(attemptRoutes, { prefix: `${apiPrefix}/attempts` });
  await app.register(analyticsRoutes, { prefix: `${apiPrefix}/analytics` });
  await app.register(paymentRoutes, { prefix: `${apiPrefix}/payments` });
  await app.register(subscriptionRoutes, { prefix: `${apiPrefix}/subscriptions` });
  await app.register(couponRoutes, { prefix: `${apiPrefix}/coupons` });

  // Student-facing test listing (public + optional auth)
  await app.register(studentTestRoutes, { prefix: `${apiPrefix}/tests` });

  // Root
  app.get("/", async () => ({
    name: "ExamEdge API",
    version: env.API_VERSION,
    status: "running",
  }));

  // ── Lifecycle Hooks ─────────────────────────────────────────────────────────
  app.addHook("onRequest", async (request) => {
    logger.debug(
      { method: request.method, url: request.url, ip: request.ip },
      "-> Incoming request"
    );
  });

  app.addHook("onResponse", async (request, reply) => {
    logger.info(
      {
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        responseTime: reply.elapsedTime.toFixed(2),
      },
      "<- Response sent"
    );
  });

  return app;
}
