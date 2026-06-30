import { FastifyInstance } from "fastify";
import { authenticate } from "../../middleware/authenticate";
import { sendSuccess, sendCreated } from "../../utils/response";
import { asyncHandler } from "../../utils/async-handler";
import { RateLimits } from "../../plugins/rate-limiter";
import {
  StartAttemptSchema,
  SaveAnswerSchema,
  MarkReviewSchema,
  SubmitAttemptSchema,
  TabSwitchSchema,
} from "./schemas/attempt.schema";
import * as AttemptEngine from "./services/attempt-engine.service";

// =============================================================================
// Attempt Engine Routes — /api/v1/attempts
// All routes require student authentication
// =============================================================================

export async function attemptRoutes(app: FastifyInstance) {

  // ── Start / Resume ──────────────────────────────────────────────────────────

  // POST /  — start a new attempt (or resume if already in progress)
  app.post(
    "/",
    {
      preHandler: [authenticate],
      config: { rateLimit: RateLimits.standard },
    },
    asyncHandler(async (request, reply) => {
      const { testId } = StartAttemptSchema.parse(request.body);
      const result = await AttemptEngine.startAttempt(testId, request.user!.id, {
        ip: request.ip,
        userAgent: request.headers["user-agent"],
      });
      return sendCreated(reply, result);
    })
  );

  // ── In-progress actions ─────────────────────────────────────────────────────

  // POST /:attemptId/answers  — save an answer
  app.post(
    "/:attemptId/answers",
    { preHandler: [authenticate] },
    asyncHandler(async (request, reply) => {
      const { attemptId } = request.params as { attemptId: string };
      const input = SaveAnswerSchema.parse(request.body);
      const result = await AttemptEngine.saveAnswer(attemptId, request.user!.id, input);
      return sendSuccess(reply, result);
    })
  );

  // PATCH /:attemptId/answers/review  — toggle mark for review
  app.patch(
    "/:attemptId/answers/review",
    { preHandler: [authenticate] },
    asyncHandler(async (request, reply) => {
      const { attemptId } = request.params as { attemptId: string };
      const input = MarkReviewSchema.parse(request.body);
      const result = await AttemptEngine.toggleMarkReview(attemptId, request.user!.id, input);
      return sendSuccess(reply, result);
    })
  );

  // POST /:attemptId/tab-switch  — report a tab switch event (proctoring)
  app.post(
    "/:attemptId/tab-switch",
    { preHandler: [authenticate] },
    asyncHandler(async (request, reply) => {
      const { attemptId } = request.params as { attemptId: string };
      const input = TabSwitchSchema.parse(request.body);
      const result = await AttemptEngine.recordTabSwitch(attemptId, request.user!.id, input);
      return sendSuccess(reply, result);
    })
  );

  // ── Submit ──────────────────────────────────────────────────────────────────

  // POST /:attemptId/submit  — student submits the test
  app.post(
    "/:attemptId/submit",
    { preHandler: [authenticate] },
    asyncHandler(async (request, reply) => {
      const { attemptId } = request.params as { attemptId: string };
      const input = SubmitAttemptSchema.parse(request.body);
      const result = await AttemptEngine.submitAttempt(attemptId, request.user!.id, input);
      return sendSuccess(reply, result);
    })
  );

  // ── Results ─────────────────────────────────────────────────────────────────

  // GET /:attemptId/result  — get full result with answer review (post-submit)
  app.get(
    "/:attemptId/result",
    { preHandler: [authenticate] },
    asyncHandler(async (request, reply) => {
      const { attemptId } = request.params as { attemptId: string };
      const result = await AttemptEngine.getAttemptResult(attemptId, request.user!.id);
      return sendSuccess(reply, result);
    })
  );

  // GET /me  — list all of the current user's attempts
  app.get(
    "/me",
    { preHandler: [authenticate] },
    asyncHandler(async (request, reply) => {
      const attempts = await AttemptEngine.listUserAttempts(request.user!.id);
      return sendSuccess(reply, attempts);
    })
  );
}
