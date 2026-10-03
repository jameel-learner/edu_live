import { describe, it, expect, vi } from "vitest";
import { isDiagramAllowlisted, generateDiagramImage } from "../src/questionPaperImageGen";
import type { Env } from "../src/index";

describe("isDiagramAllowlisted", () => {
  it("allows generic circuit/graph/cell diagrams", () => {
    expect(isDiagramAllowlisted("a simple series circuit diagram")).toBe(true);
    expect(isDiagramAllowlisted("generic graph of velocity vs time axes")).toBe(true);
    expect(isDiagramAllowlisted("a generic plant cell outline")).toBe(true);
  });

  it("blocks precise anatomical or molecular diagrams", () => {
    expect(isDiagramAllowlisted("precise diagram of the human nephron structure")).toBe(false);
    expect(isDiagramAllowlisted("exact molecular geometry of methane")).toBe(false);
  });

  it("blocks anything not matching the allowlist by default", () => {
    expect(isDiagramAllowlisted("something unrelated and unrecognized")).toBe(false);
  });
});

describe("generateDiagramImage", () => {
  it("returns null without calling AI when disabled", async () => {
    const env = { AI: { run: vi.fn() }, PDF_BUCKET: { put: vi.fn() } } as unknown as Env;
    const result = await generateDiagramImage(env, "p1", "slot1", "a simple circuit diagram", false);
    expect(result).toBeNull();
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("returns null without calling AI when blocklisted", async () => {
    const env = { AI: { run: vi.fn() }, PDF_BUCKET: { put: vi.fn() } } as unknown as Env;
    const result = await generateDiagramImage(env, "p1", "slot1", "exact nephron structure", true);
    expect(result).toBeNull();
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("generates, stores, and returns the key when allowlisted and enabled", async () => {
    const env = {
      AI: { run: vi.fn().mockResolvedValue(new ArrayBuffer(8)) },
      PDF_BUCKET: { put: vi.fn().mockResolvedValue(undefined) },
    } as unknown as Env;
    const result = await generateDiagramImage(env, "p1", "slot1", "a simple circuit diagram", true);
    expect(result).toEqual({ generatedImageKey: "question-papers/p1/gen-slot1.png" });
    expect(env.PDF_BUCKET.put).toHaveBeenCalledWith("question-papers/p1/gen-slot1.png", expect.anything(), expect.anything());
  });

  it("returns null (fails open) when the AI call throws", async () => {
    const env = {
      AI: { run: vi.fn().mockRejectedValue(new Error("model unavailable")) },
      PDF_BUCKET: { put: vi.fn() },
    } as unknown as Env;
    const result = await generateDiagramImage(env, "p1", "slot1", "a simple circuit diagram", true);
    expect(result).toBeNull();
  });
});
