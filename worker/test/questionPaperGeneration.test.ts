import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildGenerationPrompt,
  parseAndValidateGeneratedPaper,
  generatePaper,
  GenerationError,
  parseLlmJson,
  sampleChunkText,
  computeGenerationMaxTokens,
  MAX_GENERATED_DIAGRAMS,
} from "../src/questionPaperGeneration";
import { getBlueprint } from "../src/questionPaperBlueprints";
import type { Env } from "../src/index";
import * as llm from "../src/llm";
import * as imageGen from "../src/questionPaperImageGen";

afterEach(() => vi.restoreAllMocks());

const blueprint = getBlueprint("Science", 40)!;
const chaptersWithSlots = [
  {
    chunks: { filename: "ch.pdf", chunkCount: 1, chunks: [{ chunkId: 0, page: 1, text: "Carbon forms covalent bonds.", pageImageKey: null }] },
    slots: blueprint.slots,
  },
];

describe("buildGenerationPrompt", () => {
  it("includes every slot's marks/type/count and the chunk text in the user prompt", () => {
    const { system, user } = buildGenerationPrompt(blueprint, chaptersWithSlots);
    expect(system).toContain("CBSE");
    expect(user).toContain("Carbon forms covalent bonds.");
    for (const slot of blueprint.slots) {
      expect(user).toContain(String(slot.marks));
    }
  });
});

function totalQuestionCount(bp = blueprint) {
  return bp.slots.reduce((sum, s) => sum + s.count, 0);
}

describe("parseAndValidateGeneratedPaper", () => {
  it("parses valid JSON matching the blueprint's slot count", () => {
    const questions = Array.from({ length: totalQuestionCount() }, (_, i) => ({
      section: "A",
      questionType: "mcq",
      marks: 1,
      text: `Question ${i}`,
    }));
    const raw = JSON.stringify({ questions });
    const result = parseAndValidateGeneratedPaper(raw, blueprint);
    expect(result.sections.flatMap((s) => s.questions)).toHaveLength(totalQuestionCount());
  });

  it("throws GenerationError on malformed JSON", () => {
    expect(() => parseAndValidateGeneratedPaper("not json", blueprint)).toThrow(GenerationError);
  });

  it("ships a smaller paper instead of throwing when the LLM under-generates", () => {
    const raw = JSON.stringify({ questions: [{ section: "A", questionType: "mcq", marks: 1, text: "only one" }] });
    const result = parseAndValidateGeneratedPaper(raw, blueprint);
    expect(result.sections.flatMap((s) => s.questions)).toHaveLength(1);
    // marksTotal reflects what's actually on the paper (the first blueprint
    // slot's marks), not the blueprint's nominal total.
    expect(result.marksTotal).toBe(blueprint.slots[0].marks);
  });

  it("throws GenerationError when the LLM returns zero questions", () => {
    const raw = JSON.stringify({ questions: [] });
    expect(() => parseAndValidateGeneratedPaper(raw, blueprint)).toThrow(GenerationError);
  });

  it("truncates extra trailing questions instead of throwing when the LLM over-generates", () => {
    const expected = totalQuestionCount();
    const questions = Array.from({ length: expected + 1 }, (_, i) => ({
      section: "A",
      questionType: "mcq",
      marks: 1,
      text: `Question ${i}`,
    }));
    const raw = JSON.stringify({ questions });
    const result = parseAndValidateGeneratedPaper(raw, blueprint);
    expect(result.sections.flatMap((s) => s.questions)).toHaveLength(expected);
  });
});

