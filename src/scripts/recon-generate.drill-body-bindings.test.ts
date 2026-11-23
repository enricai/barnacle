import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { applyDrillParamBindings, type FoldReturnSpec, main } from "@/scripts/recon-generate";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const URL_ = "https://api.example.com/itinerary/api/v1/sailings";
const spec: FoldReturnSpec = {
  endpointPattern: "itinerary/api/v1/sailings",
  resultsPath: "data.voyages",
  joinFields: ["id"],
  drillParamBindings: {
    adults: { payloadField: "adults", type: "int", default: 2 },
    cabin: { payloadField: "cabin", type: "string", default: "IN" },
  },
};
const capture = buildCapture({
  url: URL_,
  requestPostData: null,
  responseBody: {},
  timestamp: "2024-11-01T00:00:00Z",
});

describe("applyDrillParamBindings JSON body keys", () => {
  it("binds numeric and string JSON body keys, preserving other keys and the headers text", () => {
    const body = 'body: `{"id":"v1","adults":2,"cabin":"IN"}`,';
    expect(applyDrillParamBindings(spec, capture, body)).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting emitted source
      'body: `{"id":"v1","adults":${payload.adults ?? 2},"cabin":"${payload.cabin ?? "IN"}"}`,'
    );
    const headers = 'headers: { "content-type": `application/json` },';
    expect(applyDrillParamBindings(spec, capture, headers)).toBe(headers);
  });

  it("still rewrites query params", () => {
    expect(applyDrillParamBindings(spec, capture, `${URL_}?adults=2`)).toBe(
      `${URL_}?adults=\${payload.adults ?? 2}`
    );
  });
});

describe("declared submit endpoint re-queried with differing body arrays", () => {
  it("generates without a freeze error and without a drill chain", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "declared-facet-requery-"));
    const runRoot = join(workDir, "run");
    for (const d of ["graphql", "replays", "aux"]) mkdirSync(join(runRoot, d), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), "[]");
    const bodies = [
      { filters: { tags: ["a"], mode: "any" }, page: 1 },
      { filters: { tags: ["a", "b"], mode: "all" }, page: 1 },
      { filters: { tags: ["c"], mode: "any" }, page: 1 },
      { filters: { tags: ["c", "d", "e"], mode: "all" }, page: 1 },
    ];
    for (const [i, b] of bodies.entries()) {
      const c = buildCapture({
        url: "https://api.example.com/v1/catalog/query",
        requestPostData: JSON.stringify(b),
        responseBody: { items: [{ sku: `s${i}`, name: `thing ${i}` }] },
        timestamp: `2024-01-01T00:00:${String(10 + i).padStart(2, "0")}Z`,
      });
      writeFileSync(
        join(runRoot, "graphql", `${String(i).padStart(3, "0")}-capture.json`),
        JSON.stringify({ ...c, method: "POST", phase: "action" })
      );
    }
    const siteId = `declared-facet-requery-${process.pid}`;
    const siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        submitEndpointPattern: "/v1/catalog/query",
        steps: [{ step: "open catalog" }, { step: "apply filters and search" }],
      })
    );
    const savedArgv = process.argv;
    const savedCwd = process.cwd();
    const spies = (["log", "info", "warn", "error"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation(() => {})
    );
    try {
      process.chdir(RECON_GENERATE_CWD);
      process.argv = [
        "node",
        "recon-generate.ts",
        "--site-id",
        siteId,
        "--run-dir",
        runRoot,
        "--emit",
        "ts",
        "--force",
      ];
      await main();
      const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
      expect(contract).toContain("filtersTags: z.array(z.string())");
      expect(contract).toContain("filtersMode: z.string()");
      expect(contract).toContain("payload.filtersTags");
      expect(contract).toContain("payload.filtersMode");
      expect(contract).toContain("/v1/catalog/query");
      expect(contract).not.toMatch(/would freeze/);
      expect(contract).not.toMatch(/drill/i);
      expect(contract.match(/\/v1\/catalog\/query/g)).toHaveLength(1);
    } finally {
      process.argv = savedArgv;
      process.chdir(savedCwd);
      for (const sp of spies) sp.mockRestore();
      rmSync(workDir, { recursive: true, force: true });
      rmSync(siteOutDir, { recursive: true, force: true });
    }
  }, 60_000);
});
