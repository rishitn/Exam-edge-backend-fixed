import { FastifyRequest, FastifyReply } from "fastify";

// =============================================================================
// asyncHandler — wraps route handlers to catch errors and forward to
// Fastify's error handler, eliminating try/catch in every route
// =============================================================================

type RouteHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

export function asyncHandler(fn: RouteHandler): RouteHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      return await fn(request, reply);
    } catch (error) {
      reply.send(error); // Fastify forwards to setErrorHandler
    }
  };
}
