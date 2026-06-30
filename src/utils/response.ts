import { FastifyReply } from "fastify";
import { buildPaginationMeta, PaginationMeta } from "./pagination";

// =============================================================================
// Response Helpers — every API response follows the same shape
//
// Success:  { success: true, data: T, meta?: M }
// Error:    { success: false, error: { code, message, details? } }
// Paginated:{ success: true, data: T[], meta: { total, page, pageSize, hasMore } }
// =============================================================================

export type { PaginationMeta } from "./pagination";
export { buildPaginationMeta };

export function sendSuccess<T>(
  reply: FastifyReply,
  data: T,
  statusCode = 200,
  meta?: Record<string, unknown>
): FastifyReply {
  return reply.code(statusCode).send({
    success: true,
    data,
    ...(meta && { meta }),
  });
}

export function sendCreated<T>(reply: FastifyReply, data: T): FastifyReply {
  return sendSuccess(reply, data, 201);
}

export function sendPaginated<T>(
  reply: FastifyReply,
  data: T[],
  pagination: PaginationMeta
): FastifyReply {
  return reply.code(200).send({
    success: true,
    data,
    meta: { pagination },
  });
}

export function sendNoContent(reply: FastifyReply): FastifyReply {
  return reply.code(204).send();
}
