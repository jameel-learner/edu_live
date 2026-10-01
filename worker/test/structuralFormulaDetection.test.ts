import { describe, it, expect } from "vitest";
import { looksLikeGarbledStructuralFormula, sanitizeGarbledStructuralFormulas } from "../src/structuralFormulaDetection";

describe("looksLikeGarbledStructuralFormula", () => {
  it("detects a halogen-substituted chain written as a hyphenated element sequence", () => {
    expect(looksLikeGarbledStructuralFormula("H-C-C-C-Cl")).toBe(true);
  });

  it("detects a chain containing a double bond", () => {
    expect(looksLikeGarbledStructuralFormula("H-C-C=O")).toBe(true);
  });

  it("detects a chain containing a triple bond", () => {
    expect(looksLikeGarbledStructuralFormula("H-C-C≡C-H")).toBe(true);
  });

  it("detects the pattern embedded within a larger page of prose/table text", () => {
    const pageText =
      "| Functional group | Prefix/Suffix | Example |\n" +
      "| --- | --- | --- |\n" +
      "| Halogen | Prefix: chloro, bromo, etc. | H-C-C-C-Cl |\n" +
      "| Alcohol | Suffix: -ol | H-C-C-C-OH |\n";
    expect(looksLikeGarbledStructuralFormula(pageText)).toBe(true);
  });

  it("does not flag ordinary prose text", () => {
    expect(looksLikeGarbledStructuralFormula("Newton's second law relates force, mass, and acceleration.")).toBe(false);
  });

  it("does not flag a real figure marker on its own", () => {
    expect(looksLikeGarbledStructuralFormula("[Figure: skeletal structural formula of 1-chloropropane]")).toBe(false);
  });

  it("does not flag a short two-segment hyphenated word", () => {
    expect(looksLikeGarbledStructuralFormula("well-known, state-of-the-art")).toBe(false);
  });
});

describe("sanitizeGarbledStructuralFormulas", () => {
  it("replaces a garbled formula with a [Figure: marker so downstream prompts treat it as a figure", () => {
    const result = sanitizeGarbledStructuralFormulas("Example: H-C-C-C-Cl is a haloalkane.");
    expect(result).not.toContain("H-C-C-C-Cl");
    expect(result).toMatch(/\[Figure:/);
  });

  it("replaces every occurrence in a table with multiple garbled cells", () => {
    const text =
      "| Functional group | Example |\n| --- | --- |\n| Halogen | H-C-C-C-Cl |\n| Alcohol | H-C-C-C-OH |\n";
    const result = sanitizeGarbledStructuralFormulas(text);
    expect(result).not.toContain("H-C-C-C-Cl");
    expect(result).not.toContain("H-C-C-C-OH");
    expect((result.match(/\[Figure:/g) ?? []).length).toBe(2);
  });

  it("leaves ordinary prose untouched", () => {
    const text = "Newton's second law relates force, mass, and acceleration.";
    expect(sanitizeGarbledStructuralFormulas(text)).toBe(text);
  });
});
