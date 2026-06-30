import { FastifyInstance } from "fastify";
import { authenticateAdmin, requireSuperAdmin } from "../../middleware/authenticate";
import { sendSuccess, sendCreated, sendNoContent, sendPaginated } from "../../utils/response";
import { asyncHandler } from "../../utils/async-handler";
import { RateLimits } from "../../plugins/rate-limiter";
import {
  CreateTestSchema,
  UpdateTestSchema,
  CreateSectionSchema,
  UpdateSectionSchema,
  ReorderSectionsSchema,
  AddQuestionsSchema,
  ReorderQuestionsSchema,
  ListTestsQuerySchema,
} from "./schemas/test.schema";
import * as TestBuilderService from "./services/test-builder.service";

// =============================================================================
// Test Builder Routes — /api/v1/admin/tests
// All routes require admin authentication
// =============================================================================

export async function testRoutes(app: FastifyInstance) {

  // ── Tests ──────────────────────────────────────────────────────────────────

  // GET /  — list all tests (paginated, filterable)
  app.get(
    "/",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const query = ListTestsQuerySchema.parse(request.query);
      const { tests, pagination } = await TestBuilderService.listTests(query);
      return sendPaginated(reply, tests, pagination);
    })
  );

  // POST /  — create a new test (draft)
  app.post(
    "/",
    {
      preHandler: [authenticateAdmin],
      config: { rateLimit: RateLimits.standard },
    },
    asyncHandler(async (request, reply) => {
      const input = CreateTestSchema.parse(request.body);
      const test = await TestBuilderService.createTest(input, request.admin!.id);
      return sendCreated(reply, test);
    })
  );

  // GET /:testId  — get full test with sections + questions
  app.get(
    "/:testId",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const { testId } = request.params as { testId: string };
      const test = await TestBuilderService.getTest(testId);
      return sendSuccess(reply, test);
    })
  );

  // PATCH /:testId  — update test metadata (draft only)
  app.patch(
    "/:testId",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const { testId } = request.params as { testId: string };
      const input = UpdateTestSchema.parse(request.body);
      const test = await TestBuilderService.updateTest(testId, input, request.admin!.id);
      return sendSuccess(reply, test);
    })
  );

  // DELETE /:testId  — soft delete (draft only, super admin only)
  app.delete(
    "/:testId",
    { preHandler: [requireSuperAdmin] },
    asyncHandler(async (request, reply) => {
      const { testId } = request.params as { testId: string };
      await TestBuilderService.deleteTest(testId, request.admin!.id);
      return sendNoContent(reply);
    })
  );

  // ── Publish / Unpublish ────────────────────────────────────────────────────

  // POST /:testId/publish
  app.post(
    "/:testId/publish",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const { testId } = request.params as { testId: string };
      const test = await TestBuilderService.publishTest(testId, request.admin!.id);
      return sendSuccess(reply, test);
    })
  );

  // POST /:testId/unpublish
  app.post(
    "/:testId/unpublish",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const { testId } = request.params as { testId: string };
      const test = await TestBuilderService.unpublishTest(testId, request.admin!.id);
      return sendSuccess(reply, test);
    })
  );

  // ── Sections ───────────────────────────────────────────────────────────────

  // POST /:testId/sections  — add a section
  app.post(
    "/:testId/sections",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const { testId } = request.params as { testId: string };
      const input = CreateSectionSchema.parse(request.body);
      const section = await TestBuilderService.createSection(testId, input, request.admin!.id);
      return sendCreated(reply, section);
    })
  );

  // PATCH /:testId/sections/:sectionId  — update section metadata
  app.patch(
    "/:testId/sections/:sectionId",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const { testId, sectionId } = request.params as { testId: string; sectionId: string };
      const input = UpdateSectionSchema.parse(request.body);
      const section = await TestBuilderService.updateSection(testId, sectionId, input, request.admin!.id);
      return sendSuccess(reply, section);
    })
  );

  // DELETE /:testId/sections/:sectionId  — remove section + its questions
  app.delete(
    "/:testId/sections/:sectionId",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const { testId, sectionId } = request.params as { testId: string; sectionId: string };
      await TestBuilderService.deleteSection(testId, sectionId, request.admin!.id);
      return sendNoContent(reply);
    })
  );

  // PUT /:testId/sections/reorder  — batch reorder sections
  app.put(
    "/:testId/sections/reorder",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const { testId } = request.params as { testId: string };
      const input = ReorderSectionsSchema.parse(request.body);
      await TestBuilderService.reorderSections(testId, input, request.admin!.id);
      return sendNoContent(reply);
    })
  );

  // ── Questions ──────────────────────────────────────────────────────────────

  // POST /:testId/sections/:sectionId/questions  — add questions to section
  app.post(
    "/:testId/sections/:sectionId/questions",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const { testId, sectionId } = request.params as { testId: string; sectionId: string };
      const input = AddQuestionsSchema.parse(request.body);
      const result = await TestBuilderService.addQuestions(testId, sectionId, input, request.admin!.id);
      return sendSuccess(reply, result);
    })
  );

  // DELETE /:testId/sections/:sectionId/questions/:testQuestionId  — remove question
  app.delete(
    "/:testId/sections/:sectionId/questions/:testQuestionId",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const { testId, sectionId, testQuestionId } = request.params as {
        testId: string;
        sectionId: string;
        testQuestionId: string;
      };
      await TestBuilderService.removeQuestion(testId, sectionId, testQuestionId, request.admin!.id);
      return sendNoContent(reply);
    })
  );

  // PUT /:testId/sections/:sectionId/questions/reorder  — reorder questions in section
  app.put(
    "/:testId/sections/:sectionId/questions/reorder",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const { testId, sectionId } = request.params as { testId: string; sectionId: string };
      const input = ReorderQuestionsSchema.parse(request.body);
      await TestBuilderService.reorderQuestions(testId, sectionId, input, request.admin!.id);
      return sendNoContent(reply);
    })
  );
}
