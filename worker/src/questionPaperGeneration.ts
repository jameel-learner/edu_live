import type { Env } from "./index";
import type { Blueprint, BlueprintSlot } from "./questionPaperBlueprints";
import type { ChapterChunks } from "./questionPaperRetrieval";
import { generateChatCompletion } from "./llm";
import { generateDiagramImage, isDiagramAllowlisted } from "./questionPaperImageGen";

export interface GeneratedQuestion {
  section: string;
  questionType: string;
  marks: number;
  text: string;
  latex?: string;
  table?: { headers: string[]; rows: string[][] };
  pageImageKey?: string;
  generatedImageKey?: string;
  imageSource?: "ingested" | "generated";
}

export interface GeneratedPaper {
  subject: string;
  class: string;
  marksTotal: number;
  blueprintVersion: string;
  sections: { section: string; questions: GeneratedQuestion[] }[];
}

export class GenerationError extends Error {}

const MAX_CHUNK_CHARS_PER_CHAPTER = 6000; // bounds prompt size regardless of chapter length
// Smallest useful excerpt per sampled chunk - below this, an excerpt is too
// short to set a question from, so fewer (evenly spaced) chunks are sampled.
const MIN_EXCERPT_CHARS = 400;

// Spec cost bound: image-gen fallback is "0-3 extra calls per paper".
export const MAX_GENERATED_DIAGRAMS = 3;

// max_tokens scales with paper size so an 80-mark paper (~2x the questions
// of a 40-mark one) isn't truncated mid-JSON, while staying bounded.
// 200 tokens/question was too tight in production (a 19-question 40-mark
// paper only got 3800 tokens) - the default model is a reasoning model
// (qwen3-235b-a22b), and its reasoning tokens count against max_tokens
// before it ever gets to the JSON answer, so real headroom needs to be
// well above "the JSON alone would need this many tokens." Raised with
// margin; the default model is OpenRouter's free tier, so a higher cap
// doesn't cost more unless a paid model is configured.
const TOKENS_PER_QUESTION = 450;
const MIN_GENERATION_TOKENS = 4000;
const MAX_GENERATION_TOKENS = 24000;

export function computeGenerationMaxTokens(totalQuestions: number): number {
  return Math.min(MAX_GENERATION_TOKENS, Math.max(MIN_GENERATION_TOKENS, totalQuestions * TOKENS_PER_QUESTION));
}

/**
 * Samples chunk text evenly across the WHOLE chapter within a fixed
 * character budget, rather than truncating from the start (which would
 * only ever show the LLM the chapter's opening pages).
 */
export function sampleChunkText(chunks: ChapterChunks, budget = MAX_CHUNK_CHARS_PER_CHAPTER): string {
  const texts = chunks.chunks.map((c) => c.text);
  const joined = texts.join("\n");
  if (joined.length <= budget || texts.length === 0) return joined.slice(0, budget);

  const n = texts.length;
  const k = Math.min(n, Math.max(1, Math.floor(budget / MIN_EXCERPT_CHARS)));
  // Budget minus the (k - 1) newline separators, split evenly per excerpt.
  const perExcerpt = Math.max(1, Math.floor((budget - (k - 1)) / k));
  const excerpts: string[] = [];
  for (let i = 0; i < k; i++) {
    // Evenly spaced indices spanning first..last chunk inclusive.
    const index = k === 1 ? 0 : Math.round((i * (n - 1)) / (k - 1));
    excerpts.push(texts[index].slice(0, perExcerpt));
  }
  return excerpts.join("\n");
}

interface ChapterSlot {
  slot: BlueprintSlot;
  filename: string;
}

function chapterSlotsInOrder(chaptersWithSlots: { chunks: ChapterChunks; slots: BlueprintSlot[] }[]): ChapterSlot[] {
  return chaptersWithSlots.flatMap(({ chunks, slots }) => slots.map((slot) => ({ slot, filename: chunks.filename })));
}

