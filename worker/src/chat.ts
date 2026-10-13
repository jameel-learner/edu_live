import type { Env } from "./index";
import { checkQueryInScopeAndAgeAppropriate } from "./guardrailCheck";
import { rerank, workersAiScoreFn, type RetrievedChunk } from "./rerank";
import { scoreChunksWithJev, filterJevScored, JEV_MODEL_ID, type JevScoredChunk } from "./jev";
import { webSearch, formatWebResultsAsContext } from "./webSearch";
import { buildTransactionTrace, type TransactionTrace } from "./transactionTrace";
import { getRuntimeConfig } from "./config";
import { generateChatCompletion } from "./llm";
import { isAdminAuthorized } from "./admin";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const HARD_FAIL_MESSAGE =
  "I don't have enough information in the indexed documents (or the web) to answer that question.";

const SYSTEM_PROMPT = `You are a helpful research assistant and teacher for 16-17 year old students.

Audience and scope:
- Only help with science and maths topics. If a question is outside that scope, politely decline.
- Keep language and content age-appropriate.

Policy:
- Answer only from the context provided below (documents and/or web results).
- Stay as close as possible to the wording of the source material - prefer quoting or closely
  paraphrasing the provided document context over rephrasing in your own words. The uploaded notes
  are carefully prepared study material; do not dilute or rewrite their content, and do not add
  facts, examples, or explanations that are not present in the context, even if you know them to be
  true from general knowledge.
- If the context doesn't answer the question, say so clearly instead of guessing.
- Name the source document (with page number) or web page you used.
- Keep answers concise unless the question needs detail.
- If the context contains a '[Figure: ...]' marker (a description of a diagram, structural formula, or
  image from the source material), do not try to redraw, reproduce, or transcribe that figure as text or
  ASCII art - a real image of that page is shown to the student separately. Refer to it in prose using
  its description instead.
- The context may contain mathematical or chemical formulas written in LaTeX, delimited with $...$
  (inline) or $$...$$ (block) - e.g. $C_nH_{2n+2}$. Reproduce these formulas exactly as they appear in
  the context, delimiters included - the student's app renders this LaTeX as typeset notation, so never
  strip the $ delimiters, rewrite them in plain text, or drop the underscores/braces.`;

export type AnswerStyle = "auto" | "short" | "detailed";

const ANSWER_STYLE_INSTRUCTIONS: Record<AnswerStyle, string> = {
  auto: "",
  short: "\n\nAnswer style: Answer in exactly 1-2 sentences, examiner-style. No elaboration or extra examples.",
  detailed:
    "\n\nAnswer style: Answer in 5-10 sentences, structured with a brief explanation and an example where useful. " +
    "Treat 5-10 sentences as a ceiling, not a requirement - if the retrieved context is too limited to honestly " +
    "support that much detail, say so and give the fullest answer the context actually supports, without adding " +
    "information beyond it.",
};

// Hard backstop on generation length per style - the system prompt instruction
// does the real steering, this just prevents a runaway "detailed" answer or
// catches the rare case where the model ignores a "short" instruction.
const ANSWER_STYLE_MAX_TOKENS: Record<AnswerStyle, number> = {
  auto: 512,
  short: 100,
  detailed: 500,
};

function parseAnswerStyle(value: unknown): AnswerStyle {
  return value === "short" || value === "detailed" ? value : "auto";
}

