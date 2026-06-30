import { Prisma, QuestionStatus } from "@prisma/client";
import { prisma } from "../../../lib/prisma";
import { Errors, ErrorCode } from "../../../utils/errors";
import { validateQuestionByType } from "../schemas/question-content.schema";
import { audit } from "../../../utils/audit";
import { createLogger } from "../../../lib/logger";
import { parsePagination, buildPaginationMeta } from "../../../utils/pagination";
import type {
  CreateQuestionInput,
  UpdateQuestionInput,
  ListQuestionsInput,
} from "../schemas/question.schema";

const log = createLogger("question-service");

// Fields returned in list views — excludes correctAnswer for security
const QUESTION_LIST_SELECT = {
  id: true,
  exam: true,
  type: true,
  difficulty: true,
  status: true,
  content: true,
  options: true,
  tags: true,
  sourceYear: true,
  sourceExam: true,
  isVerified: true,
  usageCount: true,
  createdAt: true,
  updatedAt: true,
  subject: { select: { id: true, name: true, code: true } },
  chapter: { select: { id: true, name: true } },
  topic:   { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.QuestionSelect;

// Full detail — includes correctAnswer and solution (for admin edit / preview)
const QUESTION_DETAIL_SELECT = {
  ...QUESTION_LIST_SELECT,
  correctAnswer: true,
  solution: true,
} satisfies Prisma.QuestionSelect;

// =============================================================================
// CREATE QUESTION
// =============================================================================
export async function createQuestion(
  input: CreateQuestionInput,
  adminId: string,
  adminIp?: string
) {
  // 1. Validate taxonomy exists and belongs to the right exam
  await assertTaxonomyValid(input.exam, input.subjectId, input.chapterId, input.topicId ?? null);

  // 2. Deep-validate content + options + answer by question type
  const validated = validateQuestionByType(
    input.type,
    input.content,
    input.options ?? null,
    input.correctAnswer,
    input.solution
  );

  // 3. Create
  const question = await prisma.question.create({
    data: {
      exam:          input.exam,
      subjectId:     input.subjectId,
      chapterId:     input.chapterId,
      topicId:       input.topicId ?? null,
      type:          input.type,
      difficulty:    input.difficulty,
      status:        QuestionStatus.ACTIVE,
      content:       validated.content as Prisma.InputJsonValue,
      options:       validated.options != null
                       ? (validated.options as Prisma.InputJsonValue)
                       : Prisma.JsonNull,
      correctAnswer: validated.correctAnswer as Prisma.InputJsonValue,
      solution:      validated.solution as Prisma.InputJsonValue,
      tags:          input.tags ?? [],
      sourceYear:    input.sourceYear ?? null,
      sourceExam:    input.sourceExam ?? null,
      createdById:   adminId,
    },
    select: QUESTION_DETAIL_SELECT,
  });

  audit.created(adminId, "Question", question.id, { type: input.type, exam: input.exam }, adminIp);
  log.info({ questionId: question.id, type: input.type }, "Question created");

  return question;
}

// =============================================================================
// GET QUESTION BY ID
// =============================================================================
export async function getQuestionById(id: string, includeAnswer = true) {
  const question = await prisma.question.findFirst({
    where: { id, deletedAt: null },
    select: includeAnswer ? QUESTION_DETAIL_SELECT : QUESTION_LIST_SELECT,
  });

  if (!question) throw Errors.notFound("Question", ErrorCode.QUESTION_NOT_FOUND);
  return question;
}

// =============================================================================
// LIST QUESTIONS (paginated, filterable)
// =============================================================================
export async function listQuestions(input: ListQuestionsInput, adminId: string) {
  const { skip, take, page, pageSize } = parsePagination(input.page, input.pageSize);

  // Build dynamic where clause
  const where: Prisma.QuestionWhereInput = {
    deletedAt: null,
    ...(input.exam       && { exam:       input.exam }),
    ...(input.subjectId  && { subjectId:  input.subjectId }),
    ...(input.chapterId  && { chapterId:  input.chapterId }),
    ...(input.topicId    && { topicId:    input.topicId }),
    ...(input.type       && { type:       input.type }),
    ...(input.difficulty && { difficulty: input.difficulty }),
    ...(input.status     && { status:     input.status }),
    ...(input.isVerified !== undefined && { isVerified: input.isVerified }),
    ...(input.tags && {
      tags: { hasSome: input.tags.split(",").map((t) => t.trim()) },
    }),
    ...(input.search && {
      // Postgres full-text search on question body text via JSON extraction
      // Falls back to ILIKE for MVP; upgrade to tsvector index in Phase 2
      content: {
        path: ["text"],
        string_contains: input.search,
      },
    }),
  };

  const orderBy: Prisma.QuestionOrderByWithRelationInput = {
    [input.sortBy]: input.sortOrder,
  };

  const [questions, total] = await Promise.all([
    prisma.question.findMany({
      where,
      select: QUESTION_LIST_SELECT,
      orderBy,
      skip,
      take,
    }),
    prisma.question.count({ where }),
  ]);

  return {
    questions,
    pagination: buildPaginationMeta(total, page, pageSize),
  };
}

// =============================================================================
// UPDATE QUESTION
// =============================================================================
export async function updateQuestion(
  id: string,
  input: UpdateQuestionInput,
  adminId: string,
  adminIp?: string
) {
  const existing = await prisma.question.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, exam: true, type: true, usageCount: true },
  });

  if (!existing) throw Errors.notFound("Question", ErrorCode.QUESTION_NOT_FOUND);

  // If question is used in tests, only allow metadata updates (tags, difficulty, status)
  // Content changes would invalidate historical attempts
  if (existing.usageCount > 0) {
    const hasContentChange =
      input.content || input.options || input.correctAnswer || input.solution;
    if (hasContentChange) {
      throw Errors.business(
        "This question is used in one or more tests. You can only edit tags, difficulty, or status. To change content, archive this question and create a new one.",
        ErrorCode.CONFLICT
      );
    }
  }

  // Validate taxonomy if changing
  if (input.subjectId || input.chapterId || input.topicId !== undefined) {
    await assertTaxonomyValid(
      existing.exam,
      input.subjectId!,
      input.chapterId!,
      input.topicId ?? null
    );
  }

  // Validate content if any content field is being updated
  let contentUpdate: Partial<{
    content: Prisma.InputJsonValue;
    options: Prisma.InputJsonValue | typeof Prisma.JsonNull;
    correctAnswer: Prisma.InputJsonValue;
    solution: Prisma.InputJsonValue;
  }> = {};

  if (input.content || input.options !== undefined || input.correctAnswer || input.solution) {
    // We need all four to re-validate — fetch current values for any not provided
    const current = await prisma.question.findUnique({
      where: { id },
      select: { content: true, options: true, correctAnswer: true, solution: true, type: true },
    });

    const validated = validateQuestionByType(
      input.type ?? current!.type,
      input.content ?? current!.content,
      input.options !== undefined ? input.options : current!.options,
      input.correctAnswer ?? current!.correctAnswer,
      input.solution ?? current!.solution
    );

    contentUpdate = {
      content:       validated.content as Prisma.InputJsonValue,
      options:       validated.options != null
                       ? (validated.options as Prisma.InputJsonValue)
                       : Prisma.JsonNull,
      correctAnswer: validated.correctAnswer as Prisma.InputJsonValue,
      solution:      validated.solution as Prisma.InputJsonValue,
    };
  }

  const question = await prisma.question.update({
    where: { id },
    data: {
      ...(input.subjectId  && { subjectId:  input.subjectId }),
      ...(input.chapterId  && { chapterId:  input.chapterId }),
      ...(input.topicId !== undefined && { topicId: input.topicId }),
      ...(input.type       && { type:       input.type }),
      ...(input.difficulty && { difficulty: input.difficulty }),
      ...(input.status     && { status:     input.status }),
      ...(input.tags       && { tags:       input.tags }),
      ...(input.sourceYear !== undefined && { sourceYear: input.sourceYear }),
      ...(input.sourceExam !== undefined && { sourceExam: input.sourceExam }),
      ...contentUpdate,
      isVerified: false, // Reset verification on any edit
    },
    select: QUESTION_DETAIL_SELECT,
  });

  audit.updated(adminId, "Question", id, { fields: Object.keys(input) }, adminIp);
  log.info({ questionId: id }, "Question updated");

  return question;
}

