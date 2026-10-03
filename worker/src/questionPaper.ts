import type { Env } from "./index";
import { getRuntimeConfig } from "./config";
import { getBlueprint, distributeSlotsAcrossChapters } from "./questionPaperBlueprints";
import { fetchAllChapterChunks } from "./questionPaperRetrieval";
import { generatePaper, GenerationError } from "./questionPaperGeneration";
import { generateAnswerKey } from "./questionPaperAnswerKey";
import { renderPaperHtml, renderAnswerKeyHtml, renderHtmlToPdf } from "./questionPaperPdf";
import { computeCacheKey, findCachedPaper, saveNewPaper, findPaperById, saveAnswerKey, savePdfKey } from "./questionPaperCache";

function errorResponse(routeName: string, err: unknown, status = 500): Response {
  console.error(`${routeName} failed`, err);
  const message = err instanceof GenerationError ? err.message : "Something went wrong - please try again.";
  return Response.json({ error: message }, { status });
}

export async function handleQuestionPaperCatalog(env: Env): Promise<Response> {
  try {
    const listed = await env.PDF_BUCKET.list({ include: ["customMetadata"] });
    const documents = listed.objects
      .filter((obj) => !obj.key.startsWith("page-images/") && !obj.key.startsWith("cleaned/") && !obj.key.startsWith("question-papers/"))
      .filter((obj) => obj.customMetadata?.subject)
      .map((obj) => ({
        filename: obj.key,
        subject: obj.customMetadata!.subject!,
        class: obj.customMetadata!.class ?? "",
        chapter: obj.customMetadata!.chapter ?? "",
      }));
    return Response.json({ documents });
  } catch (err) {
    return errorResponse("/question-paper/catalog", err);
  }
}

interface GenerateRequestBody {
  subject: string;
  class: string;
  chapterFilenames: string[];
  marksTotal: number;
}

export async function handleQuestionPaperGenerate(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json().catch(() => null)) as GenerateRequestBody | null;
    if (!body || !body.subject || !body.class || !Array.isArray(body.chapterFilenames) || body.chapterFilenames.length === 0 || !body.marksTotal) {
      return Response.json({ error: "Expected subject, class, chapterFilenames[], and marksTotal" }, { status: 400 });
    }

    const blueprint = getBlueprint(body.subject, body.marksTotal);
    if (!blueprint) {
      return Response.json({ error: `No question paper template is available yet for ${body.subject}` }, { status: 400 });
    }

    const cacheKey = computeCacheKey(body.subject, body.class, body.marksTotal, body.chapterFilenames, blueprint.version);
    const cached = await findCachedPaper(env, cacheKey);
    if (cached) {
      return Response.json({ id: cached.id, paper: cached.paperJson, cached: true });
    }

    const { found, missing } = await fetchAllChapterChunks(env, body.chapterFilenames);
    if (missing.length > 0) {
      return Response.json({ error: `These chapters aren't available: ${missing.join(", ")}` }, { status: 400 });
    }

    const chapterChunkCounts = Object.fromEntries(found.map((c) => [c.filename, c.chunkCount]));
    const slotsByChapter = distributeSlotsAcrossChapters(blueprint, chapterChunkCounts);
    const chaptersWithSlots = found.map((chunks) => ({ chunks, slots: slotsByChapter[chunks.filename] ?? [] }));

    const config = await getRuntimeConfig(env);
    const id = crypto.randomUUID();
    const generated = await generatePaper(env, blueprint, chaptersWithSlots, id, {
      llmProvider: config.llmProvider,
      questionPaperModelSlug: config.questionPaperModelSlug,
      questionPaperImageGenEnabled: config.questionPaperImageGenEnabled,
    });
    generated.class = body.class;

    const row = await saveNewPaper(env, {
      id,
      cacheKey,
      subject: body.subject,
      class: body.class,
      marksTotal: body.marksTotal,
      chapterFilenames: body.chapterFilenames,
      blueprintVersion: blueprint.version,
      paperJson: generated,
      answerKeyJson: null,
      pdfR2Key: null,
      answerKeyPdfR2Key: null,
    });

    return Response.json({ id: row.id, paper: generated, cached: false });
  } catch (err) {
    return errorResponse("/question-paper/generate", err);
  }
}

export async function handleQuestionPaperAnswerKey(request: Request, env: Env, paperId: string): Promise<Response> {
  try {
    const row = await findPaperById(env, paperId);
    if (!row) return Response.json({ error: "Question paper not found" }, { status: 404 });

    if (row.answerKeyJson) {
      return Response.json({ answerKey: row.answerKeyJson, cached: true });
    }

    const config = await getRuntimeConfig(env);
    const answerKey = await generateAnswerKey(env, row.paperJson as any, {
      llmProvider: config.llmProvider,
      questionPaperModelSlug: config.questionPaperModelSlug,
    });
    await saveAnswerKey(env, paperId, answerKey);

    return Response.json({ answerKey, cached: false });
  } catch (err) {
    return errorResponse("/question-paper/:id/answer-key", err);
  }
}

export async function handleQuestionPaperPdf(env: Env, paperId: string): Promise<Response> {
  try {
    const row = await findPaperById(env, paperId);
    if (!row) return Response.json({ error: "Question paper not found" }, { status: 404 });

    if (row.pdfR2Key) {
      const object = await env.PDF_BUCKET.get(row.pdfR2Key);
      if (object) return new Response(object.body, { headers: { "content-type": "application/pdf" } });
    }

    const html = renderPaperHtml(row.paperJson as any);
    const pdf = await renderHtmlToPdf(env, html);
    if (!pdf) return Response.json({ error: "PDF generation failed, paper still available in-chat" }, { status: 500 });

    const key = `question-papers/${paperId}.pdf`;
    await env.PDF_BUCKET.put(key, pdf, { httpMetadata: { contentType: "application/pdf" } });
    await savePdfKey(env, paperId, "pdfR2Key", key);

    return new Response(pdf, { headers: { "content-type": "application/pdf" } });
  } catch (err) {
    return errorResponse("/question-paper/:id/pdf", err);
  }
}

export async function handleQuestionPaperAnswerKeyPdf(env: Env, paperId: string): Promise<Response> {
  try {
    const row = await findPaperById(env, paperId);
    if (!row) return Response.json({ error: "Question paper not found" }, { status: 404 });
    if (!row.answerKeyJson) {
      return Response.json({ error: "Generate the answer key before requesting its PDF" }, { status: 400 });
    }

    if (row.answerKeyPdfR2Key) {
      const object = await env.PDF_BUCKET.get(row.answerKeyPdfR2Key);
      if (object) return new Response(object.body, { headers: { "content-type": "application/pdf" } });
    }

    const html = renderAnswerKeyHtml(row.paperJson as any, row.answerKeyJson as any);
    const pdf = await renderHtmlToPdf(env, html);
    if (!pdf) return Response.json({ error: "PDF generation failed, answer key still available in-chat" }, { status: 500 });

    const key = `question-papers/${paperId}-key.pdf`;
    await env.PDF_BUCKET.put(key, pdf, { httpMetadata: { contentType: "application/pdf" } });
    await savePdfKey(env, paperId, "answerKeyPdfR2Key", key);

    return new Response(pdf, { headers: { "content-type": "application/pdf" } });
  } catch (err) {
    return errorResponse("/question-paper/:id/answer-key-pdf", err);
  }
}
