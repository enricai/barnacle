import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "@/scripts/recon-generate";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import type { Capture } from "@/scripts/recon-shared";

const API = "https://gw.api.example.test";
const SEARCH = `${API}/web/pricing/v1/trips`;
const DRILL = `${API}/web/ref/v1/itineraries`;

const guests = (n: number) => Array.from({ length: n }, () => ({ country: "US", city: "AAA" }));
const ALL = ["Y", "G", "B"];
const BASE = { availability: ALL, kind: "C", meta: "I" };
/** One search per step: every facet is one key of `filters`, absent or empty until it is chosen. */
const SEARCHES: Array<{ filters: Record<string, unknown>; guests: number }> = [
  { filters: { ...BASE, trades: ["C"] }, guests: 2 },
  { filters: { ...BASE, trades: ["C"], zones: ["CE"] }, guests: 2 },
  { filters: { ...BASE, trades: ["C"], ships: ["SU"] }, guests: 2 },
  { filters: { ...BASE, trades: ["C"], ports: ["PQR"] }, guests: 2 },
  { filters: { ...BASE, trades: ["C"], length: [{ start: "6", end: "8" }] }, guests: 2 },
  {
    filters: {
      ...BASE,
      trades: ["C"],
      ports: ["PQR"],
      ships: ["SU"],
      zones: ["CE"],
      length: [{ start: "6", end: "8" }],
    },
    guests: 2,
  },
  { filters: { ...BASE, trades: ["A"] }, guests: 2 },
  { filters: { ...BASE, trades: ["E"], length: [{ start: "9", end: "15" }] }, guests: 2 },
  { filters: { ...BASE, trades: ["C"], ports: ["PQR"], ships: ["SU"] }, guests: 2 },
  {
    filters: { ...BASE, availability: ["Y", "B"], trades: ["C"], ports: ["PQR"], ships: ["SU"] },
    guests: 3,
  },
  {
    filters: {
      ...BASE,
      availability: ["Y", "B"],
      meta: "B",
      trades: ["C"],
      ports: ["PQR"],
      ships: ["SU"],
    },
    guests: 3,
  },
  { filters: { ...BASE, trips: ["U743"] }, guests: 2 },
  { filters: { ...BASE, trips: ["U646", "U648", "U703"] }, guests: 2 },
  { filters: { ...BASE, trips: ["3717", "E819"] }, guests: 2 },
];

const searchBody = (s: (typeof SEARCHES)[number]) => ({
  booking: { agency: { id: "AG1" }, currencyCode: "USD", guests: guests(s.guests), coupons: [] },
  filters: s.filters,
  leadInBy: "itins",
});
const tripsOf = (i: number): string[] =>
  (SEARCHES[i]?.filters.trips as string[] | undefined) ?? [`U74${i}`, `U64${i}`];

function cap(o: Partial<Capture>): Capture {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action",
    method: "POST",
    url: SEARCH,
    status: 200,
    requestHeaders: { "content-type": "application/json", "X-Brand": "north" },
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    responseBody: null,
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
    ...o,
  };
}

let workDir: string | null = null;
let siteOutDir: string | null = null;
afterEach(() => {
  vi.unstubAllGlobals();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
});

async function generate(): Promise<string> {
  workDir = mkdtempSync(join(tmpdir(), "faceted-post-search-"));
  const runRoot = join(workDir, "run");
  for (const dir of ["graphql", "replays", "aux"]) {
    mkdirSync(join(runRoot, dir), { recursive: true });
  }
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), "[]");
  const caps: Capture[] = [];
  const at = () => new Date(Date.UTC(2024, 0, 1, 0, 0, caps.length)).toISOString();
  SEARCHES.forEach((s, i) => {
    caps.push(
      cap({
        timestamp: at(),
        requestPostData: JSON.stringify(searchBody(s)),
        responseBody: {
          products: [
            {
              id: `P${i}`,
              offers: tripsOf(i).map((id, j) => ({ id, fare: 500 + i * 37 + j * 11 })),
            },
          ],
        },
      })
    );
    if (i < 8) return;
    const ids = tripsOf(i).slice(0, 1);
    caps.push(
      cap({
        method: "GET",
        url: `${DRILL}?offers=${ids.join(",")}`,
        timestamp: at(),
        responseBody: { offers: ids.map((id) => ({ id, days: [{ day: 1, port: `P-${id}` }] })) },
      })
    );
  });
  caps.forEach((c, i) => {
    writeFileSync(
      join(runRoot, "graphql", `${String(i).padStart(3, "0")}-capture.json`),
      JSON.stringify(c)
    );
  });
  const siteId = `faceted-post-search-e2e-${process.pid}`;
  siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      ownBackendHostnames: ["www.example.test", "gw.api.example.test"],
      submitEndpointPattern: "pricing/v1/trips$",
      requireSubmitEndpointMatch: true,
      extraPayloadFields: [
        { name: "trade", type: "string" },
        { name: "promoCode", type: "string", optional: true },
      ],
      foldReturn: [
        {
          endpointPattern: "ref/v1/itineraries\\?offers=",
          resultsPath: "products.*.offers",
          drillResultsPath: "offers",
          joinFields: ["id"],
          attachAs: "itinerary",
          payloadFlag: "includeItinerary",
        },
      ],
      steps: [
        {
          step: "Open the results page",
          optional: true,
          navigateTo: "https://www.example.test/results/?trade=C",
          payloadField: "trade",
        },
        { step: "Choose '3 Guests' from the open guest-count menu", optional: true },
      ],
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
  return join(siteOutDir, "contract.ts");
}

