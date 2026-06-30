import * as XLSX from "xlsx";
import { prisma } from "../../../lib/prisma";
import { Errors, ErrorCode } from "../../../utils/errors";
import { validateQuestionByType } from "../schemas/question-content.schema";
import { BulkUploadRowSchema, transformRowToQuestion } from "../schemas/bulk-upload.schema";
import { uploadImageToS3 } from "../../../lib/s3";
import { audit } from "../../../utils/audit";
import { createLogger } from "../../../lib/logger";
import { QuestionStatus, Prisma } from "@prisma/client";
import { env } from "../../../config/env";

const log = createLogger("bulk-upload-service");

const BATCH_SIZE = 50; // Process questions in batches to avoid DB timeouts
const MAX_ROWS   = 500; // Hard cap per upload

// =============================================================================
// Row processing result
// =============================================================================
interface RowResult {
  rowNumber: number;
  status:    "SUCCESS" | "FAILED";
  questionId?: string;
  errorMessage?: string;
  rawData: Record<string, unknown>;
}

// =============================================================================
// PROCESS BULK UPLOAD
// Called after the file has been uploaded to S3
// =============================================================================
export async function processBulkUpload(
  bulkUploadId: string,
  fileBuffer:   Buffer,
  fileName:     string,
  adminId:      string,
  adminIp?:     string
): Promise<{
  bulkUploadId: string;
  total:        number;
  success:      number;
  failed:       number;
  errors:       RowResult[];
}> {
  // 1. Parse the Excel/CSV file
  const rows = parseSpreadsheet(fileBuffer, fileName);

  if (rows.length === 0) {
    throw Errors.badRequest("The uploaded file contains no data rows.", ErrorCode.INVALID_INPUT);
  }

  if (rows.length > MAX_ROWS) {
    throw Errors.badRequest(
      `File contains ${rows.length} rows. Maximum allowed per upload is ${MAX_ROWS}. Split into multiple files.`,
      ErrorCode.INVALID_INPUT
    );
  }

  // Update bulk_upload record with total count
  await prisma.bulkUpload.update({
    where: { id: bulkUploadId },
    data:  { totalRows: rows.length, status: "PROCESSING" },
  });

  // 2. Pre-fetch all taxonomy in one shot to avoid N+1 inside the loop
  const taxonomyCache = await buildTaxonomyCache();

  // 3. Process rows
  const results: RowResult[] = [];
  let successCount = 0;
  let failureCount = 0;

  // Process in batches to keep memory and DB load manageable
  for (let batchStart = 0; batchStart < rows.length; batchStart += BATCH_SIZE) {
    const batch = rows.slice(batchStart, batchStart + BATCH_SIZE);
    const batchResults = await processBatch(batch, batchStart, taxonomyCache, adminId, bulkUploadId);

    for (const r of batchResults) {
      results.push(r);
      if (r.status === "SUCCESS") successCount++;
      else failureCount++;
    }

    // Persist progress after each batch
    await prisma.bulkUpload.update({
      where: { id: bulkUploadId },
      data:  { successCount, failureCount },
    });

    log.info(
      { bulkUploadId, batchStart, batchEnd: batchStart + batch.length, successCount, failureCount },
      "Bulk upload batch processed"
    );
  }

  // 4. Mark upload complete
  const finalStatus = failureCount === rows.length ? "FAILED" : "COMPLETED";
  await prisma.bulkUpload.update({
    where: { id: bulkUploadId },
    data:  { status: finalStatus, successCount, failureCount },
  });

  audit.bulkUpload(
    adminId,
    bulkUploadId,
    { total: rows.length, success: successCount, failed: failureCount },
    adminIp
  );

  log.info({ bulkUploadId, successCount, failureCount }, "Bulk upload complete");

  return {
    bulkUploadId,
    total:   rows.length,
    success: successCount,
    failed:  failureCount,
    errors:  results.filter((r) => r.status === "FAILED"),
  };
}

// =============================================================================
// INITIATE BULK UPLOAD — creates the DB record, returns ID for async processing
// =============================================================================
export async function initiateBulkUpload(
  adminId:  string,
  fileName: string,
  s3Url:    string,
  exam:     string
): Promise<string> {
  const record = await prisma.bulkUpload.create({
    data: {
      adminId,
      fileName,
      s3Url,
      exam:          exam as any,
      totalRows:     0,
      status:        "PROCESSING",
      successCount:  0,
      failureCount:  0,
    },
  });
  return record.id;
}

