import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { UserJwtPayload, AdminJwtPayload } from "../types";
import { Errors } from "../utils/errors";
import { generateId } from "../utils/crypto";

// =============================================================================
// JWT Token Service
// Access tokens: short-lived (15m), verified on every request
// Refresh tokens: long-lived (30d), stored in DB, rotated on each use
// =============================================================================

export function signAccessToken(payload: Omit<UserJwtPayload | AdminJwtPayload, "jti" | "iat" | "exp">): string {
  const jti = generateId();
  return jwt.sign(
    { ...payload, jti },
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.JWT_ACCESS_EXPIRY as jwt.SignOptions["expiresIn"] }
  );
}

export function signRefreshToken(payload: Omit<UserJwtPayload | AdminJwtPayload, "jti" | "iat" | "exp">): string {
  const jti = generateId();
  return jwt.sign(
    { ...payload, jti },
    env.JWT_REFRESH_SECRET,
    { expiresIn: env.JWT_REFRESH_EXPIRY as jwt.SignOptions["expiresIn"] }
  );
}

export function verifyAccessToken(token: string): UserJwtPayload | AdminJwtPayload {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET) as UserJwtPayload | AdminJwtPayload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw Errors.tokenExpired();
    }
    throw Errors.tokenInvalid();
  }
}

export function verifyRefreshToken(token: string): UserJwtPayload | AdminJwtPayload {
  try {
    return jwt.verify(token, env.JWT_REFRESH_SECRET) as UserJwtPayload | AdminJwtPayload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw Errors.tokenExpired();
    }
    throw Errors.tokenInvalid();
  }
}

// Decode without verifying (for extracting expiry from expired tokens)
export function decodeToken(token: string): UserJwtPayload | AdminJwtPayload | null {
  try {
    return jwt.decode(token) as UserJwtPayload | AdminJwtPayload | null;
  } catch {
    return null;
  }
}

// Get remaining TTL of a token in seconds (for Redis blacklist TTL)
export function getTokenRemainingTtl(token: string): number {
  const decoded = decodeToken(token);
  if (!decoded?.exp) return 0;
  const remaining = decoded.exp - Math.floor(Date.now() / 1000);
  return Math.max(0, remaining);
}
