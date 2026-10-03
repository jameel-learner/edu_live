import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleQuestionPaperCatalog,
  handleQuestionPaperGenerate,
  handleQuestionPaperAnswerKey,
  handleQuestionPaperPdf,
} from "../src/questionPaper";
import type { Env } from "../src/index";
import * as cache from "../src/questionPaperCache";
import * as retrieval from "../src/questionPaperRetrieval";
import * as generation from "../src/questionPaperGeneration";
import * as config from "../src/config";
import * as llm from "../src/llm";

function baseEnv(): Env {
  return {
    PDF_BUCKET: { list: vi.fn().mockResolvedValue({ objects: [] }) },
  } as unknown as Env;
}

describe("handleQuestionPaperCatalog", () => {
  it("returns subject/class/chapter/filename for ingested documents, excluding admin-only fields", async () => {
    const env = {
      PDF_BUCKET: {
        list: vi.fn().mockResolvedValue({
          objects: [
            { key: "ch.pdf", customMetadata: { subject: "Science", class: "10", chapter: "Carbon", chunkCount: "5", enriched: "true" } },
          ],
        }),
      },
    } as unknown as Env;

    const response = await handleQuestionPaperCatalog(env);
    const body = (await response.json()) as any;
    expect(body.documents[0]).toEqual({ filename: "ch.pdf", subject: "Science", class: "10", chapter: "Carbon" });
    expect(body.documents[0].chunkCount).toBeUndefined();
    expect(body.documents[0].enriched).toBeUndefined();
  });
});

describe("handleQuestionPaperGenerate", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns 400 when marksTotal has no matching blueprint", async () => {
    vi.spyOn(config, "getRuntimeConfig").mockResolvedValue({ llmProvider: "openrouter", questionPaperModelSlug: "x", questionPaperImageGenEnabled: false } as any);
    const env = baseEnv();
    const request = new Request("http://worker/question-paper/generate", {
      method: "POST",
      body: JSON.stringify({ subject: "History", class: "10", chapterFilenames: ["a.pdf"], marksTotal: 40 }),
    });
    const response = await handleQuestionPaperGenerate(request, env);
    expect(response.status).toBe(400);
  });

  it("returns 400 when a chapter filename doesn't exist", async () => {
    vi.spyOn(config, "getRuntimeConfig").mockResolvedValue({ llmProvider: "openrouter", questionPaperModelSlug: "x", questionPaperImageGenEnabled: false } as any);
    vi.spyOn(cache, "findCachedPaper").mockResolvedValue(null);
    vi.spyOn(retrieval, "fetchAllChapterChunks").mockResolvedValue({ found: [], missing: ["missing.pdf"] });
    const env = baseEnv();
    const request = new Request("http://worker/question-paper/generate", {
      method: "POST",
      body: JSON.stringify({ subject: "Science", class: "10", chapterFilenames: ["missing.pdf"], marksTotal: 40 }),
    });
    const response = await handleQuestionPaperGenerate(request, env);
    expect(response.status).toBe(400);
  });

  it("returns a cached paper directly without calling generatePaper", async () => {
    vi.spyOn(config, "getRuntimeConfig").mockResolvedValue({ llmProvider: "openrouter", questionPaperModelSlug: "x", questionPaperImageGenEnabled: false } as any);
    vi.spyOn(cache, "findCachedPaper").mockResolvedValue({
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
      createdAt: "2026-10-03T00:00:00.000Z",
    });
    const generateSpy = vi.spyOn(generation, "generatePaper");

    const env = baseEnv();
    const request = new Request("http://worker/question-paper/generate", {
      method: "POST",
      body: JSON.stringify({ subject: "Science", class: "10", chapterFilenames: ["a.pdf"], marksTotal: 40 }),
    });
    const response = await handleQuestionPaperGenerate(request, env);
    const body = (await response.json()) as any;

    expect(body.id).toBe("p1");
    expect(generateSpy).not.toHaveBeenCalled();
  });

  it.each([10000000, 501, 0, -40, 40.5, "40"])(
    "rejects out-of-bound or non-integer marksTotal=%s with 400 before any lookup or LLM call",
    async (marksTotal) => {
      const findSpy = vi.spyOn(cache, "findCachedPaper").mockResolvedValue(null);
      const generateSpy = vi.spyOn(generation, "generatePaper");
      const request = new Request("http://worker/question-paper/generate", {
        method: "POST",
        body: JSON.stringify({ subject: "Science", class: "10", chapterFilenames: ["a.pdf"], marksTotal }),
      });
      const response = await handleQuestionPaperGenerate(request, baseEnv());
      expect(response.status).toBe(400);
      expect(((await response.json()) as any).error).toMatch(/marksTotal/);
      expect(findSpy).not.toHaveBeenCalled();
      expect(generateSpy).not.toHaveBeenCalled();
    }
  );

  it("trims class so '10' and '10 ' share one cache key and the persisted class is trimmed", async () => {
    const findSpy = vi.spyOn(cache, "findCachedPaper").mockResolvedValue(null);
    vi.spyOn(retrieval, "fetchAllChapterChunks").mockResolvedValue({ found: [], missing: ["a.pdf"] });
    const send = (cls: string) =>
      handleQuestionPaperGenerate(
        new Request("http://worker/question-paper/generate", {
          method: "POST",
          body: JSON.stringify({ subject: "Science", class: cls, chapterFilenames: ["a.pdf"], marksTotal: 40 }),
        }),
        baseEnv()
      );
    await send("10");
    await send(" 10 ");
    expect(findSpy.mock.calls[0][1]).toBe(findSpy.mock.calls[1][1]);
  });

  it("returns the concurrent winner's paper and id when saveNewPaper reports a cache_key conflict", async () => {
    vi.spyOn(config, "getRuntimeConfig").mockResolvedValue({ llmProvider: "openrouter", questionPaperModelSlug: "x", questionPaperImageGenEnabled: false } as any);
    vi.spyOn(cache, "findCachedPaper").mockResolvedValue(null);
    vi.spyOn(retrieval, "fetchAllChapterChunks").mockResolvedValue({
      found: [{ filename: "a.pdf", chunkCount: 1, chunks: [{ chunkId: 0, page: 1, text: "t", pageImageKey: null }] }],
      missing: [],
    });
    vi.spyOn(generation, "generatePaper").mockResolvedValue({
      subject: "Science",
      class: "",
      marksTotal: 40,
      blueprintVersion: "science-40-v1",
      sections: [{ section: "A", questions: [] }],
    });
    const winnerPaper = { subject: "Science", class: "10", marksTotal: 40, blueprintVersion: "science-40-v1", sections: [] };
    const saveSpy = vi.spyOn(cache, "saveNewPaper").mockImplementation(async (_env, row) => ({
      ...row,
      id: "winner-id",
      paperJson: winnerPaper,
      createdAt: "2026-10-03T00:00:00.000Z",
    }));

    const response = await handleQuestionPaperGenerate(
      new Request("http://worker/question-paper/generate", {
        method: "POST",
        body: JSON.stringify({ subject: "Science", class: "10 ", chapterFilenames: ["a.pdf"], marksTotal: 40 }),
      }),
      baseEnv()
    );
    const body = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(body.id).toBe("winner-id");
    expect(body.paper).toEqual(winnerPaper);
    expect(body.cached).toBe(true);
    expect(saveSpy.mock.calls[0][1].class).toBe("10");
  });
});