// =============================================================================
// GET BULK UPLOAD STATUS
// =============================================================================
export async function getBulkUploadStatus(id: string, adminId: string) {
  const upload = await prisma.bulkUpload.findFirst({
    where: { id, adminId },
    select: {
      id:           true,
      fileName:     true,
      exam:         true,
      status:       true,
      totalRows:    true,
      successCount: true,
      failureCount: true,
      createdAt:    true,
      updatedAt:    true,
      items: {
        where:   { status: "FAILED" },
        select:  { rowNumber: true, errorMessage: true, rawData: true },
        orderBy: { rowNumber: "asc" },
        take:    100, // First 100 errors only
      },
    },
  });

  if (!upload) throw Errors.notFound("Bulk upload");
  return upload;
}

// =============================================================================
// LIST BULK UPLOADS for an admin
// =============================================================================
export async function listBulkUploads(adminId: string) {
  return prisma.bulkUpload.findMany({
    where:   { adminId },
    select: {
      id:           true,
      fileName:     true,
      exam:         true,
      status:       true,
      totalRows:    true,
      successCount: true,
      failureCount: true,
      createdAt:    true,
    },
    orderBy: { createdAt: "desc" },
    take:    20,
  });
}

// =============================================================================
// GENERATE EXCEL TEMPLATE for download
// =============================================================================
export function generateUploadTemplate(): Buffer {
  const wb = XLSX.utils.book_new();

  // ── Instructions sheet ────────────────────────────────────────────────────
  const instructions = [
    ["ExamEdge — Bulk Question Upload Template"],
    [""],
    ["INSTRUCTIONS:"],
    ["1. Do NOT modify column headers in the 'Questions' sheet."],
    ["2. Delete these instruction rows before uploading."],
    ["3. One row = one question. Max 500 rows per upload."],
    ["4. Required columns: exam, subject_code, chapter_name, type, question_text, correct_answer, solution_text"],
    ["5. Refer to the 'Reference' sheet for allowed values."],
    [""],
    ["COLUMN GUIDE:"],
    ["exam",             "NEET | JEE_MAIN | JEE_ADVANCED | CUET"],
    ["subject_code",     "PHY | CHEM | BIO | MATH | ENG | GT (must match seeded subjects)"],
    ["chapter_name",     "Exact chapter name as in the system"],
    ["topic_name",       "(Optional) Topic within the chapter"],
    ["type",             "MCQ_SINGLE | MCQ_MULTIPLE | INTEGER | ASSERTION | MATCH_COLUMN"],
    ["difficulty",       "EASY | MEDIUM | HARD (default: MEDIUM)"],
    ["question_text",    "The question body (required for all types)"],
    ["question_image_url", "(Optional) Full https:// URL of question image"],
    ["option_a/b/c/d",  "Required for MCQ_SINGLE, MCQ_MULTIPLE, ASSERTION types"],
    ["assertion",        "Required for ASSERTION type — the Assertion (A) statement"],
    ["reason",           "Required for ASSERTION type — the Reason (R) statement"],
    ["left_col_ids",     "MATCH_COLUMN: pipe-separated IDs e.g. 1|2|3"],
    ["left_col_texts",   "MATCH_COLUMN: pipe-separated texts e.g. Newton's law|Ohm's law|Boyle's law"],
    ["right_col_ids",    "MATCH_COLUMN: pipe-separated IDs e.g. P|Q|R"],
    ["right_col_texts",  "MATCH_COLUMN: pipe-separated texts e.g. Motion|Current|Pressure"],
    ["correct_answer",   "MCQ_SINGLE/ASSERTION: A/B/C/D | MCQ_MULTIPLE: A,C | INTEGER: 42 | MATCH: 1:P,2:Q,3:R"],
    ["solution_text",    "Detailed explanation (required)"],
    ["solution_image_url", "(Optional) Full https:// URL of solution image"],
    ["tags",             "(Optional) Comma-separated tags e.g. pyq,important,formula"],
    ["source_year",      "(Optional) Year for PYQ e.g. 2022"],
    ["source_exam",      "(Optional) e.g. NEET 2022 Paper 1"],
  ];

  const instructionSheet = XLSX.utils.aoa_to_sheet(instructions);
  instructionSheet["!cols"] = [{ wch: 25 }, { wch: 70 }];
  XLSX.utils.book_append_sheet(wb, instructionSheet, "Instructions");

  // ── Questions sheet (empty with headers) ─────────────────────────────────
  const headers = [
    "exam", "subject_code", "chapter_name", "topic_name",
    "type", "difficulty",
    "question_text", "question_image_url",
    "option_a", "option_b", "option_c", "option_d",
    "assertion", "reason",
    "left_col_ids", "left_col_texts", "right_col_ids", "right_col_texts",
    "correct_answer",
    "solution_text", "solution_image_url",
    "tags", "source_year", "source_exam",
  ];

  // Two sample rows
  const sampleMcq = [
    "NEET", "BIO", "The Living World", "Classification",
    "MCQ_SINGLE", "MEDIUM",
    "Which of the following is NOT a characteristic of living organisms?",
    "",
    "Growth", "Reproduction", "Excretion", "Crystallisation",
    "", "",
    "", "", "", "",
    "D",
    "Crystallisation is a property of non-living matter. All living organisms show growth, reproduction, and excretion.",
    "",
    "living world,characteristics", "2021", "NEET 2021",
  ];

  const sampleInteger = [
    "JEE_MAIN", "PHY", "Kinematics", "",
    "INTEGER", "HARD",
    "A ball is thrown vertically upward with velocity 20 m/s. What is the maximum height reached? (g = 10 m/s²)",
    "",
    "", "", "", "",
    "", "",
    "", "", "", "",
    "20",
    "Using v² = u² - 2gh, at max height v=0: 0 = 400 - 20h, h = 20m",
    "",
    "kinematics,projectile", "", "",
  ];

  const questionSheet = XLSX.utils.aoa_to_sheet([headers, sampleMcq, sampleInteger]);
  // Set column widths
  questionSheet["!cols"] = headers.map((h) => ({
    wch: ["question_text", "solution_text", "left_col_texts", "right_col_texts"].includes(h) ? 60 : 20,
  }));
  XLSX.utils.book_append_sheet(wb, questionSheet, "Questions");

  // ── Reference sheet ───────────────────────────────────────────────────────
  const reference = [
    ["EXAM VALUES",     "",              "TYPE VALUES",    "",                    "DIFFICULTY"],
    ["NEET",           "Medical",        "MCQ_SINGLE",    "4 options, 1 correct", "EASY"],
    ["JEE_MAIN",       "Engineering",    "MCQ_MULTIPLE",  "4 options, ≥1 correct","MEDIUM"],
    ["JEE_ADVANCED",   "IIT Engineering","INTEGER",       "Numeric answer",       "HARD"],
    ["CUET",           "Central Univ.",  "ASSERTION",     "Assertion-Reasoning",  ""],
    ["",               "",               "MATCH_COLUMN",  "Match left to right",  ""],
  ];
  const refSheet = XLSX.utils.aoa_to_sheet(reference);
  refSheet["!cols"] = [{ wch: 15 }, { wch: 18 }, { wch: 15 }, { wch: 25 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, refSheet, "Reference");

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

// =============================================================================
// Private — Parse spreadsheet buffer into raw rows
// =============================================================================
function parseSpreadsheet(buffer: Buffer, fileName: string): Record<string, unknown>[] {
  const ext = fileName.split(".").pop()?.toLowerCase();

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, {
      type:        "buffer",
      cellDates:   true,
      cellNF:      false,
      cellText:    false,
    });
  } catch {
    throw Errors.badRequest(
      "Could not parse file. Ensure it is a valid .xlsx or .csv file.",
      ErrorCode.INVALID_INPUT
    );
  }

  // Use the "Questions" sheet if it exists, otherwise the first sheet
  const sheetName =
    workbook.SheetNames.includes("Questions")
      ? "Questions"
      : workbook.SheetNames[0];

  if (!sheetName) {
    throw Errors.badRequest("Uploaded file has no sheets.", ErrorCode.INVALID_INPUT);
  }

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval:   "",     // Empty cells become empty string (not undefined)
    raw:      false,  // All values as strings for consistent parsing
    blankrows: false,
  });

  return rows;
}