type Emitted = {
  facetedPlugin: {
    meta: { bodySchema: { parse: (v: unknown) => Record<string, unknown> } };
    executeHttp: (payload: unknown, context: unknown) => Promise<{ data: unknown }>;
  };
};

/** Imports the emitted contract against this repo's source instead of the published package. */
async function load(contractPath: string): Promise<Emitted["facetedPlugin"]> {
  const runnable = contractPath.replace(/\.ts$/, ".runnable.ts");
  writeFileSync(
    runnable,
    readFileSync(contractPath, "utf8")
      .replace(/"@enricai\/barnacle\//g, '"@/')
      .replace(/^import type .*site-plugin";$/m, "")
      .replace(/^import \{ run.*browser-flow";$/m, "const runBrowserFlow = null;")
  );
  const mod = (await import(/* @vite-ignore */ runnable)) as { plugin: Emitted["facetedPlugin"] };
  return mod.plugin;
}

describe("recon-generate: faceted POST search with a GET drill", () => {
  it("emits one search whose facets the caller controls", async () => {
    const contractPath = await generate();
    const contract = readFileSync(contractPath, "utf8");
    expect(contract.match(/pricing\/v1\/trips`/g)).toHaveLength(1);
    expect(contract).toContain("trade: z.array(z.string()).optional().default");
    // A declared extra field bound to a body path is typed by that path, not overridden.
    expect(contract).not.toContain("trade: z.string()");
    // An unbound declared extra field is still emitted with its declared type.
    expect(contract).toContain("promoCode: z.string().optional()");
    expect(contract).toContain("filtersShips: z.array(z.string()).optional()");
    expect(contract).toContain("filtersLength: z.array(z.unknown()).optional()");
    expect(contract).toContain("bookingGuests: z.array(z.unknown()).optional().default");

    const plugin = await load(contractPath);
    const sent: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
        sent.push({ url: String(url), body });
        const id = new URL(String(url)).searchParams.get("offers");
        const answer = id
          ? { offers: [{ id, days: [{ day: 1, port: `P-${id}` }] }] }
          : {
              products: [
                {
                  id: "P1",
                  offers: [
                    { id: "X100", fare: 1 },
                    { id: "X200", fare: 2 },
                  ],
                },
              ],
            };
        return new Response(JSON.stringify(answer), {
          headers: { "content-type": "application/json" },
        });
      })
    );
    const run = async (payload: Record<string, unknown>) => {
      sent.length = 0;
      const result = await plugin.executeHttp(plugin.meta.bodySchema.parse(payload), {
        baseUrl: API,
      });
      return { searches: sent.filter((r) => r.url === SEARCH).map((r) => r.body), result };
    };

    const recorded = await run({});
    expect(recorded.searches).toEqual([searchBody(SEARCHES[0]!)]);
    const faceted = await run({
      trade: ["A"],
      filtersShips: ["XP"],
      filtersLength: [{ start: "7", end: "10" }],
      filtersMeta: "B",
      bookingGuests: guests(3),
    });
    expect(faceted.searches).toEqual([
      searchBody({
        filters: {
          ...BASE,
          meta: "B",
          trades: ["A"],
          ships: ["XP"],
          length: [{ start: "7", end: "10" }],
        },
        guests: 3,
      }),
    ]);
    expect(sent).toHaveLength(1);

    const drilled = await run({ includeItinerary: true });
    expect(
      sent
        .map((r) => r.url)
        .slice(1)
        .sort()
    ).toEqual([`${DRILL}?offers=X100`, `${DRILL}?offers=X200`]);
    expect(JSON.stringify(drilled.result.data)).toContain('"port":"P-X200"');
  }, 120_000);
});