export function buildGenerationPrompt(
  blueprint: Blueprint,
  chaptersWithSlots: { chunks: ChapterChunks; slots: BlueprintSlot[] }[]
): { system: string; user: string } {
  const system =
    "You are an experienced CBSE/ICSE class 10 teacher setting an exam paper. " +
    "Follow the exact slot list given. Stay within standard NCERT/CBSE/ICSE class 10 syllabus " +
    "conventions. Prefer the provided source text; where it's thin, use your own syllabus " +
    "knowledge rather than inventing facts. Return ONLY valid JSON matching the schema described, " +
    "with no markdown fences and no commentary.";

  const slotLines = chapterSlotsInOrder(chaptersWithSlots)
    .map(
      ({ slot: s, filename }, i) =>
        `${i + 1}. chapter=${filename} section=${s.section} type=${s.questionType} marks=${s.marks} count=${s.count}${s.wantsDiagram ? " (set diagramNeeded=true for this slot's questions)" : ""}`
    )
    .join("\n");

  const sourceText = chaptersWithSlots
    .map(({ chunks }) => `--- Source: ${chunks.filename} ---\n${sampleChunkText(chunks)}`)
    .join("\n\n");

  const user =
    `Blueprint slots (fill exactly this many questions per slot, in order; draw each slot's questions from ` +
    `the source text of the chapter named on its line):\n${slotLines}\n\n` +
    `Source material:\n${sourceText}\n\n` +
    `Return JSON: {"questions": [{"section": string, "questionType": string, "marks": number, "text": string, ` +
    `"latex"?: string, "table"?: {"headers": string[], "rows": string[][]}, "diagramNeeded"?: boolean, ` +
    `"diagramDescription"?: string}]}. The questions array must contain exactly the total count across all slots, ` +
    `in the same order as the slot list.`;

  return { system, user };
}

interface RawQuestion {
  section?: unknown;
  questionType?: unknown;
  marks?: unknown;
  text?: unknown;
  latex?: unknown;
  table?: unknown;
  diagramNeeded?: unknown;
  diagramDescription?: unknown;
}

/**
 * Repair strategy for free-tier models that wrap JSON in markdown fences or
 * add prose around it: try the raw text, then with a ``` / ```json fence
 * stripped, then the substring from the first "{" to the last "}". Throws
 * GenerationError only if every attempt fails.
 */
export function parseLlmJson(raw: string): unknown {
  const attempts: string[] = [];
  const trimmed = raw.trim();
  attempts.push(trimmed);

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) attempts.push(fenced[1]);
  else attempts.push(trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) attempts.push(trimmed.slice(first, last + 1));

  let lastError: unknown;
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch (err) {
      lastError = err;
    }
  }
  throw new GenerationError(`LLM returned invalid JSON: ${(lastError as Error)?.message ?? "unparseable"}`);
}

function isValidTable(t: unknown): t is { headers: string[]; rows: string[][] } {
  const table = t as { headers?: unknown; rows?: unknown } | null;
  return (
    !!table &&
    Array.isArray(table.headers) &&
    Array.isArray(table.rows) &&
    table.rows.every((r) => Array.isArray(r))
  );
}

interface ParsedEntry {
  question: GeneratedQuestion;
  diagramNeeded: boolean;
  diagramDescription?: string;
}

function parseEntries(raw: string, orderedSlots: BlueprintSlot[]): ParsedEntry[] {
  const parsed = parseLlmJson(raw) as { questions?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.questions)) {
    throw new GenerationError("LLM response missing a 'questions' array");
  }

  // One entry per question, in slot order - the paper's structure comes from
  // here, never from what the LLM echoes back.
  const perQuestionSlots = orderedSlots.flatMap((s) => Array.from({ length: s.count }, () => s));
  let rawQuestions = parsed.questions as RawQuestion[];
  if (rawQuestions.length < perQuestionSlots.length) {
    // Can't safely invent missing questions - this must surface as a visible
    // failure rather than silently shipping a short paper.
    throw new GenerationError(
      `Expected ${perQuestionSlots.length} questions matching the blueprint, got ${rawQuestions.length}`
    );
  }
  if (rawQuestions.length > perQuestionSlots.length) {
    // Free-tier models occasionally over-generate by a question or two.
    // Since structure is assigned positionally from the blueprint (not from
    // what the LLM echoes), dropping the trailing excess is safe and keeps
    // this a zero-extra-cost recovery instead of failing the whole request.
    console.warn(
      `question paper generation: LLM returned ${rawQuestions.length} questions, expected ${perQuestionSlots.length} - truncating extras`
    );
    rawQuestions = rawQuestions.slice(0, perQuestionSlots.length);
  }

  return rawQuestions.map((q, i) => {
    const slot = perQuestionSlots[i];
    const question: GeneratedQuestion = {
      section: slot.section,
      questionType: slot.questionType,
      marks: slot.marks,
      text: typeof q?.text === "string" ? q.text : String(q?.text ?? ""),
      ...(typeof q?.latex === "string" && q.latex ? { latex: q.latex } : {}),
      ...(isValidTable(q?.table) ? { table: q.table } : {}),
    };
    return {
      question,
      diagramNeeded: q?.diagramNeeded === true,
      ...(typeof q?.diagramDescription === "string" ? { diagramDescription: q.diagramDescription } : {}),
    };
  });
}

