import type { Env } from "./index";

// This route is public (no admin auth) so the frontend can load images
// directly as <img src>. Restricting it to known image prefixes (and
// requiring .png) stops it from being used to download the source PDFs or
// the rendered question-paper PDFs stored in the same bucket. Allowed:
//  - page-images/<filename>/<page>.png   (ingest-time page screenshots)
//  - question-papers/<id>/gen-<slot>.png (question-paper image-gen diagrams)
export function isServableImageKey(key: string): boolean {
  if (key.includes("..") || !key.endsWith(".png")) return false;
  if (key.startsWith("page-images/")) return true;
  return key.startsWith("question-papers/") && key.includes("/gen-");
}

export async function handleGetImage(key: string, env: Env): Promise<Response> {
  if (!isServableImageKey(key)) {
    return new Response("Not found", { status: 404 });
  }
  const object = await env.PDF_BUCKET.get(key);
  if (!object) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(await object.arrayBuffer(), {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable" },
  });
}
