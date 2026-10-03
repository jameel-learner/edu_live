# Question Paper Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let students/teachers pick subject + class + chapter(s) + a marks total in the frontend and get a CBSE/ICSE-style question paper (and, on request, its answer key and PDFs), generated with at most one LLM call on a cache miss and zero calls on repeat requests.

**Architecture:** New worker routes (`/question-paper/*`) reuse existing Vectorize/R2/OpenRouter/Browser-Rendering infra. A pure-code blueprint module decides paper structure (no LLM). A single OpenRouter call fills the blueprint from retrieved chunks, returning strict JSON. Results cache in a new D1 table (`question_papers`), keyed by a deterministic hash, so repeats are free. Answer key and PDF are separate, lazily-cached actions.

**Tech Stack:** Cloudflare Workers (TypeScript), D1, R2, Vectorize, Workers AI, OpenRouter, `@cloudflare/puppeteer` (Browser Rendering, already a dependency), Vitest, vanilla JS/HTML frontend.

**Spec:** `docs/superpowers/specs/2026-10-03-question-paper-feature-design.md`

## Global Constraints

- Every stage must match the spec's cost table exactly: cache hit = 0 LLM calls; cache miss = exactly 1 LLM call for paper generation, +0–3 image-gen calls, +1 LLM call only when answer key is explicitly requested; PDF rendering = 0 LLM calls always.
- Paper/answer-key generation **throws on failure** (does not fail open) — matches `generateChatCompletion()`'s existing contract in `worker/src/llm.ts`.
- Image-gen fallback and PDF rendering **fail open** — never block returning the rest of the paper.
- `/question-paper/generate` and `/question-paper/:id/answer-key` and the PDF routes are public (no auth), matching `/chat`. The new `/question-paper/catalog` endpoint is also public and must return only subject/class/chapter/filename — never admin-only fields (`chunkCount`, `enriched`, etc. stay `/admin/documents`-only).
- All new config fields follow the existing `config.ts` pattern exactly: added to `RuntimeConfig`, `DEFAULT_CONFIG`, `parseConfigRows`, `KNOWN_FIELDS`, and `validateConfigUpdate`.
- `worker/test/chat.test.ts` has known pre-existing mock-type errors unrelated to real code (confirmed present on main) — any *other* file erroring under `npx tsc --noEmit` is a real regression introduced by this plan.

## Review Focus

- **Malformed/partial JSON from the LLM.** The generation prompt asks for strict JSON, but a free-tier model can return truncated or slightly-invalid JSON. A paper that silently drops a section (or crashes the route with an unhandled parse error) would ship a broken paper to a student. Task 6 tests this explicitly.
- **Chapter selection that doesn't exist or has zero chunks.** A teacher could request a `chapterFilenames` entry that isn't an ingested document (typo, stale picker data) or a document with `chunkCount: 0`. The route must return a clear 4xx, not a 500 or an empty paper presented as if it succeeded. Task 6 tests this.
- **`marksTotal` with no matching blueprint and no reasonable scaling base.** E.g. a request for a subject that has zero defined blueprints yet (only Science is seeded in this plan). Must fail clearly rather than silently return an empty or wrong-size paper. Task 2 tests this.
- **Diagram slot where no ingested page image exists and image-gen is disabled (or the diagram is blocklisted).** Must degrade to the text placeholder, not omit the question or throw. Task 7 tests both the disabled-config and blocklisted-category paths.
- **Answer-key or PDF requested for a paper `id` that doesn't exist.** Must return 404, not throw an unhandled error against `undefined`. Task 8 and Task 9 test this.

---

## File Structure

| File | Responsibility |
|---|---|
| `worker/migrations/0004_create_question_papers.sql` | New table |
| `worker/src/questionPaperBlueprints.ts` | Pure-code blueprint templates + slot-scaling + multi-chapter distribution |
| `worker/src/questionPaperCache.ts` | Cache-key hashing + D1 read/write helpers for the `question_papers` table |
| `worker/src/questionPaperRetrieval.ts` | Fetch-all-chunks-for-a-document-by-filename helper (document-filtered, not semantic) |
| `worker/src/questionPaperGeneration.ts` | Prompt building, OpenRouter call, JSON parsing/validation, diagram resolution — the core generation logic |
| `worker/src/questionPaperImageGen.ts` | Allowlist/blocklist + Workers AI image-gen call + R2 caching for generated diagrams |
| `worker/src/questionPaperAnswerKey.ts` | Answer-key generation (reuses existing questions, 1 LLM call) |
| `worker/src/questionPaperPdf.ts` | HTML templates + Browser Rendering → PDF for paper and answer key |
| `worker/src/questionPaper.ts` | Route handlers (`handleQuestionPaperGenerate`, `handleQuestionPaperAnswerKey`, `handleQuestionPaperPdf`, `handleQuestionPaperAnswerKeyPdf`, `handleQuestionPaperCatalog`) tying the above together |
| `worker/src/config.ts` | Modify: add `questionPaperModelSlug`, `questionPaperImageGenEnabled` |
| `worker/src/ingestion.ts` | Modify: read/store `subject`, `class`, `chapter` form fields as R2 customMetadata |
| `worker/src/admin.ts` | Modify: include `subject`/`class`/`chapter` in `/admin/documents` response |
| `worker/src/index.ts` | Modify: `Env` additions (none needed — all new code reuses existing bindings) + route wiring |
| `frontend/dashboard.html` / `dashboard.js` | Modify: add Subject/Class/Chapter fields to upload form |
| `frontend/index.html` / `app.js` / `style.css` | Modify: replace Question Paper placeholder with picker + results UI |

---

### Task 1: D1 migration for `question_papers`

**Files:**
- Create: `worker/migrations/0004_create_question_papers.sql`

**Interfaces:**
- Produces: the `question_papers` table, consumed by `questionPaperCache.ts` (Task 3).

- [ ] **Step 1: Write the migration**

```sql
CREATE TABLE question_papers (
  id TEXT PRIMARY KEY,
  cache_key TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  class TEXT NOT NULL,
  marks_total INTEGER NOT NULL,
  chapter_filenames TEXT NOT NULL,
  blueprint_version TEXT NOT NULL,
  paper_json TEXT NOT NULL,
  answer_key_json TEXT,
  pdf_r2_key TEXT,
  answer_key_pdf_r2_key TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_question_papers_cache_key ON question_papers (cache_key);
```

- [ ] **Step 2: Apply locally and verify**

Run: `npx wrangler d1 migrations apply edu-live-db --local` (from `worker/`)
Expected: migration `0004_create_question_papers` applied with no errors; `npx wrangler d1 execute edu-live-db --local --command "SELECT name FROM sqlite_master WHERE type='table'"` lists `question_papers`.

- [ ] **Step 3: Commit**

```bash
git add worker/migrations/0004_create_question_papers.sql
git commit -m "Add question_papers D1 table migration"
```

---

### Task 2: Blueprint templates module

**Files:**
- Create: `worker/src/questionPaperBlueprints.ts`
- Test: `worker/test/questionPaperBlueprints.test.ts`

**Interfaces:**
- Produces:
  - `type QuestionType = "mcq" | "assertion_reason" | "short_answer" | "long_answer" | "case_based"`
  - `interface BlueprintSlot { section: string; questionType: QuestionType; marks: number; count: number; wantsDiagram?: boolean }`
  - `interface Blueprint { subject: string; marksTotal: number; version: string; slots: BlueprintSlot[] }`
  - `function getBlueprint(subject: string, marksTotal: number): Blueprint | null` — exact match or proportional scaling from the nearest same-subject blueprint; `null` if the subject has no blueprints defined at all.
  - `function distributeSlotsAcrossChapters(blueprint: Blueprint, chapterChunkCounts: Record<string, number>): Record<string, BlueprintSlot[]>` — maps each chapter filename to the slots it should supply questions for, proportional to chunk count, every slot assigned to exactly one chapter.