function groupIntoPaper(entries: ParsedEntry[], blueprint: Blueprint): GeneratedPaper {
  const sectionsMap = new Map<string, GeneratedQuestion[]>();
  for (const { question } of entries) {
    if (!sectionsMap.has(question.section)) sectionsMap.set(question.section, []);
    sectionsMap.get(question.section)!.push(question);
  }
  return {
    subject: blueprint.subject,
    class: "", // filled in by the caller, which knows the requested class
    marksTotal: blueprint.marksTotal,
    blueprintVersion: blueprint.version,
    sections: Array.from(sectionsMap.entries()).map(([section, questions]) => ({ section, questions })),
  };
}

/**
 * `orderedSlots` is the slot order the prompt asked for (chapter-by-chapter
 * when multiple chapters are selected); defaults to the blueprint's own order.
 * section/questionType/marks are always taken from the slot at the same
 * position, so the paper structure exactly matches the blueprint.
 */
export function parseAndValidateGeneratedPaper(
  raw: string,
  blueprint: Blueprint,
  orderedSlots: BlueprintSlot[] = blueprint.slots
): GeneratedPaper {
  return groupIntoPaper(parseEntries(raw, orderedSlots), blueprint);
}

export async function generatePaper(
  env: Env,
  blueprint: Blueprint,
  chaptersWithSlots: { chunks: ChapterChunks; slots: BlueprintSlot[] }[],
  paperId: string,
  config: { llmProvider: "openrouter" | "workers-ai"; questionPaperModelSlug: string; questionPaperImageGenEnabled: boolean }
): Promise<GeneratedPaper> {
  const { system, user } = buildGenerationPrompt(blueprint, chaptersWithSlots);
  const orderedSlots = chapterSlotsInOrder(chaptersWithSlots).map((cs) => cs.slot);
  const totalQuestions = orderedSlots.reduce((sum, s) => sum + s.count, 0);

  const result = await generateChatCompletion(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    computeGenerationMaxTokens(totalQuestions),
    env,
    { llmProvider: config.llmProvider, llmModelSlug: config.questionPaperModelSlug }
  );

  const entries = parseEntries(result.text, orderedSlots);
  const paper = groupIntoPaper(entries, blueprint);

  // Candidate ingested page images across the selected chapters. Not a
  // precise per-question source link (the LLM doesn't echo which chunk it
  // used); de-duplicated because overlapping chunks share a page, so without
  // this consecutive diagram questions would get the same image repeatedly.
  const availablePageImageKeys = [
    ...new Set(
      chaptersWithSlots
        .flatMap(({ chunks }) => chunks.chunks)
        .map((c) => c.pageImageKey)
        .filter((k): k is string => !!k)
    ),
  ];

  let imageKeyCursor = 0;
  let generatedCount = 0;
  for (let i = 0; i < entries.length; i++) {
    const { question, diagramNeeded, diagramDescription } = entries[i];
    if (!diagramNeeded) continue;

    if (imageKeyCursor < availablePageImageKeys.length) {
      question.pageImageKey = availablePageImageKeys[imageKeyCursor++];
      question.imageSource = "ingested";
    } else if (
      diagramDescription &&
      config.questionPaperImageGenEnabled &&
      isDiagramAllowlisted(diagramDescription) &&
      generatedCount < MAX_GENERATED_DIAGRAMS
    ) {
      // Counted per attempted model call (success or not) - this is the cost cap.
      generatedCount++;
      const generated = await generateDiagramImage(
        env,
        paperId,
        `${question.section}-${i + 1}`,
        diagramDescription,
        config.questionPaperImageGenEnabled
      );
      if (generated) {
        question.generatedImageKey = generated.generatedImageKey;
        question.imageSource = "generated";
      }
    }
    // else: no image - omitting the image fields IS the text-placeholder
    // behavior; the question text stands alone.
  }

  return paper;
}
