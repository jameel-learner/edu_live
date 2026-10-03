import { describe, it, expect } from "vitest";
import { getBlueprint, distributeSlotsAcrossChapters } from "../src/questionPaperBlueprints";

describe("getBlueprint", () => {
  it("returns the exact Science 40-mark blueprint whose slots sum to 40", () => {
    const bp = getBlueprint("Science", 40);
    expect(bp).not.toBeNull();
    const total = bp!.slots.reduce((sum, s) => sum + s.marks * s.count, 0);
    expect(total).toBe(40);
  });

  it("returns the exact Science 80-mark blueprint whose slots sum to 80", () => {
    const bp = getBlueprint("Science", 80);
    expect(bp).not.toBeNull();
    const total = bp!.slots.reduce((sum, s) => sum + s.marks * s.count, 0);
    expect(total).toBe(80);
  });

  it("scales the nearest blueprint for an undefined total, still summing to the requested total", () => {
    const bp = getBlueprint("Science", 20);
    expect(bp).not.toBeNull();
    const total = bp!.slots.reduce((sum, s) => sum + s.marks * s.count, 0);
    expect(total).toBe(20);
    expect(bp!.version).toContain("scaled");
  });

  it("returns null for a subject with no blueprints defined", () => {
    expect(getBlueprint("History", 40)).toBeNull();
  });
});

describe("distributeSlotsAcrossChapters", () => {
  it("assigns every slot to exactly one chapter, proportional to chunk count", () => {
    const bp = getBlueprint("Science", 40)!;
    const result = distributeSlotsAcrossChapters(bp, { "ch1.pdf": 30, "ch2.pdf": 10 });
    const assignedSlotCount = Object.values(result).reduce((sum, slots) => sum + slots.length, 0);
    expect(assignedSlotCount).toBe(bp.slots.length);
    expect(Object.keys(result).sort()).toEqual(["ch1.pdf", "ch2.pdf"]);
  });

  it("assigns all slots to the single chapter when only one is given", () => {
    const bp = getBlueprint("Science", 40)!;
    const result = distributeSlotsAcrossChapters(bp, { "ch1.pdf": 12 });
    expect(result["ch1.pdf"].length).toBe(bp.slots.length);
  });
});
