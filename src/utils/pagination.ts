import { CONSTANTS } from "../config/constants";

// =============================================================================
// Pagination Utilities
// =============================================================================

export interface PaginationParams {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

export function parsePagination(
  rawPage?: string | number,
  rawPageSize?: string | number
): PaginationParams {
  const page = Math.max(1, Number(rawPage) || 1);
  const pageSize = Math.min(
    CONSTANTS.MAX_PAGE_SIZE,
    Math.max(1, Number(rawPageSize) || CONSTANTS.DEFAULT_PAGE_SIZE)
  );

  return {
    page,
    pageSize,
    skip: (page - 1) * pageSize,
    take: pageSize,
  };
}

// Safely parse sort order from query strings
export function parseSortOrder(
  order?: string,
  allowed: string[] = ["createdAt", "updatedAt"],
  defaultField = "createdAt"
): { field: string; direction: "asc" | "desc" } {
  // Format: "createdAt:desc" or just "createdAt"
  const [rawField, rawDir] = (order ?? "").split(":");
  const field = allowed.includes(rawField) ? rawField : defaultField;
  const direction: "asc" | "desc" = rawDir === "asc" ? "asc" : "desc";
  return { field, direction };
}

export interface PaginationMeta {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasMore: boolean;
}

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
