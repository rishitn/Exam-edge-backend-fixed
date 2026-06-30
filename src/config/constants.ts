// =============================================================================
// App-wide constants — never magic numbers in code
// =============================================================================

export const CONSTANTS = {
  // Auth
  BCRYPT_ROUNDS: 12,
  OTP_LENGTH: 6,
  OTP_EXPIRY_MINUTES: 10,
  OTP_MAX_ATTEMPTS: 3,
  MAX_LOGIN_ATTEMPTS: 5,
  LOCKOUT_DURATION_MINUTES: 15,
  REFRESH_TOKEN_ROTATION: true,

  // Tokens
  EMAIL_VERIFY_TOKEN_EXPIRY_HOURS: 24,
  PASSWORD_RESET_TOKEN_EXPIRY_MINUTES: 30,

  // Pagination
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,

  // Test engine
  ANSWER_AUTOSAVE_INTERVAL_SECONDS: 30,
  MAX_TAB_SWITCHES_ALLOWED: 1,

  // Uploads
  MAX_UPLOAD_SIZE_MB: 5,
  ALLOWED_IMAGE_TYPES: ["image/jpeg", "image/png", "image/webp"],

  // Leaderboard
  LEADERBOARD_SYNC_INTERVAL_SECONDS: 60,
  LEADERBOARD_TOP_N_CACHE: 100, // Cache top 100 in Redis

  // Redis TTLs (seconds)
  REDIS_TTL: {
    OTP: 10 * 60,              // 10 minutes
    SESSION: 30 * 24 * 60 * 60, // 30 days
    TEST_META: 5 * 60,          // 5 minutes
    PLATFORM_SETTINGS: 60 * 60, // 1 hour
    RATE_LIMIT: 60,             // 1 minute window
    RANK_CACHE: 60,             // 1 minute
  },

  // Pagination cursor
  CURSOR_SECRET: "examedge_cursor_v1",
} as const;
