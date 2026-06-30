import { PrismaClient } from "@prisma/client";
import { env } from "../config/env";

// =============================================================================
// Prisma Singleton
// Prevents multiple instances in development (hot-reload creates new instances)
// In production: one instance per process
// =============================================================================

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      env.NODE_ENV === "development"
        ? ["query", "info", "warn", "error"]
        : ["warn", "error"],
    errorFormat: env.NODE_ENV === "development" ? "pretty" : "minimal",
  });

if (env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

// Graceful shutdown
export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