// =============================================================================
// Private — Build taxonomy lookup maps (exam+subjectCode → subjectId, etc.)
// =============================================================================
async function buildTaxonomyCache() {
  const subjects = await prisma.subject.findMany({
    where:  { isActive: true },
    select: { id: true, code: true, exam: true },
  });

  const chapters = await prisma.chapter.findMany({
    where:   { isActive: true },
    select:  { id: true, name: true, subjectId: true },
  });

  const topics = await prisma.topic.findMany({
    where:   { isActive: true },
    select:  { id: true, name: true, chapterId: true },
  });

  // Maps for O(1) lookups
  const subjectMap = new Map(
    subjects.map((s) => [`${s.exam}:${s.code.toUpperCase()}`, s.id])
  );

  // chapterId by "subjectId:chapterNameLower"
  const chapterMap = new Map(
    chapters.map((c) => [`${c.subjectId}:${c.name.toLowerCase().trim()}`, c.id])
  );

  // topicId by "chapterId:topicNameLower"
  const topicMap = new Map(
    topics.map((t) => [`${t.chapterId}:${t.name.toLowerCase().trim()}`, t.id])
  );

  return { subjectMap, chapterMap, topicMap };
}

type TaxonomyCache = Awaited<ReturnType<typeof buildTaxonomyCache>>;