describe("generatePaper", () => {
  it("calls generateChatCompletion exactly once and returns a validated paper", async () => {
    const questions = Array.from({ length: totalQuestionCount() }, (_, i) => ({
      section: "A",
      questionType: "mcq",
      marks: 1,
      text: `Question ${i}`,
    }));
    const spy = vi
      .spyOn(llm, "generateChatCompletion")
      .mockResolvedValue({ text: JSON.stringify({ questions }), provider: "openrouter", model: "x" });

    const env = {} as Env;
    const result = await generatePaper(env, blueprint, chaptersWithSlots, "p1", {
      llmProvider: "openrouter",
      questionPaperModelSlug: "some/model",
      questionPaperImageGenEnabled: false,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.sections.flatMap((s) => s.questions)).toHaveLength(totalQuestionCount());
  });

  const diagramSlots = [
    { section: "B", questionType: "short_answer" as const, marks: 3, count: 1, wantsDiagram: true },
    { section: "A", questionType: "mcq" as const, marks: 1, count: 1 },
  ];

  it("appends a text placeholder and attaches no image when diagram images are disabled (the default)", async () => {
    const chaptersNoImages = [
      {
        chunks: {
          filename: "ch.pdf",
          chunkCount: 1,
          chunks: [{ chunkId: 0, page: 1, text: "Figure text", pageImageKey: "page-images/ch.pdf/1.png" }],
        },
        slots: diagramSlots,
      },
    ];
    const questions = diagramSlots.flatMap((slot, i) =>
      Array.from({ length: slot.count }, () => ({ text: `Q${i}` }))
    );
    vi.spyOn(llm, "generateChatCompletion").mockResolvedValue({ text: JSON.stringify({ questions }), provider: "openrouter", model: "x" });
    const imageGenSpy = vi.spyOn(imageGen, "generateDiagramImage");

    const result = await generatePaper({} as Env, blueprint, chaptersNoImages, "p1", {
      llmProvider: "openrouter",
      questionPaperModelSlug: "m",
      questionPaperImageGenEnabled: false,
    });

    const diagramQuestion = result.sections.flatMap((s) => s.questions).find((q) => q.section === "B")!;
    expect(diagramQuestion.text).toContain("Refer to the diagram/figure in your textbook");
    expect(diagramQuestion.pageImageKey).toBeUndefined();
    expect(diagramQuestion.generatedImageKey).toBeUndefined();
    expect(imageGenSpy).not.toHaveBeenCalled();
  });

  it("resolves wantsDiagram slots to ingested pageImageKey when enabled and the chunk has one, without calling image-gen", async () => {
    const chaptersWithImage = [
      {
        chunks: {
          filename: "ch.pdf",
          chunkCount: 1,
          chunks: [{ chunkId: 0, page: 1, text: "Figure text", pageImageKey: "page-images/ch.pdf/1.png" }],
        },
        slots: diagramSlots,
      },
    ];
    const questions = diagramSlots.flatMap((slot, i) =>
      Array.from({ length: slot.count }, () => ({ text: `Q${i}` }))
    );
    vi.spyOn(llm, "generateChatCompletion").mockResolvedValue({
      text: JSON.stringify({ questions }),
      provider: "openrouter",
      model: "x",
    });
    const imageGenSpy = vi.spyOn(imageGen, "generateDiagramImage");

    const env = {} as Env;
    const result = await generatePaper(env, blueprint, chaptersWithImage, "p1", {
      llmProvider: "openrouter",
      questionPaperModelSlug: "some/model",
      questionPaperImageGenEnabled: true,
    });

    const flagged = result.sections.flatMap((s) => s.questions).find((q) => q.imageSource === "ingested");
    expect(flagged?.pageImageKey).toBe("page-images/ch.pdf/1.png");
    expect(flagged?.text).not.toContain("Refer to the diagram");
    expect(imageGenSpy).not.toHaveBeenCalled();
  });

  it("de-duplicates page images from overlapping chunks so consecutive diagram questions get distinct images", async () => {
    const twoDiagramSlots = [
      { section: "B", questionType: "short_answer" as const, marks: 3, count: 2, wantsDiagram: true },
      { section: "A", questionType: "mcq" as const, marks: 1, count: 1 },
    ];
    const chapters = [
      {
        chunks: {
          filename: "ch.pdf",
          chunkCount: 4,
          chunks: [
            { chunkId: 0, page: 1, text: "a", pageImageKey: "page-images/ch.pdf/1.png" },
            { chunkId: 1, page: 1, text: "b", pageImageKey: "page-images/ch.pdf/1.png" },
            { chunkId: 2, page: 1, text: "c", pageImageKey: "page-images/ch.pdf/1.png" },
            { chunkId: 3, page: 2, text: "d", pageImageKey: "page-images/ch.pdf/2.png" },
          ],
        },
        slots: twoDiagramSlots,
      },
    ];
    const questions = twoDiagramSlots.flatMap((slot, i) => Array.from({ length: slot.count }, () => ({ text: `Q${i}` })));
    vi.spyOn(llm, "generateChatCompletion").mockResolvedValue({ text: JSON.stringify({ questions }), provider: "openrouter", model: "x" });

    const result = await generatePaper({} as Env, blueprint, chapters, "p1", {
      llmProvider: "openrouter",
      questionPaperModelSlug: "m",
      questionPaperImageGenEnabled: true,
    });

    const keys = result.sections.flatMap((s) => s.questions).filter((q) => q.pageImageKey).map((q) => q.pageImageKey);
    expect(keys).toEqual(["page-images/ch.pdf/1.png", "page-images/ch.pdf/2.png"]);
  });

  it("caps image-gen fallback calls at MAX_GENERATED_DIAGRAMS per paper", async () => {
    const manyDiagramSlots = [{ section: "B", questionType: "short_answer" as const, marks: 3, count: 5, wantsDiagram: true }];
    const questions = Array.from({ length: 5 }, (_, i) => ({ text: `a simple circuit diagram Q${i}` }));
    vi.spyOn(llm, "generateChatCompletion").mockResolvedValue({ text: JSON.stringify({ questions }), provider: "openrouter", model: "x" });
    const imageGenSpy = vi
      .spyOn(imageGen, "generateDiagramImage")
      .mockImplementation(async (_env, paperId, slotKey) => ({ generatedImageKey: `question-papers/${paperId}/gen-${slotKey}.png` }));

    const chaptersNoImages = [{ chunks: { ...chaptersWithSlots[0].chunks }, slots: manyDiagramSlots }];
    const result = await generatePaper({} as Env, blueprint, chaptersNoImages, "p1", {
      llmProvider: "openrouter",
      questionPaperModelSlug: "m",
      questionPaperImageGenEnabled: true,
    });

    expect(MAX_GENERATED_DIAGRAMS).toBe(3);
    expect(imageGenSpy).toHaveBeenCalledTimes(MAX_GENERATED_DIAGRAMS);
    expect(result.sections.flatMap((s) => s.questions).filter((q) => q.imageSource === "generated")).toHaveLength(3);
  });

  it("scales max_tokens with the blueprint's question count instead of a fixed 4000", async () => {
    const bp80 = getBlueprint("Science", 80)!;
    const count80 = totalQuestionCount(bp80);
    const questions = Array.from({ length: count80 }, (_, i) => ({ text: `Q${i}` }));
    const spy = vi
      .spyOn(llm, "generateChatCompletion")
      .mockResolvedValue({ text: JSON.stringify({ questions }), provider: "openrouter", model: "x" });

    await generatePaper({} as Env, bp80, [{ chunks: chaptersWithSlots[0].chunks, slots: bp80.slots }], "p1", {
      llmProvider: "openrouter",
      questionPaperModelSlug: "m",
      questionPaperImageGenEnabled: false,
    });

    expect(spy.mock.calls[0][1]).toBe(computeGenerationMaxTokens(count80));
    expect(computeGenerationMaxTokens(count80)).toBeGreaterThan(computeGenerationMaxTokens(totalQuestionCount()));
    expect(computeGenerationMaxTokens(1)).toBeGreaterThanOrEqual(4000);
    expect(computeGenerationMaxTokens(100000)).toBeLessThanOrEqual(24000);
  });
});

describe("JSON repair (parseLlmJson / parseAndValidateGeneratedPaper)", () => {
  const questions = () => Array.from({ length: totalQuestionCount() }, (_, i) => ({ text: `Question ${i}` }));

  it("accepts JSON wrapped in a ```json fence", () => {
    const raw = "```json\n" + JSON.stringify({ questions: questions() }) + "\n```";
    expect(parseAndValidateGeneratedPaper(raw, blueprint).sections.flatMap((s) => s.questions)).toHaveLength(totalQuestionCount());
  });

  it("accepts JSON wrapped in a bare ``` fence", () => {
    const raw = "```\n" + JSON.stringify({ questions: questions() }) + "\n```";
    expect(parseAndValidateGeneratedPaper(raw, blueprint).sections.flatMap((s) => s.questions)).toHaveLength(totalQuestionCount());
  });

  it("accepts JSON with leading/trailing prose by slicing first { to last }", () => {
    const raw = "Here is your paper:\n" + JSON.stringify({ questions: questions() }) + "\nHope this helps!";
    expect(parseAndValidateGeneratedPaper(raw, blueprint).sections.flatMap((s) => s.questions)).toHaveLength(totalQuestionCount());
  });

  it("still throws GenerationError when no attempt yields valid JSON", () => {
    expect(() => parseLlmJson("Sorry, I can't do that { not json }")).toThrow(GenerationError);
  });

  it("repairs an invalid backslash escape (e.g. raw LaTeX \\Omega in a text field)", () => {
    // Built by hand, not JSON.stringify, since a correct stringify would
    // never reproduce the bug - the model emits a literal backslash
    // followed by a letter that isn't a legal JSON escape character.
    const raw = '{"questions": [{"text": "Find the resistance in \\Omega for Q0"}]}';
    expect(() => JSON.parse(raw)).toThrow(); // confirms this really is invalid JSON
    const result = parseLlmJson(raw) as { questions: { text: string }[] };
    expect(result.questions[0].text).toContain("Omega");
  });
});

describe("structure comes from the blueprint, not the LLM's echoed fields", () => {
  it("assigns section/questionType/marks from the slot at the same position", () => {
    const questions = Array.from({ length: totalQuestionCount() }, (_, i) => ({
      section: "Z",
      questionType: "essay",
      marks: 99,
      text: `Q${i}`,
      latex: "E = mc^2",
      table: { headers: ["a"], rows: [["1"]] },
    }));
    const paper = parseAndValidateGeneratedPaper(JSON.stringify({ questions }), blueprint);

    expect(paper.sections.map((s) => s.section)).toEqual(["A", "B", "C"]);
    const all = paper.sections.flatMap((s) => s.questions);
    expect(all.reduce((sum, q) => sum + q.marks, 0)).toBe(blueprint.marksTotal);
    expect(all[0]).toMatchObject({ section: "A", questionType: "mcq", marks: 1, latex: "E = mc^2", table: { headers: ["a"], rows: [["1"]] } });
    expect(all[all.length - 1]).toMatchObject({ section: "C", questionType: "long_answer", marks: 5 });
  });
});

describe("prompt chapter coverage", () => {
  it("names each slot's chapter filename on its slot line", () => {
    const { user } = buildGenerationPrompt(blueprint, chaptersWithSlots);
    expect(user).toContain("chapter=ch.pdf section=A");
  });

  it("samples chunks evenly across the whole chapter within the character budget", () => {
    const chunks = Array.from({ length: 50 }, (_, i) => ({
      chunkId: i,
      page: i,
      text: `CHUNK-${i} ` + "x".repeat(500),
      pageImageKey: null,
    }));
    const sampled = sampleChunkText({ filename: "big.pdf", chunkCount: 50, chunks });

    expect(sampled.length).toBeLessThanOrEqual(6000);
    expect(sampled).toContain("CHUNK-0 ");
    expect(sampled).toContain("CHUNK-49 ");
    expect(sampled).toMatch(/CHUNK-2\d /);
  });

  it("returns the full text unchanged when it fits the budget", () => {
    const sampled = sampleChunkText(chaptersWithSlots[0].chunks);
    expect(sampled).toBe("Carbon forms covalent bonds.");
  });
});
