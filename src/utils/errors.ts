// =============================================================================
// AppError — Typed, structured errors used everywhere in the codebase
// Never throw raw Error() objects — always use AppError or its subclasses
// =============================================================================

export enum ErrorCode {
  // 400 — Validation / Bad Request
  VALIDATION_ERROR = "VALIDATION_ERROR",
  INVALID_INPUT = "INVALID_INPUT",
  INVALID_OTP = "INVALID_OTP",
  OTP_EXPIRED = "OTP_EXPIRED",
  OTP_MAX_ATTEMPTS = "OTP_MAX_ATTEMPTS",
  INVALID_COUPON = "INVALID_COUPON",
  COUPON_EXPIRED = "COUPON_EXPIRED",
  COUPON_USAGE_LIMIT = "COUPON_USAGE_LIMIT",
  COUPON_NOT_APPLICABLE = "COUPON_NOT_APPLICABLE",

  // 401 — Authentication
  UNAUTHORIZED = "UNAUTHORIZED",
  TOKEN_EXPIRED = "TOKEN_EXPIRED",
  TOKEN_INVALID = "TOKEN_INVALID",
  TOKEN_REVOKED = "TOKEN_REVOKED",
  INVALID_CREDENTIALS = "INVALID_CREDENTIALS",
  EMAIL_NOT_VERIFIED = "EMAIL_NOT_VERIFIED",
  MOBILE_NOT_VERIFIED = "MOBILE_NOT_VERIFIED",

  // 403 — Authorization
  FORBIDDEN = "FORBIDDEN",
  INSUFFICIENT_ROLE = "INSUFFICIENT_ROLE",
  EXAM_SCOPE_DENIED = "EXAM_SCOPE_DENIED",
  ACCOUNT_SUSPENDED = "ACCOUNT_SUSPENDED",
  ACCOUNT_LOCKED = "ACCOUNT_LOCKED",

  // 404 — Not Found
  NOT_FOUND = "NOT_FOUND",
  USER_NOT_FOUND = "USER_NOT_FOUND",
  ADMIN_NOT_FOUND = "ADMIN_NOT_FOUND",
  TEST_NOT_FOUND = "TEST_NOT_FOUND",
  QUESTION_NOT_FOUND = "QUESTION_NOT_FOUND",
  ATTEMPT_NOT_FOUND = "ATTEMPT_NOT_FOUND",
  ORDER_NOT_FOUND = "ORDER_NOT_FOUND",

  // 409 — Conflict
  CONFLICT = "CONFLICT",
  EMAIL_ALREADY_EXISTS = "EMAIL_ALREADY_EXISTS",
  MOBILE_ALREADY_EXISTS = "MOBILE_ALREADY_EXISTS",
  ALREADY_ATTEMPTED = "ALREADY_ATTEMPTED",
  TEST_ALREADY_PUBLISHED = "TEST_ALREADY_PUBLISHED",

  // 422 — Business Logic
  TEST_NOT_ACCESSIBLE = "TEST_NOT_ACCESSIBLE",
  TEST_NOT_PUBLISHED = "TEST_NOT_PUBLISHED",
  TEST_WINDOW_CLOSED = "TEST_WINDOW_CLOSED",
  ATTEMPT_ALREADY_SUBMITTED = "ATTEMPT_ALREADY_SUBMITTED",
  ATTEMPT_IN_PROGRESS = "ATTEMPT_IN_PROGRESS",
  SUBSCRIPTION_REQUIRED = "SUBSCRIPTION_REQUIRED",
  PAYMENT_REQUIRED = "PAYMENT_REQUIRED",
  SUBSCRIPTION_ALREADY_ACTIVE = "SUBSCRIPTION_ALREADY_ACTIVE",

  // 429 — Rate Limit
  RATE_LIMIT_EXCEEDED = "RATE_LIMIT_EXCEEDED",
  TOO_MANY_OTP_REQUESTS = "TOO_MANY_OTP_REQUESTS",
  TOO_MANY_LOGIN_ATTEMPTS = "TOO_MANY_LOGIN_ATTEMPTS",

  // 500 — Server
  INTERNAL_ERROR = "INTERNAL_ERROR",
  DATABASE_ERROR = "DATABASE_ERROR",
  EXTERNAL_SERVICE_ERROR = "EXTERNAL_SERVICE_ERROR",
  PAYMENT_GATEWAY_ERROR = "PAYMENT_GATEWAY_ERROR",
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  public readonly details?: unknown;
  public readonly isOperational: boolean; // false = programmer error, don't expose to client

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details?: unknown,
    isOperational = true
  ) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = isOperational;

    // Maintains proper stack trace in V8
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AppError);
    }
  }

  toJSON() {
    return {
      success: false,
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

// =============================================================================
// Factory functions — clean call sites
// =============================================================================

export const Errors = {
  badRequest: (message: string, code = ErrorCode.INVALID_INPUT, details?: unknown) =>
    new AppError(400, code, message, details),

  validation: (message: string, details?: unknown) =>
    new AppError(400, ErrorCode.VALIDATION_ERROR, message, details),

  unauthorized: (message = "Authentication required", code = ErrorCode.UNAUTHORIZED) =>
    new AppError(401, code, message),

  invalidCredentials: () =>
    new AppError(401, ErrorCode.INVALID_CREDENTIALS, "Invalid email or password"),

  tokenExpired: () =>
    new AppError(401, ErrorCode.TOKEN_EXPIRED, "Token has expired"),

  tokenInvalid: () =>
    new AppError(401, ErrorCode.TOKEN_INVALID, "Token is invalid"),

  forbidden: (message = "Access denied", code = ErrorCode.FORBIDDEN) =>
    new AppError(403, code, message),

  notFound: (resource: string, code?: ErrorCode) =>
    new AppError(404, code ?? ErrorCode.NOT_FOUND, `${resource} not found`),

  conflict: (message: string, code = ErrorCode.CONFLICT) =>
    new AppError(409, code, message),

  business: (message: string, code: ErrorCode) =>
    new AppError(422, code, message),

  rateLimited: (message = "Too many requests", code = ErrorCode.RATE_LIMIT_EXCEEDED) =>
    new AppError(429, code, message),

  internal: (message = "Internal server error") =>
    new AppError(500, ErrorCode.INTERNAL_ERROR, message, undefined, false),
};
