import { buildApp } from "./app";
import { env } from "./config/env";
import { logger } from "./lib/logger";
import { disconnectPrisma } from "./lib/prisma";
import { disconnectRedis } from "./lib/redis";

// =============================================================================
// Server Entry Point
// Starts Fastify and handles graceful shutdown on SIGTERM / SIGINT
// =============================================================================

async function start(): Promise<void> {
  logger.info(`🚀 Starting ExamEdge API (${env.NODE_ENV})...`);

  const app = await buildApp();

  try {
    await app.listen({
      port: env.PORT,
      host: "0.0.0.0", // Required for Docker/Railway
    });

    logger.info(`✅ Server running on port ${env.PORT}`);
    logger.info(`📡 API: http://localhost:${env.PORT}/api/${env.API_VERSION}`);
    logger.info(`🏥 Health: http://localhost:${env.PORT}/health`);
  } catch (err) {
    logger.error({ err }, "❌ Failed to start server");
    process.exit(1);
  }

  // ── Graceful Shutdown ───────────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}. Shutting down gracefully...`);

    try {
      // Stop accepting new connections
      await app.close();
      logger.info("Fastify server closed");

      // Close DB connections
      await disconnectPrisma();
      logger.info("Prisma disconnected");

      // Close Redis connections
      await disconnectRedis();
      logger.info("Redis disconnected");

      logger.info("✅ Graceful shutdown complete");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "Error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM")); // Docker / K8s stop
  process.on("SIGINT", () => shutdown("SIGINT"));   // Ctrl+C in dev

  // Handle unhandled promise rejections (last resort)
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "Unhandled promise rejection");
    // Don't exit in production — let it log and continue
    if (env.NODE_ENV !== "production") {
      process.exit(1);
    }
  });

  process.on("uncaughtException", (err) => {
    logger.error({ err }, "Uncaught exception — shutting down");
    shutdown("uncaughtException");
  });
}

start();
