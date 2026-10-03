import { describe, it, expect, vi } from "vitest";
import { computeCacheKey, findCachedPaper, saveNewPaper, findPaperById, saveAnswerKey, savePdfKey } from "../src/questionPaperCache";
import type { Env } from "../src/index";

function makeEnv(overrides: Partial<{ first: unknown; all: { results: unknown[] }; run: unknown }> = {}) {
  const db = {
    prepare: vi.fn().mockReturnThis(),
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(overrides.first ?? null),
    all: vi.fn().mockResolvedValue(overrides.all ?? { results: [] }),
    run: vi.fn().mockResolvedValue(overrides.run ?? {}),
  };
  return { EDU_LIVE_DB: db } as unknown as Env;
}

describe("computeCacheKey", () => {
  it("is deterministic regardless of chapter filename order", () => {
    const a = computeCacheKey("Science", "10", 40, ["b.pdf", "a.pdf"], "science-40-v1");
    const b = computeCacheKey("Science", "10", 40, ["a.pdf", "b.pdf"], "science-40-v1");
    expect(a).toBe(b);
  });

  it("differs when marksTotal differs", () => {
    const a = computeCacheKey("Science", "10", 40, ["a.pdf"], "science-40-v1");
    const b = computeCacheKey("Science", "10", 80, ["a.pdf"], "science-40-v1");
    expect(a).not.toBe(b);
  });
});

describe("findCachedPaper", () => {
  it("returns null when no row matches", async () => {
    const env = makeEnv({ first: null });
    expect(await findCachedPaper(env, "nonexistent-key")).toBeNull();
  });

  it("parses JSON columns when a row matches", async () => {
    const env = makeEnv({
      first: {
        id: "p1",
        cache_key: "k1",
        subject: "Science",
        class: "10",
        marks_total: 40,
        chapter_filenames: '["a.pdf"]',
        blueprint_version: "science-40-v1",
        paper_json: '{"sections":[]}',
        answer_key_json: null,
        pdf_r2_key: null,
        answer_key_pdf_r2_key: null,
        created_at: "2026-10-03T00:00:00.000Z",
      },
    });
    const row = await findCachedPaper(env, "k1");
    expect(row).not.toBeNull();
    expect(row!.paperJson).toEqual({ sections: [] });
    expect(row!.chapterFilenames).toEqual(["a.pdf"]);
  });
});

describe("saveNewPaper / findPaperById / saveAnswerKey / savePdfKey", () => {
  it("saveNewPaper inserts and returns the row with createdAt set", async () => {
    const env = makeEnv();
    const row = await saveNewPaper(env, {
      id: "p1",
      cacheKey: "k1",
      subject: "Science",
      class: "10",
      marksTotal: 40,
      chapterFilenames: ["a.pdf"],
      blueprintVersion: "science-40-v1",
      paperJson: { sections: [] },
      answerKeyJson: null,
      pdfR2Key: null,
      answerKeyPdfR2Key: null,
    });
    expect(row.id).toBe("p1");
    expect(typeof row.createdAt).toBe("string");
  });

  it("uses INSERT ... ON CONFLICT(cache_key) DO NOTHING", async () => {
    const env = makeEnv({ run: { meta: { changes: 1 } } });
    await saveNewPaper(env, {
      id: "p1",
      cacheKey: "k1",
      subject: "Science",
      class: "10",
      marksTotal: 40,
      chapterFilenames: ["a.pdf"],
      blueprintVersion: "science-40-v1",
      paperJson: { sections: [] },
      answerKeyJson: null,
      pdfR2Key: null,
      answerKeyPdfR2Key: null,
    });
    const sql = (env.EDU_LIVE_DB.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toMatch(/ON CONFLICT\(cache_key\) DO NOTHING/);
  });

  it("two concurrent saves with the same cache_key don't throw - the loser gets the winner's row back", async () => {
    // Simulates D1: first INSERT inserts (changes=1), second hits the
    // conflict and is skipped (changes=0); the follow-up SELECT by
    // cache_key returns the winner's row.
    const winnerDbRow = {
      id: "winner",
      cache_key: "k1",
      subject: "Science",
      class: "10",
      marks_total: 40,
      chapter_filenames: '["a.pdf"]',
      blueprint_version: "science-40-v1",
      paper_json: '{"sections":[{"section":"A","questions":[]}]}',
      answer_key_json: null,
      pdf_r2_key: null,
      answer_key_pdf_r2_key: null,
      created_at: "2026-10-03T00:00:00.000Z",
    };
    const db = {
      prepare: vi.fn().mockReturnThis(),
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValueOnce({ meta: { changes: 1 } }).mockResolvedValueOnce({ meta: { changes: 0 } }),
      first: vi.fn().mockResolvedValue(winnerDbRow),
    };
    const env = { EDU_LIVE_DB: db } as unknown as Env;
    const base = {
      cacheKey: "k1",
      subject: "Science",
      class: "10",
      marksTotal: 40,
      chapterFilenames: ["a.pdf"],
      blueprintVersion: "science-40-v1",
      paperJson: { sections: [] },
      answerKeyJson: null,
      pdfR2Key: null,
      answerKeyPdfR2Key: null,
    };

    const [first, second] = await Promise.all([
      saveNewPaper(env, { ...base, id: "winner" }),
      saveNewPaper(env, { ...base, id: "loser" }),
    ]);

    expect(first.id).toBe("winner");
    expect(second.id).toBe("winner");
    expect(second.paperJson).toEqual({ sections: [{ section: "A", questions: [] }] });
  });

  it("findPaperById returns null for an unknown id", async () => {
    const env = makeEnv({ first: null });
    expect(await findPaperById(env, "unknown-id")).toBeNull();
  });

  it("saveAnswerKey and savePdfKey run without throwing", async () => {
    const env = makeEnv();
    await expect(saveAnswerKey(env, "p1", { answers: [] })).resolves.toBeUndefined();
    await expect(savePdfKey(env, "p1", "pdfR2Key", "question-papers/p1.pdf")).resolves.toBeUndefined();
  });
});
