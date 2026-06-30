import { FastifyInstance } from "fastify";
import crypto from "crypto";

// =============================================================================
// Request Context Plugin
// Attaches a unique request ID to every request for tracing
// Also adds server timing headers for performance monitoring
// =============================================================================

export async function requestContextPlugin(app: FastifyInstance): Promise<void> {
  // Add request ID to every request (use client-provided ID or generate one)
  app.addHook("onRequest", async (request, reply) => {
    const requestId =
      (request.headers["x-request-id"] as string) ||
      crypto.randomBytes(8).toString("hex");

    // Make it available on request object
    (request as any).id = requestId;

    // Echo it back in response headers
    reply.header("X-Request-ID", requestId);

    // Start timing
    (request as any)._startTime = process.hrtime.bigint();
  });

  // Add server timing header on response
  app.addHook("onSend", async (request, reply) => {
    const start = (request as any)._startTime as bigint | undefined;
    if (start) {
      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      reply.header("Server-Timing", `total;dur=${durationMs.toFixed(2)}`);
    }
  });
}