// =============================================================================
// DELETE QUESTION (soft delete)
// =============================================================================
export async function deleteQuestion(id: string, adminId: string, adminIp?: string) {
  const question = await prisma.question.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, usageCount: true },
  });

  if (!question) throw Errors.notFound("Question", ErrorCode.QUESTION_NOT_FOUND);

  if (question.usageCount > 0) {
    throw Errors.business(
      `Cannot delete: this question is used in ${question.usageCount} test(s). Archive it instead.`,
      ErrorCode.CONFLICT
    );
  }

  await prisma.question.update({
    where: { id },
    data: { deletedAt: new Date(), status: QuestionStatus.ARCHIVED },
  });

  audit.deleted(adminId, "Question", id, adminIp);
  log.info({ questionId: id, adminId }, "Question soft-deleted");

  return { message: "Question deleted" };
}

// =============================================================================
// BULK DELETE
// =============================================================================
export async function bulkDeleteQuestions(
  questionIds: string[],
  adminId: string,
  adminIp?: string
) {
  // Find questions in use
  const inUse = await prisma.question.findMany({
    where: { id: { in: questionIds }, usageCount: { gt: 0 }, deletedAt: null },
    select: { id: true },
  });

  if (inUse.length > 0) {
    throw Errors.business(
      `${inUse.length} question(s) are used in tests and cannot be deleted. Remove them from tests first or archive them instead.`,
      ErrorCode.CONFLICT
    );
  }

  const result = await prisma.question.updateMany({
    where: { id: { in: questionIds }, deletedAt: null },
    data: { deletedAt: new Date(), status: QuestionStatus.ARCHIVED },
  });

  log.info({ count: result.count, adminId }, "Bulk question delete");
  return { deleted: result.count };
}

