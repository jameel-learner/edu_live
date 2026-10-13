#!/usr/bin/env node
// Manual regression eval harness - NOT part of the vitest suite, NOT run in
// CI, NOT triggered automatically by anything. Run it by hand before a risky
// change: a model swap, a prompt rewrite, a retrieval/reranking change, a
// swapped PDF/chunking library, etc. See CLAUDE.md / worker/evals/README.md
// (if present) for the full rationale.
//
// Usage:
//   node evals/run-evals.js [--model=SLUG] [--judge-model=SLUG] [--no-judge]
//                           [--feature-changed="what changed"] [--worker-url=URL]
//                           [--admin-key=KEY] [--out-dir=DIR]
//
// --model          Model slug to test generation with, overriding the live
//                   config for this run only (never touches production
//                   traffic/config). Defaults to the worker's configured
//                   evalModelSlug (Settings tab) if set, else errors.
// --judge-model     Model slug used to GRADE answers. Deliberately defaults
//                   to a different model than generation (see judgeModel
//                   below) to avoid a model grading its own homework.
// --no-judge        Skip the LLM judge entirely and use a cheap, literal
//                   substring check (case.cheapKeywords) instead. Zero extra
//                   LLM calls - use this for a quick sanity pass; the judge
//                   is the authoritative default because it checks meaning,
//                   not exact wording.
// --feature-changed Free-text label stored in the report, e.g.
//                   --feature-changed="switched chat model to X". Lets you
//                   grep report history for what caused a result to change.
// --worker-url      Defaults to the deployed production worker.
// --admin-key       Falls back to ADMIN_API_KEY from the environment or
//                   worker/.dev.vars.
// --out-dir         Defaults to evals/results/ (gitignored).

const fs = require("fs");
const path = require("path");

// A different vendor/family than the default generation model (OpenAI) and
// the default question-paper enrichment model, chosen for the same reason
// documented in llm.ts: a model shouldn't grade its own homework. Already
// proven reachable via OpenRouter elsewhere in this codebase (ingestion
// enrichment uses the same slug).
const JUDGE_MODEL_DEFAULT = "google/gemini-2.5-flash";
const DEFAULT_WORKER_URL = "https://edu-live-worker.naveed-ks.workers.dev";

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    const m = raw.match(/^--([a-zA-Z-]+)(?:=(.*))?$/);
    if (!m) continue;
    const key = m[1];
    args[key] = m[2] === undefined ? true : m[2];
  }
  return args;
}

// Reads KEY=VALUE lines from worker/.dev.vars for secrets not already in
// process.env - same convention wrangler itself uses for local dev.
function loadDevVars() {
  const varsPath = path.join(__dirname, "..", ".dev.vars");
  if (!fs.existsSync(varsPath)) return {};
  const out = {};
  for (const line of fs.readFileSync(varsPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

function parseLlmJsonLoose(raw) {
  const trimmed = raw.trim();
  const attempts = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) attempts.push(fenced[1]);
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) attempts.push(trimmed.slice(first, last + 1));
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch (_) {
      // try next candidate
    }
  }
  throw new Error(`judge returned unparseable JSON: ${raw.slice(0, 200)}`);
}

