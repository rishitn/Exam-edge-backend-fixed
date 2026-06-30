import { FastifyInstance, FastifyError } from "fastify";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { AppError, ErrorCode } from "../utils/errors";
import { createLogger } from "../lib/logger";
import { env } from "../config/env";

const log = createLogger("error-handler");

// =============================================================================
// Global Error Handler Plugin
// Normalizes ALL errors into the standard { success, error } shape
// Handles: AppError, ZodError, Prisma errors, Fastify built-ins, unknown errors
// =============================================================================

export async function errorHandlerPlugin(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((error, request, reply) => {
    // ── AppError (our own structured errors) ──────────────────────────────────
    if (error instanceof AppError) {
      if (!error.isOperational) {
        log.error(
          { err: error, requestId: request.id, url: request.url },
          "Programmer error (non-operational AppError)"
        );
      }
      return reply.code(error.statusCode).send(error.toJSON());
    }

    // ── Zod Validation Errors ─────────────────────────────────────────────────
    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      }));
      return reply.code(400).send({
        success: false,
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          message: "Validation failed",
          details,
        },
      });
    }

    // ── Prisma Errors ─────────────────────────────────────────────────────────
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      // P2002: Unique constraint violation
      if (error.code === "P2002") {
        const fields = (error.meta?.target as string[]) ?? ["field"];
        return reply.code(409).send({
          success: false,
          error: {
            code: ErrorCode.CONFLICT,
            message: `${fields.join(", ")} already exists`,
          },
        });
      }

      // P2025: Record not found
      if (error.code === "P2025") {
        return reply.code(404).send({
          success: false,
          error: {
            code: ErrorCode.NOT_FOUND,
            message: "Record not found",
          },
        });
      }

      // P2003: Foreign key constraint
      if (error.code === "P2003") {
        return reply.code(400).send({
          success: false,
          error: {
            code: ErrorCode.INVALID_INPUT,
            message: "Referenced record does not exist",
          },
        });
      }

      log.error({ err: error, code: error.code }, "Unhandled Prisma error");
      return reply.code(500).send({
        success: false,
        error: {
          code: ErrorCode.DATABASE_ERROR,
          message: "Database error",
        },
      });
    }

    if (error instanceof Prisma.PrismaClientValidationError) {
      log.error({ err: error }, "Prisma validation error");
      return reply.code(400).send({
        success: false,
        error: {
          code: ErrorCode.INVALID_INPUT,
          message: "Invalid data provided",
        },
      });
    }

    // ── Fastify Built-in Errors (404, 405, body parsing, etc.) ────────────────
    const fastifyError = error as FastifyError;
    if (fastifyError.statusCode) {
      // Body parsing errors
      if (fastifyError.statusCode === 400 && fastifyError.code?.startsWith("FST_ERR_CTP")) {
        return reply.code(400).send({
          success: false,
          error: {
            code: ErrorCode.INVALID_INPUT,
            message: "Invalid request body",
          },
        });
      }

      // Rate limit
      if (fastifyError.statusCode === 429) {
        return reply.code(429).send({
          success: false,
          error: {
            code: ErrorCode.RATE_LIMIT_EXCEEDED,
            message: "Too many requests. Please slow down.",
          },
        });
      }

      if (fastifyError.statusCode < 500) {
        return reply.code(fastifyError.statusCode).send({
          success: false,
          error: {
            code: ErrorCode.INVALID_INPUT,
            message: fastifyError.message,
          },
        });
      }
    }

    // ── Unknown / Unexpected Error ─────────────────────────────────────────────
    log.error(
      {
        err: error,
        requestId: request.id,
        url: request.url,
        method: request.method,
        body: request.body,
      },
      "Unhandled error"
    );

    return reply.code(500).send({
      success: false,
      error: {
        code: ErrorCode.INTERNAL_ERROR,
        message: "An unexpected error occurred",
        // Only expose details in development
        ...(env.NODE_ENV === "development" && {
          details: {
            name: (error as Error).name,
            message: (error as Error).message,
            stack: (error as Error).stack,
          },
        }),
      },
    });
  });

  // 404 handler for routes that don't exist
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      success: false,
      error: {
        code: ErrorCode.NOT_FOUND,
        message: `Route ${request.method} ${request.url} not found`,
      },
    });
  });
}
