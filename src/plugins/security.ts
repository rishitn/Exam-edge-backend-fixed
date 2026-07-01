import { FastifyInstance } from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import { env } from "../config/env";

// =============================================================================
// Security Plugin — CORS + Helmet security headers
// =============================================================================

export async function securityPlugin(app: FastifyInstance): Promise<void> {
  // CORS — only allow our own frontends
  await app.register(fastifyCors, {
   origin: [env.FRONTEND_URL, env.ADMIN_URL, env.SUPER_ADMIN_URL, "https://exam-edge-frontend.vercel.app"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-ID"],
    exposedHeaders: ["X-Request-ID", "X-RateLimit-Limit", "X-RateLimit-Remaining"],
    credentials: true,
    maxAge: 86400, // 24h preflight cache
  });

  // Helmet — sets security headers
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false, // Needed for some S3 image loads
  });
}
