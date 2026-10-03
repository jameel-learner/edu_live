# Question Paper Generation — Design Spec

Date: 2026-10-03
Status: Approved for planning

## Purpose

Add a "Question Paper" feature where students or teachers request a question
paper (optionally an answer key) for one chapter, multiple chapters, or a
whole subject, for a given total marks (e.g. 40, 80, 100). Output should read
like a real CBSE/ICSE class 10 paper — correct section structure, marks
distribution, question types (MCQ, Assertion-Reason, short/long answer,
case-based) — and must support diagrams, tables, and formulas, since none of
the sample papers reviewed are text-only.

The overriding non-functional requirement is **cost**: this must be cheap
enough to offer to many students/teachers across India. Every design
decision below is chosen to minimize LLM calls, with caching eliminating
repeat cost entirely for common requests.

## Non-goals (this phase)

- Auto-grading / scoring a student's submitted answers against the key.
  (Noted as a clear candidate for a future, separate feature and spec.)
- Real internet search for content gap-filling (the LLM's own trained
  knowledge, constrained by a CBSE/ICSE-syllabus prompt, is used instead —
  `webSearch.ts` stays reserved for chat's existing fallback use case).
- Generating exam content purely from scratch with no template structure —
  structure is always blueprint-driven, never LLM-decided.

## Architecture Overview

A new pipeline parallel to `/chat` and `/ingest`, reusing existing
infrastructure rather than introducing new vendors or bindings:

- New worker routes:
  - `POST /question-paper/generate` — generates (or returns cached) a paper.
  - `POST /question-paper/:id/answer-key` — generates (or returns cached) the
    answer key for an existing paper.
  - `GET /question-paper/:id/pdf` and `GET /question-paper/:id/answer-key-pdf`
    — renders (or returns cached) a print-ready PDF.
  - `GET /question-paper/catalog` — public, lightweight listing of ingested
    documents' subject/class/chapter metadata for the picker UI (distinct
    from `/admin/documents`, which is admin-gated and returns more fields).
- Reuses: Vectorize (chunk storage/retrieval), Workers AI (embeddings,
  optional image-gen), OpenRouter via `generateChatCompletion()` (the single
  generation call), R2 (existing bucket — new `question-papers/` prefix),
  Browser Rendering (`BROWSER` binding, already used for page screenshots —
  reused here for HTML→PDF), `config.ts` pattern (new fields, D1-backed,
  editable from Settings tab, safe defaults).
- New frontend surface: the already-stubbed "Question Paper" tab in the
  chat frontend (`index.html`/`app.js`) — a picker (subject → class →
  chapter checklist) + marks-total dropdown + "Generate" button, rendering
  results with Markdown + KaTeX + inline images, plus "Download PDF",
  "Generate Answer Key", and "Regenerate" actions.

## Data Model

### R2 `edu-live-pdfs` — extended document metadata

Existing per-document `customMetadata` (set at `/ingest`, already carrying
`chunkCount`, `pageCount`, `indexedAt`, `enriched`) gains three new fields,
populated via new fields on the dashboard's upload form:

- `subject` (e.g. `"Science"`, `"Math"`)
- `class` (e.g. `"10"`)
- `chapter` (e.g. `"Carbon and its Compounds"`)

No new bucket or binding required.

### New D1 table `question_papers`

