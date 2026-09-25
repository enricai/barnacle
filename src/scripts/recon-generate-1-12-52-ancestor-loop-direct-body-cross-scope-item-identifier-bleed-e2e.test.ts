import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * Regression coverage for a defect shape distinct from every currently-landed
 * fold-hoist test: a `g0`-scoped ancestor loop that owns TWO of its own
 * DIRECT request bodies — plain fetch calls, never wrapped in a fold-hoisted
 * chain — each reading a field reached only by drilling into the ancestor's
 * own nested object (analogous to a real report's `minimumPriceSummary.
 * currency`), with no `item` sub-loop of its own supplying either call's
 * binding. This must coexist, in one generated flow, with a wholly separate,
 * later, structurally unrelated fold that legitimately declares its own bare
 * `item` loop variable over its own unrelated collection.
 *
 * `recon-generate.ts`'s real generator selects exactly ONE action sequence
 * per site (`selectPayloadAction`) — feeding both scenarios' captures into a
 * single `recon:generate` run collapses one into the other or silently drops
 * it, rather than emitting two coexisting loops (verified empirically: this
 * is an architectural property of the generator's single-primary selection,
 * not a scoping bug). So — mirroring the precedent already established by
 * the accepted `recon-generate-1-12-52-ancestor-loop-no-item-sibling-cross-
 * scope-item-bleed-e2e.test.ts` and `recon-generate-1-12-52-ancestor-scoped-
 * hoisted-call-identifier-bleed-e2e.test.ts` (which combine two independent
 * `emitMultiStepExecuteHttp` invocations into one `combinedBody`) — this
 * drives the real `recon:generate` CLI TWICE, once per scenario, so EACH
 * half is produced (and `tsc`-verified) by the full generator pipeline the
 * report's own TS2304 repro went through, then concatenates both real,
 * CLI-emitted `executeHttp` bodies to prove no `item` identifier bleeds
 * across the two, cross-invocation, independently-scoped loops. The isolated
 * `emitMultiStepExecuteHttp`-level sibling tests above only ever hand-feed a
 * chain-hoisted call; neither exercises this direct-body (non-hoisted, plain
 * per-group fetch) code path against genuine captures.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const ANCESTOR_HOST = "www.ancestor-loop-direct-body-item-bleed-ancestor-fixture.example.com";
const SECTIONS_URL = `https://${ANCESTOR_HOST}/catalog/sections`;
const ENTRY_DETAILS_URL = `https://${ANCESTOR_HOST}/catalog/entries/details`;
const ENTRY_LABELS_URL = `https://${ANCESTOR_HOST}/catalog/entries/labels`;

const UNRELATED_HOST = "www.ancestor-loop-direct-body-item-bleed-unrelated-fixture.example.com";
const ORDER_LINE_ITEMS_URL = `https://${UNRELATED_HOST}/orders/line-items`;
const ORDER_PROMO_URL = `https://${UNRELATED_HOST}/orders/promo-eligibility`;

/**
 * Two ancestor groups (`sec1`/`sec2`), each carrying THREE entries. Neither
 * direct drill call below depends on any per-entry field — both key off the
 * matched (first) entry's own `entryId`, reached only by drilling through
 * the ancestor's own `entries` array, so both calls resolve as ancestor-
 * scoped (one fetch per group) with no reason for a per-entry sub-loop of
 * their own. `r3`/`r4` are decoys — same drilled pathnames, but foreign to
 * the primary response — so the same-endpoint variance check this fold
 * detection relies on has a second, genuinely differing capture to compare
 * each drill's own param against.
 */
function ancestorScenarioCaptures(): Capture[] {
  const sections = buildCapture({
    url: SECTIONS_URL,
    requestPostData: null,
    responseBody: {
      sections: [
        {
          masterCode: "sec1",
          entries: [
            { entryId: "e1", name: "Widget" },
            { entryId: "e2", name: "Gadget" },
            { entryId: "e3", name: "Doohickey" },
          ],
        },
        {
          masterCode: "sec2",
          entries: [
            { entryId: "e4", name: "Thingamajig" },
            { entryId: "e5", name: "Contraption" },
            { entryId: "e6", name: "Gizmo" },
          ],
        },
      ],
    },
    timestamp: "2025-08-01T00:00:00Z",
  });
  const details = buildCapture({
    url: `${ENTRY_DETAILS_URL}?code=e1`,
    requestPostData: null,
    responseBody: {
      details: [
        { entryId: "e1", description: "A widget." },
        { entryId: "e2", description: "A gadget." },
        { entryId: "e3", description: "A doohickey." },
      ],
    },
    timestamp: "2025-08-01T00:00:01Z",
  });
  const labels = buildCapture({
    url: `${ENTRY_LABELS_URL}?tag=e1`,
    requestPostData: null,
    responseBody: {
      labels: [
        { entryId: "e1", label: "north-widget" },
        { entryId: "e2", label: "north-gadget" },
        { entryId: "e3", label: "north-doohickey" },
      ],
    },
    timestamp: "2025-08-01T00:00:02Z",
  });
  const detailsDecoy = buildCapture({
    url: `${ENTRY_DETAILS_URL}?code=zzz-unrelated`,
    requestPostData: null,
    responseBody: { details: [] },
    timestamp: "2025-08-01T00:00:03Z",
  });
  const labelsDecoy = buildCapture({
    url: `${ENTRY_LABELS_URL}?tag=zzz-unrelated`,
    requestPostData: null,
    responseBody: { labels: [] },
    timestamp: "2025-08-01T00:00:04Z",
  });
  return [sections, details, labels, detailsDecoy, labelsDecoy];
}

/**
 * A wholly separate, structurally unrelated fold: an order's line items,
 * drilled per-item for promo eligibility. This is the only collection in
 * this scenario needing a per-item loop, so its fold plan declares a bare
 * `item` binding — the identifier that must never bleed into the ancestor
 * scenario's own g0-scoped calls above.
 */
function unrelatedScenarioCaptures(): Capture[] {
  const lineItems = buildCapture({
    url: ORDER_LINE_ITEMS_URL,
    requestPostData: JSON.stringify({ orderId: "ord-1" }),
    responseBody: {
      lineItems: [
        { sku: "sku-a", quantity: 2 },
        { sku: "sku-b", quantity: 1 },
      ],
    },
    timestamp: "2025-09-01T00:00:00Z",
  });
  const promo = buildCapture({
    url: ORDER_PROMO_URL,
    requestPostData: JSON.stringify({ sku: "sku-a" }),
    responseBody: { eligibility: [{ sku: "sku-a", eligible: true }] },
    timestamp: "2025-09-01T00:00:01Z",
  });
  return [lineItems, promo];
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

interface GeneratedSite {
  siteOutDir: string;
  contract: string;
  tsconfigPath: string;
}

function runGenerateAndTypecheck(
  workDirs: string[],
  tsconfigPaths: string[],
  siteOutDirs: string[],
  siteId: string,
  ownBackendHostname: string,
  steps: Array<{ step: string }>,
  captures: Capture[]
): GeneratedSite {
  const workDir = mkdtempSync(
    join(tmpdir(), `barnacle-ancestor-loop-direct-body-item-bleed-e2e-${siteId}-`)
  );
  workDirs.push(workDir);
  const runRoot = join(workDir, "run");
  writeRunDir(runRoot, captures);

  const siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  siteOutDirs.push(siteOutDir);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({ steps, ownBackendHostnames: [ownBackendHostname] })
  );

  const result = spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

  const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

  const tsconfigPath = join(
    REPO_ROOT,
    `tsconfig.ancestor-loop-direct-body-item-bleed-e2e.${siteId}.json`
  );
  tsconfigPaths.push(tsconfigPath);
  writeFileSync(
    tsconfigPath,
    JSON.stringify({
      extends: "./tsconfig.json",
      compilerOptions: {
        noEmit: true,
        incremental: false,
        tsBuildInfoFile: null,
        paths: {
          "@/*": ["./src/*"],
          "@test/*": ["./test/*"],
          "@enricai/barnacle/*": ["./src/*"],
        },
      },
      include: [`src/sites/${siteId}/**/*.ts`],
    })
  );
  const check = spawnSync(TSC_BIN, ["-p", tsconfigPath, "--noEmit"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const diagnostics = `${check.stdout}\n${check.stderr}`;
  const referencesEmittedFile = diagnostics.includes("contract.ts");
  expect(referencesEmittedFile, diagnostics).toBe(false);
  expect(check.status, diagnostics).toBe(0);

  return { siteOutDir, contract, tsconfigPath };
}

/** Every `for (const <loopVar> of ...) { ... }` block's own body text in
 * `body`, walked via brace depth from each occurrence's own open brace — a
 * loop variable may legitimately be declared more than once across a
 * combined multi-invocation output. */
function allLoopBodySpans(body: string, loopVar: string): Array<{ start: number; end: number }> {
  // Item-scoped fetches now parallelize into `Promise.allSettled((X).map(async
  // (item) => {...}))` (see emitItemLoopLines in recon-generate.ts) instead of
  // a bare `for (const item of X) {`, so both declaration shapes must be
  // recognized here.
  const openMarkers = [`for (const ${loopVar} of`, `.map(async (${loopVar}) =>`];
  const spans: Array<{ start: number; end: number }> = [];
  for (const openMarker of openMarkers) {
    let searchFrom = 0;
    for (;;) {
      const markerIndex = body.indexOf(openMarker, searchFrom);
      if (markerIndex === -1) break;
      const braceStart = body.indexOf("{", markerIndex);
      let depth = 0;
      let loopEnd = -1;
      for (let i = braceStart; i < body.length; i++) {
        if (body[i] === "{") depth++;
        if (body[i] === "}") {
          depth--;
          if (depth === 0) {
            loopEnd = i + 1;
            break;
          }
        }
      }
      if (loopEnd === -1) {
        throw new Error(`allLoopBodySpans: unterminated "${openMarker}" loop body`);
      }
      spans.push({ start: markerIndex, end: loopEnd });
      searchFrom = loopEnd;
    }
  }
  return spans;
}

/** Every occurrence of `\b<loopVar>\b` anywhere in `body` OUTSIDE every span
 * where `loopVar` is legitimately declared. */
function occurrencesOutsideEveryOwnLoop(body: string, loopVar: string): string[] {
  const spans = allLoopBodySpans(body, loopVar);
  const outside = spans
    .slice()
    .sort((a, b) => a.start - b.start)
    .reduceRight(
      (remaining, span) => `${remaining.slice(0, span.start)}${remaining.slice(span.end)}`,
      body
    );
  return outside.match(new RegExp(`\\b${loopVar}\\b`, "g")) ?? [];
}

let workDirs: string[] = [];
let siteOutDirs: string[] = [];
let tsconfigPaths: string[] = [];

afterEach(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
  for (const dir of siteOutDirs) rmSync(dir, { recursive: true, force: true });
  for (const path of tsconfigPaths) rmSync(path, { force: true });
  workDirs = [];
  siteOutDirs = [];
  tsconfigPaths = [];
});

describe("recon-generate CLI — ancestor loop's own direct request bodies never bleed into a separate, later, unrelated item loop", () => {
  it("keeps both of g0's own direct drill bodies bound to g0's own nested field, coexisting with a separate real CLI run's legitimate item loop, and both typecheck", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    const ancestorSiteId = `ancestor-loop-direct-body-item-bleed-ancestor-e2e${process.pid}`;
    const ancestor = runGenerateAndTypecheck(
      workDirs,
      tsconfigPaths,
      siteOutDirs,
      ancestorSiteId,
      ANCESTOR_HOST,
      [{ step: "browse catalog sections, entry details, and entry labels" }],
      ancestorScenarioCaptures()
    );

    const unrelatedSiteId = `ancestor-loop-direct-body-item-bleed-unrelated-e2e${process.pid}`;
    const unrelated = runGenerateAndTypecheck(
      workDirs,
      tsconfigPaths,
      siteOutDirs,
      unrelatedSiteId,
      UNRELATED_HOST,
      [{ step: "view order line items and check promo eligibility" }],
      unrelatedScenarioCaptures()
    );

    // Both real CLI runs resolved the shapes this test depends on.
    expect(ancestor.contract).toContain("for (const g0 of");
    expect(ancestor.contract).not.toContain("for (const item0 of");
    expect(ancestor.contract).not.toContain("for (const item1 of");
    expect(unrelated.contract).toContain("(foldItems).map(async (item) =>");

    // Both of g0's own direct request bodies are issued directly inside the
    // g0 loop, before any per-entry sub-loop — reached only by drilling into
    // the ancestor's own nested `entries` array, never a per-item accessor.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    expect(ancestor.contract).toContain(
      'catalog/entries/details?code=${(((g0 as Record<string, unknown>).entries as Record<string, unknown>)["0"] as Record<string, unknown>).entryId}'
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    expect(ancestor.contract).toContain(
      'catalog/entries/labels?tag=${(((g0 as Record<string, unknown>).entries as Record<string, unknown>)["0"] as Record<string, unknown>).entryId}'
    );
    expect(ancestor.contract).not.toMatch(/entries\/(details|labels)\?(code|tag)=\$\{item/);

    // The regression: no `item` reference anywhere in the COMBINED
    // executeHttp bodies of both real, independently-generated CLI runs
    // lands outside the one loop that actually declares it — including both
    // of g0's own direct bodies, which have no item sub-loop supplying a
    // binding for either of them, and including the wholly separate, later,
    // unrelated run's own legitimate `item` loop. Scoped to the executeHttp
    // bodies themselves (not the surrounding schema/docstring text, which
    // can legitimately mention "item" in prose).
    const combinedExecuteHttpBodies = `${extractExecuteHttpBodyFromContract(ancestor.contract)}\n${extractExecuteHttpBodyFromContract(unrelated.contract)}`;
    expect(occurrencesOutsideEveryOwnLoop(combinedExecuteHttpBodies, "item")).toEqual([]);

    // Runtime: each real CLI run's own executeHttp threads its own scope
    // correctly, independently, with no ReferenceError from either.
    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    const ancestorFetch = vi.fn(async (url: string) => {
      const responseBody = (() => {
        if (url.includes("catalog/sections")) {
          return {
            sections: [
              {
                masterCode: "sec1",
                entries: [
                  { entryId: "e1", name: "Widget" },
                  { entryId: "e2", name: "Gadget" },
                  { entryId: "e3", name: "Doohickey" },
                ],
              },
              {
                masterCode: "sec2",
                entries: [
                  { entryId: "e4", name: "Thingamajig" },
                  { entryId: "e5", name: "Contraption" },
                  { entryId: "e6", name: "Gizmo" },
                ],
              },
            ],
          };
        }
        if (url.includes("catalog/entries/details?code=e1")) {
          return {
            details: [
              { entryId: "e1", description: "A widget." },
              { entryId: "e2", description: "A gadget." },
              { entryId: "e3", description: "A doohickey." },
            ],
          };
        }
        if (url.includes("catalog/entries/labels?tag=e1")) {
          return {
            labels: [
              { entryId: "e1", label: "north-widget" },
              { entryId: "e2", label: "north-gadget" },
              { entryId: "e3", label: "north-doohickey" },
            ],
          };
        }
        return { details: [], labels: [] };
      })();
      return {
        status: 200,
        ok: true,
        text: vi.fn().mockResolvedValue(JSON.stringify(responseBody)),
        headers: new Headers(),
      };
    });
    vi.stubGlobal("fetch", ancestorFetch);

    // Reaching this point without a ReferenceError already proves neither of
    // g0's own direct bodies referenced an undeclared `item` binding.
    const ancestorExecuteHttp = evalExecuteHttpBody(
      extractExecuteHttpBodyFromContract(ancestor.contract),
      httpClient,
      z
    );

    return ancestorExecuteHttp({ BaseUrl: `https://${ANCESTOR_HOST}` }).then(
      async (ancestorResult) => {
        const ancestorData = ancestorResult.data as {
          sections?: Array<{ entries: Array<Record<string, unknown>> }>;
        };
        expect(ancestorData.sections?.[0]?.entries).toEqual([
          { entryId: "e1", name: "Widget", description: "A widget.", label: "north-widget" },
          { entryId: "e2", name: "Gadget", description: "A gadget.", label: "north-gadget" },
          {
            entryId: "e3",
            name: "Doohickey",
            description: "A doohickey.",
            label: "north-doohickey",
          },
        ]);

        const unrelatedFetch = vi.fn(async (_url: string, init?: { body?: string }) => {
          const requestBody = init?.body
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : null;
          const responseBody =
            typeof requestBody?.sku === "string"
              ? { eligibility: [{ sku: requestBody.sku, eligible: true }] }
              : {
                  lineItems: [
                    { sku: "sku-a", quantity: 2 },
                    { sku: "sku-b", quantity: 1 },
                  ],
                };
          return {
            status: 200,
            ok: true,
            text: vi.fn().mockResolvedValue(JSON.stringify(responseBody)),
            headers: new Headers(),
          };
        });
        vi.stubGlobal("fetch", unrelatedFetch);

        const unrelatedExecuteHttp = evalExecuteHttpBody(
          extractExecuteHttpBodyFromContract(unrelated.contract),
          httpClient,
          z
        );
        const unrelatedResult = await unrelatedExecuteHttp({
          BaseUrl: `https://${UNRELATED_HOST}`,
          orderId: "ord-1",
        });
        const unrelatedData = unrelatedResult.data as {
          lineItems?: Array<Record<string, unknown>>;
        };
        expect(unrelatedData.lineItems).toEqual([
          { sku: "sku-a", quantity: 2, eligible: true },
          { sku: "sku-b", quantity: 1, eligible: true },
        ]);
      }
    );
  }, 60_000);
});
