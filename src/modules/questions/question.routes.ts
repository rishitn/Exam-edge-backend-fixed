import { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import {
  CreateQuestionSchema,
  UpdateQuestionSchema,
  ListQuestionsSchema,
  BulkDeleteSchema,
  VerifyQuestionSchema,
} from "./schemas/question.schema";
import * as QuestionService from "./services/question.service";
import * as BulkUploadService from "./services/bulk-upload.service";
import { uploadImageToS3 } from "../../lib/s3";
import { authenticateAdmin, requireSuperAdmin, requireExamScope } from "../../middleware/authenticate";
import { sendSuccess, sendCreated, sendPaginated } from "../../utils/response";
import { asyncHandler } from "../../utils/async-handler";
import { Errors, ErrorCode } from "../../utils/errors";
import { CONSTANTS } from "../../config/constants";

// =============================================================================
// Question Bank Routes — /api/v1/admin/questions/*
// All routes require admin authentication
// =============================================================================

export async function questionRoutes(app: FastifyInstance): Promise<void> {

  // Register multipart plugin for file uploads (scoped to this plugin)
  await app.register(multipart, {
    limits: {
      fileSize:  CONSTANTS.MAX_UPLOAD_SIZE_MB * 1024 * 1024,
      files:     1,
      fieldSize: 1024 * 1024,
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // TAXONOMY (read-only — needed for dropdowns in question form)
  // ────────────────────────────────────────────────────────────────────────────

  // GET /questions/subjects?exam=NEET
  app.get(
    "/subjects",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const { exam } = request.query as { exam?: string };
      const subjects = await QuestionService.getSubjects(exam);
      return sendSuccess(reply, { subjects });
    })
  );

  // GET /questions/subjects/:subjectId/chapters
  app.get(
    "/subjects/:subjectId/chapters",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const { subjectId } = request.params as { subjectId: string };
      const chapters = await QuestionService.getChapters(subjectId);
      return sendSuccess(reply, { chapters });
    })
  );

  // GET /questions/chapters/:chapterId/topics
  app.get(
    "/chapters/:chapterId/topics",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const { chapterId } = request.params as { chapterId: string };
      const topics = await QuestionService.getTopics(chapterId);
      return sendSuccess(reply, { topics });
    })
  );

  // ────────────────────────────────────────────────────────────────────────────
  // STATS
  // ────────────────────────────────────────────────────────────────────────────

  // GET /questions/stats?exam=NEET
  app.get(
    "/stats",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const { exam } = request.query as { exam?: string };
      const stats = await QuestionService.getQuestionStats(exam);
      return sendSuccess(reply, { stats });
    })
  );

  // ────────────────────────────────────────────────────────────────────────────
  // CRUD
  // ────────────────────────────────────────────────────────────────────────────

  // GET /questions
  app.get(
    "/",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const input = ListQuestionsSchema.parse(request.query);
      const { questions, pagination } = await QuestionService.listQuestions(
        input,
        request.admin!.id
      );
      return sendPaginated(reply, questions, pagination);
    })
  );

  // POST /questions
  app.post(
    "/",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const input = CreateQuestionSchema.parse(request.body);

      // Verify admin has scope for this exam
      requireExamScope(request.admin!, input.exam as any);

      const question = await QuestionService.createQuestion(
        input,
        request.admin!.id,
        request.ip
      );
      return sendCreated(reply, { question });
    })
  );

  // GET /questions/:id
  app.get(
    "/:id",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const { id } = request.params as { id: string };
      const question = await QuestionService.getQuestionById(id, true);
      return sendSuccess(reply, { question });
    })
  );

  // PATCH /questions/:id
  app.patch(
    "/:id",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const { id } = request.params as { id: string };
      const input  = UpdateQuestionSchema.parse(request.body);
      const question = await QuestionService.updateQuestion(
        id,
        input,
        request.admin!.id,
        request.ip
      );
      return sendSuccess(reply, { question });
    })
  );

  // DELETE /questions/:id
  app.delete(
    "/:id",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await QuestionService.deleteQuestion(id, request.admin!.id, request.ip);
      return sendSuccess(reply, result);
    })
  );

  // POST /questions/bulk-delete
  app.post(
    "/bulk-delete",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const { questionIds } = BulkDeleteSchema.parse(request.body);
      const result = await QuestionService.bulkDeleteQuestions(
        questionIds,
        request.admin!.id,
        request.ip
      );
      return sendSuccess(reply, result);
    })
  );

  // PATCH /questions/:id/verify  (Super Admin only)
  app.patch(
    "/:id/verify",
    { preHandler: [requireSuperAdmin] },
    asyncHandler(async (request, reply) => {
      const { id } = request.params as { id: string };
      const { isVerified } = VerifyQuestionSchema.parse(request.body);
      const result = await QuestionService.setQuestionVerification(
        id,
        isVerified,
        request.admin!.id,
        request.ip
      );
      return sendSuccess(reply, result);
    })
  );

  // ────────────────────────────────────────────────────────────────────────────
  // IMAGE UPLOAD
  // POST /questions/upload-image
  // Uploads an image to S3 and returns the URL for use in question content
  // ────────────────────────────────────────────────────────────────────────────

  app.post(
    "/upload-image",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const data = await request.file();
      if (!data) throw Errors.badRequest("No file provided", ErrorCode.INVALID_INPUT);

      // Stream to buffer
      const chunks: Buffer[] = [];
      for await (const chunk of data.file) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      if (buffer.length === 0) {
        throw Errors.badRequest("Uploaded file is empty", ErrorCode.INVALID_INPUT);
      }

      const result = await uploadImageToS3(
        buffer,
        data.mimetype,
        "question",
        "temp",                   // entity ID set to "temp" until question is saved
        request.admin!.id,
        data.filename
      );

      return sendSuccess(reply, {
        url:      result.publicUrl,
        s3Key:    result.s3Key,
        message:  "Image uploaded. Use the URL in your question content.",
      });
    })
  );

  // ────────────────────────────────────────────────────────────────────────────
  // BULK UPLOAD
  // ────────────────────────────────────────────────────────────────────────────

  // GET /questions/bulk-upload/template
  // Download the Excel template
  app.get(
    "/bulk-upload/template",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (_request, reply) => {
      const buffer = BulkUploadService.generateUploadTemplate();
      reply
        .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("Content-Disposition", `attachment; filename="examedge_question_template.xlsx"`)
        .header("Content-Length", buffer.length);
      return reply.send(buffer);
    })
  );

  // POST /questions/bulk-upload
  // Upload filled template — processes synchronously for MVP
  // (Move to a job queue in Phase 2 for large uploads)
  app.post(
    "/bulk-upload",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const data = await request.file();
      if (!data) throw Errors.badRequest("No file provided", ErrorCode.INVALID_INPUT);

      // Validate file type
      const allowedMimes = [
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-excel",
        "text/csv",
      ];
      if (!allowedMimes.includes(data.mimetype)) {
        throw Errors.badRequest(
          "Invalid file type. Upload an .xlsx or .csv file.",
          ErrorCode.INVALID_INPUT
        );
      }

      const { exam } = (request.query as { exam?: string });
      if (!exam) {
        throw Errors.badRequest("exam query parameter is required (e.g. ?exam=NEET)", ErrorCode.INVALID_INPUT);
      }

      requireExamScope(request.admin!, exam as any);

      // Buffer the file
      const chunks: Buffer[] = [];
      for await (const chunk of data.file) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      if (buffer.length === 0) throw Errors.badRequest("Uploaded file is empty");

      // Upload file to S3 for record keeping
      const s3Result = await uploadImageToS3(
        buffer,
        data.mimetype,
        "bulk-upload",
        `${request.admin!.id}-${Date.now()}`,
        request.admin!.id,
        data.filename
      ).catch(() => ({ publicUrl: "", s3Key: "" })); // Non-fatal if S3 fails

      // Create the bulk upload record
      const bulkUploadId = await BulkUploadService.initiateBulkUpload(
        request.admin!.id,
        data.filename,
        s3Result.publicUrl,
        exam
      );

      // Process synchronously (acceptable for up to 500 rows in MVP)
      const result = await BulkUploadService.processBulkUpload(
        bulkUploadId,
        buffer,
        data.filename,
        request.admin!.id,
        request.ip
      );

      const statusCode = result.failed === result.total ? 422 : 201;

      return reply.code(statusCode).send({
        success: result.failed < result.total,
        data: {
          bulkUploadId:  result.bulkUploadId,
          total:         result.total,
          created:       result.success,
          failed:        result.failed,
          errors:        result.errors.slice(0, 50), // Return first 50 errors inline
          message:       result.failed === 0
                           ? `All ${result.total} questions imported successfully.`
                           : `${result.success} of ${result.total} questions imported. ${result.failed} failed.`,
        },
      });
    })
  );

  // GET /questions/bulk-upload/:id — check status of a past upload
  app.get(
    "/bulk-upload/:id",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const { id } = request.params as { id: string };
      const upload = await BulkUploadService.getBulkUploadStatus(id, request.admin!.id);
      return sendSuccess(reply, { upload });
    })
  );

  // GET /questions/bulk-upload — list all uploads by this admin
  app.get(
    "/bulk-uploads",
    { preHandler: [authenticateAdmin] },
    asyncHandler(async (request, reply) => {
      const uploads = await BulkUploadService.listBulkUploads(request.admin!.id);
      return sendSuccess(reply, { uploads });
    })
  );
}
