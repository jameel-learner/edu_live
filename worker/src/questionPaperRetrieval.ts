import type { Env } from "./index";
import { chunkVectorId } from "./vectorId";

export interface ChapterChunks {
  filename: string;
  chunkCount: number;
  chunks: { chunkId: number; page: number; text: string; pageImageKey: string | null }[];
}

export const GET_BY_IDS_BATCH_SIZE = 20;

export async function fetchChapterChunks(env: Env, filename: string): Promise<ChapterChunks | null> {
  const head = await env.PDF_BUCKET.head(filename);
  const chunkCount = Number(head?.customMetadata?.chunkCount ?? 0);
  if (!head || chunkCount <= 0) return null;

  const ids = Array.from({ length: chunkCount }, (_, i) => chunkVectorId(filename, i));
  const idToChunkId = new Map(ids.map((id, i) => [id, i]));
  // Defensive batching: Vectorize may cap IDs per getByIds call (limit not
  // verifiable locally), so a large chapter is fetched in fixed-size batches.
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += GET_BY_IDS_BATCH_SIZE) {
    batches.push(ids.slice(i, i + GET_BY_IDS_BATCH_SIZE));
  }
  const vectors = (await Promise.all(batches.map((batch) => env.VECTORIZE.getByIds(batch)))).flat();

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
