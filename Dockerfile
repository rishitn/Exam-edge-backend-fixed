FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache openssl

# Install dependencies only when needed
FROM base AS deps
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Build stage
FROM base AS builder
COPY package*.json ./
RUN npm install
COPY . .
RUN npx prisma generate
RUN npm run build

# Generate the Prisma client into the production node_modules too.
# The `deps` stage only ran `npm ci --only=production`, so it never has
# .prisma/client. Without this stage, runner boots with node_modules
# from `deps` (no Prisma client) and crashes immediately with
# "Cannot find module '.prisma/client/default'".
FROM deps AS prod-deps
COPY prisma ./prisma
RUN npx prisma generate

# Production image
FROM base AS runner
ENV NODE_ENV=production

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 examedge
USER examedge

COPY --from=prod-deps --chown=examedge:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=examedge:nodejs /app/dist ./dist
COPY --from=builder --chown=examedge:nodejs /app/prisma ./prisma
COPY --chown=examedge:nodejs package.json ./

EXPOSE 3001
ENV PORT=3001

# Run migrations then start server
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/index.js"]