async function recordTransaction(env: Env, trace: TransactionTrace): Promise<void> {
  try {
    await env.EDU_LIVE_DB.prepare(
      `INSERT INTO transactions
        (timestamp, question, provider, model, path_taken, confidence, retrieval_json,
         llm_input, llm_output, jev_input_json, jev_output_json, input_tokens, output_tokens,
         jev_cost_usd, llm_cost_usd, jev_model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        trace.timestamp,
        trace.question,
        trace.provider,
        trace.model,
        trace.pathTaken,
        trace.confidence,
        JSON.stringify(trace.retrieval),
        trace.llmInput,
        trace.llmOutput,
        trace.jevInput ? JSON.stringify(trace.jevInput) : null,
        trace.jevOutput ? JSON.stringify(trace.jevOutput) : null,
        trace.inputTokens,
        trace.outputTokens,
        trace.jevCostUsd,
        trace.llmCostUsd,
        trace.jevModel
      )
      .run();
  } catch (err) {
    console.error("failed to record transaction trace", err);
  }
}

export async function handleChat(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    question?: string;
    answerStyle?: string;
    modelOverride?: string;
  } | null;
  const question = body?.question?.trim();
  const answerStyle = parseAnswerStyle(body?.answerStyle);

  if (!question) {
    return Response.json({ error: "Expected JSON body with a 'question' field" }, { status: 400 });
  }

  const config = await getRuntimeConfig(env);
  // modelOverride exists for the manual eval harness (worker/evals/) to test
  // a candidate model without touching the live config that real traffic
  // uses - gated behind the same admin key as /admin/*, so an ordinary
  // student request can never set it.
  const modelOverride =
    typeof body?.modelOverride === "string" && body.modelOverride.trim() && isAdminAuthorized(request, env)
      ? body.modelOverride.trim()
      : null;
  const generationConfig = modelOverride ? { ...config, llmModelSlug: modelOverride } : config;

  if (config.guardrailEnabled) {
    const decision = await checkQueryInScopeAndAgeAppropriate(question, env.AI);
    if (!decision.allowed) {
      const status = decision.reason === "guardrail_error" ? 503 : 200;
      return Response.json(
        { answer: decision.refusalMessage, reason: decision.reason, docSources: [], webSources: [] },
        { status }
      );
    }
  }

  try {
    const embedResponse = await env.AI.run(EMBEDDING_MODEL, { text: [question] });
    const questionVector = (embedResponse as { data: number[][] }).data[0];

    const matches = await env.VECTORIZE.query(questionVector, { topK: config.topK, returnMetadata: true });
    const retrieved: RetrievedChunk[] = matches.matches.map((m) => ({
      text: String(m.metadata?.text ?? ""),
      page: Number(m.metadata?.page ?? 0),
      pageEnd: Number(m.metadata?.pageEnd ?? 0),
      source: String(m.metadata?.source ?? ""),
      chunkId: Number(m.metadata?.chunkId ?? 0),
      cosineScore: m.score,
      pageImageKey: m.metadata?.pageImageKey ? String(m.metadata.pageImageKey) : null,
    }));

    const reranked = await rerank(question, retrieved, workersAiScoreFn(env.AI));

    const jevEnabled = config.jevEnabled;
    const jevResult = jevEnabled
      ? await scoreChunksWithJev(question, reranked, env.OPENROUTER_API_KEY)
      : {
          chunks: reranked.map((c) => ({ ...c, jevRelevance: null, jevBlocked: false }) as JevScoredChunk),
          costUsd: 0,
          success: true,
        };

    // Only filter by relevance when JEV actually ran and produced real
    // scores. If JEV failed, jevResult.chunks all carry jevRelevance=null -
    // filtering on that would discard every chunk, which is worse than not
    // running JEV at all.
    const jevDocSources =
      jevEnabled && jevResult.success
        ? filterJevScored(jevResult.chunks, config.jevRelevanceThreshold)
        : jevResult.chunks;

    // Confidence gate: even a JEV-kept chunk can be too weak a match to
    // trust. The reranker's score scale is not guaranteed to be
    // non-negative (it may return raw cross-encoder logits), so a
    // threshold of 0 (the default) skips the gate entirely rather than
    // comparing with >= - that guarantees the default never changes
    // existing behavior regardless of the underlying score range.
    const topConfidence = jevDocSources[0] ? jevDocSources[0].rerankScore ?? jevDocSources[0].cosineScore : null;
    const passesConfidenceGate =
      config.confidenceThreshold <= 0 || topConfidence === null || topConfidence >= config.confidenceThreshold;
    const docSources = passesConfidenceGate ? jevDocSources : [];
    // keptKeys drives the dashboard's kept/discarded status per chunk - it
    // must reflect what actually survived ALL gates (JEV + confidence), or
    // a chunk the confidence gate just dropped would still show as "kept".
    const keptKeys = new Set(docSources.map((c) => `${c.source}::${c.chunkId}`));

    let webSources: Awaited<ReturnType<typeof webSearch>> = [];
    if (docSources.length === 0 && config.webSearchMode !== "rag_only") {
      webSources = await webSearch(question);
    }

    const documentContext = docSources.map((c) => `[${c.source} p.${c.page}]\n${c.text}`).join("\n\n");
    const webContext = webSources.length > 0 ? formatWebResultsAsContext(webSources) : "";
    const context = [documentContext, webContext].filter(Boolean).join("\n\n---\n\n") || "No context found.";
    const llmInput = `Question: ${question}\n\nContext:\n${context}`;

    const jevModel = jevEnabled ? JEV_MODEL_ID : null;

    let answer: string;
    let llmProvider: string = generationConfig.llmProvider;
    let llmModel: string = generationConfig.llmModelSlug;
    let llmInputTokens: number | null = null;
    let llmOutputTokens: number | null = null;
    let llmCostUsd = 0;
    if (config.hardFailNoDocument && docSources.length === 0 && webSources.length === 0) {
      answer = HARD_FAIL_MESSAGE;
    } else {
      const generateResult = await generateChatCompletion(
        [
          { role: "system", content: SYSTEM_PROMPT + ANSWER_STYLE_INSTRUCTIONS[answerStyle] },
          { role: "user", content: llmInput },
        ],
        ANSWER_STYLE_MAX_TOKENS[answerStyle],
        env,
        generationConfig
      );
      answer = generateResult.text;
      llmProvider = generateResult.provider;
      llmModel = generateResult.model;
      llmInputTokens = generateResult.inputTokens ?? null;
      llmOutputTokens = generateResult.outputTokens ?? null;
      llmCostUsd = generateResult.costUsd ?? 0;
    }

    const trace = buildTransactionTrace({
      question,
      provider: llmProvider,
      model: llmModel,
      pathTaken: webSources.length > 0 ? "web_fallback" : "pdf_only",
      jevAnnotated: jevResult.chunks,
      keptKeys,
      llmInput,
      llmOutput: answer,
      jevEnabled,
      jevModel,
      jevCostUsd: jevResult.costUsd,
      inputTokens: llmInputTokens,
      outputTokens: llmOutputTokens,
      llmCostUsd,
    });
    ctx.waitUntil(recordTransaction(env, trace));

    return Response.json({
      answer,
      docSources: docSources.map((c) => ({
        source: c.source,
        page: c.page,
        pageEnd: c.pageEnd,
        text: c.text,
        pageImageKey: c.pageImageKey,
      })),
      webSources,
    });
  } catch (err) {
    console.error("chat pipeline failed", err);
    return Response.json(
      { error: "Something went wrong answering this question - please try again." },
      { status: 502 }
    );
  }
}
