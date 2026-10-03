import { describe, it, expect, vi } from "vitest";
import {
  buildGenerationPrompt,
  parseAndValidateGeneratedPaper,
  generatePaper,
  GenerationError,
} from "../src/questionPaperGeneration";
import { getBlueprint } from "../src/questionPaperBlueprints";
import type { Env } from "../src/index";
import * as llm from "../src/llm";
import * as imageGen from "../src/questionPaperImageGen";

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

  it("throws GenerationError when the question count doesn't match the blueprint", () => {
    const raw = JSON.stringify({ questions: [{ section: "A", questionType: "mcq", marks: 1, text: "only one" }] });
    expect(() => parseAndValidateGeneratedPaper(raw, blueprint)).toThrow(GenerationError);
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

  it("resolves wantsDiagram slots to ingested pageImageKey when the chunk has one, without calling image-gen", async () => {
    const chaptersWithImage = [
      {
        chunks: {
          filename: "ch.pdf",
          chunkCount: 1,
          chunks: [{ chunkId: 0, page: 1, text: "Figure text", pageImageKey: "page-images/ch.pdf/1.png" }],
        },
        slots: blueprint.slots,
      },
    ];
    const diagramSlotIndex = blueprint.slots.findIndex((s) => s.wantsDiagram);
    const questions = blueprint.slots.flatMap((slot, slotIdx) =>
      Array.from({ length: slot.count }, (_, i) => ({
        section: slot.section,
        questionType: slot.questionType,
        marks: slot.marks,
        text: `Q${slotIdx}-${i}`,
        diagramNeeded: slotIdx === diagramSlotIndex,
      }))
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
    expect(imageGenSpy).not.toHaveBeenCalled();
  });
});
