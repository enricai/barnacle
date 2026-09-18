import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Bottleneck from "bottleneck";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { HttpClientError, UnknownScraperError } from "@/scraper/errors";
import { createHttpClient } from "@/scraper/http-client";
import {
  evalExecuteHttpBody,
  extractExecuteHttpBodyFromContract,
} from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const LISTING_URL = "https://api.example.com/catalog-listing-api/listing/";
const PRICING_URL = "https://api.example.com/catalog-listing-api/pricing/";
const BASE_URL = "https://api.example.com";

const ITEM_COUNT = 10;
const FAILING_ITEM_ID = "cruise-5";
const HTML_404_BODY = "<html>Not Found</html>";

const itemIds = Array.from({ length: ITEM_COUNT }, (_, i) => `cruise-${i}`);
const PRICE_FOR = (itemId: string): number => 100 + Number(itemId.split("-").pop());

/**
 * Same paginated-listing drill shape as
 * recon-generate-drill-item-parallel-isolation-e2e.test.ts — reusing it here
 * proves the per-item isolation from that fix and the 4xx classification
 * this test pins compose: one item's non-JSON 4xx must classify correctly
 * WITHOUT taking any sibling item down or throwing a JSON-parse exception
 * first.
 */
function buildPagedListingDrillCaptures(): Capture[] {
  return [
    buildCapture({
      url: LISTING_URL,
      requestPostData: '{"page":1}',
      responseBody: { totalPages: 1, cruises: itemIds.map((id) => ({ id })) },
      timestamp: "2024-09-01T00:00:00Z",
    }),
    buildCapture({
      url: PRICING_URL,
      requestPostData: `{"id":"${itemIds[0]}"}`,
      responseBody: { prices: [{ id: itemIds[0], amount: PRICE_FOR(itemIds[0]!) }] },
      timestamp: "2024-09-01T00:00:02Z",
    }),
    buildCapture({
      url: PRICING_URL,
      requestPostData: `{"id":"${itemIds[1]}"}`,
      responseBody: { prices: [{ id: itemIds[1], amount: PRICE_FOR(itemIds[1]!) }] },
      timestamp: "2024-09-01T00:00:03Z",
    }),
  ];
}

function writeRunDir(root: string, captures: Capture[]): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));
  captures.forEach((capture, index) => {
    writeFileSync(
      join(root, "graphql", `${String(index).padStart(3, "0")}-capture.json`),
      JSON.stringify(capture)
    );
  });
}

/**
 * Stubs `fetch`: the listing call resolves immediately, every pricing call
 * resolves 200/JSON EXCEPT `FAILING_ITEM_ID`'s, which returns a 404 with an
 * HTML (non-JSON) body — the shape a target's error page actually sends, not
 * a JSON error envelope. Proves the emitted drill's own fetch/parse checks
 * status before ever calling `JSON.parse` on the body.
 */
function stubPagedListingDrillFetch(): void {
  const fn = vi.fn().mockImplementation((_url: string, init?: { body?: string }) => {
    const requestBody = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    if (requestBody && typeof requestBody.page === "number") {
      return Promise.resolve({
        status: 200,
        ok: true,
        text: vi
          .fn()
          .mockResolvedValue(
            JSON.stringify({ totalPages: 1, cruises: itemIds.map((id) => ({ id })) })
          ),
        headers: new Headers(),
      });
    }
    const id = requestBody?.id as string;
    if (id === FAILING_ITEM_ID) {
      return Promise.resolve({
        status: 404,
        ok: false,
        text: vi.fn().mockResolvedValue(HTML_404_BODY),
        headers: new Headers(),
      });
    }
    return Promise.resolve({
      status: 200,
      ok: true,
      text: vi.fn().mockResolvedValue(JSON.stringify({ prices: [{ id, amount: PRICE_FOR(id) }] })),
      headers: new Headers(),
    });
  });
  vi.stubGlobal("fetch", fn);
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("recon-generate — paginated-listing item drill: 4xx HTML body classifies before JSON parsing", () => {
  it("classifies a 404 HTML-body drill response as a non-retryable HttpClientError, never a SyntaxError or UnknownScraperError, while sibling items still resolve", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-paged-drill-4xx-html-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, buildPagedListingDrillCaptures());

    const siteId = `paged-drill-4xx-html-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "browse paged cruise listing" },
          { step: "drill into cruise pricing", submitStep: true },
        ],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    const body = extractExecuteHttpBodyFromContract(contract);
    const limiter = new Bottleneck({ maxConcurrent: ITEM_COUNT, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    // The emitted per-item drill loop discards Promise.allSettled's own
    // settled-results array (it only needs the side-effect merge onto each
    // item), so this spy is the only way to observe the FAILING_ITEM_ID
    // promise's actual rejection reason from outside.
    const realAllSettled = Promise.allSettled.bind(Promise);
    const capturedSettlements: PromiseSettledResult<unknown>[][] = [];
    vi.spyOn(Promise, "allSettled").mockImplementation(async (promises) => {
      const settled = await realAllSettled(promises as Iterable<PromiseLike<unknown>>);
      capturedSettlements.push(settled);
      return settled;
    });

    stubPagedListingDrillFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    return executeHttp({ BaseUrl: BASE_URL, id: itemIds[0] }).then((result) => {
      const data = result.data as { cruises?: Array<Record<string, unknown>> };
      expect(data.cruises).toHaveLength(ITEM_COUNT);

      const byId = new Map((data.cruises ?? []).map((item) => [item.id as string, item]));
      for (const id of itemIds) {
        if (id === FAILING_ITEM_ID) {
          expect(byId.get(id)).toEqual({ id });
          continue;
        }
        expect(byId.get(id)).toEqual({ id, amount: PRICE_FOR(id) });
      }

      expect(capturedSettlements.length).toBeGreaterThan(0);
      const settlements = capturedSettlements[0]!;
      const failingIndex = itemIds.indexOf(FAILING_ITEM_ID);
      const failingSettlement = settlements[failingIndex]!;
      expect(failingSettlement.status).toBe("rejected");
      const reason = (failingSettlement as PromiseRejectedResult).reason;

      // The classified 4xx — not a generic transient failure and, above
      // all, not a JSON.parse SyntaxError thrown before status was ever
      // checked.
      expect(reason).toBeInstanceOf(HttpClientError);
      expect((reason as HttpClientError).status).toBe(404);
      expect(reason).not.toBeInstanceOf(UnknownScraperError);
      expect(reason).not.toBeInstanceOf(SyntaxError);

      for (const [index, id] of itemIds.entries()) {
        if (id === FAILING_ITEM_ID) continue;
        expect(settlements[index]!.status).toBe("fulfilled");
      }
    });
  }, 30_000);
});
