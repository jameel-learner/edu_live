// Matches a run of short (1-2 letter) chemistry element-like tokens joined
// by bond notation (-, =, triple-bond), e.g. "H-C-C-C-Cl" or "H-C-C=O".
// Real prose essentially never produces this shape, so it's a reliable
// signal that the enrichment model attempted to transcribe a structural/
// skeletal formula image as text instead of recognizing it as a figure -
// see ingestionEnrichment.ts's prompt instructions for the primary
// (prompt-based) fix this backs up with a deterministic, code-level check.
const GARBLED_STRUCTURAL_FORMULA_PATTERN = /\b[A-Za-z]{1,2}(?:[-=≡][A-Za-z]{1,2}){2,}\b/;
// Same pattern as a global regex, used for sanitizeGarbledStructuralFormulas's
// replaceAll - a single non-global RegExp object can't be reused for both
// .test() (which would advance lastIndex) and a global replace.
const GARBLED_STRUCTURAL_FORMULA_PATTERN_GLOBAL = new RegExp(GARBLED_STRUCTURAL_FORMULA_PATTERN.source, "g");

export function looksLikeGarbledStructuralFormula(text: string): boolean {
  return GARBLED_STRUCTURAL_FORMULA_PATTERN.test(text);
}

/**
 * Replaces every garbled-formula-looking span with a generic [Figure: ...]
 * marker, so the stored/chunked text downstream (retrieval, chat/explain
 * prompts) treats it exactly like any other figure - never redrawn, shown
 * via the real page screenshot instead - rather than quoting the garbled
 * pseudo-text verbatim.
 */
export function sanitizeGarbledStructuralFormulas(text: string): string {
  return text.replace(GARBLED_STRUCTURAL_FORMULA_PATTERN_GLOBAL, "[Figure: a structural/chemical formula diagram]");
}
