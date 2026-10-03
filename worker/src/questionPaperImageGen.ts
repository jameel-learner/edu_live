import type { Env } from "./index";

const IMAGE_GEN_MODEL = "@cf/stabilityai/stable-diffusion-xl-base-1.0";

// Only diagram categories where visual accuracy isn't exam-critical - exam
// content that must be scientifically precise (anatomy, exact molecular
// geometry) always falls back to a text placeholder instead, per the
// accuracy guardrail in docs/superpowers/specs/2026-10-03-question-paper-feature-design.md.
const ALLOWLIST_KEYWORDS = ["circuit", "graph", "axes", "plant cell", "cell outline", "geometric", "geometry shape"];
const BLOCKLIST_KEYWORDS = ["nephron", "anatomical", "anatomy", "molecular geometry", "exact structure", "precise diagram"];

export function isDiagramAllowlisted(description: string): boolean {
  const lower = description.toLowerCase();
  if (BLOCKLIST_KEYWORDS.some((kw) => lower.includes(kw))) return false;
  return ALLOWLIST_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Fails open: returns null (never throws) on disabled config, blocklisted
 * description, or any generation/storage error - a missing diagram must
 * degrade to a text placeholder, never block the rest of the paper.
 */
export async function generateDiagramImage(
  env: Env,
  paperId: string,
  slotKey: string,
  description: string,
  enabled: boolean
): Promise<{ generatedImageKey: string } | null> {
  if (!enabled) return null;
  if (!isDiagramAllowlisted(description)) return null;

  try {
    const result = await env.AI.run(IMAGE_GEN_MODEL, { prompt: `Simple textbook-style diagram: ${description}` });
    const key = `question-papers/${paperId}/gen-${slotKey}.png`;
    await env.PDF_BUCKET.put(key, result as ArrayBuffer, { httpMetadata: { contentType: "image/png" } });
    return { generatedImageKey: key };
  } catch (err) {
    console.error("question paper image-gen failed, falling back to text placeholder", err);
    return null;
  }
}
