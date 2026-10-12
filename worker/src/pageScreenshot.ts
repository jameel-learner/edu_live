import puppeteer, { type Browser } from "@cloudflare/puppeteer";
import type { Env } from "./index";

const MIN_PLAUSIBLE_SCREENSHOT_BYTES = 4000;

function base64FromArrayBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * Launches one Browser Rendering session to be reused across every figure
 * page in a single ingest (capturePageScreenshot opens/closes a page per
 * call, not a browser per call) - Browser Rendering caps launches per
 * minute more tightly than plain fetch concurrency, so launching once per
 * document instead of once per figure page matters for any multi-figure
 * PDF. Never throws: returns null on failure so ingestion can skip
 * screenshot capture entirely rather than fail.
 */
export async function launchScreenshotBrowser(env: Env): Promise<Browser | null> {
  try {
    return await puppeteer.launch(env.BROWSER);
  } catch (err) {
    console.error("browser rendering launch failed", err);
    return null;
  }
}

/**
 * Screenshots one page of a PDF on an already-launched browser, using
 * Cloudflare Browser Rendering - Chromium's built-in PDF viewer renders the
 * page (including any embedded image, even one nested inside a table cell)
 * exactly as laid out, so we never have to solve PDF rasterization
 * ourselves. Never throws: any failure (navigation timeout, screenshot
 * error) returns null, since a failed screenshot must not block ingestion -
 * the page's Markdown-enriched text (with its [Figure: ...] description) is
 * still indexed either way. Only the page is closed here, not the browser -
 * the caller (which launched it via launchScreenshotBrowser) owns closing
 * the browser once after all figure pages are done.
 */
export async function capturePageScreenshot(
  browser: Browser,
  pdfBytes: ArrayBuffer,
  pageNumber: number
): Promise<ArrayBuffer | null> {
  let page;
  try {
    page = await browser.newPage();
    // Puppeteer's default viewport (800x600) is small enough that Chromium's
    // PDF viewer UI chrome (toolbar, thumbnail sidebar) ends up taking a
    // large share of the captured frame alongside the actual page content -
    // confirmed in production: a captured screenshot showed the full browser
    // PDF-viewer app, not a clean page image. A larger viewport leaves more
    // room for the actual content relative to that chrome. Portrait (not
    // square) to roughly match a real page's own aspect ratio - a square
    // viewport at "page-fit" zoom still letterboxes with wasted margin on a
    // portrait page.
    await page.setViewport({ width: 1240, height: 1754 });
    // toolbar=0/navpanes=0/statusbar=0 hide Chromium's PDF viewer chrome -
    // without them the screenshot captures the browser's PDF-reader app, not
    // the page. zoom=page-fit is the critical one for legibility: without it,
    // the viewer's continuous-scroll view fills the tall viewport with page
    // content AND spills into the start of the next page below, so the
    // actual target page (and any diagram on it) only occupies a small
    // fraction of the captured frame - confirmed in production: a captured
    // diagram was technically present but unreadably small once scaled down
    // in the chat UI. page-fit scales the single target page to fill the
    // viewport instead, maximizing the diagram's actual pixel size.
    const dataUrl = `data:application/pdf;base64,${base64FromArrayBuffer(pdfBytes)}#page=${pageNumber}&zoom=page-fit&toolbar=0&navpanes=0&statusbar=0`;
    // networkidle0 (rather than the default "load") waits for the PDF
    // viewer's own rendering to settle before screenshotting - screenshotting
    // immediately on "load" can capture a blank or toolbar-only frame.
    await page.goto(dataUrl, { waitUntil: "networkidle0" });
    const screenshot = (await page.screenshot()) as Uint8Array;
    // A screenshot that's almost entirely one flat color - the known
    // Browser Rendering timing issue where a frame gets captured before the
    // PDF viewer finishes painting, leaving a blank or solid-black image -
    // compresses to a PNG far smaller than any page with real content.
    // Treat it as a failed capture rather than ship a known-blank image:
    // consistent with this function's existing fail-open contract (no image
    // is better than a broken one).
    if (screenshot.byteLength < MIN_PLAUSIBLE_SCREENSHOT_BYTES) {
      console.error(
        `page screenshot for page ${pageNumber} looks blank (${screenshot.byteLength} bytes) - discarding`
      );
      return null;
    }
    return screenshot as unknown as ArrayBuffer;
  } catch (err) {
    console.error(`page screenshot failed for page ${pageNumber}`, err);
    return null;
  } finally {
    await page?.close().catch(() => {});
  }
}
