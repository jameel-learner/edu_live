import type { Env } from "./index";
import type { GeneratedPaper } from "./questionPaperGeneration";
import { generateChatCompletion } from "./llm";

export interface AnswerKeyEntry {
  section: string;
  questionIndex: number;
  answer: string;
}

export interface AnswerKey {
  entries: AnswerKeyEntry[];
}

export async function generateAnswerKey(
  env: Env,
  paper: GeneratedPaper,
  config: { llmProvider: "openrouter" | "workers-ai"; questionPaperModelSlug: string }
): Promise<AnswerKey> {
  const system =
    "You are a CBSE/ICSE class 10 examiner writing a concise, mark-scheme-style answer key. " +
    "For each question, give the key points/model answer only - not a full essay. Return ONLY valid JSON.";

  const questionLines = paper.sections
    .flatMap((s) => s.questions.map((q, i) => ({ section: s.section, questionIndex: i, text: q.text, marks: q.marks })))
    .map((q) => `section=${q.section} index=${q.questionIndex} marks=${q.marks}: ${q.text}`)
    .join("\n");

  const user =
    `Write answers for each question below.\n${questionLines}\n\n` +
    `Return JSON: {"entries": [{"section": string, "questionIndex": number, "answer": string}]}, one entry per question above.`;

  const result = await generateChatCompletion(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    3000,
    env,
    { llmProvider: config.llmProvider, llmModelSlug: config.questionPaperModelSlug }
  );

  return JSON.parse(result.text) as AnswerKey;
}
