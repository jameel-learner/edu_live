export type QuestionType = "mcq" | "assertion_reason" | "short_answer" | "long_answer" | "case_based";

export interface BlueprintSlot {
  section: string;
  questionType: QuestionType;
  marks: number;
  count: number;
  wantsDiagram?: boolean;
}

export interface Blueprint {
  subject: string;
  marksTotal: number;
  version: string;
  slots: BlueprintSlot[];
}

// Modeled directly on the sample CBSE papers reviewed during design
// (docs/superpowers/specs/2026-10-03-question-paper-feature-design.md).
// Keep this list purely additive - add more {subject, marksTotal} blueprints
// here as new sample papers are reviewed, never branch on subject in code.
const BLUEPRINTS: Blueprint[] = [
  {
    subject: "Science",
    marksTotal: 40,
    version: "science-40-v1",
    slots: [
      { section: "A", questionType: "mcq", marks: 1, count: 5 },
      { section: "A", questionType: "assertion_reason", marks: 1, count: 2 },
      { section: "B", questionType: "short_answer", marks: 2, count: 6 },
      { section: "B", questionType: "short_answer", marks: 3, count: 4, wantsDiagram: true },
      { section: "C", questionType: "case_based", marks: 4, count: 1, wantsDiagram: true },
      { section: "C", questionType: "long_answer", marks: 5, count: 1 },
    ],
  },
  {
    subject: "Science",
    marksTotal: 80,
    version: "science-80-v1",
    slots: [
      { section: "A", questionType: "mcq", marks: 1, count: 10 },
      { section: "A", questionType: "assertion_reason", marks: 1, count: 4 },
      { section: "B", questionType: "short_answer", marks: 2, count: 12 },
      { section: "B", questionType: "short_answer", marks: 3, count: 8, wantsDiagram: true },
      { section: "C", questionType: "case_based", marks: 4, count: 2, wantsDiagram: true },
      { section: "C", questionType: "long_answer", marks: 5, count: 2 },
    ],
  },
  // Modeled directly on the CBSE Mathematics Standard (Code 041) Class X
  // Sample Question Paper, 2025-26, 80 marks, 38 questions, 5 sections -
  // matched section-by-section, not approximated. wantsDiagram marks the
  // sections where the real paper actually carries a figure (circle/tangent
  // proofs in Section C, triangle/solid-geometry in Section D, the
  // coordinate-geometry case study in Section E) - Sections A and B in the
  // source paper are text/numeric only.
  {
    subject: "Maths",
    marksTotal: 80,
    version: "maths-80-v1",
    slots: [
      { section: "A", questionType: "mcq", marks: 1, count: 18 },
      { section: "A", questionType: "assertion_reason", marks: 1, count: 2 },
      { section: "B", questionType: "short_answer", marks: 2, count: 5 },
      { section: "C", questionType: "short_answer", marks: 3, count: 6, wantsDiagram: true },
      { section: "D", questionType: "long_answer", marks: 5, count: 4, wantsDiagram: true },
      { section: "E", questionType: "case_based", marks: 4, count: 3, wantsDiagram: true },
    ],
  },
];

function blueprintTotal(slots: BlueprintSlot[]): number {
  return slots.reduce((sum, s) => sum + s.marks * s.count, 0);
}

function scaleBlueprint(base: Blueprint, marksTotal: number): Blueprint {
  const baseTotal = blueprintTotal(base.slots);
  const ratio = marksTotal / baseTotal;
  let scaledSlots = base.slots.map((s) => ({ ...s, count: Math.max(1, Math.round(s.count * ratio)) }));
  let diff = marksTotal - blueprintTotal(scaledSlots);
  // Absorb any rounding remainder into the largest-count slot's count, in
  // units of that slot's marks, so the total always matches exactly.
  if (diff !== 0) {
    const target = [...scaledSlots].sort((a, b) => b.count - a.count)[0];
    const delta = Math.trunc(diff / target.marks);
    const oldCount = target.count;
    target.count = Math.max(1, target.count + delta);
    const actualDelta = target.count - oldCount;
    diff -= actualDelta * target.marks;
  }
  // Handle any remaining difference (e.g., when clamping prevents full adjustment)
  while (diff !== 0) {
    if (diff > 0) {
      // Final odd remainder: add a 1-mark slot for the shortage.
      scaledSlots = [...scaledSlots, { section: scaledSlots[0].section, questionType: "mcq", marks: 1, count: diff }];
      break;
    } else {
      // We're over; find the best slot to reduce by 1 to get closer to target.
      let bestIdx = -1;
      let bestDiffAbs = Math.abs(diff);
      for (let i = 0; i < scaledSlots.length; i++) {
        if (scaledSlots[i].count > 1) {
          const newDiff = diff + scaledSlots[i].marks;
          if (Math.abs(newDiff) < bestDiffAbs) {
            bestIdx = i;
            bestDiffAbs = Math.abs(newDiff);
          }
        }
      }
      if (bestIdx === -1) break;  // Can't reduce further
      scaledSlots[bestIdx].count--;
      diff += scaledSlots[bestIdx].marks;
    }
  }
  return { subject: base.subject, marksTotal, version: `${base.version}-scaled-${marksTotal}`, slots: scaledSlots };
}

export function getBlueprint(subject: string, marksTotal: number): Blueprint | null {
  const exact = BLUEPRINTS.find((b) => b.subject === subject && b.marksTotal === marksTotal);
  if (exact) return exact;

  const candidates = BLUEPRINTS.filter((b) => b.subject === subject);
  if (candidates.length === 0) return null;

  const nearest = candidates.reduce((best, b) =>
    Math.abs(b.marksTotal - marksTotal) < Math.abs(best.marksTotal - marksTotal) ? b : best
  );
  return scaleBlueprint(nearest, marksTotal);
}

export function distributeSlotsAcrossChapters(
  blueprint: Blueprint,
  chapterChunkCounts: Record<string, number>
): Record<string, BlueprintSlot[]> {
  const chapters = Object.keys(chapterChunkCounts);
  const result: Record<string, BlueprintSlot[]> = Object.fromEntries(chapters.map((c) => [c, []]));
  const totalChunks = chapters.reduce((sum, c) => sum + chapterChunkCounts[c], 0) || 1;

  let chapterIndex = 0;
  let runningWeight = 0;
  for (const slot of blueprint.slots) {
    // Walk chapters in proportion to their chunk-count share of the total,
    // advancing to the next chapter once the current one's share is used up.
    const currentChapter = chapters[Math.min(chapterIndex, chapters.length - 1)];
    result[currentChapter].push(slot);
    runningWeight += 1 / blueprint.slots.length;
    const currentShare = chapterChunkCounts[currentChapter] / totalChunks;
    if (runningWeight >= currentShare && chapterIndex < chapters.length - 1) {
      chapterIndex += 1;
      runningWeight = 0;
    }
  }
  return result;
}