async function callOpenRouter(openrouterKey, model, system, user, maxTokens) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openrouterKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: maxTokens,
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter call failed (${response.status}): ${await response.text()}`);
  }
  const body = await response.json();
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter call returned no content");
  return content;
}

const JUDGE_SYSTEM_PROMPT =
  "You are grading a student-facing answer for factual correctness against a list of key facts. " +
  "Each key fact must be correctly conveyed IN MEANING - paraphrasing, reordering, different wording, or " +
  "extra correct detail all count as a pass. Only fail if a key fact is actually missing, contradicted, or " +
  "replaced with something factually wrong. Do not fail for missing elaboration, missing citations, " +
  "formatting differences, or brevity. Reply with ONLY a JSON object: " +
  '{"pass": boolean, "reason": "one short sentence"}.';

async function judge(openrouterKey, judgeModel, keyFacts, answerText) {
  const user =
    `Key facts the answer must correctly convey:\n${keyFacts.map((f) => `- ${f}`).join("\n")}\n\n` +
    `Actual answer:\n${answerText || "(empty)"}`;
  const raw = await callOpenRouter(openrouterKey, judgeModel, JUDGE_SYSTEM_PROMPT, user, 150);
  const parsed = parseLlmJsonLoose(raw);
  return { pass: parsed.pass === true, reason: typeof parsed.reason === "string" ? parsed.reason : "" };
}

function cheapCheck(keywords, text) {
  const haystack = (text || "").toLowerCase();
  const missing = (keywords || []).filter((kw) => !haystack.includes(kw.toLowerCase()));
  return { pass: missing.length === 0, reason: missing.length ? `missing: ${missing.join(", ")}` : "all keywords present" };
}

async function grade(mode, { keyFacts, cheapKeywords, answerText, openrouterKey, judgeModel }) {
  if (mode === "cheap") return cheapCheck(cheapKeywords, answerText);
  return judge(openrouterKey, judgeModel, keyFacts, answerText);
}

async function runChatCase(workerUrl, adminKey, modelOverride, testCase) {
  const response = await fetch(`${workerUrl}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(adminKey ? { "x-admin-key": adminKey } : {}) },
    body: JSON.stringify({
      question: testCase.question,
      answerStyle: "auto",
      ...(modelOverride ? { modelOverride } : {}),
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `/chat failed (${response.status})`);
  return { answerText: body.answer || "", raw: body };
}

