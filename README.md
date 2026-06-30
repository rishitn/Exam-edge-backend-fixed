# ExamEdge Backend API

Production-grade online examination platform for NEET, JEE, and CUET.

---

## Quick Start

### Prerequisites

- [Node.js 20+](https://nodejs.org) (LTS recommended)
- [Docker Desktop](https://www.docker.com/products/docker-desktop)

### 1. Clone and install

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Open `.env` and set the **minimum required values** for local development:

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | ✅ Always | Set automatically via docker-compose |
| `REDIS_URL` | ✅ Always | Set automatically via docker-compose |
| `JWT_ACCESS_SECRET` | ✅ Always | Any random 32+ char string |
| `JWT_REFRESH_SECRET` | ✅ Always | A different random 32+ char string |
| `GOOGLE_CLIENT_ID` | ⚠️ Prod only | Needed for Google OAuth login |
| `GOOGLE_CLIENT_SECRET` | ⚠️ Prod only | Needed for Google OAuth login |
| `MSG91_AUTH_KEY` | ⚠️ Prod only | Needed for SMS OTP |
| `AWS_ACCESS_KEY_ID` | ⚠️ Prod only | Needed for file uploads |
| `AWS_SECRET_ACCESS_KEY` | ⚠️ Prod only | Needed for file uploads |
| `AWS_S3_BUCKET` | ⚠️ Prod only | Needed for file uploads |
| `SMTP_HOST` / `SMTP_USER` | ⚠️ Prod only | Needed for email sending |
| `RAZORPAY_KEY_ID` | ⚠️ Prod only | Needed for payments |

> **Note:** In `development` mode, all third-party service vars are optional. The server will boot without them — those features will simply fail at runtime when called.

### 3. Start infrastructure

```bash
docker-compose up -d
```

This starts **PostgreSQL** (port 5432) and **Redis** (port 6379).

### 4. Set up the database

```bash
# Generate Prisma client (must run after npm install or schema changes)
npx prisma generate

# Create tables (run migrations)
npx prisma migrate dev --name init

# Seed reference data (subjects, chapters, topics, super admin)
npx prisma db seed
```

### 5. Start the server

```bash
npm run dev
```

Server: `http://localhost:3001`  
Health check: `http://localhost:3001/health/ready`  
API base: `http://localhost:3001/api/v1`

---

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start dev server with hot reload (ts-node-dev) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled production build |
| `npx prisma generate` | Regenerate Prisma client after schema changes |
| `npx prisma migrate dev` | Apply pending migrations (dev only) |
| `npx prisma migrate deploy` | Apply migrations (production) |
| `npx prisma db seed` | Seed the database with reference data |
| `npx prisma studio` | Open interactive database browser GUI |

---

## Project Structure

```
src/
├── config/         # env validation, constants
├── lib/            # shared clients (prisma, redis, jwt, s3, email, sms)
├── middleware/     # auth middleware
├── modules/        # feature modules (auth, admin-auth, questions, health)
│   └── <module>/
│       ├── <module>.routes.ts
│       ├── schemas/   # Zod validation schemas
│       └── services/  # business logic
├── plugins/        # Fastify plugins (error handler, rate limiter, security)
├── types/          # global TypeScript types
└── utils/          # shared utilities (errors, pagination, response, crypto)
prisma/
├── schema.prisma   # database schema
└── seeds/          # seed scripts
```

---

## Environment Variable Reference

Copy `.env.example` to `.env`. All variables with defaults are optional locally.

```env
# ── App ─────────────────────────────────────────────────
NODE_ENV=development
PORT=3001
FRONTEND_URL=http://localhost:3000
ADMIN_URL=http://localhost:3002

# ── Database (docker-compose sets these) ────────────────
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/examedge
REDIS_URL=redis://localhost:6379

# ── JWT (generate with: openssl rand -base64 48) ────────
JWT_ACCESS_SECRET=change_me_at_least_32_chars_long_abc
JWT_REFRESH_SECRET=change_me_different_32_chars_long_xyz

# ── Google OAuth (prod only) ─────────────────────────────
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=http://localhost:3001/api/v1/auth/google/callback

# ── SMS OTP via MSG91 (prod only) ───────────────────────
MSG91_AUTH_KEY=
MSG91_TEMPLATE_ID=

# ── AWS S3 (prod only) ──────────────────────────────────
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=ap-south-1
AWS_S3_BUCKET=
AWS_S3_BASE_URL=

# ── SMTP Email (prod only) ──────────────────────────────
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASSWORD=
EMAIL_FROM=noreply@examedge.in

# ── Razorpay (prod only) ────────────────────────────────
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
```

---

## Troubleshooting

**`Cannot find module '../../../lib/prisma'`**  
Run `npx prisma generate` — the Prisma client must be generated before TypeScript can compile.

**`❌ Invalid environment configuration`**  
Check your `.env` file. In development only `DATABASE_URL`, `REDIS_URL`, `JWT_ACCESS_SECRET`, and `JWT_REFRESH_SECRET` are required.

**`Redis connection refused`**  
Run `docker-compose up -d` to start the Redis container.

**`P1001: Can't reach database server`**  
Run `docker-compose up -d` to start the PostgreSQL container.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 + TypeScript |
| Framework | Fastify |
| Database | PostgreSQL via Prisma ORM |
| Cache / Sessions | Redis |
| Auth | JWT + Google OAuth + SMS OTP (MSG91) |
| File Storage | AWS S3 |
| Email | Nodemailer (SMTP) |
| Payments | Razorpay |
| Logging | Pino |
