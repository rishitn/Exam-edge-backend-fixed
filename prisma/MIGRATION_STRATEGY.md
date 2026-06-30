# ExamEdge — Database Migration & Index Strategy

## Migration Workflow

```bash
# Initial setup
npx prisma migrate dev --name init

# After schema changes
npx prisma migrate dev --name <descriptive_name>

# Production deploy (no prompt, no rollback)
npx prisma migrate deploy

# Reset dev DB (DANGER: destroys all data)
npx prisma migrate reset

# Seed after migration
npx prisma db seed

# Open Prisma Studio (DB GUI)
npx prisma studio
```

---

## Index Strategy

### Why These Indexes

#### users table
| Index | Reason |
|---|---|
| email | Login lookup |
| mobile | OTP login lookup |
| status | Filter active users in queries |
| createdAt | Admin analytics — new signups over time |

#### questions table
| Index | Reason |
|---|---|
| exam | Filter questions by exam in admin panel |
| subjectId, chapterId, topicId | Drill-down taxonomy filters |
| type | Filter by question type in test builder |
| difficulty | Filter by difficulty in test builder |
| status | Only surface ACTIVE questions in test builder |
| createdById | Admin sees their own questions |
| tags | Tag-based search (GIN index recommended for array) |

#### tests table
| Index | Reason |
|---|---|
| exam + status | Student listing: show published tests by exam |
| scheduledFrom, scheduledUntil | Time-window filtering |
| isFree | Quick free/paid filter |
| createdById | Admin dashboard — admin sees their tests |

#### test_attempts table
| Index | Reason |
|---|---|
| userId | Student's attempt history |
| testId | All attempts for a test (leaderboard computation) |
| status | Filter IN_PROGRESS attempts (for resume detection) |
| rank | Sorting leaderboard from DB |

#### attempt_answers table
| Index | Reason |
|---|---|
| attemptId | Fetch all answers for an attempt (result page) |
| questionId | Analytics — how many students got Q correct |

#### orders table
| Index | Reason |
|---|---|
| userId | Student's order history |
| testId | Revenue per test |
| status | Filter successful payments |
| razorpayOrderId | Webhook lookup |
| createdAt | Revenue timeline analytics |

#### audit_logs table
| Index | Reason |
|---|---|
| adminId | Super admin views one admin's actions |
| entityType + entityId | All actions on a specific entity |
| createdAt | Time-range audit queries |

---

## Recommended PostgreSQL Extensions

```sql
-- Run these ONCE on your database:
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";      -- UUID generation (backup to cuid)
CREATE EXTENSION IF NOT EXISTS "pg_trgm";         -- Trigram similarity for fuzzy search
CREATE EXTENSION IF NOT EXISTS "btree_gin";       -- GIN indexes on scalar types
CREATE EXTENSION IF NOT EXISTS "unaccent";        -- Accent-insensitive search

-- GIN index for array fields (tags search) — run after migration:
CREATE INDEX CONCURRENTLY idx_questions_tags_gin
  ON questions USING GIN (tags);

CREATE INDEX CONCURRENTLY idx_tests_tags_gin
  ON tests USING GIN (tags);

-- Partial index: only index published tests (most common query)
CREATE INDEX CONCURRENTLY idx_tests_published
  ON tests (exam, scheduled_from, scheduled_until)
  WHERE status = 'PUBLISHED';

-- Partial index: only active questions
CREATE INDEX CONCURRENTLY idx_questions_active
  ON questions (exam, subject_id, chapter_id, difficulty)
  WHERE status = 'ACTIVE' AND deleted_at IS NULL;
```

---

## Data Partitioning Plan (When You Hit Scale)

### Phase 1 (0 → 100k users): No partitioning needed
### Phase 2 (100k → 500k users): Partition `attempt_answers` by `created_at` (monthly)
### Phase 3 (500k → 1M+ users): Partition `test_attempts` and `audit_logs` by month

```sql
-- Example: Partition attempt_answers by month (Phase 2)
CREATE TABLE attempt_answers (
  ...
) PARTITION BY RANGE (created_at);

CREATE TABLE attempt_answers_2025_01
  PARTITION OF attempt_answers
  FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
```

---

## Connection Pooling

