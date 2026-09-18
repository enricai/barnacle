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

const ITEM_COUNT = 10;
const FAILING_ITEM_ID = "cruise-5";
// Long enough that a genuinely sequential loop could never observe more than
// one pricing fetch in flight at once inside its window, short enough to
// keep the test fast.
const CALL_LATENCY_MS = 20;

const itemIds = Array.from({ length: ITEM_COUNT }, (_, i) => `cruise-${i}`);
const PRICE_FOR = (itemId: string): number => 100 + Number(itemId.split("-").pop());

/**
 * A REST paginated listing (`page` in the request body, distinct from a
 * single-shot search) whose per-item pricing drill is keyed off each item's
 * own id from that listing page — the shape reported as under-detected by
 * the fold emitter's item-scoped-fetch signal: a drill hanging off a
 * PAGINATED list's item id, rather than a single-shot search's item id (the
 * shape {@link buildMulticallSingleShotSearchDrillDownActionSteps}-style
 * fixtures already cover). The listing carries a `page` request-body field
 * — the paginated-listing signal, structurally distinct from a single-shot
 * search's bare body — so the primary's own shape, not just the site's real
 * page count, is what makes this a paginated-list drill rather than a
 * single-shot one. Two distinct drill captures (different item ids) let the
 * generator's join-key detection resolve the pricing id as item-scoped
 * rather than freezing it as a literal. 10 primary items is enough for a
 * timing-based assertion to distinguish concurrent per-item drill fetches
 * from sequential ones.
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
 * takes `CALL_LATENCY_MS` to resolve (so overlap between calls is
 * observable), and `FAILING_ITEM_ID`'s own pricing call 403s (a
 * non-retryable bot-challenge abort in `createHttpClient`) instead of
 * resolving — proving one item's rejected fetch doesn't prevent the other
 * items' fetches from completing and merging. `maxInFlight` is filled in
 * with the highest number of pricing calls ever outstanding at once.
 */
function stubPagedListingDrillFetch(maxInFlight: { value: number }): void {
  let inFlight = 0;
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
    inFlight++;
    maxInFlight.value = Math.max(maxInFlight.value, inFlight);
    return new Promise((resolve) => {
      setTimeout(() => {
        inFlight--;
        if (id === FAILING_ITEM_ID) {
          resolve({
            status: 403,
            ok: false,
            text: vi.fn().mockResolvedValue(JSON.stringify({ error: "forbidden" })),
            headers: new Headers(),
          });
          return;
        }
        resolve({
          status: 200,
          ok: true,
          text: vi
            .fn()
            .mockResolvedValue(JSON.stringify({ prices: [{ id, amount: PRICE_FOR(id) }] })),
          headers: new Headers(),
        });
      }, CALL_LATENCY_MS);
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
});

describe("recon-generate — paginated-listing item drill: parallel dispatch with per-item failure isolation", () => {
  it("emits a Promise.allSettled-based per-item drill loop, issues every item's fetch concurrently, and folds every non-failing item's data even though one item's fetch rejects", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-paged-drill-parallel-isolation-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, buildPagedListingDrillCaptures());

    const siteId = `paged-drill-parallel-isolation-e2e-test-${process.pid}`;
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

    // The emitted per-item drill loop issues its fetches through
    // Promise.allSettled — not a bare `for (const item of foldItems) { await
    // ... }` with no isolation — even though the primary is a paginated
    // listing (a prior page's item id), not a single-shot search.
    expect(contract).toContain("Promise.allSettled(");
    expect(contract).toMatch(/foldItems\)\.map\(async \(item\) => \{/);

    const body = extractExecuteHttpBodyFromContract(contract);
    const limiter = new Bottleneck({ maxConcurrent: ITEM_COUNT, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    const maxInFlight = { value: 0 };
    stubPagedListingDrillFetch(maxInFlight);

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    return executeHttp({ BaseUrl: BASE_URL, id: itemIds[0] }).then((result) => {
      const data = result.data as { cruises?: Array<Record<string, unknown>> };
      expect(data.cruises).toHaveLength(ITEM_COUNT);

      const byId = new Map((data.cruises ?? []).map((item) => [item.id as string, item]));
      for (const id of itemIds) {
        if (id === FAILING_ITEM_ID) {
          // The failing item is neither omitted nor able to abort the
          // batch — it just never receives the merged pricing data.
          expect(byId.get(id)).toEqual({ id });
          continue;
        }
        expect(byId.get(id)).toEqual({ id, amount: PRICE_FOR(id) });
      }

      // Call-order/timing evidence that the per-item drill fetches actually
      // ran concurrently, not one at a time: a sequential loop could never
      // have more than one pricing call outstanding within CALL_LATENCY_MS.
      expect(maxInFlight.value).toBeGreaterThan(1);
    });
  }, 30_000);
});
