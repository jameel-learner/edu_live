import { describe, it, expect, vi, afterEach } from "vitest";
import { generateAnswerKey, validateAnswerKey } from "../src/questionPaperAnswerKey";
import { GenerationError, type GeneratedPaper } from "../src/questionPaperGeneration";
import type { Env } from "../src/index";
import * as llm from "../src/llm";

afterEach(() => vi.restoreAllMocks());

const paper: GeneratedPaper = {
  subject: "Science",
  class: "10",
  marksTotal: 40,
  blueprintVersion: "science-40-v1",
  sections: [{ section: "A", questions: [{ section: "A", questionType: "mcq", marks: 1, text: "What is catenation?" }] }],
};

describe("generateAnswerKey", () => {
  it("calls generateChatCompletion exactly once and returns one entry per question", async () => {
    const spy = vi.spyOn(llm, "generateChatCompletion").mockResolvedValue({
      text: JSON.stringify({ entries: [{ section: "A", questionIndex: 0, answer: "Carbon's ability to bond with itself." }] }),
      provider: "openrouter",
      model: "x",
    });

    const env = {} as Env;
    const key = await generateAnswerKey(env, paper, { llmProvider: "openrouter", questionPaperModelSlug: "some/model" });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(key.entries).toHaveLength(1);
    expect(key.entries[0].answer).toContain("Carbon");
  });

  it("does not include the source chunk text in the prompt (reuses paper questions only)", async () => {
    const spy = vi
      .spyOn(llm, "generateChatCompletion")
      .mockResolvedValue({ text: JSON.stringify({ entries: [{ section: "A", questionIndex: 0, answer: "x" }] }), provider: "openrouter", model: "x" });

    const env = {} as Env;
    await generateAnswerKey(env, paper, { llmProvider: "openrouter", questionPaperModelSlug: "some/model" });

    const callArgs = spy.mock.calls[0][0];
    const userMessage = callArgs.find((m) => m.role === "user")!.content;
    expect(userMessage).toContain("What is catenation?");
  });

  it("throws GenerationError (instead of returning data to be cached) when JSON parses but has no entries array", async () => {
    vi.spyOn(llm, "generateChatCompletion").mockResolvedValue({
      text: JSON.stringify({ answers: [{ section: "A", questionIndex: 0, answer: "x" }] }),
      provider: "openrouter",
      model: "x",
    });
    await expect(
      generateAnswerKey({} as Env, paper, { llmProvider: "openrouter", questionPaperModelSlug: "m" })
    ).rejects.toThrow(GenerationError);
  });

  it("throws GenerationError when an entry is missing required fields", async () => {
    vi.spyOn(llm, "generateChatCompletion").mockResolvedValue({
      text: JSON.stringify({ entries: [{ section: "A", answer: "no index" }] }),
      provider: "openrouter",
      model: "x",
    });
    await expect(
      generateAnswerKey({} as Env, paper, { llmProvider: "openrouter", questionPaperModelSlug: "m" })
    ).rejects.toThrow(GenerationError);
  });

  it("accepts a fenced JSON response and strips unexpected extra fields", async () => {
    vi.spyOn(llm, "generateChatCompletion").mockResolvedValue({
      text: "```json\n" + JSON.stringify({ entries: [{ section: "A", questionIndex: 0, answer: "ok", extra: 1 }] }) + "\n```",
      provider: "openrouter",
      model: "x",
    });
    const key = await generateAnswerKey({} as Env, paper, { llmProvider: "openrouter", questionPaperModelSlug: "m" });
    expect(key).toEqual({ entries: [{ section: "A", questionIndex: 0, answer: "ok" }] });
  });
});

describe("validateAnswerKey", () => {
  it("rejects null, non-objects, and non-array entries", () => {
    expect(() => validateAnswerKey(null)).toThrow(GenerationError);
    expect(() => validateAnswerKey("x")).toThrow(GenerationError);
    expect(() => validateAnswerKey({ entries: {} })).toThrow(GenerationError);
  });
});
