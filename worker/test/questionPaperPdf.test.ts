import { describe, it, expect, vi } from "vitest";
import { renderPaperHtml, renderAnswerKeyHtml, renderHtmlToPdf } from "../src/questionPaperPdf";
import type { GeneratedPaper } from "../src/questionPaperGeneration";
import type { AnswerKey } from "../src/questionPaperAnswerKey";
import type { Env } from "../src/index";

const paper: GeneratedPaper = {
  subject: "Science",
  class: "10",
  marksTotal: 40,
  blueprintVersion: "science-40-v1",
  sections: [{ section: "A", questions: [{ section: "A", questionType: "mcq", marks: 1, text: "What is catenation?" }] }],
};

describe("renderPaperHtml", () => {
  it("includes the subject, marks total, section heading, and question text", () => {
    const html = renderPaperHtml(paper);
    expect(html).toContain("Science");
    expect(html).toContain("40");
    expect(html).toContain("Section A");
    expect(html).toContain("What is catenation?");
  });
});

describe("renderAnswerKeyHtml", () => {
  it("includes each question's answer text", () => {
    const key: AnswerKey = { entries: [{ section: "A", questionIndex: 0, answer: "Carbon bonds with itself." }] };
    const html = renderAnswerKeyHtml(paper, key);
    expect(html).toContain("Carbon bonds with itself.");
  });
});

describe("renderHtmlToPdf", () => {
  it("returns null (fails open) when the browser launch throws", async () => {
    const env = { BROWSER: {} } as unknown as Env;
    const result = await renderHtmlToPdf(env, "<html></html>");
    // In the Vitest environment there's no real Browser Rendering binding,
    // so this always exercises the fail-open path - that's the behavior
    // under test here.
    expect(result).toBeNull();
  });
});
