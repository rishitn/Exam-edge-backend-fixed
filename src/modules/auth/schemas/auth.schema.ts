import { z } from "zod";

// =============================================================================
// Student Auth Schemas — validated at route level before hitting service
// =============================================================================

const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(72, "Password too long") // bcrypt max
  .regex(/[A-Z]/, "Must contain at least one uppercase letter")
  .regex(/[a-z]/, "Must contain at least one lowercase letter")
  .regex(/[0-9]/, "Must contain at least one number");

const mobileSchema = z
  .string()
  .regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit Indian mobile number");

const emailSchema = z.string().email("Enter a valid email address").toLowerCase();

export const RegisterWithEmailSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(100).trim(),
  email: emailSchema,
  password: passwordSchema,
  targetExams: z
    .array(z.enum(["NEET", "JEE_MAIN", "JEE_ADVANCED", "CUET"]))
    .min(1, "Select at least one target exam")
    .optional(),
});

export const LoginWithEmailSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Password is required"),
});

export const SendOtpSchema = z.object({
  mobile: mobileSchema,
  purpose: z.enum(["LOGIN", "REGISTER"]).default("LOGIN"),
});

export const VerifyOtpSchema = z.object({
  mobile: mobileSchema,
  otp: z.string().length(6, "OTP must be 6 digits").regex(/^\d+$/, "OTP must be numeric"),
  purpose: z.enum(["LOGIN", "REGISTER"]).default("LOGIN"),
  // Required for REGISTER purpose
  name: z.string().min(2).max(100).trim().optional(),
});

export const RefreshTokenSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token required"),
});

export const ForgotPasswordSchema = z.object({
  email: emailSchema,
});

export const ResetPasswordSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});

export const VerifyEmailSchema = z.object({
  token: z.string().min(1),
});

export const GoogleCallbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().optional(),
});

export type RegisterWithEmailInput = z.infer<typeof RegisterWithEmailSchema>;
export type LoginWithEmailInput = z.infer<typeof LoginWithEmailSchema>;
export type SendOtpInput = z.infer<typeof SendOtpSchema>;
export type VerifyOtpInput = z.infer<typeof VerifyOtpSchema>;
export type RefreshTokenInput = z.infer<typeof RefreshTokenSchema>;
export type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;
