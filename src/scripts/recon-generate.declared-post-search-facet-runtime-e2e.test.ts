import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "@/scripts/recon-generate";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import type { Capture } from "@/scripts/recon-shared";

const PAGE = "www.example-voyages.test";
const API = "https://gw.example-voyages.test";
const SEARCH = `${API}/internal/v1/trips`;

const BASE = { kind: "C", meta: "I" };
/** One search per step: every facet is one key of `filters`, absent until chosen. */
const FACETS: Array<Record<string, unknown>> = [
  { ...BASE, regions: ["N"] },
  { ...BASE, regions: ["N"], areas: ["NE"] },
  { ...BASE, regions: ["N"], vessels: ["V1"] },
  { ...BASE, regions: ["N"], harbors: ["HBR"] },
  { ...BASE, regions: ["N"], span: [{ start: "6", end: "8" }] },
  { ...BASE, regions: ["S"] },
  { ...BASE, regions: ["W"], span: [{ start: "9", end: "15" }] },
];

const cap = (i: number): Capture => ({
  timestamp: `2024-01-01T00:00:${String(10 + i).padStart(2, "0")}Z`,
  phase: "action",
  method: "POST",
  url: SEARCH,
  status: 200,
  requestHeaders: { "content-type": "application/json" },
  requestPostData: JSON.stringify({ party: { size: 2 }, filters: FACETS[i] }),
  responseHeaders: { "content-type": "application/json" },
  responseBody: { trips: [{ id: `T${i}`, fare: 100 + i }] },
  operationName: null,
  query: null,
  variables: null,
  decodedParams: null,
});

type Plugin = {
  meta: { bodySchema: { parse: (v: unknown) => Record<string, unknown> } };
  executeHttp: (payload: unknown, context: unknown) => Promise<unknown>;
};

let workDir: string | null = null;
let siteOutDir: string | null = null;
afterEach(() => {
  vi.unstubAllGlobals();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

async function generate(steps: unknown[]): Promise<Plugin> {
  workDir = mkdtempSync(join(tmpdir(), "declared-post-search-runtime-"));
  const runRoot = join(workDir, "run");
  for (const d of ["graphql", "replays", "aux"]) mkdirSync(join(runRoot, d), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), "[]");
  FACETS.forEach((_, i) => {
    writeFileSync(
      join(runRoot, "graphql", `${String(i).padStart(3, "0")}-capture.json`),
      JSON.stringify(cap(i))
    );
  });
  const siteId = `declared-post-search-runtime-${process.pid}`;
  siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      ownBackendHostnames: [PAGE, "gw.example-voyages.test"],
      submitEndpointPattern: "v1/trips$",
      requireSubmitEndpointMatch: true,
      steps,
    })
  );
  const savedArgv = process.argv;
  const savedCwd = process.cwd();
  const spies = [
    ...(["log", "info", "warn", "error"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation(() => {})
    ),
    ...[process.stdout, process.stderr].map((st) =>
      vi.spyOn(st, "write").mockImplementation((() => true) as never)
    ),
  ];
  try {
    process.chdir(RECON_GENERATE_CWD);
    process.argv = [
      "node",
      "src/scripts/recon-generate.ts",
      "--site-id",
      siteId,
      "--run-dir",
      runRoot,
      "--emit",
      "ts",
      "--force",
    ];
    await main();
  } finally {
    process.argv = savedArgv;
    process.chdir(savedCwd);
    for (const sp of spies) sp.mockRestore();
  }
  const contractPath = join(siteOutDir, "contract.ts");
  const runnable = contractPath.replace(/\.ts$/, ".runnable.ts");
  writeFileSync(
    runnable,
    readFileSync(contractPath, "utf8")
      .replace(/"@enricai\/barnacle\//g, '"@/')
      .replace(/^import type .*site-plugin";$/m, "")
      .replace(/^import \{ run.*browser-flow";$/m, "const runBrowserFlow = null;")
  );
  const mod = (await import(/* @vite-ignore */ runnable)) as { plugin: Plugin };
  return mod.plugin;
}

async function sentBodies(plugin: Plugin, payload: Record<string, unknown>): Promise<unknown[]> {
  const sent: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url) === SEARCH) sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ trips: [{ id: "X", fare: 1 }] }), {
        headers: { "content-type": "application/json" },
      });
    })
  );
  await plugin.executeHttp(plugin.meta.bodySchema.parse(payload), { baseUrl: API });
  return sent;
}

const nav = (query: string, field?: string) => ({
  step: "Open the pre-filtered results page",
  optional: true,
  navigateTo: `https://${PAGE}/results/?kind=C${query}`,
  ...(field ? { payloadField: field } : {}),
});

describe("recon-generate: declared payloadFields drive a faceted read-only POST search", () => {
  it("each declared field fills its own facet array at once, a composite value its element", async () => {
    const plugin = await generate([
      nav("&region=N", "region"),
      nav("&region=N&area=NE", "area"),
      nav("&region=N&vessel=V1", "vessel"),
      nav("&region=N&harbor=HBR", "harbor"),
      nav("&region=N&span=6_8", "span"),
    ]);
    const [body] = await sentBodies(plugin, {
      region: "W",
      area: "SW",
      vessel: "V9",
      harbor: "QQQ",
      span: "9_15",
    });
    expect(body).toEqual({
      party: { size: 2 },
      filters: {
        ...BASE,
        regions: ["W"],
        areas: ["SW"],
        vessels: ["V9"],
        harbors: ["QQQ"],
        span: [{ start: "9", end: "15" }],
      },
    });
  });

  it("a facet the caller omits stays absent unless it was recorded on the first search", async () => {
    const plugin = await generate([
      nav("&region=N", "region"),
      nav("&region=N&vessel=V1", "vessel"),
      nav("&region=N&span=6_8", "span"),
    ]);
    expect(await sentBodies(plugin, { span: "9_15" })).toEqual([
      {
        party: { size: 2 },
        filters: { ...BASE, regions: ["N"], span: [{ start: "9", end: "15" }] },
      },
    ]);
  });

  it("a single declared field selects its facet, accepts a list, and leaves the rest as recorded", async () => {
    const plugin = await generate([nav("&region=N", "region")]);
    expect(await sentBodies(plugin, { region: "S" })).toEqual([
      { party: { size: 2 }, filters: { ...BASE, regions: ["S"] } },
    ]);
    expect(await sentBodies(plugin, { region: ["S", "W"] })).toEqual([
      { party: { size: 2 }, filters: { ...BASE, regions: ["S", "W"] } },
    ]);
    expect(await sentBodies(plugin, {})).toEqual([
      { party: { size: 2 }, filters: { ...BASE, regions: ["N"] } },
    ]);
  });
});
