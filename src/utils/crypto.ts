import crypto from "crypto";
import bcrypt from "bcrypt";
import { CONSTANTS } from "../config/constants";

// =============================================================================
// Crypto Utilities
// =============================================================================

// Password hashing
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, CONSTANTS.BCRYPT_ROUNDS);
}

export async function comparePassword(
  plaintext: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}

// Secure random token (URL-safe base64)
export function generateSecureToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

// Numeric OTP
export function generateOtp(length = CONSTANTS.OTP_LENGTH): string {
  const min = Math.pow(10, length - 1);
  const max = Math.pow(10, length) - 1;
  // Use crypto for true randomness — not Math.random()
  const range = max - min + 1;
  const bytesNeeded = Math.ceil(Math.log2(range) / 8);
  let otp: number;
  do {
    const buf = crypto.randomBytes(bytesNeeded);
    otp = parseInt(buf.toString("hex"), 16) % range;
  } while (otp + min > max);
  return (otp + min).toString();
}

// Hash OTP/tokens before storing in DB (never store plaintext OTPs)
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// HMAC signature (for webhook verification)
export function createHmacSignature(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifyHmacSignature(
  payload: string,
  secret: string,
  signature: string
): boolean {
  const expected = createHmacSignature(payload, secret);
  // Timing-safe comparison
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(expected, "hex")
    );
  } catch {
    return false;
  }
}

// Generate a CUID-compatible ID (used when Prisma isn't creating the record)
export function generateId(): string {
  return `c${crypto.randomBytes(16).toString("base64url").slice(0, 24)}`;
}
