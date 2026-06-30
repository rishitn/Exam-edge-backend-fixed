import axios from "axios";
import { env } from "../config/env";
import { createLogger } from "./logger";
import { AppError, ErrorCode } from "../utils/errors";

const log = createLogger("msg91");

// =============================================================================
// MSG91 OTP Service
// Docs: https://docs.msg91.com/reference/send-otp
// =============================================================================

const MSG91_BASE_URL = "https://control.msg91.com/api/v5";

interface Msg91SendOtpResponse {
  type: "success" | "error";
  message: string;
  request_id?: string;
}

export async function sendOtpViaSms(mobile: string, otp: string): Promise<void> {
  // Normalize mobile — MSG91 expects 91XXXXXXXXXX format
  const normalizedMobile = normalizeMobile(mobile);

  try {
    const response = await axios.post<Msg91SendOtpResponse>(
      `${MSG91_BASE_URL}/otp`,
      {
        template_id: env.MSG91_TEMPLATE_ID,
        mobile: normalizedMobile,
        authkey: env.MSG91_AUTH_KEY,
        otp,
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 10_000,
      }
    );

    if (response.data.type !== "success") {
      log.error({ response: response.data, mobile: normalizedMobile }, "MSG91: OTP send failed");
      throw new AppError(
        502,
        ErrorCode.EXTERNAL_SERVICE_ERROR,
        "Failed to send OTP. Please try again."
      );
    }

    log.info({ mobile: normalizedMobile }, "MSG91: OTP sent");
  } catch (err) {
    if (err instanceof AppError) throw err;
    log.error({ err, mobile: normalizedMobile }, "MSG91: Request failed");
    throw new AppError(
      502,
      ErrorCode.EXTERNAL_SERVICE_ERROR,
      "OTP service unavailable. Please try again."
    );
  }
}

function normalizeMobile(mobile: string): string {
  // Strip everything except digits
  const digits = mobile.replace(/\D/g, "");
  // If already has country code (12 digits starting with 91)
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  // Indian 10-digit number
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

export function validateIndianMobile(mobile: string): boolean {
  const digits = mobile.replace(/\D/g, "");
  // 10 digits, starts with 6-9
  return /^[6-9]\d{9}$/.test(digits);
}
