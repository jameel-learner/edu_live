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

function envWithImages(images: Record<string, Uint8Array>): Env {
  return {
    PDF_BUCKET: {
      get: vi.fn(async (key: string) =>
        images[key] ? ({ arrayBuffer: async () => images[key].buffer } as unknown as R2ObjectBody) : null
      ),
    },
  } as unknown as Env;
}

const richPaper: GeneratedPaper = {
  subject: "Science",
  class: "10",
  marksTotal: 40,
  blueprintVersion: "science-40-v1",
  sections: [
    {
      section: "B",
      questions: [
        {
          section: "B",
          questionType: "short_answer",
          marks: 3,
          text: "Use <b>Ohm's</b> law & the table",
          latex: "V = IR < 5",
          table: { headers: ["V", "I<x>"], rows: [["2", "0.5"]] },
          generatedImageKey: "question-papers/p1/gen-B-1.png",
          imageSource: "generated",
        },
        {
          section: "B",
          questionType: "short_answer",
          marks: 3,
          text: "Label the figure",
          pageImageKey: "page-images/ch.pdf/2.png",
          imageSource: "ingested",
        },
        {
          section: "B",
          questionType: "short_answer",
          marks: 3,
          text: "Missing image question",
          pageImageKey: "page-images/ch.pdf/missing.png",
          imageSource: "ingested",
        },
      ],
    },
  ],
};

describe("renderPaperHtml", () => {
  it("includes the subject, marks total, section heading, and question text", async () => {
    const html = await renderPaperHtml(paper, envWithImages({}));
    expect(html).toContain("Science");
    expect(html).toContain("40");
    expect(html).toContain("Section A");
    expect(html).toContain("What is catenation?");
  });

  it("renders tables, LaTeX blocks, and embeds images as base64 data URLs fetched from R2", async () => {
    const env = envWithImages({
      "question-papers/p1/gen-B-1.png": new Uint8Array([1, 2, 3]),
      "page-images/ch.pdf/2.png": new Uint8Array([4, 5, 6]),
    });
    const html = await renderPaperHtml(richPaper, env);

    expect(html).toContain("<table>");
    expect(html).toContain("<th>I&lt;x&gt;</th>");
    expect(html).toContain("<td>0.5</td>");
    expect(html).toContain('<pre class="qp-latex">V = IR &lt; 5</pre>');
    expect(html).toContain(`src="data:image/png;base64,${btoa(String.fromCharCode(1, 2, 3))}"`);
    expect(html).toContain(`src="data:image/png;base64,${btoa(String.fromCharCode(4, 5, 6))}"`);
    // A missing R2 object just omits that image (fails open).
    expect(html.match(/<img /g)).toHaveLength(2);
  });

  it("escapes interpolated question text", async () => {
    const html = await renderPaperHtml(richPaper, envWithImages({}));
    expect(html).toContain("Use &lt;b&gt;Ohm&#39;s&lt;/b&gt; law &amp; the table");
    expect(html).not.toContain("<b>Ohm");
  });
});

describe("renderAnswerKeyHtml", () => {
  it("includes each question's answer text", async () => {
    const key: AnswerKey = { entries: [{ section: "A", questionIndex: 0, answer: "Carbon bonds with itself." }] };
    const html = await renderAnswerKeyHtml(paper, key, envWithImages({}));
    expect(html).toContain("Carbon bonds with itself.");
  });

  it("renders tables/LaTeX/images alongside the answers and escapes the answer text", async () => {
    const key: AnswerKey = { entries: [{ section: "B", questionIndex: 0, answer: "I = V/R <script>" }] };
    const env = envWithImages({ "question-papers/p1/gen-B-1.png": new Uint8Array([7]) });
    const html = await renderAnswerKeyHtml(richPaper, key, env);
    expect(html).toContain("<table>");
    expect(html).toContain('<pre class="qp-latex">');
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain("I = V/R &lt;script&gt;");
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
