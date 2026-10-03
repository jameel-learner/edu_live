import { describe, it, expect, vi } from "vitest";
import { fetchChapterChunks, fetchAllChapterChunks, GET_BY_IDS_BATCH_SIZE } from "../src/questionPaperRetrieval";
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

describe("fetchChapterChunks batching", () => {
  it("splits getByIds into batches of at most GET_BY_IDS_BATCH_SIZE and concatenates results in chunk order", async () => {
    const chunkCount = 45;
    const getByIds = vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, metadata: { page: 1, text: `t-${id}` } }))
    );
    const env = {
      PDF_BUCKET: { head: vi.fn().mockResolvedValue({ customMetadata: { chunkCount: String(chunkCount) } }) },
      VECTORIZE: { getByIds },
    } as unknown as Env;

    const result = await fetchChapterChunks(env, "big.pdf");

    expect(getByIds).toHaveBeenCalledTimes(Math.ceil(chunkCount / GET_BY_IDS_BATCH_SIZE));
    for (const call of getByIds.mock.calls) {
      expect(call[0].length).toBeLessThanOrEqual(GET_BY_IDS_BATCH_SIZE);
    }
    expect(getByIds.mock.calls.flatMap((c) => c[0])).toEqual(
      Array.from({ length: chunkCount }, (_, i) => chunkVectorId("big.pdf", i))
    );
    expect(result!.chunks.map((c) => c.chunkId)).toEqual(Array.from({ length: chunkCount }, (_, i) => i));
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