| column | type | purpose |
|---|---|---|
| `id` | TEXT (UUID) | primary key |
| `cache_key` | TEXT, unique index | hash of (sorted chapter doc filenames, subject, class, marks_total, blueprint_version) — the cache lookup key |
| `subject` | TEXT | for listing/filtering |
| `class` | TEXT | for listing/filtering |
| `marks_total` | INTEGER | for listing/filtering |
| `chapter_filenames` | TEXT (JSON array) | which ingested docs were used as source |
| `blueprint_version` | TEXT | which fixed template generated this paper (future template edits don't silently invalidate old cached papers) |
| `paper_json` | TEXT (JSON) | full structured paper: sections → questions → `{text, marks, type, latex?, table?, pageImageKey?, generatedImageKey?, imageSource?}` |
| `answer_key_json` | TEXT (JSON), nullable | populated lazily on first answer-key request |
| `pdf_r2_key` | TEXT, nullable | populated lazily on first PDF request |
| `answer_key_pdf_r2_key` | TEXT, nullable | populated lazily on first answer-key PDF request |
| `created_at` | TEXT | for admin visibility / cost auditing |

### New R2 prefix

- `question-papers/<id>.pdf`, `question-papers/<id>-key.pdf` — rendered PDFs.
- `question-papers/<id>/gen-<slot>.png` — any image-gen-fallback diagrams,
  cached so a cached paper never regenerates images.

### Migration

A new `worker/migrations/NNNN_question_papers.sql`, following the existing
migration pattern used for `transactions`/`config`.

## Blueprint Templates (deterministic structure layer)

A pure code module, `worker/src/questionPaperBlueprints.ts` — **no LLM
involvement**. Each blueprint is config data (not hardcoded branching logic),
keyed by `(subject, marksTotal)`, listing slots:
`{section, questionType, marks, count, wantsDiagram?: boolean}`.

Two reference blueprints are defined initially, modeled directly on the
sample papers reviewed during design:

- **Science, 40 marks** — Section A: 7× MCQ/Assertion-Reason (1 mark each);
  Section B: short answers (2–3 marks mixed); Section C: one reading/
  case-based passage (4 marks) + long answers (5 marks).
- **Science, 80 marks** — adds more sections, more MCQs, a diagram/numerical-
  heavy section, multiple case-based passages.

Additional blueprints (Math, other marks totals such as 20/25/30/50/60/100)
are added the same way — as new config entries — without touching
generation code. This keeps the system flexible for templates not yet
defined, per explicit requirement.

**Fallback for undefined totals**: scale the nearest template's slot
*counts* proportionally in code (still zero LLM calls).

**Multi-chapter requests**: slots are distributed across selected chapters
roughly proportional to each chapter's available chunk count — pure code,
no LLM call.

## Generation Flow

`POST /question-paper/generate` body: `{subject, class, chapterFilenames[],
marksTotal}`.

1. **Cache check**: compute `cache_key`; D1 lookup. Hit → return
   `paper_json` immediately. **0 LLM calls, 0 embedding calls.**
2. **Miss** → build blueprint (pure code) → for each selected chapter
   document, fetch its chunks by document-filter (not semantic similarity —
   question papers need full chapter coverage, not "most relevant to one
   question" like chat's retrieval). This is a straightforward
   metadata-keyed fetch, not a new embedding call.
3. **Single OpenRouter call** — one prompt containing: (a) the blueprint
   slot list; (b) pulled chunk text per chapter (sampled/truncated per
   chapter if large, to bound input tokens); (c) instructions to stay
   within CBSE/ICSE class-X syllabus conventions, filling thin-coverage
   slots from trained knowledge rather than inventing ungrounded facts;
   (d) a strict JSON schema to return — a questions array matching blueprint
   slots 1:1, each with `text`, `marks`, `type`, optional `latex`, optional
   `table`, optional `diagramNeeded: boolean` + `diagramDescription`.
4. **Diagram resolution** (code, no LLM) — for each `diagramNeeded: true`
   question, check whether any source chunk used for that question carries
   a `pageImageKey`; attach it if so (`imageSource: "ingested"`). Otherwise
   queue for the image-gen fallback.
5. **Persist** the row; return `paper_json`.

This bounds the cold path to **exactly 1 LLM call** regardless of paper
size, matching the existing pipeline's discipline (e.g. ingestion enrichment
is also one call per document, not per page).

## Diagrams, Tables, Formulas

- **Tables**: returned as Markdown (or a dedicated `table` field) in the
  question JSON; rendered by the frontend's existing Markdown table support.
  No extra calls.
- **Formulas/equations**: returned as a `latex` field, rendered with KaTeX.
  Chemistry structural formulas reuse the existing deterministic fallback
  logic (already shipped, commits 4091dae/01be7c4) rather than reinventing
  it.
- **Authentic diagrams**: resolved from `pageImageKey` as in generation-flow
  step 4; flagged `imageSource: "ingested"`.
- **Image-gen fallback**: fires only when `diagramNeeded: true` and no
  ingested page image matches. One Workers AI image-gen call per missing
  diagram, gated by a code-level **allowlist** (generic circuit schematics,
  generic graph axes, generic cell/plant outlines, generic geometric
  figures — content where visual accuracy isn't exam-critical) vs a
  **blocklist** that always skips generation (precise anatomical diagrams,
  exact molecular/structural geometry, anything not verifiable) — blocklisted
  slots fall back to a text placeholder: "(Refer to the diagram in your
  textbook)" rather than risk a confidently-wrong image. Generated images
  are flagged `imageSource: "generated"` and cached in R2 under
  `question-papers/<id>/gen-<slot>.png`, so repeats of a cached paper never
  regenerate. Config flag `questionPaperImageGenEnabled` is a kill-switch.
- **Cost bound**: image-gen only fires on cache-miss, only for allowlisted
  slots that actually need it — typically 0–3 extra calls per paper, never
  per-question.

## Answer Key + PDF Generation

**Answer key** (`POST /question-paper/:id/answer-key`):
- Cache check: if `answer_key_json` is already populated, return it — 0
  calls.
- Miss → **1 LLM call**, reusing the already-generated `paper_json`
  questions as input (no re-retrieval, no re-generation of questions) — the
  prompt asks only for model answers/marking points per question, styled
  concisely like the sample docs' "Answer" sections (mark-scheme-like, not
  essay-length). Persisted into the same row.

