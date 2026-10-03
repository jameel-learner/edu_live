import type { Env } from "./index";
import type { Blueprint, BlueprintSlot } from "./questionPaperBlueprints";
import type { ChapterChunks } from "./questionPaperRetrieval";
import { generateChatCompletion } from "./llm";
import { generateDiagramImage } from "./questionPaperImageGen";

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

function sampleChunkText(chunks: ChapterChunks): string {
  const joined = chunks.chunks.map((c) => c.text).join("\n");
  return joined.length > MAX_CHUNK_CHARS_PER_CHAPTER ? joined.slice(0, MAX_CHUNK_CHARS_PER_CHAPTER) : joined;
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

  const slotLines = chaptersWithSlots
    .flatMap(({ slots }) => slots)
    .map(
      (s, i) =>
        `${i + 1}. section=${s.section} type=${s.questionType} marks=${s.marks} count=${s.count}${s.wantsDiagram ? " (set diagramNeeded=true for this slot's questions)" : ""}`
    )
    .join("\n");

  const sourceText = chaptersWithSlots
    .map(({ chunks }) => `--- Source: ${chunks.filename} ---\n${sampleChunkText(chunks)}`)
    .join("\n\n");

  const user =
    `Blueprint slots (fill exactly this many questions per slot, in order):\n${slotLines}\n\n` +
    `Source material:\n${sourceText}\n\n` +
    `Return JSON: {"questions": [{"section": string, "questionType": string, "marks": number, "text": string, ` +
    `"latex"?: string, "table"?: {"headers": string[], "rows": string[][]}, "diagramNeeded"?: boolean, ` +
    `"diagramDescription"?: string}]}. The questions array must contain exactly the total count across all slots, ` +
    `in the same order as the slot list.`;

  return { system, user };
}

interface RawQuestion {
  section: string;
  questionType: string;
  marks: number;
  text: string;
  latex?: string;
  table?: { headers: string[]; rows: string[][] };
  diagramNeeded?: boolean;
  diagramDescription?: string;
}

export function parseAndValidateGeneratedPaper(raw: string, blueprint: Blueprint): GeneratedPaper {
  let parsed: { questions: RawQuestion[] };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new GenerationError(`LLM returned invalid JSON: ${(err as Error).message}`);
  }

  if (!parsed || !Array.isArray(parsed.questions)) {
    throw new GenerationError("LLM response missing a 'questions' array");
  }

  const expectedCount = blueprint.slots.reduce((sum, s) => sum + s.count, 0);
  if (parsed.questions.length !== expectedCount) {
    throw new GenerationError(
      `Expected ${expectedCount} questions matching the blueprint, got ${parsed.questions.length}`
    );
  }

  const sectionsMap = new Map<string, GeneratedQuestion[]>();
  for (const q of parsed.questions) {
    const question: GeneratedQuestion = {
      section: q.section,
      questionType: q.questionType,
      marks: q.marks,
      text: q.text,
      ...(q.latex ? { latex: q.latex } : {}),
      ...(q.table ? { table: q.table } : {}),
    };
    if (!sectionsMap.has(q.section)) sectionsMap.set(q.section, []);
    sectionsMap.get(q.section)!.push(question);
  }

  return {
    subject: blueprint.subject,
    class: "", // filled in by the caller (generatePaper), which knows the requested class
    marksTotal: blueprint.marksTotal,
    blueprintVersion: blueprint.version,
    sections: Array.from(sectionsMap.entries()).map(([section, questions]) => ({ section, questions })),
  };
}

// diagramNeeded/diagramDescription aren't part of GeneratedQuestion (they're
// resolved away before the caller sees the final paper), so this parses the
// raw LLM output a second time here rather than widening the public type.
function extractDiagramHints(raw: string): { diagramNeeded?: boolean; diagramDescription?: string }[] {
  const parsed = JSON.parse(raw) as { questions: RawQuestion[] };
  return parsed.questions.map((q) => ({ diagramNeeded: q.diagramNeeded, diagramDescription: q.diagramDescription }));
}

export async function generatePaper(
  env: Env,
  blueprint: Blueprint,
  chaptersWithSlots: { chunks: ChapterChunks; slots: BlueprintSlot[] }[],
  paperId: string,
  config: { llmProvider: "openrouter" | "workers-ai"; questionPaperModelSlug: string; questionPaperImageGenEnabled: boolean }
): Promise<GeneratedPaper> {
  const { system, user } = buildGenerationPrompt(blueprint, chaptersWithSlots);

  const result = await generateChatCompletion(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    4000,
    env,
    { llmProvider: config.llmProvider, llmModelSlug: config.questionPaperModelSlug }
  );

  const paper = parseAndValidateGeneratedPaper(result.text, blueprint);
  const diagramHints = extractDiagramHints(result.text);

  // Build a lookup from chunk pageImageKey candidates per chapter, used as
  // a fallback match for any diagram-flagged question (not a precise
  // per-question source link, since the LLM doesn't echo which chunk it
  // used - this is acceptable because wantsDiagram slots are intentionally
  // sparse and chapters with a captured figure usually have very few).
  const availablePageImageKeys = chaptersWithSlots
    .flatMap(({ chunks }) => chunks.chunks)
    .map((c) => c.pageImageKey)
    .filter((k): k is string => !!k);

  let flatIndex = 0;
  let imageKeyCursor = 0;
  for (const section of paper.sections) {
    for (const question of section.questions) {
      const hint = diagramHints[flatIndex++];
      if (hint?.diagramNeeded) {
        if (imageKeyCursor < availablePageImageKeys.length) {
          question.pageImageKey = availablePageImageKeys[imageKeyCursor++];
          question.imageSource = "ingested";
        } else if (hint.diagramDescription) {
          const generated = await generateDiagramImage(
            env,
            paperId,
            `${section.section}-${flatIndex}`,
            hint.diagramDescription,
            config.questionPaperImageGenEnabled
          );
          if (generated) {
            question.generatedImageKey = generated.generatedImageKey;
            question.imageSource = "generated";
          }
          // else: no image available - question.text stands alone as the
          // text placeholder path (caller/frontend shows the plain text;
          // no further code change needed here since omitting the image
          // fields IS the placeholder behavior).
        }
      }
    }
  }

  return paper;
}
