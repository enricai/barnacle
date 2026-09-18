import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Bottleneck from "bottleneck";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
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

const ITEM_COUNT = 20;
const FAILING_ITEM_IDS = new Set(["cruise-5", "cruise-13"]);
const HTML_404_BODY = "<html>Not Found</html>";

const itemIds = Array.from({ length: ITEM_COUNT }, (_, i) => `cruise-${i}`);
const PRICE_FOR = (itemId: string): number => 100 + Number(itemId.split("-").pop());

/**
 * Same paginated-listing drill shape as the individual item-3 and item-2
 * regression tests, but at the doc's actually-reported failure rate: two of
 * twenty items (10%, in the reported 0.2-2%-of-many-ids ballpark once scaled
 * down for test speed) return a non-JSON HTML 4xx while the rest succeed.
 * Proves the classify-before-parse fix and the Promise.allSettled per-item
 * isolation fix compose — neither one alone is exercised at this shape
 * anywhere else.
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
 * resolves 200/JSON EXCEPT the two `FAILING_ITEM_IDS`, which deterministically
 * return a 404 with an HTML (non-JSON) body — the shape a target's error page
 * actually sends, not a JSON error envelope.
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
    if (FAILING_ITEM_IDS.has(id)) {
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

describe("recon-generate — paginated-listing item drill: mixed non-JSON 4xx failures among many parallel items", () => {
  it("merges all successful items' data and cleanly excludes the non-JSON-4xx items, never failing the whole batch", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-paged-drill-mixed-4xx-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, buildPagedListingDrillCaptures());

    const siteId = `paged-drill-mixed-4xx-e2e-test-${process.pid}`;
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

    stubPagedListingDrillFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    return executeHttp({ BaseUrl: BASE_URL, id: itemIds[0] }).then((result) => {
      const data = result.data as { cruises?: Array<Record<string, unknown>> };
      expect(data.cruises).toHaveLength(ITEM_COUNT);

      const byId = new Map((data.cruises ?? []).map((item) => [item.id as string, item]));
      let successCount = 0;
      for (const id of itemIds) {
        if (FAILING_ITEM_IDS.has(id)) {
          expect(byId.get(id)).toEqual({ id });
          continue;
        }
        expect(byId.get(id)).toEqual({ id, amount: PRICE_FOR(id) });
        successCount++;
      }
      expect(successCount).toBe(ITEM_COUNT - FAILING_ITEM_IDS.size);
    });
  }, 30_000);
});
