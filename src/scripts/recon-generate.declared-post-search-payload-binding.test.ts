import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "@/scripts/recon-generate";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import type { Capture } from "@/scripts/recon-shared";

const REPO_ROOT = join(__dirname, "..", "..");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");
const HOST = "api.example-travel.test";

const BASE = { kind: "R", meta: "I" };
const FACETS: Array<Record<string, unknown>> = [
  { ...BASE, carriers: ["AA"] },
  { ...BASE, carriers: ["AA"], cabins: ["ECO"] },
  { ...BASE, carriers: ["AA"], hubs: ["JFK"] },
  { ...BASE, carriers: ["BB"], hubs: ["JFK"], cabins: ["ECO"] },
  { ...BASE, carriers: ["CC"], hubs: ["LHR"] },
  { ...BASE, carriers: ["AA"], cabins: ["BUS"], hubs: ["LHR"] },
];

function cap(o: Partial<Capture>): Capture {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action",
    method: "POST",
    url: `https://${HOST}/v1/flights/search`,
    status: 200,
    requestHeaders: { "content-type": "application/json" },
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
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate: declared payloadFields bind on a faceted POST search", () => {
  it("reads every declared field in the emitted body and logs no unread-field warning", async () => {
    workDir = mkdtempSync(join(tmpdir(), "declared-post-search-binding-"));
    const runRoot = join(workDir, "run");
    for (const d of ["graphql", "replays", "aux"]) mkdirSync(join(runRoot, d), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), "[]");
    FACETS.forEach((f, i) => {
      const c = cap({
        timestamp: `2024-01-01T00:00:${String(10 + i).padStart(2, "0")}Z`,
        requestPostData: JSON.stringify({ booking: { currency: "USD", pax: 2 }, filters: f }),
        responseBody: { flights: [{ id: `F${i}`, price: 100 + i }] },
      });
      writeFileSync(
        join(runRoot, "graphql", `${String(i).padStart(3, "0")}-capture.json`),
        JSON.stringify(c)
      );
    });
    const siteId = `declared-post-search-binding-${process.pid}`;
    siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        submitEndpointPattern: "/v1/flights/search",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [HOST],
        steps: [
          {
            step: "Open the results page",
            optional: true,
            navigateTo: `https://${HOST}/results/?carrier=AA`,
            payloadField: "carrier",
          },
          {
            step: "Open the hub filter dropdown and select the 'JFK' option",
            payloadField: "hub",
          },
          {
            step: "Open the cabin filter dropdown and select the 'ECO' option",
            payloadField: "cabin",
          },
        ],
      })
    );
    const logged: string[] = [];
    const savedArgv = process.argv;
    const savedCwd = process.cwd();
    const spies = (["log", "info", "warn", "error"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation((...a: unknown[]) => {
        logged.push(a.map(String).join(" "));
      })
    );
    const writes = [process.stdout, process.stderr].map((st) =>
      vi.spyOn(st, "write").mockImplementation(((chunk: unknown) => {
        logged.push(String(chunk));
        return true;
      }) as never)
    );
    try {
      process.chdir(RECON_GENERATE_CWD);
      process.argv = [
        "node",
        GENERATE_SCRIPT,
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
      for (const sp of [...spies, ...writes]) sp.mockRestore();
    }
    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    const output = logged.join("\n");
    expect(contract).toContain("/v1/flights/search");
    for (const field of ["carrier", "hub", "cabin"]) {
      expect(contract, contract).toMatch(new RegExp(`payload\\.${field}\\b`));
      expect(output).not.toContain(`declared payloadField ${field} is read by no emitted request`);
    }
    expect(output).not.toMatch(/read by no emitted request/);
  }, 60_000);
});