Use **PgBouncer** in transaction mode for production:

```
DATABASE_URL="postgresql://user:pass@pgbouncer:6432/examedge?pgbouncer=true&connection_limit=1"
DIRECT_URL="postgresql://user:pass@postgres:5432/examedge"
```

In `schema.prisma`:
```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")      // PgBouncer (pooled)
  directUrl = env("DIRECT_URL")        // Direct (for migrations)
}
```

---

## Redis Keys Architecture

The following Redis keys are used alongside PostgreSQL:

```
# Leaderboard sorted set (score as member weight)
leaderboard:{testId}                   ZADD / ZRANK / ZREVRANK

# Real-time rank for a user
leaderboard:{testId}:user:{userId}     GET / SET (cached rank)

# In-progress attempt answers (auto-save buffer)
attempt:{attemptId}:answers            HSET (field = questionId, value = JSON)

# OTP store
otp:{mobile}:{purpose}                 SET with 10min TTL

# Rate limiting
ratelimit:login:{ip}                   INCR with TTL
ratelimit:otp:{mobile}                 INCR with TTL

# Session / Active test takers
active_attempts                        SADD / SREM (set of attemptIds)

# Cached test metadata (avoid DB hit on every question load)
test:meta:{testId}                     SET with 5min TTL (JSON)

# Platform settings cache
platform:settings                      HSET (key = setting key, value = JSON)
```

---

## Environment Variables Required

```bash
# Database
DATABASE_URL="postgresql://user:password@localhost:5432/examedge"
DIRECT_URL="postgresql://user:password@localhost:5432/examedge"

# Redis
REDIS_URL="redis://localhost:6379"

# Auth
JWT_ACCESS_SECRET="<32-char-random>"
JWT_REFRESH_SECRET="<32-char-random>"
JWT_ACCESS_EXPIRY="15m"
JWT_REFRESH_EXPIRY="30d"

# Google OAuth
GOOGLE_CLIENT_ID="..."
GOOGLE_CLIENT_SECRET="..."

# MSG91
MSG91_AUTH_KEY="..."
MSG91_TEMPLATE_ID="..."
MSG91_SENDER_ID="EXAMEG"

# Razorpay
RAZORPAY_KEY_ID="..."
RAZORPAY_KEY_SECRET="..."
RAZORPAY_WEBHOOK_SECRET="..."

# AWS S3
AWS_ACCESS_KEY_ID="..."
AWS_SECRET_ACCESS_KEY="..."
AWS_REGION="ap-south-1"
AWS_S3_BUCKET="examedge-assets"

# Super Admin Seed
SUPER_ADMIN_EMAIL="superadmin@examedge.in"
SUPER_ADMIN_PASSWORD="<strong-password>"

# App
NODE_ENV="development"
PORT=3001
FRONTEND_URL="http://localhost:3000"
```

---

## Key Design Decisions & Rationale

### 1. CUID over UUID
CUIDs are URL-safe, shorter, and collision-resistant. Better for URLs like `/tests/clx...`.

### 2. JSON columns for question content
Question types have wildly different structures. JSON avoids 5 separate nullable tables while keeping the schema clean. Validated at the application layer.

### 3. Soft deletes (deletedAt)
Users and Questions use soft deletes. This preserves historical attempt data integrity. Hard deletes cascade would corrupt past attempt analytics.

### 4. Denormalized counters (totalAttempts, usageCount)
Updated atomically via Prisma `increment`. Avoids expensive COUNT(*) queries on hot paths.

### 5. SectionMarkingScheme as separate table
Not a JSON blob on Test. This allows per-section, per-question-type scheme overrides and is queryable. Critical for JEE Advanced where different question types carry different marks in the same section.

### 6. LeaderboardEntry separate from TestAttempt
Leaderboard is a denormalized, fast-read table. Real-time updates go to Redis first, then sync to LeaderboardEntry every 60 seconds. TestAttempt holds the source of truth.

### 7. CouponUsage separate from Order
Allows querying "how many times has user X used coupon Y" without scanning orders. Enables per-user coupon limits efficiently.

### 8. MediaAsset registry
Every S3 upload is registered here. Allows detecting orphaned assets (questions deleted but images remaining), enabling periodic S3 cleanup jobs.
