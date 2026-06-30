import { AuthenticatedUser, AuthenticatedAdmin } from "./index";

// =============================================================================
// Fastify Type Augmentation
// Adds typed properties to FastifyRequest so TypeScript knows what's on `request`
// =============================================================================

declare module "fastify" {
  interface FastifyRequest {
    // Set by authenticate middleware
    user?: AuthenticatedUser;
    admin?: AuthenticatedAdmin;

    // Set by rate limiter
    rateLimitKey?: string;

    // Request ID (auto-set by Fastify)
    id: string;
  }
}