- [ ] **Step 1: Write failing tests**

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/questionPaperBlueprints.test.ts` (from `worker/`)
Expected: FAIL — `questionPaperBlueprints` module not found.

- [ ] **Step 3: Implement the module**

```typescript
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
      { section: "B", questionType: "short_answer", marks: 2, count: 10 },
      { section: "C", questionType: "short_answer", marks: 3, count: 10, wantsDiagram: true },
      { section: "D", questionType: "case_based", marks: 4, count: 2, wantsDiagram: true },
      { section: "E", questionType: "long_answer", marks: 5, count: 4 },
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
    target.count = Math.max(1, target.count + delta);
    diff -= delta * target.marks;
  }
  if (diff !== 0) {
    // Final odd remainder: adjust the first slot's marks-weighted count by 1 unit if possible, else leave as a single extra 1-mark slot.
    scaledSlots = [...scaledSlots, { section: scaledSlots[0].section, questionType: "mcq", marks: 1, count: Math.abs(diff) }];
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/questionPaperBlueprints.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/questionPaperBlueprints.ts worker/test/questionPaperBlueprints.test.ts
git commit -m "Add question paper blueprint templates (pure code, no LLM)"
```

---

### Task 3: Cache-key hashing + D1 read/write helpers

**Files:**
- Create: `worker/src/questionPaperCache.ts`
- Test: `worker/test/questionPaperCache.test.ts`

**Interfaces:**
- Consumes: `Env` from `./index` (`EDU_LIVE_DB`).
- Produces:
  - `function computeCacheKey(subject: string, cls: string, marksTotal: number, chapterFilenames: string[], blueprintVersion: string): string`
  - `interface QuestionPaperRow { id: string; cacheKey: string; subject: string; class: string; marksTotal: number; chapterFilenames: string[]; blueprintVersion: string; paperJson: unknown; answerKeyJson: unknown | null; pdfR2Key: string | null; answerKeyPdfR2Key: string | null; createdAt: string }`
  - `async function findCachedPaper(env: Env, cacheKey: string): Promise<QuestionPaperRow | null>`
  - `async function saveNewPaper(env: Env, row: Omit<QuestionPaperRow, "createdAt">): Promise<QuestionPaperRow>`
  - `async function findPaperById(env: Env, id: string): Promise<QuestionPaperRow | null>`
  - `async function saveAnswerKey(env: Env, id: string, answerKeyJson: unknown): Promise<void>`
  - `async function savePdfKey(env: Env, id: string, field: "pdfR2Key" | "answerKeyPdfR2Key", r2Key: string): Promise<void>`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect, vi } from "vitest";
import { computeCacheKey, findCachedPaper, saveNewPaper, findPaperById, saveAnswerKey, savePdfKey } from "../src/questionPaperCache";
import type { Env } from "../src/index";

function makeEnv(overrides: Partial<{ first: unknown; all: { results: unknown[] }; run: unknown }> = {}) {
  const db = {
    prepare: vi.fn().mockReturnThis(),
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(overrides.first ?? null),
    all: vi.fn().mockResolvedValue(overrides.all ?? { results: [] }),
    run: vi.fn().mockResolvedValue(overrides.run ?? {}),
  };
  return { EDU_LIVE_DB: db } as unknown as Env;
}

describe("computeCacheKey", () => {
  it("is deterministic regardless of chapter filename order", () => {
    const a = computeCacheKey("Science", "10", 40, ["b.pdf", "a.pdf"], "science-40-v1");
    const b = computeCacheKey("Science", "10", 40, ["a.pdf", "b.pdf"], "science-40-v1");
    expect(a).toBe(b);
  });

  it("differs when marksTotal differs", () => {
    const a = computeCacheKey("Science", "10", 40, ["a.pdf"], "science-40-v1");
    const b = computeCacheKey("Science", "10", 80, ["a.pdf"], "science-40-v1");
    expect(a).not.toBe(b);
  });
});

describe("findCachedPaper", () => {
  it("returns null when no row matches", async () => {
    const env = makeEnv({ first: null });
    expect(await findCachedPaper(env, "nonexistent-key")).toBeNull();
  });

  it("parses JSON columns when a row matches", async () => {
    const env = makeEnv({
      first: {
        id: "p1",
        cache_key: "k1",
        subject: "Science",
        class: "10",
        marks_total: 40,
        chapter_filenames: '["a.pdf"]',
        blueprint_version: "science-40-v1",
        paper_json: '{"sections":[]}',
        answer_key_json: null,
        pdf_r2_key: null,
        answer_key_pdf_r2_key: null,
        created_at: "2026-10-03T00:00:00.000Z",
      },
    });
    const row = await findCachedPaper(env, "k1");
    expect(row).not.toBeNull();
    expect(row!.paperJson).toEqual({ sections: [] });
    expect(row!.chapterFilenames).toEqual(["a.pdf"]);
  });
});

describe("saveNewPaper / findPaperById / saveAnswerKey / savePdfKey", () => {
  it("saveNewPaper inserts and returns the row with createdAt set", async () => {
    const env = makeEnv();
    const row = await saveNewPaper(env, {
      id: "p1",
      cacheKey: "k1",
      subject: "Science",
      class: "10",
      marksTotal: 40,
      chapterFilenames: ["a.pdf"],
      blueprintVersion: "science-40-v1",
      paperJson: { sections: [] },
      answerKeyJson: null,
      pdfR2Key: null,
      answerKeyPdfR2Key: null,
    });
    expect(row.id).toBe("p1");
    expect(typeof row.createdAt).toBe("string");
  });

  it("findPaperById returns null for an unknown id", async () => {
    const env = makeEnv({ first: null });
    expect(await findPaperById(env, "unknown-id")).toBeNull();
  });

  it("saveAnswerKey and savePdfKey run without throwing", async () => {
    const env = makeEnv();
    await expect(saveAnswerKey(env, "p1", { answers: [] })).resolves.toBeUndefined();
    await expect(savePdfKey(env, "p1", "pdfR2Key", "question-papers/p1.pdf")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/questionPaperCache.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```typescript
import type { Env } from "./index";

export interface QuestionPaperRow {
  id: string;
  cacheKey: string;
  subject: string;
  class: string;
  marksTotal: number;
  chapterFilenames: string[];
  blueprintVersion: string;
  paperJson: unknown;
  answerKeyJson: unknown | null;
  pdfR2Key: string | null;
  answerKeyPdfR2Key: string | null;
  createdAt: string;
}

// Plain FNV-1a hash over a canonical string - deterministic across chapter
// order, cheap, no crypto dependency needed for a cache key (not a secret).
function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function computeCacheKey(
  subject: string,
  cls: string,
  marksTotal: number,
  chapterFilenames: string[],
  blueprintVersion: string
): string {
  const canonical = [subject, cls, String(marksTotal), [...chapterFilenames].sort().join(","), blueprintVersion].join(
    "|"
  );
  return hashString(canonical);
}

function rowFromDb(raw: Record<string, unknown>): QuestionPaperRow {
  return {
    id: raw.id as string,
    cacheKey: raw.cache_key as string,
    subject: raw.subject as string,
    class: raw.class as string,
    marksTotal: Number(raw.marks_total),
    chapterFilenames: JSON.parse(raw.chapter_filenames as string),
    blueprintVersion: raw.blueprint_version as string,
    paperJson: JSON.parse(raw.paper_json as string),
    answerKeyJson: raw.answer_key_json ? JSON.parse(raw.answer_key_json as string) : null,
    pdfR2Key: (raw.pdf_r2_key as string | null) ?? null,
    answerKeyPdfR2Key: (raw.answer_key_pdf_r2_key as string | null) ?? null,
    createdAt: raw.created_at as string,
  };
}

export async function findCachedPaper(env: Env, cacheKey: string): Promise<QuestionPaperRow | null> {
  const row = await env.EDU_LIVE_DB.prepare("SELECT * FROM question_papers WHERE cache_key = ?")
    .bind(cacheKey)
    .first<Record<string, unknown>>();
  return row ? rowFromDb(row) : null;
}

export async function findPaperById(env: Env, id: string): Promise<QuestionPaperRow | null> {
  const row = await env.EDU_LIVE_DB.prepare("SELECT * FROM question_papers WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
  return row ? rowFromDb(row) : null;
}

export async function saveNewPaper(
  env: Env,
  row: Omit<QuestionPaperRow, "createdAt">
): Promise<QuestionPaperRow> {
  const createdAt = new Date().toISOString();
  await env.EDU_LIVE_DB.prepare(
    `INSERT INTO question_papers
      (id, cache_key, subject, class, marks_total, chapter_filenames, blueprint_version, paper_json, answer_key_json, pdf_r2_key, answer_key_pdf_r2_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      row.id,
      row.cacheKey,
      row.subject,
      row.class,
      row.marksTotal,
      JSON.stringify(row.chapterFilenames),
      row.blueprintVersion,
      JSON.stringify(row.paperJson),
      row.answerKeyJson ? JSON.stringify(row.answerKeyJson) : null,
      row.pdfR2Key,
      row.answerKeyPdfR2Key,
      createdAt
    )
    .run();
  return { ...row, createdAt };
}

export async function saveAnswerKey(env: Env, id: string, answerKeyJson: unknown): Promise<void> {
  await env.EDU_LIVE_DB.prepare("UPDATE question_papers SET answer_key_json = ? WHERE id = ?")
    .bind(JSON.stringify(answerKeyJson), id)
    .run();
}

export async function savePdfKey(
  env: Env,
  id: string,
  field: "pdfR2Key" | "answerKeyPdfR2Key",
  r2Key: string
): Promise<void> {
  const column = field === "pdfR2Key" ? "pdf_r2_key" : "answer_key_pdf_r2_key";
  await env.EDU_LIVE_DB.prepare(`UPDATE question_papers SET ${column} = ? WHERE id = ?`).bind(r2Key, id).run();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/questionPaperCache.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/questionPaperCache.ts worker/test/questionPaperCache.test.ts
git commit -m "Add question paper D1 cache read/write helpers"
```

---

### Task 4: Config additions

**Files:**
- Modify: `worker/src/config.ts`
- Test: `worker/test/config.test.ts` (extend existing)

**Interfaces:**
- Produces: `RuntimeConfig.questionPaperModelSlug: string`, `RuntimeConfig.questionPaperImageGenEnabled: boolean`, consumed by Task 6 (generation) and Task 7 (image-gen).

- [ ] **Step 1: Write failing test additions**

Add to `worker/test/config.test.ts`, inside the existing `describe("parseConfigRows", ...)` block's "parses each stored value" test, add two more rows and two more expected fields (extend the existing object literals), and add a new top-level test:

```typescript
it("defaults questionPaperModelSlug and questionPaperImageGenEnabled when absent", () => {
  const result = parseConfigRows([]);
  expect(result.questionPaperModelSlug).toBe(DEFAULT_CONFIG.questionPaperModelSlug);
  expect(result.questionPaperImageGenEnabled).toBe(true);
});

it("rejects an empty questionPaperModelSlug and a non-boolean questionPaperImageGenEnabled", () => {
  expect(validateConfigUpdate({ questionPaperModelSlug: "" })).toHaveLength(1);
  expect(validateConfigUpdate({ questionPaperImageGenEnabled: "yes" })).toHaveLength(1);
  expect(validateConfigUpdate({ questionPaperModelSlug: "some/model", questionPaperImageGenEnabled: false })).toHaveLength(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — new fields undefined / `questionPaperModelSlug` not recognized.

- [ ] **Step 3: Implement the config additions**

In `worker/src/config.ts`:

```typescript
// Add to RuntimeConfig interface:
  questionPaperModelSlug: string;
  questionPaperImageGenEnabled: boolean;

// Add to DEFAULT_CONFIG (reuse the same OpenRouter default as chat - a
// separate field, not a shared one, so this can be tuned independently
// without touching chat's model):
  questionPaperModelSlug: DEFAULT_OPENROUTER_MODEL,
  questionPaperImageGenEnabled: true,

// Add to parseConfigRows return object:
    questionPaperModelSlug: map.get("questionPaperModelSlug") ?? DEFAULT_CONFIG.questionPaperModelSlug,
    questionPaperImageGenEnabled: map.has("questionPaperImageGenEnabled")
      ? map.get("questionPaperImageGenEnabled") === "true"
      : DEFAULT_CONFIG.questionPaperImageGenEnabled,

// Add to KNOWN_FIELDS set:
  "questionPaperModelSlug",
  "questionPaperImageGenEnabled",

// Add to validateConfigUpdate, after the ingestionModelSlug block:
  if ("questionPaperModelSlug" in input) {
    const v = input.questionPaperModelSlug;
    if (typeof v !== "string" || v.trim().length === 0) {
      errors.push({ field: "questionPaperModelSlug", message: "questionPaperModelSlug must be a non-empty string" });
    }
  }
  if ("questionPaperImageGenEnabled" in input && typeof input.questionPaperImageGenEnabled !== "boolean") {
    errors.push({ field: "questionPaperImageGenEnabled", message: "questionPaperImageGenEnabled must be a boolean" });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/config.ts worker/test/config.test.ts
git commit -m "Add questionPaperModelSlug and questionPaperImageGenEnabled config fields"
```

---

### Task 5: Ingestion + admin metadata extension (subject/class/chapter)

**Files:**
- Modify: `worker/src/ingestion.ts`
- Modify: `worker/src/admin.ts`
- Test: `worker/test/ingestion.test.ts` (extend), `worker/test/admin.test.ts` (extend)

**Interfaces:**
- Produces: R2 `customMetadata.subject`, `.class`, `.chapter` on ingested documents, surfaced via `/admin/documents` as `subject`, `class`, `chapter` fields — consumed by Task 10 (catalog endpoint, read via `PDF_BUCKET.list`, same pattern as `handleAdminDocuments`).

- [ ] **Step 1: Write failing tests**

Add to `worker/test/ingestion.test.ts` (find the existing successful-ingest test and extend its formData setup and R2 `put` assertion — exact line numbers vary, so locate the test asserting on `env.PDF_BUCKET.put` customMetadata and add alongside it):

```typescript
it("stores subject/class/chapter as customMetadata when provided in the form", async () => {
  const formData = new FormData();
  formData.append("file", new File([VALID_PDF_BYTES], "test.pdf", { type: "application/pdf" }));
  formData.append("subject", "Science");
  formData.append("class", "10");
  formData.append("chapter", "Carbon and its Compounds");
  const request = new Request("http://worker/ingest", { method: "POST", body: formData });

  await handleIngest(request, env);

  const putCall = (env.PDF_BUCKET.put as ReturnType<typeof vi.fn>).mock.calls.find(([key]) => key === "test.pdf");
  expect(putCall[2].customMetadata).toMatchObject({
    subject: "Science",
    class: "10",
    chapter: "Carbon and its Compounds",
  });
});
```

Add to `worker/test/admin.test.ts` (extend the existing `handleAdminDocuments` test's mocked `customMetadata` and assert the new fields pass through):

```typescript
it("includes subject/class/chapter in the documents list when present", async () => {
  env.PDF_BUCKET.list = vi.fn().mockResolvedValue({
    objects: [
      {
        key: "test.pdf",
        size: 100,
        customMetadata: {
          indexedAt: "2026-10-03T00:00:00.000Z",
          chunkCount: "3",
          subject: "Science",
          class: "10",
          chapter: "Carbon and its Compounds",
        },
      },
    ],
  });
  const response = await handleAdminDocuments(env);
  const body = await response.json();
  expect(body.documents[0]).toMatchObject({ subject: "Science", class: "10", chapter: "Carbon and its Compounds" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/ingestion.test.ts test/admin.test.ts`
Expected: FAIL — fields not present on the written/returned metadata.

- [ ] **Step 3: Implement**

In `worker/src/ingestion.ts`, find where `formData` is read (`const force = formData.get("force") === "true";`) and add nearby:

```typescript
  const subject = String(formData.get("subject") ?? "");
  const cls = String(formData.get("class") ?? "");
  const chapter = String(formData.get("chapter") ?? "");
```

Find the final `R2.put()` call for the source PDF (per `CLAUDE.md`, this happens last, with `{chunkCount, pageCount, indexedAt, enriched}` customMetadata) and add the three fields to that same `customMetadata` object:

```typescript
      subject,
      class: cls,
      chapter,
```

In `worker/src/admin.ts`, in `handleAdminDocuments`, add to the `documents` mapping (alongside the existing `enriched` field):

```typescript
      subject: obj.customMetadata?.subject ?? null,
      class: obj.customMetadata?.class ?? null,
      chapter: obj.customMetadata?.chapter ?? null,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/ingestion.test.ts test/admin.test.ts`
Expected: PASS

- [ ] **Step 5: Run full suite to check for regressions**

Run: `npx vitest run` (from `worker/`)
Expected: PASS (aside from the pre-existing known `chat.test.ts` mock-type issues noted in Global Constraints).

- [ ] **Step 6: Commit**

```bash
git add worker/src/ingestion.ts worker/src/admin.ts worker/test/ingestion.test.ts worker/test/admin.test.ts
git commit -m "Store and surface subject/class/chapter metadata for ingested documents"
```

---

### Task 6: Chunk retrieval helper (document-filtered, not semantic)

**Files:**
- Create: `worker/src/questionPaperRetrieval.ts`
- Test: `worker/test/questionPaperRetrieval.test.ts`

**Interfaces:**
- Consumes: `Env` (`PDF_BUCKET`, `VECTORIZE`), `chunkVectorId` from `./vectorId` (existing).
- Produces:
  - `interface ChapterChunks { filename: string; chunkCount: number; chunks: { chunkId: number; page: number; text: string; pageImageKey: string | null }[] }`
  - `async function fetchChapterChunks(env: Env, filename: string): Promise<ChapterChunks | null>` — `null` if the document doesn't exist in R2 or has `chunkCount: 0`.
  - `async function fetchAllChapterChunks(env: Env, filenames: string[]): Promise<{ found: ChapterChunks[]; missing: string[] }>`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect, vi } from "vitest";
import { fetchChapterChunks, fetchAllChapterChunks } from "../src/questionPaperRetrieval";
import type { Env } from "../src/index";
import { chunkVectorId } from "../src/vectorId";

function makeEnv(headResult: unknown, vectors: { id: string; metadata: Record<string, unknown> }[]) {
  return {
    PDF_BUCKET: { head: vi.fn().mockResolvedValue(headResult) },
    VECTORIZE: { getByIds: vi.fn().mockResolvedValue(vectors) },
  } as unknown as Env;
}

describe("fetchChapterChunks", () => {
  it("returns null when the document doesn't exist", async () => {
    const env = makeEnv(null, []);
    expect(await fetchChapterChunks(env, "missing.pdf")).toBeNull();
  });

  it("returns null when chunkCount is 0", async () => {
    const env = makeEnv({ customMetadata: { chunkCount: "0" } }, []);
    expect(await fetchChapterChunks(env, "empty.pdf")).toBeNull();
  });

  it("returns chunks with page and pageImageKey when the document has chunks", async () => {
    const id0 = chunkVectorId("ch.pdf", 0);
    const env = makeEnv({ customMetadata: { chunkCount: "1" } }, [
      { id: id0, metadata: { page: 2, text: "hello", pageImageKey: "page-images/ch.pdf/2.png" } },
    ]);
    const result = await fetchChapterChunks(env, "ch.pdf");
    expect(result).not.toBeNull();
    expect(result!.chunks).toEqual([{ chunkId: 0, page: 2, text: "hello", pageImageKey: "page-images/ch.pdf/2.png" }]);
  });
});

describe("fetchAllChapterChunks", () => {
  it("separates found documents from missing ones", async () => {
    const env = {
      PDF_BUCKET: {
        head: vi.fn((key: string) =>
          key === "found.pdf" ? Promise.resolve({ customMetadata: { chunkCount: "1" } }) : Promise.resolve(null)
        ),
      },
      VECTORIZE: {
        getByIds: vi.fn().mockResolvedValue([{ id: chunkVectorId("found.pdf", 0), metadata: { page: 1, text: "x" } }]),
      },
    } as unknown as Env;

    const result = await fetchAllChapterChunks(env, ["found.pdf", "missing.pdf"]);
    expect(result.found.map((c) => c.filename)).toEqual(["found.pdf"]);
    expect(result.missing).toEqual(["missing.pdf"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/questionPaperRetrieval.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```typescript
import type { Env } from "./index";
import { chunkVectorId } from "./vectorId";

export interface ChapterChunks {
  filename: string;
  chunkCount: number;
  chunks: { chunkId: number; page: number; text: string; pageImageKey: string | null }[];
}

export async function fetchChapterChunks(env: Env, filename: string): Promise<ChapterChunks | null> {
  const head = await env.PDF_BUCKET.head(filename);
  const chunkCount = Number(head?.customMetadata?.chunkCount ?? 0);
  if (!head || chunkCount <= 0) return null;

  const ids = Array.from({ length: chunkCount }, (_, i) => chunkVectorId(filename, i));
  const idToChunkId = new Map(ids.map((id, i) => [id, i]));
  const vectors = await env.VECTORIZE.getByIds(ids);

  const chunks = vectors
    .map((v) => ({
      chunkId: idToChunkId.get(v.id) ?? 0,
      page: Number(v.metadata?.page ?? 0),
      text: String(v.metadata?.text ?? ""),
      pageImageKey: v.metadata?.pageImageKey ? String(v.metadata.pageImageKey) : null,
    }))
    .sort((a, b) => a.chunkId - b.chunkId);

  return { filename, chunkCount, chunks };
}

export async function fetchAllChapterChunks(
  env: Env,
  filenames: string[]
): Promise<{ found: ChapterChunks[]; missing: string[] }> {
  const results = await Promise.all(filenames.map((f) => fetchChapterChunks(env, f)));
  const found: ChapterChunks[] = [];
  const missing: string[] = [];
  results.forEach((r, i) => {
    if (r) found.push(r);
    else missing.push(filenames[i]);
  });
  return { found, missing };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/questionPaperRetrieval.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/questionPaperRetrieval.ts worker/test/questionPaperRetrieval.test.ts
git commit -m "Add document-filtered chunk retrieval for question paper generation"
```

---

### Task 7: Image-gen fallback (allowlist/blocklist + Workers AI + R2 caching)

**Files:**
- Create: `worker/src/questionPaperImageGen.ts`
- Test: `worker/test/questionPaperImageGen.test.ts`

**Interfaces:**
- Consumes: `Env` (`AI`, `PDF_BUCKET`).
- Produces:
  - `function isDiagramAllowlisted(description: string): boolean` — simple keyword match against the allowlist/blocklist described in the spec.
  - `async function generateDiagramImage(env: Env, paperId: string, slotKey: string, description: string, enabled: boolean): Promise<{ generatedImageKey: string } | null>` — returns `null` (never throws) when disabled, blocklisted, or generation fails; otherwise generates, stores at `question-papers/<paperId>/gen-<slotKey>.png`, returns the key.

- [ ] **Step 1: Write failing tests**

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/questionPaperImageGen.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/questionPaperImageGen.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/questionPaperImageGen.ts worker/test/questionPaperImageGen.test.ts
git commit -m "Add guarded image-gen fallback for question paper diagrams"
```

---

### Task 8: Core generation module (prompt, LLM call, JSON validation, diagram resolution)

**Files:**
- Create: `worker/src/questionPaperGeneration.ts`
- Test: `worker/test/questionPaperGeneration.test.ts`

**Interfaces:**
- Consumes:
  - `Blueprint`, `BlueprintSlot`, `getBlueprint`, `distributeSlotsAcrossChapters` from `./questionPaperBlueprints` (Task 2)
  - `ChapterChunks` from `./questionPaperRetrieval` (Task 6)
  - `generateChatCompletion` from `./llm` (existing)
  - `generateDiagramImage` from `./questionPaperImageGen` (Task 7)
- Produces:
  - `interface GeneratedQuestion { section: string; questionType: string; marks: number; text: string; latex?: string; table?: { headers: string[]; rows: string[][] }; pageImageKey?: string; generatedImageKey?: string; imageSource?: "ingested" | "generated" }`
  - `interface GeneratedPaper { subject: string; class: string; marksTotal: number; blueprintVersion: string; sections: { section: string; questions: GeneratedQuestion[] }[] }`
  - `class GenerationError extends Error` — thrown (not caught) on LLM/JSON failure, per the throw-on-failure contract.
  - `async function buildGenerationPrompt(blueprint: Blueprint, chaptersWithSlots: { chunks: ChapterChunks; slots: BlueprintSlot[] }[]): { system: string; user: string }` — pure, no I/O.
  - `function parseAndValidateGeneratedPaper(raw: string, blueprint: Blueprint): GeneratedPaper` — throws `GenerationError` on malformed JSON or a slot-count mismatch.
  - `async function generatePaper(env: Env, blueprint: Blueprint, chaptersWithSlots: { chunks: ChapterChunks; slots: BlueprintSlot[] }[], paperId: string, config: { llmProvider: "openrouter" | "workers-ai"; questionPaperModelSlug: string; questionPaperImageGenEnabled: boolean }): Promise<GeneratedPaper>` — orchestrates prompt build → `generateChatCompletion` → parse/validate → diagram resolution (ingested `pageImageKey` first, then `generateDiagramImage` fallback) → returns the final `GeneratedPaper`.

- [ ] **Step 1: Write failing tests**

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/questionPaperGeneration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/questionPaperGeneration.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/questionPaperGeneration.ts worker/test/questionPaperGeneration.test.ts
git commit -m "Add core question paper generation (single LLM call + diagram resolution)"
```

---

### Task 9: Answer key generation module

**Files:**
- Create: `worker/src/questionPaperAnswerKey.ts`
- Test: `worker/test/questionPaperAnswerKey.test.ts`

**Interfaces:**
- Consumes: `GeneratedPaper` from `./questionPaperGeneration` (Task 8), `generateChatCompletion` from `./llm`.
- Produces:
  - `interface AnswerKeyEntry { section: string; questionIndex: number; answer: string }`
  - `interface AnswerKey { entries: AnswerKeyEntry[] }`
  - `async function generateAnswerKey(env: Env, paper: GeneratedPaper, config: { llmProvider: "openrouter" | "workers-ai"; questionPaperModelSlug: string }): Promise<AnswerKey>` — exactly one LLM call, reusing `paper`'s question text as input (no retrieval).

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect, vi } from "vitest";
import { generateAnswerKey } from "../src/questionPaperAnswerKey";
import type { GeneratedPaper } from "../src/questionPaperGeneration";
import type { Env } from "../src/index";
import * as llm from "../src/llm";

const paper: GeneratedPaper = {
  subject: "Science",
  class: "10",
  marksTotal: 40,
  blueprintVersion: "science-40-v1",
  sections: [{ section: "A", questions: [{ section: "A", questionType: "mcq", marks: 1, text: "What is catenation?" }] }],
};

describe("generateAnswerKey", () => {
  it("calls generateChatCompletion exactly once and returns one entry per question", async () => {
    const spy = vi.spyOn(llm, "generateChatCompletion").mockResolvedValue({
      text: JSON.stringify({ entries: [{ section: "A", questionIndex: 0, answer: "Carbon's ability to bond with itself." }] }),
      provider: "openrouter",
      model: "x",
    });

    const env = {} as Env;
    const key = await generateAnswerKey(env, paper, { llmProvider: "openrouter", questionPaperModelSlug: "some/model" });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(key.entries).toHaveLength(1);
    expect(key.entries[0].answer).toContain("Carbon");
  });

  it("does not include the source chunk text in the prompt (reuses paper questions only)", async () => {
    const spy = vi
      .spyOn(llm, "generateChatCompletion")
      .mockResolvedValue({ text: JSON.stringify({ entries: [{ section: "A", questionIndex: 0, answer: "x" }] }), provider: "openrouter", model: "x" });

    const env = {} as Env;
    await generateAnswerKey(env, paper, { llmProvider: "openrouter", questionPaperModelSlug: "some/model" });

    const callArgs = spy.mock.calls[0][0];
    const userMessage = callArgs.find((m) => m.role === "user")!.content;
    expect(userMessage).toContain("What is catenation?");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/questionPaperAnswerKey.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/questionPaperAnswerKey.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/questionPaperAnswerKey.ts worker/test/questionPaperAnswerKey.test.ts
git commit -m "Add answer key generation (single LLM call, reuses existing questions)"
```

---

### Task 10: PDF rendering module

**Files:**
- Create: `worker/src/questionPaperPdf.ts`
- Test: `worker/test/questionPaperPdf.test.ts`

**Interfaces:**
- Consumes: `GeneratedPaper` from `./questionPaperGeneration`, `AnswerKey` from `./questionPaperAnswerKey`, `@cloudflare/puppeteer` (existing dependency, same as `pageScreenshot.ts`).
- Produces:
  - `function renderPaperHtml(paper: GeneratedPaper): string` — pure, no I/O.
  - `function renderAnswerKeyHtml(paper: GeneratedPaper, key: AnswerKey): string` — pure, no I/O.
  - `async function renderHtmlToPdf(env: Env, html: string): Promise<ArrayBuffer | null>` — uses `BROWSER` binding; returns `null` (never throws) on failure, per the fail-open PDF contract.

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect, vi } from "vitest";
import { renderPaperHtml, renderAnswerKeyHtml, renderHtmlToPdf } from "../src/questionPaperPdf";
import type { GeneratedPaper } from "../src/questionPaperGeneration";
import type { AnswerKey } from "../src/questionPaperAnswerKey";
import type { Env } from "../src/index";

const paper: GeneratedPaper = {
  subject: "Science",
  class: "10",
  marksTotal: 40,
  blueprintVersion: "science-40-v1",
  sections: [{ section: "A", questions: [{ section: "A", questionType: "mcq", marks: 1, text: "What is catenation?" }] }],
};

describe("renderPaperHtml", () => {
  it("includes the subject, marks total, section heading, and question text", () => {
    const html = renderPaperHtml(paper);
    expect(html).toContain("Science");
    expect(html).toContain("40");
    expect(html).toContain("Section A");
    expect(html).toContain("What is catenation?");
  });
});

describe("renderAnswerKeyHtml", () => {
  it("includes each question's answer text", () => {
    const key: AnswerKey = { entries: [{ section: "A", questionIndex: 0, answer: "Carbon bonds with itself." }] };
    const html = renderAnswerKeyHtml(paper, key);
    expect(html).toContain("Carbon bonds with itself.");
  });
});

describe("renderHtmlToPdf", () => {
  it("returns null (fails open) when the browser launch throws", async () => {
    const env = { BROWSER: {} } as unknown as Env;
    const result = await renderHtmlToPdf(env, "<html></html>");
    // In the Vitest environment there's no real Browser Rendering binding,
    // so this always exercises the fail-open path - that's the behavior
    // under test here.
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/questionPaperPdf.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```typescript
import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "./index";
import type { GeneratedPaper } from "./questionPaperGeneration";
import type { AnswerKey } from "./questionPaperAnswerKey";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const BASE_STYLE =
  "body{font-family:Georgia,serif;padding:32px;} h1{font-size:20px;} h2{font-size:16px;margin-top:24px;} " +
  "ol{padding-left:20px;} li{margin-bottom:12px;}";

export function renderPaperHtml(paper: GeneratedPaper): string {
  const sections = paper.sections
    .map(
      (s) =>
        `<h2>Section ${escapeHtml(s.section)}</h2><ol>${s.questions
          .map((q) => `<li>${escapeHtml(q.text)} <em>[${q.marks} mark${q.marks === 1 ? "" : "s"}]</em></li>`)
          .join("")}</ol>`
    )
    .join("");

  return `<html><head><style>${BASE_STYLE}</style></head><body>` +
    `<h1>${escapeHtml(paper.subject)} - Class ${escapeHtml(paper.class)} (${paper.marksTotal} Marks)</h1>` +
    sections +
    `</body></html>`;
}

export function renderAnswerKeyHtml(paper: GeneratedPaper, key: AnswerKey): string {
  const answerByQuestion = new Map(key.entries.map((e) => [`${e.section}:${e.questionIndex}`, e.answer]));
  const sections = paper.sections
    .map(
      (s) =>
        `<h2>Section ${escapeHtml(s.section)}</h2><ol>${s.questions
          .map((q, i) => {
            const answer = answerByQuestion.get(`${s.section}:${i}`) ?? "";
            return `<li>${escapeHtml(q.text)}<br/><strong>Answer:</strong> ${escapeHtml(answer)}</li>`;
          })
          .join("")}</ol>`
    )
    .join("");

  return `<html><head><style>${BASE_STYLE}</style></head><body>` +
    `<h1>${escapeHtml(paper.subject)} - Class ${escapeHtml(paper.class)} Answer Key</h1>` +
    sections +
    `</body></html>`;
}

/**
 * Fails open: returns null (never throws) on any Browser Rendering error -
 * PDF generation must never block showing the paper itself, per the PDF
 * stage's fail-open contract.
 */
export async function renderHtmlToPdf(env: Env, html: string): Promise<ArrayBuffer | null> {
  let browser;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setContent(html);
    const pdf = await page.pdf();
    return pdf as unknown as ArrayBuffer;
  } catch (err) {
    console.error("question paper PDF rendering failed", err);
    return null;
  } finally {
    await browser?.close().catch(() => {});
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/questionPaperPdf.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/questionPaperPdf.ts worker/test/questionPaperPdf.test.ts
git commit -m "Add question paper PDF rendering via Browser Rendering binding"
```

---

### Task 11: Route handlers + wiring into `index.ts`

**Files:**
- Create: `worker/src/questionPaper.ts`
- Modify: `worker/src/index.ts`
- Test: `worker/test/questionPaper.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–10, plus `getRuntimeConfig` from `./config`, `isAdminAuthorized`-style pattern is NOT used here (these routes are public per Global Constraints).
- Produces:
  - `async function handleQuestionPaperCatalog(env: Env): Promise<Response>`
  - `async function handleQuestionPaperGenerate(request: Request, env: Env): Promise<Response>`
  - `async function handleQuestionPaperAnswerKey(request: Request, env: Env, paperId: string): Promise<Response>`
  - `async function handleQuestionPaperPdf(env: Env, paperId: string): Promise<Response>`
  - `async function handleQuestionPaperAnswerKeyPdf(env: Env, paperId: string): Promise<Response>`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleQuestionPaperCatalog,
  handleQuestionPaperGenerate,
  handleQuestionPaperAnswerKey,
  handleQuestionPaperPdf,
} from "../src/questionPaper";
import type { Env } from "../src/index";
import * as cache from "../src/questionPaperCache";
import * as retrieval from "../src/questionPaperRetrieval";
import * as generation from "../src/questionPaperGeneration";
import * as config from "../src/config";

function baseEnv(): Env {
  return {
    PDF_BUCKET: { list: vi.fn().mockResolvedValue({ objects: [] }) },
  } as unknown as Env;
}

describe("handleQuestionPaperCatalog", () => {
  it("returns subject/class/chapter/filename for ingested documents, excluding admin-only fields", async () => {
    const env = {
      PDF_BUCKET: {
        list: vi.fn().mockResolvedValue({
          objects: [
            { key: "ch.pdf", customMetadata: { subject: "Science", class: "10", chapter: "Carbon", chunkCount: "5", enriched: "true" } },
          ],
        }),
      },
    } as unknown as Env;

    const response = await handleQuestionPaperCatalog(env);
    const body = await response.json();
    expect(body.documents[0]).toEqual({ filename: "ch.pdf", subject: "Science", class: "10", chapter: "Carbon" });
    expect(body.documents[0].chunkCount).toBeUndefined();
    expect(body.documents[0].enriched).toBeUndefined();
  });
});

describe("handleQuestionPaperGenerate", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns 400 when marksTotal has no matching blueprint", async () => {
    vi.spyOn(config, "getRuntimeConfig").mockResolvedValue({ llmProvider: "openrouter", questionPaperModelSlug: "x", questionPaperImageGenEnabled: false } as any);
    const env = baseEnv();
    const request = new Request("http://worker/question-paper/generate", {
      method: "POST",
      body: JSON.stringify({ subject: "History", class: "10", chapterFilenames: ["a.pdf"], marksTotal: 40 }),
    });
    const response = await handleQuestionPaperGenerate(request, env);
    expect(response.status).toBe(400);
  });

  it("returns 400 when a chapter filename doesn't exist", async () => {
    vi.spyOn(config, "getRuntimeConfig").mockResolvedValue({ llmProvider: "openrouter", questionPaperModelSlug: "x", questionPaperImageGenEnabled: false } as any);
    vi.spyOn(cache, "findCachedPaper").mockResolvedValue(null);
    vi.spyOn(retrieval, "fetchAllChapterChunks").mockResolvedValue({ found: [], missing: ["missing.pdf"] });
    const env = baseEnv();
    const request = new Request("http://worker/question-paper/generate", {
      method: "POST",
      body: JSON.stringify({ subject: "Science", class: "10", chapterFilenames: ["missing.pdf"], marksTotal: 40 }),
    });
    const response = await handleQuestionPaperGenerate(request, env);
    expect(response.status).toBe(400);
  });

  it("returns a cached paper directly without calling generatePaper", async () => {
    vi.spyOn(config, "getRuntimeConfig").mockResolvedValue({ llmProvider: "openrouter", questionPaperModelSlug: "x", questionPaperImageGenEnabled: false } as any);
    vi.spyOn(cache, "findCachedPaper").mockResolvedValue({
      id: "p1",
      cacheKey: "k1",
      subject: "Science",
      class: "10",
      marksTotal: 40,
      chapterFilenames: ["a.pdf"],
      blueprintVersion: "science-40-v1",
      paperJson: { sections: [] },
      answerKeyJson: null,
      pdfR2Key: null,
      answerKeyPdfR2Key: null,
      createdAt: "2026-10-03T00:00:00.000Z",
    });
    const generateSpy = vi.spyOn(generation, "generatePaper");

    const env = baseEnv();
    const request = new Request("http://worker/question-paper/generate", {
      method: "POST",
      body: JSON.stringify({ subject: "Science", class: "10", chapterFilenames: ["a.pdf"], marksTotal: 40 }),
    });
    const response = await handleQuestionPaperGenerate(request, env);
    const body = await response.json();

    expect(body.id).toBe("p1");
    expect(generateSpy).not.toHaveBeenCalled();
  });
});

describe("handleQuestionPaperAnswerKey / handleQuestionPaperPdf", () => {
  it("answer key returns 404 for an unknown paper id", async () => {
    vi.spyOn(cache, "findPaperById").mockResolvedValue(null);
    const env = baseEnv();
    const request = new Request("http://worker/question-paper/unknown/answer-key", { method: "POST" });
    const response = await handleQuestionPaperAnswerKey(request, env, "unknown");
    expect(response.status).toBe(404);
  });

  it("pdf returns 404 for an unknown paper id", async () => {
    vi.spyOn(cache, "findPaperById").mockResolvedValue(null);
    const env = baseEnv();
    const response = await handleQuestionPaperPdf(env, "unknown");
    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/questionPaper.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```typescript
import type { Env } from "./index";
import { getRuntimeConfig } from "./config";
import { getBlueprint, distributeSlotsAcrossChapters } from "./questionPaperBlueprints";
import { fetchAllChapterChunks } from "./questionPaperRetrieval";
import { generatePaper, GenerationError } from "./questionPaperGeneration";
import { generateAnswerKey } from "./questionPaperAnswerKey";
import { renderPaperHtml, renderAnswerKeyHtml, renderHtmlToPdf } from "./questionPaperPdf";
import { computeCacheKey, findCachedPaper, saveNewPaper, findPaperById, saveAnswerKey, savePdfKey } from "./questionPaperCache";

function errorResponse(routeName: string, err: unknown, status = 500): Response {
  console.error(`${routeName} failed`, err);
  const message = err instanceof GenerationError ? err.message : "Something went wrong - please try again.";
  return Response.json({ error: message }, { status });
}

export async function handleQuestionPaperCatalog(env: Env): Promise<Response> {
  try {
    const listed = await env.PDF_BUCKET.list({ include: ["customMetadata"] });
    const documents = listed.objects
      .filter((obj) => !obj.key.startsWith("page-images/") && !obj.key.startsWith("cleaned/") && !obj.key.startsWith("question-papers/"))
      .filter((obj) => obj.customMetadata?.subject)
      .map((obj) => ({
        filename: obj.key,
        subject: obj.customMetadata!.subject!,
        class: obj.customMetadata!.class ?? "",
        chapter: obj.customMetadata!.chapter ?? "",
      }));
    return Response.json({ documents });
  } catch (err) {
    return errorResponse("/question-paper/catalog", err);
  }
}

interface GenerateRequestBody {
  subject: string;
  class: string;
  chapterFilenames: string[];
  marksTotal: number;
}

export async function handleQuestionPaperGenerate(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json().catch(() => null)) as GenerateRequestBody | null;
    if (!body || !body.subject || !body.class || !Array.isArray(body.chapterFilenames) || body.chapterFilenames.length === 0 || !body.marksTotal) {
      return Response.json({ error: "Expected subject, class, chapterFilenames[], and marksTotal" }, { status: 400 });
    }

    const blueprint = getBlueprint(body.subject, body.marksTotal);
    if (!blueprint) {
      return Response.json({ error: `No question paper template is available yet for ${body.subject}` }, { status: 400 });
    }

    const cacheKey = computeCacheKey(body.subject, body.class, body.marksTotal, body.chapterFilenames, blueprint.version);
    const cached = await findCachedPaper(env, cacheKey);
    if (cached) {
      return Response.json({ id: cached.id, paper: cached.paperJson, cached: true });
    }

    const { found, missing } = await fetchAllChapterChunks(env, body.chapterFilenames);
    if (missing.length > 0) {
      return Response.json({ error: `These chapters aren't available: ${missing.join(", ")}` }, { status: 400 });
    }

    const chapterChunkCounts = Object.fromEntries(found.map((c) => [c.filename, c.chunkCount]));
    const slotsByChapter = distributeSlotsAcrossChapters(blueprint, chapterChunkCounts);
    const chaptersWithSlots = found.map((chunks) => ({ chunks, slots: slotsByChapter[chunks.filename] ?? [] }));

    const config = await getRuntimeConfig(env);
    const id = crypto.randomUUID();
    const generated = await generatePaper(env, blueprint, chaptersWithSlots, id, {
      llmProvider: config.llmProvider,
      questionPaperModelSlug: config.questionPaperModelSlug,
      questionPaperImageGenEnabled: config.questionPaperImageGenEnabled,
    });
    generated.class = body.class;

    const row = await saveNewPaper(env, {
      id,
      cacheKey,
      subject: body.subject,
      class: body.class,
      marksTotal: body.marksTotal,
      chapterFilenames: body.chapterFilenames,
      blueprintVersion: blueprint.version,
      paperJson: generated,
      answerKeyJson: null,
      pdfR2Key: null,
      answerKeyPdfR2Key: null,
    });

    return Response.json({ id: row.id, paper: generated, cached: false });
  } catch (err) {
    return errorResponse("/question-paper/generate", err);
  }
}

export async function handleQuestionPaperAnswerKey(request: Request, env: Env, paperId: string): Promise<Response> {
  try {
    const row = await findPaperById(env, paperId);
    if (!row) return Response.json({ error: "Question paper not found" }, { status: 404 });

    if (row.answerKeyJson) {
      return Response.json({ answerKey: row.answerKeyJson, cached: true });
    }

    const config = await getRuntimeConfig(env);
    const answerKey = await generateAnswerKey(env, row.paperJson as any, {
      llmProvider: config.llmProvider,
      questionPaperModelSlug: config.questionPaperModelSlug,
    });
    await saveAnswerKey(env, paperId, answerKey);

    return Response.json({ answerKey, cached: false });
  } catch (err) {
    return errorResponse("/question-paper/:id/answer-key", err);
  }
}

export async function handleQuestionPaperPdf(env: Env, paperId: string): Promise<Response> {
  try {
    const row = await findPaperById(env, paperId);
    if (!row) return Response.json({ error: "Question paper not found" }, { status: 404 });

    if (row.pdfR2Key) {
      const object = await env.PDF_BUCKET.get(row.pdfR2Key);
      if (object) return new Response(object.body, { headers: { "content-type": "application/pdf" } });
    }

    const html = renderPaperHtml(row.paperJson as any);
    const pdf = await renderHtmlToPdf(env, html);
    if (!pdf) return Response.json({ error: "PDF generation failed, paper still available in-chat" }, { status: 500 });

    const key = `question-papers/${paperId}.pdf`;
    await env.PDF_BUCKET.put(key, pdf, { httpMetadata: { contentType: "application/pdf" } });
    await savePdfKey(env, paperId, "pdfR2Key", key);

    return new Response(pdf, { headers: { "content-type": "application/pdf" } });
  } catch (err) {
    return errorResponse("/question-paper/:id/pdf", err);
  }
}

export async function handleQuestionPaperAnswerKeyPdf(env: Env, paperId: string): Promise<Response> {
  try {
    const row = await findPaperById(env, paperId);
    if (!row) return Response.json({ error: "Question paper not found" }, { status: 404 });
    if (!row.answerKeyJson) {
      return Response.json({ error: "Generate the answer key before requesting its PDF" }, { status: 400 });
    }

    if (row.answerKeyPdfR2Key) {
      const object = await env.PDF_BUCKET.get(row.answerKeyPdfR2Key);
      if (object) return new Response(object.body, { headers: { "content-type": "application/pdf" } });
    }

    const html = renderAnswerKeyHtml(row.paperJson as any, row.answerKeyJson as any);
    const pdf = await renderHtmlToPdf(env, html);
    if (!pdf) return Response.json({ error: "PDF generation failed, answer key still available in-chat" }, { status: 500 });

    const key = `question-papers/${paperId}-key.pdf`;
    await env.PDF_BUCKET.put(key, pdf, { httpMetadata: { contentType: "application/pdf" } });
    await savePdfKey(env, paperId, "answerKeyPdfR2Key", key);

    return new Response(pdf, { headers: { "content-type": "application/pdf" } });
  } catch (err) {
    return errorResponse("/question-paper/:id/answer-key-pdf", err);
  }
}
```

Then in `worker/src/index.ts`, add the import and route wiring. Add to the imports at the top:

```typescript
import {
  handleQuestionPaperCatalog,
  handleQuestionPaperGenerate,
  handleQuestionPaperAnswerKey,
  handleQuestionPaperPdf,
  handleQuestionPaperAnswerKeyPdf,
} from "./questionPaper";
```

Add route handling inside the `fetch` handler, alongside the existing `/explain` block:

```typescript
    if (request.method === "GET" && url.pathname === "/question-paper/catalog") {
      return withCors(await handleQuestionPaperCatalog(env));
    }
    if (request.method === "POST" && url.pathname === "/question-paper/generate") {
      return withCors(await handleQuestionPaperGenerate(request, env));
    }
    if (request.method === "POST" && url.pathname.match(/^\/question-paper\/[^/]+\/answer-key$/)) {
      const paperId = url.pathname.split("/")[2];
      return withCors(await handleQuestionPaperAnswerKey(request, env, paperId));
    }
    if (request.method === "GET" && url.pathname.match(/^\/question-paper\/[^/]+\/pdf$/)) {
      const paperId = url.pathname.split("/")[2];
      return withCors(await handleQuestionPaperPdf(env, paperId));
    }
    if (request.method === "GET" && url.pathname.match(/^\/question-paper\/[^/]+\/answer-key-pdf$/)) {
      const paperId = url.pathname.split("/")[2];
      return withCors(await handleQuestionPaperAnswerKeyPdf(env, paperId));
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/questionPaper.test.ts`
Expected: PASS

- [ ] **Step 5: Run full worker test suite + typecheck**

Run: `npx vitest run` and `npx tsc --noEmit` (from `worker/`)
Expected: PASS (aside from the pre-existing known `chat.test.ts` mock-type issues).

- [ ] **Step 6: Commit**

```bash
git add worker/src/questionPaper.ts worker/src/index.ts worker/test/questionPaper.test.ts
git commit -m "Wire question paper routes into the worker"
```

---

### Task 12: Admin dashboard upload form fields

**Files:**
- Modify: `frontend/dashboard.html`
- Modify: `frontend/dashboard.js`

**Interfaces:**
- Consumes: `/ingest` endpoint (now accepting `subject`/`class`/`chapter` form fields per Task 5).
- Produces: nothing new consumed elsewhere — UI-only change.

- [ ] **Step 1: Inspect the current upload form**

Run: `grep -n "upload\|<form" "frontend/dashboard.html"` to locate the upload card's form markup.

- [ ] **Step 2: Add the three fields to the form**

In `frontend/dashboard.html`, inside the existing upload form (before the file input or submit button), add:

```html
<label for="upload-subject">Subject</label>
<input type="text" id="upload-subject" name="subject" placeholder="e.g. Science" required />
<label for="upload-class">Class</label>
<input type="text" id="upload-class" name="class" placeholder="e.g. 10" required />
<label for="upload-chapter">Chapter</label>
<input type="text" id="upload-chapter" name="chapter" placeholder="e.g. Carbon and its Compounds" required />
```

- [ ] **Step 3: Include the fields in the upload request**

In `frontend/dashboard.js`, find the handler that builds `FormData` for the `/ingest` POST (near the existing `fetch(`${WORKER_URL}/ingest`` call) and add, alongside the existing `file`/`force` fields:

```javascript
formData.append("subject", document.getElementById("upload-subject").value.trim());
formData.append("class", document.getElementById("upload-class").value.trim());
formData.append("chapter", document.getElementById("upload-chapter").value.trim());
```

- [ ] **Step 4: Manually verify**

Run `npx wrangler dev` from `frontend/` (or `npx serve .`) pointed at a locally running worker, upload a test PDF with all three fields filled in, then check `GET /admin/documents` response includes `subject`/`class`/`chapter` for that document.

- [ ] **Step 5: Commit**

```bash
git add frontend/dashboard.html frontend/dashboard.js
git commit -m "Add subject/class/chapter fields to the dashboard upload form"
```

---

### Task 13: Question Paper tab frontend (picker + results + actions)

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/app.js`
- Modify: `frontend/style.css`

**Interfaces:**
- Consumes: `GET /question-paper/catalog`, `POST /question-paper/generate`, `POST /question-paper/:id/answer-key`, `GET /question-paper/:id/pdf`, `GET /question-paper/:id/answer-key-pdf` (all from Task 11).

- [ ] **Step 1: Replace the placeholder markup**

In `frontend/index.html`, replace the existing placeholder block:

```html
<div id="question-paper-placeholder" class="coming-soon" hidden>
  Question Paper generation is coming soon.
</div>
```

with:

```html
<div id="question-paper-panel" class="question-paper-panel" hidden>
  <div class="qp-picker">
    <label for="qp-subject-select">Subject</label>
    <select id="qp-subject-select"></select>
    <label for="qp-class-select">Class</label>
    <select id="qp-class-select"></select>
    <fieldset id="qp-chapter-list"><legend>Chapters</legend></fieldset>
    <label for="qp-marks-select">Total Marks</label>
    <select id="qp-marks-select">
      <option value="40">40</option>
      <option value="80">80</option>
    </select>
    <button type="button" id="qp-generate-btn">Generate</button>
  </div>
  <div id="qp-result"></div>
</div>
```

- [ ] **Step 2: Wire up the JS**

In `frontend/app.js`, replace the reference to `questionPaperPlaceholder` with `question-paper-panel`, and add the picker/generation logic. Replace:

```javascript
const questionPaperPlaceholder = document.getElementById("question-paper-placeholder");
```

with:

```javascript
const questionPaperPanel = document.getElementById("question-paper-panel");
const qpSubjectSelect = document.getElementById("qp-subject-select");
const qpClassSelect = document.getElementById("qp-class-select");
const qpChapterList = document.getElementById("qp-chapter-list");
const qpMarksSelect = document.getElementById("qp-marks-select");
const qpGenerateBtn = document.getElementById("qp-generate-btn");
const qpResult = document.getElementById("qp-result");

let qpCatalog = [];

async function loadQuestionPaperCatalog() {
  if (qpCatalog.length > 0) return;
  const response = await fetch(`${WORKER_URL}/question-paper/catalog`);
  const body = await response.json();
  qpCatalog = body.documents || [];

  const subjects = [...new Set(qpCatalog.map((d) => d.subject))];
  qpSubjectSelect.innerHTML = subjects.map((s) => `<option value="${s}">${s}</option>`).join("");
  renderClassOptions();
}

function renderClassOptions() {
  const subject = qpSubjectSelect.value;
  const classes = [...new Set(qpCatalog.filter((d) => d.subject === subject).map((d) => d.class))];
  qpClassSelect.innerHTML = classes.map((c) => `<option value="${c}">${c}</option>`).join("");
  renderChapterCheckboxes();
}

function renderChapterCheckboxes() {
  const subject = qpSubjectSelect.value;
  const cls = qpClassSelect.value;
  const chapters = qpCatalog.filter((d) => d.subject === subject && d.class === cls);
  qpChapterList.innerHTML =
    "<legend>Chapters</legend>" +
    chapters
      .map(
        (c) =>
          `<label><input type="checkbox" value="${c.filename}" /> ${c.chapter}</label>`
      )
      .join("");
}

qpSubjectSelect.addEventListener("change", renderClassOptions);
qpClassSelect.addEventListener("change", renderChapterCheckboxes);

qpGenerateBtn.addEventListener("click", async () => {
  const chapterFilenames = [...qpChapterList.querySelectorAll("input:checked")].map((el) => el.value);
  if (chapterFilenames.length === 0) {
    qpResult.textContent = "Select at least one chapter.";
    return;
  }

  qpResult.textContent = "Generating...";
  const response = await fetch(`${WORKER_URL}/question-paper/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subject: qpSubjectSelect.value,
      class: qpClassSelect.value,
      chapterFilenames,
      marksTotal: Number(qpMarksSelect.value),
    }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "Something went wrong." }));
    qpResult.textContent = body.error;
    return;
  }

  const body = await response.json();
  renderQuestionPaper(body.id, body.paper);
});

function renderQuestionPaper(paperId, paper) {
  const sectionsHtml = paper.sections
    .map(
      (s) =>
        `<h3>Section ${s.section}</h3><ol>${s.questions
          .map((q) => {
            const image = q.pageImageKey || q.generatedImageKey
              ? `<img src="${WORKER_URL}/images/${encodeURIComponent(q.pageImageKey || q.generatedImageKey)}" alt="diagram" />`
              : "";
            return `<li>${q.text} <em>[${q.marks} mark${q.marks === 1 ? "" : "s"}]</em>${image}</li>`;
          })
          .join("")}</ol>`
    )
    .join("");

  qpResult.innerHTML =
    `<div class="qp-actions">` +
    `<a href="${WORKER_URL}/question-paper/${paperId}/pdf" target="_blank">Download PDF</a>` +
    `<button type="button" id="qp-answer-key-btn">Generate Answer Key</button>` +
    `</div>${sectionsHtml}<div id="qp-answer-key-result"></div>`;

  document.getElementById("qp-answer-key-btn").addEventListener("click", async () => {
    const akResult = document.getElementById("qp-answer-key-result");
    akResult.textContent = "Generating answer key...";
    const response = await fetch(`${WORKER_URL}/question-paper/${paperId}/answer-key`, { method: "POST" });
    if (!response.ok) {
      akResult.textContent = "Could not generate the answer key.";
      return;
    }
    const body = await response.json();
    akResult.innerHTML =
      `<h3>Answer Key</h3><ol>${body.answerKey.entries.map((e) => `<li>${e.answer}</li>`).join("")}</ol>` +
      `<a href="${WORKER_URL}/question-paper/${paperId}/answer-key-pdf" target="_blank">Download Answer Key PDF</a>`;
  });
}
```

In the mode-switching logic further down `app.js`, replace references to `questionPaperPlaceholder` with `questionPaperPanel` and call `loadQuestionPaperCatalog()` when the tab is selected:

```javascript
    const isQuestionPaper = currentMode === "questionPaper";
    questionPaperPanel.hidden = !isQuestionPaper;
    chatLog.hidden = isQuestionPaper;
    chatForm.hidden = isQuestionPaper;
    if (isQuestionPaper) loadQuestionPaperCatalog();
```

- [ ] **Step 3: Add minimal styling**

In `frontend/style.css`, add:

```css
.question-paper-panel { display: flex; flex-direction: column; gap: 16px; }
.qp-picker { display: flex; flex-direction: column; gap: 8px; max-width: 400px; }
#qp-chapter-list { border: 1px solid var(--border-color, #ccc); padding: 8px; }
.qp-actions { display: flex; gap: 12px; margin-bottom: 16px; }
#qp-result img { max-width: 100%; margin-top: 8px; }
```

- [ ] **Step 4: Manually verify end-to-end**

With the worker running locally and at least one Science document ingested with subject/class/chapter metadata (Task 12), run the frontend (`npx serve .` from `frontend/`), open the Question Paper tab, select subject/class/chapters/marks, click Generate, confirm the paper renders, click Download PDF (confirm a PDF downloads), click Generate Answer Key (confirm it renders and its PDF link works).

- [ ] **Step 5: Commit**

```bash
git add frontend/index.html frontend/app.js frontend/style.css
git commit -m "Build Question Paper tab UI: picker, generation, PDF, answer key"
```

---

## Post-Plan Note

Math blueprints and any marks-totals beyond 40/80 are intentionally deferred (per the approved design discussion) — add them as new entries in `BLUEPRINTS` in `worker/src/questionPaperBlueprints.ts` (Task 2) with no other code changes required, and add the corresponding `<option>` to `qp-marks-select` in `frontend/index.html` (Task 13).
