import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "./index";
import type { GeneratedPaper, GeneratedQuestion } from "./questionPaperGeneration";
import type { AnswerKey } from "./questionPaperAnswerKey";
import { isServableImageKey } from "./images";

function escapeHtml(text: unknown): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const BASE_STYLE =
  "body{font-family:Georgia,serif;padding:32px;} h1{font-size:20px;} h2{font-size:16px;margin-top:24px;} " +
  "ol{padding-left:20px;} li{margin-bottom:12px;} " +
  "table{border-collapse:collapse;margin:8px 0;} th,td{border:1px solid #444;padding:4px 8px;font-size:13px;} " +
  "pre.qp-latex{font-family:'Courier New',monospace;background:#f4f4f4;padding:6px 8px;white-space:pre-wrap;margin:6px 0;} " +
  "img.qp-diagram{display:block;max-width:100%;max-height:360px;margin:8px 0;}";

function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function questionImageKey(q: GeneratedQuestion): string | undefined {
  return q.pageImageKey || q.generatedImageKey;
}

/**
 * Fetches every question's diagram from R2 and returns key -> data: URL, so
 * the rendered PDF is self-contained (no HTTP fetch from inside Browser
 * Rendering, no CORS/auth concerns). Fails open per image: a missing or
 * unreadable image is simply omitted from the PDF.
 */
async function loadImageDataUrls(env: Env, paper: GeneratedPaper): Promise<Map<string, string>> {
  const keys = [
    ...new Set(
      paper.sections
        .flatMap((s) => s.questions)
        .map(questionImageKey)
        .filter((k): k is string => !!k && isServableImageKey(k))
    ),
  ];
  const entries = await Promise.all(
    keys.map(async (key): Promise<[string, string] | null> => {
      try {
        const object = await env.PDF_BUCKET.get(key);
        if (!object) return null;
        return [key, `data:image/png;base64,${bytesToBase64(await object.arrayBuffer())}`];
      } catch (err) {
        console.error("question paper PDF: failed to load image, omitting it", key, err);
        return null;
      }
    })
  );
  return new Map(entries.filter((e): e is [string, string] => e !== null));
}

function renderTable(table: GeneratedQuestion["table"]): string {
  if (!table || !Array.isArray(table.headers) || !Array.isArray(table.rows)) return "";
  const head = `<tr>${table.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr>`;
  const body = table.rows
    .map((row) => `<tr>${(Array.isArray(row) ? row : []).map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function renderQuestionBody(q: GeneratedQuestion, images: Map<string, string>): string {
  const marks = `<em>[${escapeHtml(q.marks)} mark${q.marks === 1 ? "" : "s"}]</em>`;
  const latex = q.latex ? `<pre class="qp-latex">${escapeHtml(q.latex)}</pre>` : "";
  const key = questionImageKey(q);
  const dataUrl = key ? images.get(key) : undefined;
  const image = dataUrl ? `<img class="qp-diagram" src="${dataUrl}" alt="diagram" />` : "";
  return `${escapeHtml(q.text)} ${marks}${latex}${renderTable(q.table)}${image}`;
}

export async function renderPaperHtml(paper: GeneratedPaper, env: Env): Promise<string> {
  const images = await loadImageDataUrls(env, paper);
  const sections = paper.sections
    .map(
      (s) =>
        `<h2>Section ${escapeHtml(s.section)}</h2><ol>${s.questions
          .map((q) => `<li>${renderQuestionBody(q, images)}</li>`)
          .join("")}</ol>`
    )
    .join("");

  return `<html><head><style>${BASE_STYLE}</style></head><body>` +
    `<h1>${escapeHtml(paper.subject)} - Class ${escapeHtml(paper.class)} (${escapeHtml(paper.marksTotal)} Marks)</h1>` +
    sections +
    `</body></html>`;
}

export async function renderAnswerKeyHtml(paper: GeneratedPaper, key: AnswerKey, env: Env): Promise<string> {
  const images = await loadImageDataUrls(env, paper);
  const answerByQuestion = new Map(key.entries.map((e) => [`${e.section}:${e.questionIndex}`, e.answer]));
  const sections = paper.sections
    .map(
      (s) =>
        `<h2>Section ${escapeHtml(s.section)}</h2><ol>${s.questions
          .map((q, i) => {
            const answer = answerByQuestion.get(`${s.section}:${i}`) ?? "";
            return `<li>${renderQuestionBody(q, images)}<br/><strong>Answer:</strong> ${escapeHtml(answer)}</li>`;
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
