import { describe, it, expect, vi } from "vitest";
import { generateAnswerKey } from "../src/questionPaperAnswerKey";
import type { GeneratedPaper } from "../src/questionPaperGeneration";
import type { Env } from "../src/index";
import * as llm from "../src/llm";

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
});