async function runQuestionPaperCase(workerUrl, adminKey, modelOverride, testCase) {
  const genResponse = await fetch(`${workerUrl}/question-paper/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(adminKey ? { "x-admin-key": adminKey } : {}) },
    body: JSON.stringify({
      subject: testCase.subject,
      chapterFilenames: testCase.chapterFilenames,
      marksTotal: testCase.marksTotal,
      ...(modelOverride ? { modelOverride } : {}),
    }),
  });
  const genBody = await genResponse.json().catch(() => ({}));
  if (!genResponse.ok) throw new Error(genBody.error || `/question-paper/generate failed (${genResponse.status})`);

  const akResponse = await fetch(`${workerUrl}/question-paper/${encodeURIComponent(genBody.id)}/answer-key`, {
    method: "POST",
    headers: { ...(adminKey ? { "x-admin-key": adminKey } : {}) },
  });
  const akBody = await akResponse.json().catch(() => ({}));
  if (!akResponse.ok) throw new Error(akBody.error || `/answer-key failed (${akResponse.status})`);

  const paperText = JSON.stringify(genBody.paper);
  const answerKeyText = (akBody.answerKey?.entries || []).map((e) => e.answer).join("\n");
  return {
    marksTotal: genBody.paper?.marksTotal ?? 0,
    combinedText: `${paperText}\n\n${answerKeyText}`,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const devVars = loadDevVars();

  const workerUrl = (args["worker-url"] || DEFAULT_WORKER_URL).replace(/\/$/, "");
  const adminKey = args["admin-key"] || process.env.ADMIN_API_KEY || devVars.ADMIN_API_KEY || "";
  const openrouterKey = process.env.OPENROUTER_API_KEY || devVars.OPENROUTER_API_KEY || "";
  const judgeModel = args["judge-model"] || JUDGE_MODEL_DEFAULT;
  const gradeMode = args["no-judge"] ? "cheap" : "judge";
  const featureChanged = args["feature-changed"] || null;

  let modelOverride = typeof args.model === "string" ? args.model : null;
  if (!modelOverride && adminKey) {
    try {
      const cfgResponse = await fetch(`${workerUrl}/admin/config`, { headers: { "x-admin-key": adminKey } });
      const cfgBody = await cfgResponse.json().catch(() => ({}));
      if (cfgResponse.ok && cfgBody.config?.evalModelSlug) modelOverride = cfgBody.config.evalModelSlug;
    } catch (err) {
      console.warn(`Could not fetch evalModelSlug from /admin/config: ${err.message}`);
    }
  }
  if (!modelOverride) {
    console.error(
      "No model specified. Pass --model=<slug>, or set 'Eval model (slug)' in the dashboard's Settings > Evals card."
    );
    process.exit(1);
  }
  if (gradeMode === "judge" && !openrouterKey) {
    console.error("OPENROUTER_API_KEY not found (env or worker/.dev.vars) - needed for LLM-judge grading. Use --no-judge to skip it.");
    process.exit(1);
  }

  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, "golden-cases.json"), "utf8"));
  const results = [];

  console.log(`Running ${golden.cases.length} eval case(s) against ${workerUrl}`);
  console.log(`  model under test: ${modelOverride}`);
  console.log(`  grading: ${gradeMode === "judge" ? `LLM judge (${judgeModel})` : "cheap keyword fallback"}`);
  if (featureChanged) console.log(`  feature changed: ${featureChanged}`);
  console.log("");

  for (const testCase of golden.cases) {
    process.stdout.write(`  [${testCase.id}] `);
    try {
      if (testCase.mode === "chat") {
        const { answerText } = await runChatCase(workerUrl, adminKey, modelOverride, testCase);
        const verdict = await grade(gradeMode, {
          keyFacts: testCase.keyFacts,
          cheapKeywords: testCase.cheapKeywords,
          answerText,
          openrouterKey,
          judgeModel,
        });
        results.push({ id: testCase.id, mode: "chat", pass: verdict.pass, reason: verdict.reason, answerText });
        console.log(verdict.pass ? "PASS" : `FAIL - ${verdict.reason}`);
      } else if (testCase.mode === "questionPaper") {
        const { marksTotal, combinedText } = await runQuestionPaperCase(workerUrl, adminKey, modelOverride, testCase);
        const marksOk = marksTotal >= (testCase.minMarksTotal ?? testCase.marksTotal);
        if (!marksOk) {
          results.push({
            id: testCase.id,
            mode: "questionPaper",
            pass: false,
            reason: `generated only ${marksTotal}/${testCase.marksTotal} marks (minimum ${testCase.minMarksTotal})`,
          });
          console.log(`FAIL - under-generated (${marksTotal}/${testCase.marksTotal} marks)`);
          continue;
        }
        let allSubPass = true;
        const subResults = [];
        for (const fc of testCase.factChecks) {
          const verdict = await grade(gradeMode, {
            keyFacts: fc.keyFacts,
            cheapKeywords: fc.cheapKeywords,
            answerText: combinedText,
            openrouterKey,
            judgeModel,
          });
          subResults.push({ id: fc.id, pass: verdict.pass, reason: verdict.reason });
          if (!verdict.pass) allSubPass = false;
        }
        results.push({ id: testCase.id, mode: "questionPaper", pass: allSubPass, marksTotal, factChecks: subResults });
        console.log(
          allSubPass
            ? `PASS (${marksTotal} marks, ${subResults.length} fact checks)`
            : `FAIL - ${subResults.filter((r) => !r.pass).map((r) => r.id).join(", ")}`
        );
      }
    } catch (err) {
      results.push({ id: testCase.id, mode: testCase.mode, pass: false, reason: `error: ${err.message}` });
      console.log(`ERROR - ${err.message}`);
    }
  }

  const passCount = results.filter((r) => r.pass).length;
  console.log(`\n${passCount}/${results.length} passed`);

  const outDir = args["out-dir"] || path.join(__dirname, "results");
  fs.mkdirSync(outDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(outDir, `${timestamp}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        workerUrl,
        modelUnderTest: modelOverride,
        gradeMode,
        judgeModel: gradeMode === "judge" ? judgeModel : null,
        featureChanged,
        passCount,
        totalCount: results.length,
        results,
      },
      null,
      2
    )
  );
  console.log(`Report written to ${outPath}`);

  if (passCount < results.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
