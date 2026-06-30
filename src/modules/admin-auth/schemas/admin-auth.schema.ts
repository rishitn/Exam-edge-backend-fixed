import { z } from "zod";

// =============================================================================
// Admin Auth Schemas
// =============================================================================

export const AdminLoginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1, "Password is required"),
  totpCode: z.string().length(6).regex(/^\d+$/).optional(), // Required if 2FA enabled
});

export const AdminRefreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
});

export const AdminSetupTotpSchema = z.object({
  totpCode: z.string().length(6).regex(/^\d+$/, "TOTP must be 6 digits"),
});

export const CreateAdminSchema = z.object({
  name: z.string().min(2).max(100).trim(),
  email: z.string().email().toLowerCase(),
  assignedExams: z
    .array(z.enum(["NEET", "JEE_MAIN", "JEE_ADVANCED", "CUET"]))
    .min(1, "Assign at least one exam"),
});

export const UpdateAdminSchema = z.object({
  name: z.string().min(2).max(100).trim().optional(),
  assignedExams: z
    .array(z.enum(["NEET", "JEE_MAIN", "JEE_ADVANCED", "CUET"]))
    .min(1)
    .optional(),
  status: z.enum(["ACTIVE", "INACTIVE", "SUSPENDED"]).optional(),
});

export const AdminChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z
    .string()
    .min(8)
    .regex(/[A-Z]/)
    .regex(/[a-z]/)
    .regex(/[0-9]/),
});

export type AdminLoginInput = z.infer<typeof AdminLoginSchema>;
export type CreateAdminInput = z.infer<typeof CreateAdminSchema>;
export type UpdateAdminInput = z.infer<typeof UpdateAdminSchema>;
