import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  compileActionSteps,
  emitContractTs,
  extractGraphQLActionSequence,
  indexStateValues,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * A GET search with declared per-item drills (array-form foldReturn): the
 * declared intent wins over incidental capture shape. The search stays a GET
 * with its facets, every declared drill is one gated, isolated hop inside the
 * per-item loop whichever entry position or method it has, and the flags and
 * attached keys are published in the schemas.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");
const HOST = "api.catalog-fixture.example.com";
const ITEMS = [{ sku: "a1" }, { sku: "b2" }, { sku: "c3" }];

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let tick = 0;
const ts = (): string => `2026-01-01T00:00:${String(10 + tick++).padStart(2, "0")}Z`;

function generate(tag: string, foldReturn: unknown[], withPostDrill: boolean): string {
  tick = 0;
  const workDir = mkdtempSync(join(tmpdir(), "declared-drills-get-"));
  dirs.push(workDir);
  const runRoot = join(workDir, "run");
  for (const d of ["graphql", "replays", "aux"]) mkdirSync(join(runRoot, d), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), "[]");
  const get = (url: string, responseBody: unknown) =>
    buildCapture({ url, requestPostData: null, responseBody, timestamp: ts(), method: "GET" });
  const captures = [
    get(`https://${HOST}/catalog/search?term=shoe&category=boots&limit=20`, { results: ITEMS }),
    get(`https://${HOST}/catalog/search?term=boot&limit=20&color=red`, { results: ITEMS }),
  ];
  for (const { sku } of ITEMS) {
    captures.push(
      get(`https://${HOST}/catalog/pricing?sku=${sku}&region=us`, { sku, amount: 10 }),
      get(`https://${HOST}/catalog/detail?sku=${sku}`, { sku, description: `d-${sku}` }),
      get(`https://${HOST}/catalog/offers?sku=${sku}`, {
        results: [{ offer: "o1" }, { offer: "o2" }],
      })
    );
    if (withPostDrill) {
      captures.push(
        buildCapture({
          url: `https://${HOST}/catalog/stock`,
          requestPostData: JSON.stringify({ sku, qty: 1 }),
          responseBody: { results: [{ inStock: true }, { inStock: false }] },
          timestamp: ts(),
        })
      );
    }
  }
  for (const [i, c] of captures.entries()) {
    writeFileSync(
      join(runRoot, "graphql", `${String(i).padStart(3, "0")}-c.json`),
      JSON.stringify(c)
    );
  }
  const siteId = `declared-drills-get-${tag}-${process.pid}`;
  const siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  dirs.push(siteOutDir);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [
        { step: "open the catalog" },
        { step: "search for items", payloadField: "term" },
        { step: "pick a category", payloadField: "category", optional: true },
      ],
      ownBackendHostnames: [HOST],
      foldReturn,
    })
  );
  const result = spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return readFileSync(join(siteOutDir, "contract.ts"), "utf8");
}

const count = (text: string, needle: string): number => text.split(needle).length - 1;
const payloadSchema = (contract: string): string =>
  contract.slice(
    contract.indexOf("PayloadSchema = z"),
    contract.indexOf("export type", contract.indexOf("PayloadSchema = z"))
  );

