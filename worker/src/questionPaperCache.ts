import type { Env } from "./index";

export interface QuestionPaperRow {
  id: string;
  cacheKey: string;
  subject: string;
  marksTotal: number;
  chapterFilenames: string[];
  blueprintVersion: string;
  paperJson: unknown;
  answerKeyJson: unknown | null;
  pdfR2Key: string | null;
  answerKeyPdfR2Key: string | null;
  createdAt: string;
}

// Plain FNV-1a hash over a canonical string - deterministic across chapter
// order, cheap, no crypto dependency needed for a cache key (not a secret).
function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function computeCacheKey(
  subject: string,
  marksTotal: number,
  chapterFilenames: string[],
  blueprintVersion: string
): string {
  const canonical = [subject, String(marksTotal), [...chapterFilenames].sort().join(","), blueprintVersion].join("|");
  return hashString(canonical);
}

function rowFromDb(raw: Record<string, unknown>): QuestionPaperRow {
  return {
    id: raw.id as string,
    cacheKey: raw.cache_key as string,
    subject: raw.subject as string,
    marksTotal: Number(raw.marks_total),
    chapterFilenames: JSON.parse(raw.chapter_filenames as string),
    blueprintVersion: raw.blueprint_version as string,
    paperJson: JSON.parse(raw.paper_json as string),
    answerKeyJson: raw.answer_key_json ? JSON.parse(raw.answer_key_json as string) : null,
    pdfR2Key: (raw.pdf_r2_key as string | null) ?? null,
    answerKeyPdfR2Key: (raw.answer_key_pdf_r2_key as string | null) ?? null,
    createdAt: raw.created_at as string,
  };
}

export async function findCachedPaper(env: Env, cacheKey: string): Promise<QuestionPaperRow | null> {
  const row = await env.EDU_LIVE_DB.prepare("SELECT * FROM question_papers WHERE cache_key = ?")
    .bind(cacheKey)
    .first<Record<string, unknown>>();
  return row ? rowFromDb(row) : null;
}

export async function findPaperById(env: Env, id: string): Promise<QuestionPaperRow | null> {
  const row = await env.EDU_LIVE_DB.prepare("SELECT * FROM question_papers WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
  return row ? rowFromDb(row) : null;
}

/**
 * Race-safe insert: two concurrent cache-misses for the same cache_key both
 * generate a paper, but only the first insert wins. The loser gets the
 * winner's existing row back (check `returned.id !== row.id`) instead of a
 * UNIQUE-constraint 500.
 */
export async function saveNewPaper(
  env: Env,
  row: Omit<QuestionPaperRow, "createdAt">
): Promise<QuestionPaperRow> {
  const createdAt = new Date().toISOString();
  const result = await env.EDU_LIVE_DB.prepare(
    `INSERT INTO question_papers
      (id, cache_key, subject, marks_total, chapter_filenames, blueprint_version, paper_json, answer_key_json, pdf_r2_key, answer_key_pdf_r2_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO NOTHING`
  )
    .bind(
      row.id,
      row.cacheKey,
      row.subject,
      row.marksTotal,
      JSON.stringify(row.chapterFilenames),
      row.blueprintVersion,
      JSON.stringify(row.paperJson),
      row.answerKeyJson ? JSON.stringify(row.answerKeyJson) : null,
      row.pdfR2Key,
      row.answerKeyPdfR2Key,
      createdAt
    )
    .run();

  if (result?.meta?.changes === 0) {
    const existing = await findCachedPaper(env, row.cacheKey);
    if (existing) return existing;
    throw new Error(`question paper insert for cache_key ${row.cacheKey} was skipped but no existing row was found`);
  }
  return { ...row, createdAt };
}

export async function saveAnswerKey(env: Env, id: string, answerKeyJson: unknown): Promise<void> {
  await env.EDU_LIVE_DB.prepare("UPDATE question_papers SET answer_key_json = ? WHERE id = ?")
    .bind(JSON.stringify(answerKeyJson), id)
    .run();
}

export async function savePdfKey(
  env: Env,
  id: string,
  field: "pdfR2Key" | "answerKeyPdfR2Key",
  r2Key: string
): Promise<void> {
  const column = field === "pdfR2Key" ? "pdf_r2_key" : "answer_key_pdf_r2_key";
  await env.EDU_LIVE_DB.prepare(`UPDATE question_papers SET ${column} = ? WHERE id = ?`).bind(r2Key, id).run();
}