describe("handleQuestionPaperAnswerKey / handleQuestionPaperPdf", () => {
  it("answer key returns 404 for an unknown paper id", async () => {
    vi.spyOn(cache, "findPaperById").mockResolvedValue(null);
    const env = baseEnv();
    const request = new Request("http://worker/question-paper/unknown/answer-key", { method: "POST" });
    const response = await handleQuestionPaperAnswerKey(request, env, "unknown");
    expect(response.status).toBe(404);
  });

  it("does not cache a malformed answer key - returns an error and never calls saveAnswerKey", async () => {
    vi.spyOn(cache, "findPaperById").mockResolvedValue({
      id: "p1",
      cacheKey: "k1",
      subject: "Science",
      class: "10",
      marksTotal: 40,
      chapterFilenames: ["a.pdf"],
      blueprintVersion: "science-40-v1",
      paperJson: { subject: "Science", class: "10", marksTotal: 40, blueprintVersion: "v", sections: [{ section: "A", questions: [{ section: "A", questionType: "mcq", marks: 1, text: "Q" }] }] },
      answerKeyJson: null,
      pdfR2Key: null,
      answerKeyPdfR2Key: null,
      createdAt: "2026-10-03T00:00:00.000Z",
    });
    vi.spyOn(config, "getRuntimeConfig").mockResolvedValue({ llmProvider: "openrouter", questionPaperModelSlug: "x" } as any);
    vi.spyOn(llm, "generateChatCompletion").mockResolvedValue({ text: '{"answers": []}', provider: "openrouter", model: "x" });
    const saveSpy = vi.spyOn(cache, "saveAnswerKey").mockResolvedValue(undefined);

    const response = await handleQuestionPaperAnswerKey(
      new Request("http://worker/question-paper/p1/answer-key", { method: "POST" }),
      baseEnv(),
      "p1"
    );

    expect(response.status).toBe(500);
    expect(saveSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("pdf returns 404 for an unknown paper id", async () => {
    vi.spyOn(cache, "findPaperById").mockResolvedValue(null);
    const env = baseEnv();
    const response = await handleQuestionPaperPdf(env, "unknown");
    expect(response.status).toBe(404);
  });
});