**PDF generation** (`GET /question-paper/:id/pdf`,
`/question-paper/:id/answer-key-pdf`):
- **Zero LLM calls** — pure rendering. `paper_json`/`answer_key_json` is
  converted to an HTML template and rendered to PDF via the existing
  `BROWSER` binding (already used in `pageScreenshot.ts` for page
  screenshots — same binding, new use, no new dependency). Result stored at
  `question-papers/<id>.pdf` (or `-key.pdf`), R2 key cached in the D1 row,
  served directly from R2 on repeat requests.

Answer key and PDF are both strictly **opt-in** actions, never bundled into
the base `/question-paper/generate` call — a user who only wants to read the
paper in-chat triggers neither.

## Config Additions (`config.ts`)

- `questionPaperModelSlug` (default: falls back to `llmModelSlug`) — lets a
  different model be chosen for structured-JSON paper generation without
  affecting chat.
- `questionPaperImageGenEnabled` (default: `true`) — kill-switch for the
  image-gen fallback.

Both D1-backed, editable from the dashboard's Settings tab, take effect on
next request — same pattern as all existing config fields.

## Admin Changes

- Dashboard's PDF upload card (`dashboard.js`) gains three fields: Subject,
  Class, Chapter — saved as R2 `customMetadata` on ingest.
- Document list in the Data Ingestion Dashboard can filter/group by these
  new fields.

## Frontend Changes

The already-stubbed Question Paper tab (`index.html`/`app.js`):

1. Subject → Class → Chapter(s) checklist, populated from
   `GET /question-paper/catalog`.
2. Marks-total dropdown, built from available blueprint keys (extensible as
   more blueprints are added).
3. "Generate" → `POST /question-paper/generate` → renders result (Markdown +
   KaTeX + inline images) in the tab.
4. Actions on the rendered paper: "Download PDF", "Generate Answer Key"
   (reveals the key inline with its own PDF download), "Regenerate"
   (bypasses cache — an explicit, visible choice to spend another LLM call).

## Failure Philosophy

Matching the existing per-stage contracts documented in `CLAUDE.md`:

- **Paper generation LLM call**: throws on failure (visible, not silently
  degraded) — same posture as chat's generation stage, since a
  cost/quality regression here should never be invisible.
- **Image-gen fallback**: fails open — skip to text placeholder, never
  blocks the rest of the paper.
- **PDF rendering**: fails open — "PDF generation failed, paper still
  available above," paper itself remains usable.
- **Answer-key generation**: throws on failure, same reasoning as paper
  generation (it's a second LLM-authored artifact, not a best-effort
  enrichment).

## Cost Profile Summary

| scenario | LLM calls | image-gen calls | notes |
|---|---|---|---|
| Repeat request (cache hit) | 0 | 0 | pure D1 read |
| New chapter/marks combo | 1 | 0–3 | generation call + optional diagram fallback |
| Answer key (first time) | 1 | 0 | reuses existing questions, no re-retrieval |
| Answer key (cached) | 0 | 0 | pure D1 read |
| PDF (any) | 0 | 0 | pure rendering via existing Browser binding |

This mirrors the ingestion pipeline's "validate/generate once, cache
forever" discipline, and ensures the common case — a popular chapter/marks
combination requested by many students across India — costs nothing after
the first generation.

## Open Items for Implementation Planning

- Exact JSON schema for `paper_json`/`answer_key_json` (to be nailed down
  in the implementation plan, including how OpenRouter structured-output /
  JSON mode is enforced and validated, with a repair/retry strategy if the
  model returns malformed JSON).
- Which Workers AI image-gen model to use, and how its output is validated
  before being shown as a "diagram" (minimal sanity check, e.g. non-empty
  image, matches requested dimensions).
- HTML/CSS template(s) for the PDF rendering layer (one for question paper,
  one for answer key), including pagination for long papers.
- Initial set of Math blueprints (only Science 40/80 are defined in this
  spec; Math and additional marks-totals are explicitly left as easy
  follow-on config additions, not blocking v1).
