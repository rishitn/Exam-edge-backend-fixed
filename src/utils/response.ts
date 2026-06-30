import { FastifyReply } from "fastify";

// =============================================================================
// Response Helpers — every API response follows the same shape
//
// Success:  { success: true, data: T, meta?: M }
// Error:    { success: false, error: { code, message, details? } }
// Paginated:{ success: true, data: T[], meta: { total, page, pageSize, hasMore } }
// =============================================================================

export interface PaginationMeta {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasMore: boolean;
}

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

// Build pagination meta from query params + total count
export function buildPaginationMeta(
  total: number,
  page: number,
  pageSize: number
): PaginationMeta {
  return {
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
    hasMore: page * pageSize < total,
  };
}