// =============================================================================
// Private — Process a single batch of rows
// =============================================================================
async function processBatch(
  rows:          Record<string, unknown>[],
  batchOffset:   number,
  taxonomy:      TaxonomyCache,
  adminId:       string,
  bulkUploadId:  string
): Promise<RowResult[]> {
  const results: RowResult[] = [];

  for (let i = 0; i < rows.length; i++) {
    const rowNumber = batchOffset + i + 2; // +2: 1-indexed + header row
    const rawData   = rows[i];

    try {
      // Step 1: Validate row schema
      const parsed = BulkUploadRowSchema.safeParse(rawData);
      if (!parsed.success) {
        const msg = parsed.error.issues
          .map((e) => `${e.path.join(".")}: ${e.message}`)
          .join("; ");
        throw new Error(msg);
      }

      // Step 2: Transform into structured question fields
      const transformed = transformRowToQuestion(parsed.data);

      // Step 3: Resolve taxonomy IDs from names/codes
      const subjectKey = `${transformed.exam}:${transformed.subjectCode.toUpperCase()}`;
      const subjectId  = taxonomy.subjectMap.get(subjectKey);
      if (!subjectId) {
        throw new Error(
          `Subject code "${transformed.subjectCode}" not found for exam "${transformed.exam}". Check the Reference sheet for valid codes.`
        );
      }

      const chapterKey = `${subjectId}:${transformed.chapterName.toLowerCase().trim()}`;
      const chapterId  = taxonomy.chapterMap.get(chapterKey);
      if (!chapterId) {
        throw new Error(
          `Chapter "${transformed.chapterName}" not found under subject code "${transformed.subjectCode}". Check exact chapter name spelling.`
        );
      }

      let topicId: string | null = null;
      if (transformed.topicName) {
        const topicKey = `${chapterId}:${transformed.topicName.toLowerCase().trim()}`;
        topicId        = taxonomy.topicMap.get(topicKey) ?? null;
        // Topic not found = warning, not error (topics are optional)
        if (!topicId) {
          log.warn(
            { topicName: transformed.topicName, chapterId },
            "Bulk upload: topic not found, leaving null"
          );
        }
      }

      // Step 4: Deep content validation by question type
      const validated = validateQuestionByType(
        transformed.type,
        transformed.content,
        transformed.options,
        transformed.correctAnswer,
        transformed.solution
      );

      // Step 5: Create question in DB
      const question = await prisma.question.create({
        data: {
          exam:          transformed.exam as any,
          subjectId,
          chapterId,
          topicId,
          type:          transformed.type as any,
          difficulty:    transformed.difficulty as any,
          status:        QuestionStatus.ACTIVE,
          content:       validated.content        as Prisma.InputJsonValue,
          options:       validated.options != null
                           ? (validated.options   as Prisma.InputJsonValue)
                           : Prisma.JsonNull,
          correctAnswer: validated.correctAnswer  as Prisma.InputJsonValue,
          solution:      validated.solution       as Prisma.InputJsonValue,
          tags:          transformed.tags,
          sourceYear:    transformed.sourceYear   ?? null,
          sourceExam:    transformed.sourceExam   ?? null,
          createdById:   adminId,
        },
        select: { id: true },
      });

      // Record success
      await prisma.bulkUploadItem.create({
        data: {
          bulkUploadId,
          rowNumber,
          questionId: question.id,
          status:     "SUCCESS",
          rawData:    rawData as Prisma.InputJsonValue,
        },
      });

      results.push({ rowNumber, status: "SUCCESS", questionId: question.id, rawData: rawData as Record<string, unknown> });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";

      // Record failure
      await prisma.bulkUploadItem.create({
        data: {
          bulkUploadId,
          rowNumber,
          status:       "FAILED",
          errorMessage,
          rawData:      rawData as Prisma.InputJsonValue,
        },
      });

      results.push({ rowNumber, status: "FAILED", errorMessage, rawData: rawData as Record<string, unknown> });
      log.debug({ rowNumber, errorMessage }, "Bulk upload row failed");
    }
  }

  return results;
}
