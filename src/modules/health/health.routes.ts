import { FastifyInstance } from "fastify";
import { prisma } from "../../lib/prisma";
import { getRedis } from "../../lib/redis";
import { createLogger } from "../../lib/logger";

const log = createLogger("health");

// =============================================================================
// Health Check Routes
// GET /health        — liveness (is the process up?)
// GET /health/ready  — readiness (is DB + Redis connected?)
// =============================================================================

export async function healthRoutes(app: FastifyInstance): Promise<void> {

  // Liveness — always 200 if process is running
  app.get("/", async (_request, reply) => {
    return reply.code(200).send({
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  // Readiness — checks DB and Redis connectivity
  app.get("/ready", async (_request, reply) => {
    const checks: Record<string, { status: "ok" | "error"; latencyMs?: number; error?: string }> = {};

    // Check PostgreSQL
    const dbStart = Date.now();
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = { status: "ok", latencyMs: Date.now() - dbStart };
    } catch (err) {
      log.error({ err }, "Health: DB check failed");
      checks.database = { status: "error", error: "Database unreachable" };
    }

    // Check Redis
    const redisStart = Date.now();
    try {
      await getRedis().ping();
      checks.redis = { status: "ok", latencyMs: Date.now() - redisStart };
    } catch (err) {
      log.error({ err }, "Health: Redis check failed");
      checks.redis = { status: "error", error: "Redis unreachable" };
    }

    const allOk = Object.values(checks).every((c) => c.status === "ok");

    return reply.code(allOk ? 200 : 503).send({
      status: allOk ? "ready" : "degraded",
      timestamp: new Date().toISOString(),
      checks,
    });
  });
}
