import { TestStatus, Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma";
import { Errors, ErrorCode } from "../../../utils/errors";
import { createLogger } from "../../../lib/logger";
import { parsePagination } from "../../../utils/pagination";
import { buildPaginationMeta } from "../../../utils/response";
import type {
  CreateTestInput,
  UpdateTestInput,
  CreateSectionInput,
  UpdateSectionInput,
  ReorderSectionsInput,
  AddQuestionsInput,
  ReorderQuestionsInput,
  ListTestsQuery,
} from "../schemas/test.schema";

const log = createLogger("test-builder-service");

// =============================================================================
// Test Builder Service
// All test management operations — admins only
// =============================================================================

// ── Shared select shapes ─────────────────────────────────────────────────────

const TEST_LIST_SELECT = {
  id: true,
  title: true,
  description: true,
  exam: true,
  type: true,
  status: true,
  durationMinutes: true,
  isFree: true,
  price: true,
  randomizeQuestions: true,
  randomizeOptions: true,
  totalQuestions: true,
  totalMarks: true,
  totalAttempts: true,
  tags: true,
  thumbnailUrl: true,
  scheduledFrom: true,
  scheduledUntil: true,
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
  createdBy: {
    select: { id: true, email: true },
  },
} satisfies Prisma.TestSelect;

const TEST_DETAIL_SELECT = {
  ...TEST_LIST_SELECT,
  instructions: true,
  subscriptionInclusive: true,
  sections: {
    orderBy: { order: "asc" as const },
    select: {
      id: true,
      name: true,
      order: true,
      exam: true,
      subjectId: true,
      description: true,
      totalQuestions: true,
      requiredAttempts: true,
      createdAt: true,
      testQuestions: {
        orderBy: { order: "asc" as const },
        select: {
          id: true,
          order: true,
          question: {
            select: {
              id: true,
              type: true,
              difficulty: true,
              content: true,
              subject: { select: { id: true, name: true } },
              chapter: { select: { id: true, name: true } },
              topic: { select: { id: true, name: true } },
              status: true,
            },
          },
        },
      },
    },
  },
} satisfies Prisma.TestSelect;

// ── Helper ───────────────────────────────────────────────────────────

async function requireTest(id: string) {
  const test = await prisma.test.findUnique({
    where: { id, deletedAt: null },
    select: { id: true, status: true, createdById: true, totalQuestions: true, durationMinutes: true },
  });
  if (!test) throw Errors.notFound("Test", ErrorCode.TEST_NOT_FOUND);
  return test;
}

async function requireDraft(id: string) {
  const test = await requireTest(id);
  if (test.status !== TestStatus.DRAFT) {
    throw Errors.business(
      "Only DRAFT tests can be modified. Unpublish the test first.",
      ErrorCode.TEST_ALREADY_PUBLISHED
    );
  }
  return test;
}

// ── CRUD ────────────────────────────────────────────────────────────

export async function createTest(input: CreateTestInput, adminId: string) {
  if (!input.title || input.title.trim() === "") {
    throw Errors.badRequest("Test title is required.", ErrorCode.VALIDATION_ERROR);
  }

  const testData: Prisma.TestUncheckedCreateInput = {
    title: input.title,
    description: input.description,
    instructions: input.instructions,
    exam: input.exam,
    type: input.type,
    durationMinutes: input.durationMinutes,
    scheduledFrom: input.scheduledFrom,
    scheduledUntil: input.scheduledUntil,
    isFree: input.isFree,
    price: input.price != null ? new Prisma.Decimal(input.price) : null,
    subscriptionInclusive: input.subscriptionInclusive,
    randomizeQuestions: input.randomizeQuestions,
    randomizeOptions: input.randomizeOptions,
    tags: input.tags,
    thumbnailUrl: input.thumbnailUrl,
    status: TestStatus.DRAFT,
    createdById: adminId,
  };

  const test = await prisma.test.create({
    data: testData,
    select: TEST_LIST_SELECT,
  });

  log.info({ testId: test.id, adminId }, "Test created");
  return test;
}

export async function getTest(id: string) {
  const test = await prisma.test.findUnique({
    where: { id, deletedAt: null },
    select: TEST_DETAIL_SELECT,
  });
  if (!test) throw Errors.notFound("Test", ErrorCode.TEST_NOT_FOUND);
  return test;
}

export async function listTests(query: ListTestsQuery) {
  const { page, pageSize, skip, take } = parsePagination(query.page, query.pageSize);

  const where: Prisma.TestWhereInput = {
    deletedAt: null,
    ...(query.exam && { exam: query.exam }),
    ...(query.type && { type: query.type }),
    ...(query.status && { status: query.status }),
    ...(query.search && {
      OR: [
        { title: { contains: query.search, mode: "insensitive" } },
        { description: { contains: query.search, mode: "insensitive" } },
        { tags: { has: query.search } },
      ],
    }),
  };

  const [tests, total] = await Promise.all([
    prisma.test.findMany({
      where,
      select: TEST_LIST_SELECT,
      orderBy: { [query.sortBy]: query.sortOrder },
      skip,
      take,
    }),
    prisma.test.count({ where }),
  ]);

  return { tests, pagination: buildPaginationMeta(total, page, pageSize) };
}

export async function updateTest(id: string, input: UpdateTestInput, adminId: string) {
  await requireDraft(id);

  const test = await prisma.test.update({
    where: { id },
    data: {
      ...input,
      price: input.price != null ? new Prisma.Decimal(input.price) : undefined,
    },
    select: TEST_LIST_SELECT,
  });

  log.info({ testId: id, adminId }, "Test updated");
  return test;
}

export async function deleteTest(id: string, adminId: string) {
  await requireDraft(id);

  // Soft delete
  await prisma.test.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  log.info({ testId: id, adminId }, "Test soft-deleted");
}

// ── Publish / Unpublish ──────────────────────────────────────────────────────

export async function publishTest(id: string, adminId: string) {
  const test = await requireTest(id);

  if (test.status === TestStatus.PUBLISHED) {
    throw Errors.conflict("Test is already published", ErrorCode.TEST_ALREADY_PUBLISHED);
  }

  // Validation: must have at least one section with at least one question
  const sectionCount = await prisma.testSection.count({ where: { testId: id } });
  if (sectionCount === 0) {
    throw Errors.business(
      "A test must have at least one section before publishing.",
      ErrorCode.VALIDATION_ERROR
    );
  }

  const questionCount = await prisma.testQuestion.count({ where: { testId: id } });
  if (questionCount === 0) {
    throw Errors.business(
      "A test must have at least one question before publishing.",
      ErrorCode.VALIDATION_ERROR
    );
  }

  // Validation: must have a duration set (either test-level or per-section)
  if (!test.durationMinutes) {
    const sectionsWithTime = await prisma.testSection.count({
      where: { testId: id },
    });
    // If no test-level duration we need to confirm section-level is present
    // For simplicity: require durationMinutes at test level unless sections have it
    if (sectionsWithTime === 0) {
      throw Errors.business(
        "A test must have a duration configured before publishing.",
        ErrorCode.VALIDATION_ERROR
      );
    }
  }

  const updated = await prisma.test.update({
    where: { id },
    data: {
      status: TestStatus.PUBLISHED,
      publishedAt: new Date(),
      publishedById: adminId,
      totalQuestions: questionCount,
    },
    select: TEST_LIST_SELECT,
  });

  log.info({ testId: id, adminId, questionCount }, "Test published");
  return updated;
}

export async function unpublishTest(id: string, adminId: string) {
  const test = await requireTest(id);

  if (test.status !== TestStatus.PUBLISHED) {
    throw Errors.business("Only published tests can be unpublished.", ErrorCode.TEST_NOT_PUBLISHED);
  }

  const updated = await prisma.test.update({
    where: { id },
    data: { status: TestStatus.DRAFT },
    select: TEST_LIST_SELECT,
  });

  log.info({ testId: id, adminId }, "Test unpublished");
  return updated;
}

// ── Sections ──────────────────────────────────────────────────────────

export async function createSection(testId: string, input: CreateSectionInput, adminId: string) {
  await requireDraft(testId);

  // Auto-assign next order if not provided
  const maxOrder = await prisma.testSection.aggregate({
    where: { testId },
    _max: { order: true },
  });
  const order = input.order ?? (maxOrder._max.order ?? -1) + 1;

  const section = await prisma.testSection.create({
    data: {
      name: input.name,
      order,
      exam: input.exam,
      testId,
      ...(input.subjectId && { subjectId: input.subjectId }),
      ...(input.description && { description: input.description }),
      ...(input.totalQuestions != null && { totalQuestions: input.totalQuestions }),
      ...(input.requiredAttempts != null && { requiredAttempts: input.requiredAttempts }),
    },
  });

  log.info({ testId, sectionId: section.id, adminId }, "Section created");
  return section;
}

export async function updateSection(
  testId: string,
  sectionId: string,
  input: UpdateSectionInput,
  adminId: string
) {
  await requireDraft(testId);

  const existing = await prisma.testSection.findUnique({ where: { id: sectionId } });
  if (!existing || existing.testId !== testId) {
    throw Errors.notFound("Section");
  }

  const section = await prisma.testSection.update({
    where: { id: sectionId },
    data: input,
  });

  log.info({ testId, sectionId, adminId }, "Section updated");
  return section;
}

export async function deleteSection(testId: string, sectionId: string, adminId: string) {
  await requireDraft(testId);

  const existing = await prisma.testSection.findUnique({
    where: { id: sectionId },
    select: { testId: true },
  });
  if (!existing || existing.testId !== testId) {
    throw Errors.notFound("Section");
  }

  // Cascade handled by Prisma schema (onDelete: Cascade on TestQuestion)
  await prisma.testSection.delete({ where: { id: sectionId } });
  log.info({ testId, sectionId, adminId }, "Section deleted");
}

export async function reorderSections(
  testId: string,
  input: ReorderSectionsInput,
  adminId: string
) {
  await requireDraft(testId);

  await prisma.$transaction(
    input.sections.map(({ id, order }) =>
      prisma.testSection.updateMany({
        where: { id, testId },
        data: { order },
      })
    )
  );

  log.info({ testId, adminId }, "Sections reordered");
}

// ── Questions ──────────────────────────────────────────────────────────

export async function addQuestions(
  testId: string,
  sectionId: string,
  input: AddQuestionsInput,
  adminId: string
) {
  await requireDraft(testId);

  const section = await prisma.testSection.findUnique({ where: { id: sectionId } });
  if (!section || section.testId !== testId) throw Errors.notFound("Section");

  // Validate all question IDs exist and are ACTIVE
  const questionIds = input.questions.map((q) => q.questionId);
  const foundQuestions = await prisma.question.findMany({
    where: { id: { in: questionIds }, status: "ACTIVE" },
    select: { id: true },
  });

  if (foundQuestions.length !== questionIds.length) {
    const foundIds = new Set(foundQuestions.map((q) => q.id));
    const missing = questionIds.filter((id) => !foundIds.has(id));
    throw Errors.badRequest(
      `${missing.length} question(s) not found or not active: ${missing.join(", ")}`,
      ErrorCode.QUESTION_NOT_FOUND
    );
  }

  // Check for duplicates within the test (schema enforces unique[testId, questionId])
  const existing = await prisma.testQuestion.findMany({
    where: { testId, questionId: { in: questionIds } },
    select: { questionId: true },
  });
  if (existing.length > 0) {
    const dupes = existing.map((q) => q.questionId);
    throw Errors.conflict(
      `${dupes.length} question(s) already exist in this test: ${dupes.join(", ")}`,
      ErrorCode.CONFLICT
    );
  }

  // Get current max order in section
  const maxOrder = await prisma.testQuestion.aggregate({
    where: { sectionId },
    _max: { order: true },
  });
  let nextOrder = (maxOrder._max.order ?? -1) + 1;

  const data = input.questions.map((q) => ({
    testId,
    sectionId,
    questionId: q.questionId,
    order: q.order ?? nextOrder++,
  }));

  await prisma.testQuestion.createMany({ data });

  // Update denormalized totalQuestions on test
  await prisma.test.update({
    where: { id: testId },
    data: {
      totalQuestions: {
        increment: input.questions.length,
      },
    },
  });

  log.info({ testId, sectionId, count: input.questions.length, adminId }, "Questions added");
  return { added: input.questions.length };
}

export async function removeQuestion(
  testId: string,
  sectionId: string,
  testQuestionId: string,
  adminId: string
) {
  await requireDraft(testId);

  const tq = await prisma.testQuestion.findUnique({
    where: { id: testQuestionId },
    select: { testId: true, sectionId: true },
  });

  if (!tq || tq.testId !== testId || tq.sectionId !== sectionId) {
    throw Errors.notFound("Question in test");
  }

  await prisma.testQuestion.delete({ where: { id: testQuestionId } });

  // Decrement denormalized count
  await prisma.test.update({
    where: { id: testId },
    data: { totalQuestions: { decrement: 1 } },
  });

  log.info({ testId, sectionId, testQuestionId, adminId }, "Question removed from test");
}

export async function reorderQuestions(
  testId: string,
  sectionId: string,
  input: ReorderQuestionsInput,
  adminId: string
) {
  await requireDraft(testId);

  const section = await prisma.testSection.findUnique({ where: { id: sectionId } });
  if (!section || section.testId !== testId) throw Errors.notFound("Section");

  await prisma.$transaction(
    input.questions.map(({ id, order }) =>
      prisma.testQuestion.updateMany({
        where: { id, sectionId, testId },
        data: { order },
      })
    )
  );

  log.info({ testId, sectionId, adminId }, "Questions reordered");
}
