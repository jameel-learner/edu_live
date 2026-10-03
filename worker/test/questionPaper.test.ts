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
});

describe("handleQuestionPaperAnswerKey / handleQuestionPaperPdf", () => {
  it("answer key returns 404 for an unknown paper id", async () => {
    vi.spyOn(cache, "findPaperById").mockResolvedValue(null);
    const env = baseEnv();
    const request = new Request("http://worker/question-paper/unknown/answer-key", { method: "POST" });
    const response = await handleQuestionPaperAnswerKey(request, env, "unknown");
    expect(response.status).toBe(404);
  });

  it("pdf returns 404 for an unknown paper id", async () => {
    vi.spyOn(cache, "findPaperById").mockResolvedValue(null);
    const env = baseEnv();
    const response = await handleQuestionPaperPdf(env, "unknown");
    expect(response.status).toBe(404);
  });
});
