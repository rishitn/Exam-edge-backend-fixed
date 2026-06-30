import { z } from "zod";

// =============================================================================
// Environment Schema — validated at startup
// External services (Google OAuth, SMS, S3, Email, Razorpay) are optional in
// development so the server can boot without a full third-party setup.
// =============================================================================

const isDev = process.env.NODE_ENV !== "production";

// Helper: required in prod, optional in dev
const prodRequired = (schema: z.ZodString) =>
  isDev ? schema.optional() : schema;

const envSchema = z.object({
  // App
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  API_VERSION: z.string().default("v1"),
  FRONTEND_URL: z.string().url().default("http://localhost:3000"),
  ADMIN_URL: z.string().url().default("http://localhost:3002"),
  SUPER_ADMIN_URL: z.string().url().default("http://localhost:3003"),

  // Database — always required
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().min(1).optional(),

  // Redis — always required
  REDIS_URL: z.string().min(1),
  REDIS_PASSWORD: z.string().optional(),

  // JWT — always required
  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
  JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET must be at least 32 characters"),
  JWT_ACCESS_EXPIRY: z.string().default("15m"),
  JWT_REFRESH_EXPIRY: z.string().default("30d"),

  // Google OAuth — optional in dev
  GOOGLE_CLIENT_ID: prodRequired(z.string().min(1)),
  GOOGLE_CLIENT_SECRET: prodRequired(z.string().min(1)),
  GOOGLE_CALLBACK_URL: isDev
    ? z.string().url().default("http://localhost:3001/api/v1/auth/google/callback")
    : z.string().url(),

  // MSG91 SMS — optional in dev
  MSG91_AUTH_KEY: prodRequired(z.string().min(1)),
  MSG91_TEMPLATE_ID: prodRequired(z.string().min(1)),
  MSG91_SENDER_ID: z.string().default("EXAMEG"),

  // Razorpay — optional in dev
  RAZORPAY_KEY_ID: prodRequired(z.string().min(1)),
  RAZORPAY_KEY_SECRET: prodRequired(z.string().min(1)),
  RAZORPAY_WEBHOOK_SECRET: prodRequired(z.string().min(1)),

  // AWS S3 — optional in dev
  AWS_ACCESS_KEY_ID: prodRequired(z.string().min(1)),
  AWS_SECRET_ACCESS_KEY: prodRequired(z.string().min(1)),
  AWS_REGION: z.string().default("ap-south-1"),
  AWS_S3_BUCKET: prodRequired(z.string().min(1)),
  AWS_S3_BASE_URL: isDev
    ? z.string().url().default("http://localhost:9000")
    : z.string().url(),

  // SMTP — optional in dev
  SMTP_HOST: prodRequired(z.string().min(1)),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: z.coerce.boolean().default(false),
  SMTP_USER: isDev ? z.string().optional() : z.string().email(),
  SMTP_PASSWORD: prodRequired(z.string().min(1)),
  EMAIL_FROM: z.string().default("noreply@examedge.in"),

  // Rate limiting
  RATE_LIMIT_MAX: z.coerce.number().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
});

// Validate on import — process exits immediately on failure
const _parsed = envSchema.safeParse(process.env);

if (!_parsed.success) {
  console.error("\n❌ Invalid environment configuration:\n");
  _parsed.error.issues.forEach((issue) => {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  });
  console.error("\nFix the above issues in your .env file and restart.\n");
  process.exit(1);
}

export const env = _parsed.data;
export type Env = typeof env;
