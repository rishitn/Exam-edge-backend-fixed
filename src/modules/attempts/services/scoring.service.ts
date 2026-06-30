import { QuestionType } from "@prisma/client";

// =============================================================================
// Scoring Engine
// Pure functions — no DB or side effects.
// Handles: correct/wrong/unattempted per question type.
// Scoring model: correct = +1, wrong = 0, unattempted = 0
// (Marks weighting is handled in the calling service)
// =============================================================================

export interface QuestionResult {
  isCorrect: boolean;
  isPartiallyCorrect: boolean; // MCQ_MULTIPLE only
  isAttempted: boolean;
  marksAwarded: number;        // Raw marks before weight
}

// ── Normalise answer to a comparable form ────────────────────────────────────

function normalise(val: unknown): unknown {
  if (val === null || val === undefined) return null;
  if (typeof val === "string") return val.trim().toUpperCase();
  if (typeof val === "number") return val;
  if (Array.isArray(val)) return [...val].map((v) => String(v).trim().toUpperCase()).sort();
  if (typeof val === "object") {
    // MATCH_COLUMN: { "1": "P", "2": "Q" }
    const obj = val as Record<string, string>;
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k.trim(), String(v).trim().toUpperCase()])
    );
  }
  return val;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalise(a)) === JSON.stringify(normalise(b));
}

// ── Per-question scoring ──────────────────────────────────────────────────────

export function scoreAnswer(
  questionType: QuestionType,
  correctAnswer: unknown,
  studentAnswer: unknown
): QuestionResult {
  const isAttempted = studentAnswer !== null && studentAnswer !== undefined;

  if (!isAttempted) {
    return { isCorrect: false, isPartiallyCorrect: false, isAttempted: false, marksAwarded: 0 };
  }

  switch (questionType) {
    case QuestionType.MCQ_SINGLE:
    case QuestionType.ASSERTION: {
      const correct = deepEqual(correctAnswer, studentAnswer);
      return { isCorrect: correct, isPartiallyCorrect: false, isAttempted: true, marksAwarded: correct ? 1 : 0 };
    }

    case QuestionType.MCQ_MULTIPLE: {
      const correct = correctAnswer as string[];
      const student = studentAnswer as string[];
      const normCorrect = (correct.map((v) => String(v).toUpperCase())).sort();
      const normStudent = (student.map((v) => String(v).toUpperCase())).sort();

      const isCorrect = JSON.stringify(normCorrect) === JSON.stringify(normStudent);
      if (isCorrect) {
        return { isCorrect: true, isPartiallyCorrect: false, isAttempted: true, marksAwarded: 1 };
      }

      // Partial: student got some correct with no wrong selections
      const correctSet = new Set(normCorrect);
      const studentSet = new Set(normStudent);
      const hasWrong = [...studentSet].some((v) => !correctSet.has(v));
      const isPartiallyCorrect = !hasWrong && normStudent.length > 0 && normStudent.length < normCorrect.length;

      return {
        isCorrect: false,
        isPartiallyCorrect,
        isAttempted: true,
        marksAwarded: 0, // Partial credit applied in service layer based on scheme
      };
    }

    case QuestionType.INTEGER: {
      // Allow both numeric and string forms: "42" == 42
      const normCorrect = Number(correctAnswer);
      const normStudent = Number(studentAnswer);
      const correct = !isNaN(normCorrect) && !isNaN(normStudent) && Math.abs(normCorrect - normStudent) < 1e-9;
      return { isCorrect: correct, isPartiallyCorrect: false, isAttempted: true, marksAwarded: correct ? 1 : 0 };
    }

    case QuestionType.MATCH_COLUMN: {
      const correct = deepEqual(correctAnswer, studentAnswer);
      return { isCorrect: correct, isPartiallyCorrect: false, isAttempted: true, marksAwarded: correct ? 1 : 0 };
    }

    default:
      return { isCorrect: false, isPartiallyCorrect: false, isAttempted: true, marksAwarded: 0 };
  }
}

// ── Aggregate result across all answers ──────────────────────────────────────

export interface AggregateResult {
  rawScore: number;
  correctCount: number;
  incorrectCount: number;
  unattemptedCount: number;
  accuracyPct: number;          // correct / attempted * 100
}

export interface ScoredAnswer {
  questionId: string;
  sectionId: string;
  sectionName: string;
  questionType: QuestionType;
  correctAnswer: unknown;
  studentAnswer: unknown;
  isCorrect: boolean;
  isPartiallyCorrect: boolean;
  isAttempted: boolean;
  marksAwarded: number;
}

export function aggregateResults(answers: ScoredAnswer[]): {
  aggregate: AggregateResult;
  sectionScores: Record<string, { sectionName: string; score: number; correct: number; total: number }>;
} {
  let rawScore = 0;
  let correctCount = 0;
  let incorrectCount = 0;
  let unattemptedCount = 0;
  const sectionScores: Record<string, { sectionName: string; score: number; correct: number; total: number }> = {};

  for (const ans of answers) {
    // Init section bucket
    if (!sectionScores[ans.sectionId]) {
      sectionScores[ans.sectionId] = { sectionName: ans.sectionName, score: 0, correct: 0, total: 0 };
    }
    sectionScores[ans.sectionId].total++;

    if (!ans.isAttempted) {
      unattemptedCount++;
      continue;
    }

    rawScore += ans.marksAwarded;
    sectionScores[ans.sectionId].score += ans.marksAwarded;

    if (ans.isCorrect) {
      correctCount++;
      sectionScores[ans.sectionId].correct++;
    } else {
      incorrectCount++;
    }
  }

  const attempted = correctCount + incorrectCount;
  const accuracyPct = attempted > 0 ? (correctCount / attempted) * 100 : 0;

  return {
    aggregate: { rawScore, correctCount, incorrectCount, unattemptedCount, accuracyPct },
    sectionScores,
  };
}