describe("declared drills on a GET search, GET drills only", () => {
  const contract = generate(
    "get",
    [
      {
        endpointPattern: "catalog/pricing",
        resultsPath: "results",
        joinFields: ["sku"],
        attachAs: "pricing",
      },
      {
        endpointPattern: "catalog/detail",
        resultsPath: "results",
        joinFields: ["sku"],
        payloadFlag: "includeDetail",
      },
      {
        endpointPattern: "catalog/offers",
        resultsPath: "results",
        joinFields: ["sku"],
        attachAs: "offers",
      },
    ],
    false
  );
  const http = contract.slice(
    contract.indexOf("async executeHttp("),
    contract.indexOf("async execute(")
  );

  it("issues the search as a GET carrying every facet as an optional query param", () => {
    expect(http).not.toContain("payload.query");
    expect(http).not.toContain('method: "POST"');
    expect(http).toContain(
      'payload.category !== undefined ? [["category", String(payload.category)]]'
    );
    expect(http).toContain('payload.color !== undefined ? [["color", String(payload.color)]]');
    expect(payloadSchema(contract)).not.toMatch(/\bquery:/);
  });

  it("emits each declared drill exactly once, inside the per-item loop", () => {
    const loopStart = http.indexOf("foldItems");
    for (const path of ["catalog/pricing", "catalog/detail", "catalog/offers"]) {
      expect(count(http, `/${path}?`), path).toBe(1);
      expect(http.indexOf(`/${path}?`), path).toBeGreaterThan(loopStart);
    }
  });

  it("gates the flagged drill on its payload flag and declares the flag in the schema", () => {
    expect(http).toContain('(payload as Record<string, unknown>)["includeDetail"]');
    expect(payloadSchema(contract)).toMatch(/includeDetail: z\.boolean\(\)\.optional\(\)/);
  });

  it("isolates each attached or flagged drill so a failure drops only its own key", () => {
    for (const name of ["pricing", "detail", "offers"]) {
      expect(contract).toContain(`fold drill ${name} failed`);
    }
  });

  it("attaches the whole answer under its key and publishes that key in the response schema", () => {
    expect(http).toContain('["offers"]: foldMatches');
    const response = contract.slice(
      contract.indexOf("ResponseSchema = z"),
      contract.indexOf("export type")
    );
    expect(response).toMatch(/offers: z\.array\(/);
    expect(response).toMatch(/amount: z\.number\(\)/);
    expect(response).toMatch(/description: z\.string\(\)/);
  });
});

describe("declared POST drill on a GET search", () => {
  const contract = generate(
    "post",
    [
      { endpointPattern: "catalog/pricing", resultsPath: "results", joinFields: ["sku"] },
      {
        endpointPattern: "catalog/stock",
        resultsPath: "results",
        joinFields: ["sku"],
        attachAs: "stock",
        payloadFlag: "includeStock",
      },
    ],
    true
  );
  const http = contract.slice(
    contract.indexOf("async executeHttp("),
    contract.indexOf("async execute(")
  );

  it("keeps the captured GET search a GET: a drill POST is not the flow's endpoint", () => {
    expect(http).toContain("/catalog/search?${new URLSearchParams(");
    expect(http).not.toContain("payload.query");
    expect(contract).not.toContain("JobTrackingSchema");
  });

  it("emits the POST hop once, in the loop, with its method, body and content type, gated by its flag", () => {
    expect(count(http, "/catalog/stock")).toBe(1);
    expect(http.indexOf("/catalog/stock")).toBeGreaterThan(http.indexOf("foldItems"));
    expect(http).toContain('method: "POST"');
    expect(http).toContain('"content-type": "application/json"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting emitted source
    expect(http).toContain('"sku":"${item.sku}"');
    expect(http).toContain('(payload as Record<string, unknown>)["includeStock"]');
    expect(payloadSchema(contract)).toMatch(/includeStock: z\.boolean\(\)\.optional\(\)/);
    expect(contract).toContain("fold drill stock failed");
  });

  it("publishes the POST drill's attach key in the response schema", () => {
    const response = contract.slice(
      contract.indexOf("ResponseSchema = z"),
      contract.indexOf("export type")
    );
    expect(response).toMatch(/stock: z\.array\(/);
  });
});

describe("emitContractTs with a GET primary and a declared flagged POST drill", () => {
  const base = `https://${HOST}`;
  const capture = (
    method: string,
    url: string,
    responseBody: unknown,
    postData: string | null
  ) => ({
    timestamp: ts(),
    phase: "browse",
    method,
    url,
    status: 200,
    requestHeaders: postData === null ? {} : { "Content-Type": "application/json" },
    requestPostData: postData,
    responseHeaders: {},
    responseBody,
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  });
  const spec = {
    endpointPattern: "/catalog/stock/",
    resultsPath: "results",
    joinFields: ["sku"],
    attachAs: "stock",
    payloadFlag: "includeStock",
  };
  const captures = [
    capture("GET", `${base}/catalog/search?page=1`, { results: ITEMS }, null),
    capture("POST", `${base}/catalog/stock/`, { results: [{ qty: 1 }] }, '{"sku":"a1","qty":2}'),
    capture("POST", `${base}/catalog/stock/`, { results: [{ qty: 1 }] }, '{"sku":"b2","qty":2}'),
  ];

  it("derives the GET request from the declared primary instead of POSTing a query body", () => {
    const actions = extractGraphQLActionSequence(captures as never[], null, spec as never);
    const stateIndex = indexStateValues(
      captures as never[],
      new Set(),
      new Set(actions.map((a) => a.index))
    );
    const contract = emitContractTs({
      siteId: "direct-get-primary",
      pascal: "DirectGetPrimary",
      baseUrl: base,
      baseHeaders: {},
      minTime: 100,
      safeRps: 10,
      responseBody: captures[0]!.responseBody,
      gql: false,
      gqlQuery: null,
      endpointPath: "/catalog/search",
      gqlOperationName: null,
      gqlVariables: null,
      auxFiles: [],
      actionSteps: compileActionSteps(actions, stateIndex),
      foldReturnSpec: spec,
    } as never);
    expect(contract).toContain('method: "GET"');
    expect(contract).not.toContain("payload.query");
    expect(contract).not.toContain("JobTrackingSchema");
    expect(contract).toContain('(payload as Record<string, unknown>)["includeStock"]');
    expect(contract).toMatch(/includeStock: z\.boolean\(\)\.optional\(\)/);
    expect(contract).toContain('"content-type": "application/json"');
  });
});
