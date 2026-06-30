import { AdminRole, UserStatus, AdminStatus, ExamType } from "@prisma/client";

// =============================================================================
// Global Types
// =============================================================================

// JWT payload shapes
export interface UserJwtPayload {
  sub: string;       // userId
  email?: string;
  mobile?: string;
  type: "user";
  jti?: string;      // JWT ID for blacklisting
  iat?: number;
  exp?: number;
}

export interface AdminJwtPayload {
  sub: string;       // adminId
  email: string;
  role: AdminRole;
  assignedExams: ExamType[];
  type: "admin";
  jti?: string;
  iat?: number;
  exp?: number;
}

export type JwtPayload = UserJwtPayload | AdminJwtPayload;

// Request context — attached to request after authentication
export interface AuthenticatedUser {
  id: string;
  email?: string | null;
  mobile?: string | null;
  status: UserStatus;
  type: "user";
}

export interface AuthenticatedAdmin {
  id: string;
  email: string;
  role: AdminRole;
  assignedExams: ExamType[];
  status: AdminStatus;
  type: "admin";
}

export type AuthenticatedActor = AuthenticatedUser | AuthenticatedAdmin;

// API response shapes
export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

export interface ApiError {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

// Pagination
export interface PaginatedResponse<T> {
  success: true;
  data: T[];
  meta: {
    pagination: {
      total: number;
      page: number;
      pageSize: number;
      totalPages: number;
      hasMore: boolean;
    };
  };
}
