import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "./index";
import type { GeneratedPaper } from "./questionPaperGeneration";
import type { AnswerKey } from "./questionPaperAnswerKey";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const BASE_STYLE =
  "body{font-family:Georgia,serif;padding:32px;} h1{font-size:20px;} h2{font-size:16px;margin-top:24px;} " +
  "ol{padding-left:20px;} li{margin-bottom:12px;}";

export function renderPaperHtml(paper: GeneratedPaper): string {
  const sections = paper.sections
    .map(
      (s) =>
        `<h2>Section ${escapeHtml(s.section)}</h2><ol>${s.questions
          .map((q) => `<li>${escapeHtml(q.text)} <em>[${q.marks} mark${q.marks === 1 ? "" : "s"}]</em></li>`)
          .join("")}</ol>`
    )
    .join("");

  return `<html><head><style>${BASE_STYLE}</style></head><body>` +
    `<h1>${escapeHtml(paper.subject)} - Class ${escapeHtml(paper.class)} (${paper.marksTotal} Marks)</h1>` +
    sections +
    `</body></html>`;
}

export function renderAnswerKeyHtml(paper: GeneratedPaper, key: AnswerKey): string {
  const answerByQuestion = new Map(key.entries.map((e) => [`${e.section}:${e.questionIndex}`, e.answer]));
  const sections = paper.sections
    .map(
      (s) =>
        `<h2>Section ${escapeHtml(s.section)}</h2><ol>${s.questions
          .map((q, i) => {
            const answer = answerByQuestion.get(`${s.section}:${i}`) ?? "";
            return `<li>${escapeHtml(q.text)}<br/><strong>Answer:</strong> ${escapeHtml(answer)}</li>`;
          })
          .join("")}</ol>`
    )
    .join("");

  return `<html><head><style>${BASE_STYLE}</style></head><body>` +
    `<h1>${escapeHtml(paper.subject)} - Class ${escapeHtml(paper.class)} Answer Key</h1>` +
    sections +
    `</body></html>`;
}

/**
 * Fails open: returns null (never throws) on any Browser Rendering error -
 * PDF generation must never block showing the paper itself, per the PDF
 * stage's fail-open contract.
 */
export async function renderHtmlToPdf(env: Env, html: string): Promise<ArrayBuffer | null> {
  let browser;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setContent(html);
    const pdf = await page.pdf();
    return pdf as unknown as ArrayBuffer;
  } catch (err) {
    console.error("question paper PDF rendering failed", err);
    return null;
  } finally {
    await browser?.close().catch(() => {});
  }
}
