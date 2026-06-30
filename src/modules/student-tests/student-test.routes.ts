import { FastifyInstance } from "fastify";
import { authenticate, optionalAuthenticate } from "../../middleware/authenticate";
import { asyncHandler } from "../../utils/async-handler";
import {
  sendSuccess,
  sendPaginated,
  buildPaginationMeta,
} from "../../utils/response";
import { listTestsQuerySchema, testParamsSchema } from "./schemas/student-test.schema";
import * as StudentTestService from "./services/student-test.service";
import { createLogger } from "../../lib/logger";

const log = createLogger("student-test-routes");

// =============================================================================
// Student Test Listing Routes — /api/v1/tests
//
// Public (guests + authenticated students):
//   GET  /tests                  Browse published tests (paginated, filterable)
//   GET  /tests/:testId          Full detail for a single published test
//
// Student only (auth required):
//   GET  /tests/my               Tests the student can currently access
//   GET  /tests/:testId/attempts My attempt summary for a test (drives CTA state)
// =============================================================================

export async function studentTestRoutes(app: FastifyInstance): Promise<void> {

  // ── GET /tests — Browse published tests ─────────────────────────────────────
  //
  // Available to everyone.  Optional auth is used to tag each test with
  // the student's access status (free / subscribed / purchased / locked / guest).
  app.get(
    "/",
    { preHandler: [optionalAuthenticate] },
    asyncHandler(async (request, reply) => {
      const query = listTestsQuerySchema.parse(request.query);
      const userId = request.user?.id ?? null;

      const { tests, pagination } = await StudentTestService.browseTests(query, userId);

      log.debug({ userId, query }, "GET /tests");
      return sendPaginated(reply, tests, pagination);
    })
  );

  // ── GET /tests/my — Tests accessible to this student ────────────────────────
  //
  // Returns all tests the student can currently start / resume:
  //   • Free tests
  //   • Tests covered by their active subscription
  //   • Tests they've individually purchased
  //
  // Route must be declared BEFORE /:testId so Fastify doesn't treat "my" as an id.
  app.get(
    "/my",
    { preHandler: [authenticate] },
    asyncHandler(async (request, reply) => {
      const tests = await StudentTestService.getMyTests(request.user!.id);
      log.debug({ userId: request.user!.id, count: tests.length }, "GET /tests/my");
      return sendSuccess(reply, tests);
    })
  );

  // ── GET /tests/:testId — Single test detail ──────────────────────────────────
  //
  // Returns sections + instructions.
  // Access status tells the frontend whether to show "Start Test" or "Buy/Subscribe".
  app.get(
    "/:testId",
    { preHandler: [optionalAuthenticate] },
    asyncHandler(async (request, reply) => {
      const { testId } = testParamsSchema.parse(request.params);
      const userId = request.user?.id ?? null;

      const test = await StudentTestService.getTestDetail(testId, userId);

      log.debug({ testId, userId, access: test.access }, "GET /tests/:testId");
      return sendSuccess(reply, test);
    })
  );

  // ── GET /tests/:testId/attempts — My attempt summary for a test ───────────────
  //
  // Lightweight endpoint that drives front-end CTAs:
  //   • No attempts → "Start Test"
  //   • In-progress attempt exists → "Resume"
  //   • Only completed attempts → "Reattempt" + "View Results"
  app.get(
    "/:testId/attempts",
    { preHandler: [authenticate] },
    asyncHandler(async (request, reply) => {
      const { testId } = testParamsSchema.parse(request.params);
      const userId = request.user!.id;

      const summary = await StudentTestService.getTestAttemptSummary(testId, userId);

      log.debug({ testId, userId, summary }, "GET /tests/:testId/attempts");
      return sendSuccess(reply, summary);
    })
  );
}