// =============================================================================
// VERIFY / UNVERIFY QUESTION (Super Admin or senior admin)
// =============================================================================
export async function setQuestionVerification(
  id: string,
  isVerified: boolean,
  adminId: string,
  adminIp?: string
) {
  const question = await prisma.question.findFirst({
    where: { id, deletedAt: null },
    select: { id: true },
  });

  if (!question) throw Errors.notFound("Question", ErrorCode.QUESTION_NOT_FOUND);

  await prisma.question.update({
    where: { id },
    data: { isVerified, verifiedById: isVerified ? adminId : null },
  });

  audit.updated(adminId, "Question", id, { isVerified }, adminIp);
  return { message: isVerified ? "Question verified" : "Verification removed" };
}

// =============================================================================
// TAXONOMY — Subjects, Chapters, Topics
// =============================================================================
export async function getSubjects(exam?: string) {
  return prisma.subject.findMany({
    where: {
      isActive: true,
      ...(exam && { exam: exam as any }),
    },
    select: {
      id: true,
      name: true,
      code: true,
      exam: true,
      order: true,
      _count: { select: { questions: { where: { deletedAt: null } } } },
    },
    orderBy: [{ exam: "asc" }, { order: "asc" }],
  });
}

export async function getChapters(subjectId: string) {
  const subject = await prisma.subject.findUnique({
    where: { id: subjectId },
    select: { id: true },
  });
  if (!subject) throw Errors.notFound("Subject");

  return prisma.chapter.findMany({
    where: { subjectId, isActive: true },
    select: {
      id: true,
      name: true,
      order: true,
      _count: { select: { questions: { where: { deletedAt: null } } } },
    },
    orderBy: { order: "asc" },
  });
}

export async function getTopics(chapterId: string) {
  const chapter = await prisma.chapter.findUnique({
    where: { id: chapterId },
    select: { id: true },
  });
  if (!chapter) throw Errors.notFound("Chapter");

  return prisma.topic.findMany({
    where: { chapterId, isActive: true },
    select: {
      id: true,
      name: true,
      order: true,
      _count: { select: { questions: { where: { deletedAt: null } } } },
    },
    orderBy: { order: "asc" },
  });
}

// =============================================================================
// QUESTION STATS — for admin dashboard
// =============================================================================
export async function getQuestionStats(exam?: string) {
  const where: Prisma.QuestionWhereInput = {
    deletedAt: null,
    ...(exam && { exam: exam as any }),
  };

  const [total, byType, byDifficulty, byStatus, recentlyAdded] = await Promise.all([
    prisma.question.count({ where }),

    prisma.question.groupBy({
      by: ["type"],
      where,
      _count: { _all: true },
    }),

    prisma.question.groupBy({
      by: ["difficulty"],
      where,
      _count: { _all: true },
    }),

    prisma.question.groupBy({
      by: ["status"],
      where,
      _count: { _all: true },
    }),

    prisma.question.count({
      where: {
        ...where,
        createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
    }),
  ]);

  return {
    total,
    recentlyAdded,
    byType:       byType.map((r)       => ({ type:       r.type,       count: r._count._all })),
    byDifficulty: byDifficulty.map((r) => ({ difficulty: r.difficulty, count: r._count._all })),
    byStatus:     byStatus.map((r)     => ({ status:     r.status,     count: r._count._all })),
  };
}

// =============================================================================
// Private Helpers
// =============================================================================
async function assertTaxonomyValid(
  exam: string,
  subjectId: string,
  chapterId: string,
  topicId: string | null
) {
  const subject = await prisma.subject.findFirst({
    where: { id: subjectId, exam: exam as any, isActive: true },
    select: { id: true },
  });
  if (!subject) {
    throw Errors.badRequest(`Subject not found or does not belong to ${exam}`, ErrorCode.INVALID_INPUT);
  }

  const chapter = await prisma.chapter.findFirst({
    where: { id: chapterId, subjectId, isActive: true },
    select: { id: true },
  });
  if (!chapter) {
    throw Errors.badRequest("Chapter not found or does not belong to the selected subject", ErrorCode.INVALID_INPUT);
  }

  if (topicId) {
    const topic = await prisma.topic.findFirst({
      where: { id: topicId, chapterId, isActive: true },
      select: { id: true },
    });
    if (!topic) {
      throw Errors.badRequest("Topic not found or does not belong to the selected chapter", ErrorCode.INVALID_INPUT);
    }
  }
}
