/**
 * One-off probe: does Stagehand v3's `Locator.setInputFiles({ buffer })`
 * payload-injection variant actually work on a remote Steel session?
 *
 * We need to know this before designing the full upload primitive in
 * recon-browser.ts. The Stagehand type docs say buffer-based upload exists
 * for remote browsers (Browserbase, Steel) — but "documented" and "works on
 * our specific Steel + CDP transport" are different things.
 *
 * Target: https://the-internet.herokuapp.com/upload — a public, well-known
 * test page with a single `<input type="file" id="file-upload">` and a
 * "File Uploaded!" success page that says the filename back.
 *
 * Pass criteria: after setInputFiles + clicking submit, the URL changes to
 * /upload (sic — the success page is at the same path) and the body contains
 * the filename we passed.
 *
 * Throwaway. Delete after we know the answer.
 */

import { getScriptLogger } from "@/lib/logging";
import { createBrowserSession } from "@/scraper/session";

const logger = getScriptLogger("probe-setinputfiles");

const TARGET_URL = "https://the-internet.herokuapp.com/upload";
const FILE_INPUT_SELECTOR = "css=#file-upload";
const SUBMIT_SELECTOR = "css=#file-submit";

async function main(): Promise<void> {
  logger.info(`probe-setinputfiles: target=${TARGET_URL}`);

  // Make a tiny PDF-shaped buffer. Doesn't have to be a real PDF — the test
  // page just echoes the name. A minimal valid PDF would be ~200 bytes;
  // the test page accepts anything.
  const fileBuffer = Buffer.from("%PDF-1.4\n%probe\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n", "utf8");
  const fileName = "probe-resume.pdf";

  const session = await createBrowserSession();
  logger.info(`probe using provider=${session.provider} sessionId=${session.sessionId}`);
  try {
    const stagehand = session.stagehand;
    const page = await stagehand.context.awaitActivePage();

    logger.info(`navigating to ${TARGET_URL}`);
    await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeoutMs: 60_000 });

    const preUrl = page.url();
    const preTitle = await page.title().catch(() => "");
    logger.info(`pre-upload state: url=${preUrl} title=${JSON.stringify(preTitle)}`);

    const fileInput = page.locator(FILE_INPUT_SELECTOR).first();
    const inputCount = await page.locator(FILE_INPUT_SELECTOR).count().catch(() => -1);
    logger.info(`file input locator count=${inputCount}`);
    if (inputCount === 0) {
      throw new Error(`file input ${FILE_INPUT_SELECTOR} not found on ${TARGET_URL}`);
    }

    logger.info(`calling setInputFiles with buffer payload (name=${fileName}, size=${fileBuffer.length}b)`);
    await fileInput.setInputFiles({ name: fileName, mimeType: "application/pdf", buffer: fileBuffer });
    logger.info("setInputFiles resolved without throwing");

    // Read the input's files[].length from the page itself to prove the file
    // was actually attached, not just that the API returned cleanly.
    const filesLength = await page.evaluate(
      `(() => { const el = document.querySelector('#file-upload'); return el && el.files ? el.files.length : -1; })()`
    );
    logger.info(`post-setInputFiles: input.files.length=${JSON.stringify(filesLength)}`);

    if (filesLength !== 1) {
      throw new Error(`file did not attach: input.files.length=${JSON.stringify(filesLength)}`);
    }

    logger.info("clicking submit");
    await page.locator(SUBMIT_SELECTOR).first().click();
    await page.waitForTimeout(2_000);

    const postUrl = page.url();
    const postTitle = await page.title().catch(() => "");
    const bodyText = await page.evaluate(`(() => document.body ? document.body.innerText : '')()`);
    const bodyExcerpt = typeof bodyText === "string" ? bodyText.slice(0, 500) : "(non-string)";

    logger.info(`post-submit state: url=${postUrl} title=${JSON.stringify(postTitle)}`);
    logger.info(`body excerpt: ${JSON.stringify(bodyExcerpt)}`);

    const success = typeof bodyText === "string" && bodyText.includes(fileName);
    logger.info(`PROBE VERDICT: ${success ? "PASS" : "FAIL"} (filename in body=${success})`);
  } finally {
    await session.close();
  }
}

main().catch((err: unknown) => {
  logger.error(`probe-setinputfiles failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
