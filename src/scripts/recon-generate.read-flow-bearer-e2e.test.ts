import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "@/scripts/recon-generate";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import type { Capture } from "@/scripts/recon-shared";

const REPO_ROOT = join(__dirname, "..", "..");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

function cap(o: Partial<Capture>): Capture {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action",
    method: "POST",
    url: "https://api.example.com/v1/catalog/query",
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

describe("recon-generate: read-only GraphQL search behind a page-served bearer", () => {
  it.each([true, false])(
    "sends a call-time bearer (token located: %s)",
    async (located) => {
      workDir = mkdtempSync(join(tmpdir(), "read-flow-bearer-"));
      const runRoot = join(workDir, "run");
      mkdirSync(join(runRoot, "graphql"), { recursive: true });
      mkdirSync(join(runRoot, "replays"), { recursive: true });
      mkdirSync(join(runRoot, "aux"), { recursive: true });
      writeFileSync(join(runRoot, "replays", "rate-limit.json"), "[]");
      const caps: Capture[] = [];
      const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
      const J = `eyJhbGciOiJIUzI1NiJ9.${b64({ tokenType: "client", sub: "s" })}.sigsigsig`;
      const Q = "query ($input: I!) { allTrips(input: $input) { id name price } }";
      [
        ["USD", 2],
        ["GBP", 2],
        ["USD", 3],
      ].forEach(([c, n], i) => {
        caps.push(
          cap({
            url: "https://api.example.com/graphql",
            timestamp: `2024-01-01T00:00:1${i}Z`,
            requestHeaders: { "content-type": "application/json", authorization: `Bearer ${J}` },
            query: Q,
            variables: { input: { currency: c, party: n } },
            requestPostData: JSON.stringify({
              query: Q,
              variables: { input: { currency: c, party: n } },
            }),
            responseBody: {
              data: {
                allTrips: [
                  { id: `t${i}`, name: `n${i}`, price: 10 + i },
                  { id: `u${i}`, name: "m", price: 9 },
                ],
              },
            },
          })
        );
      });
      writeFileSync(
        join(runRoot, "replays", "000.json"),
        JSON.stringify({
          url: "https://api.example.com/graphql",
          method: "POST",
          operationName: null,
          replayStatus: 401,
          captureStatus: 200,
          shapeDiffers: false,
          shapeRestoringHeaders: [],
          omittedCaptureHeaders: ["authorization"],
          authReplay: {
            status: 200,
            tokenReplayable: true,
            tokenSource: located
              ? { document: 0, url: "https://api.example.com/planner", source: "rsc-row" }
              : null,
          },
        })
      );
      for (const [i, c] of caps.entries()) {
        writeFileSync(
          join(runRoot, "graphql", `${String(i).padStart(3, "0")}-capture.json`),
          JSON.stringify(c)
        );
      }
      const siteId = `${located ? "a" : "b"}-read-flow-bearer-e2e-${process.pid}`;
      siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
      mkdirSync(siteOutDir, { recursive: true });
      writeFileSync(
        join(siteOutDir, "recon-flow.json"),
        JSON.stringify({
          submitEndpointPattern: "api.example.com/graphql",
          requireSubmitEndpointMatch: true,
          ownBackendHostnames: ["api.example.com"],
          steps: [{ step: "open catalog" }, { step: "apply filters and search" }],
        })
      );
      const savedArgv = process.argv;
      const savedCwd = process.cwd();
      const spies = (["log", "info", "warn", "error"] as const).map((k) =>
        vi.spyOn(console, k).mockImplementation(() => {})
      );
      const writes = [process.stdout, process.stderr].map((st) =>
        vi.spyOn(st, "write").mockImplementation((() => true) as never)
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
      expect(contract).not.toContain(J);
      expect(contract).not.toContain("ApplicantContactSchema");
      expect(contract).toContain("resolveHeaders: resolveAuthHeaders");
      expect(contract).toContain(
        `createBearerHeaderResolver({ documentUrl: ${located ? '"https://api.example.com/planner"' : "null"}`
      );
      expect(contract).toContain('from "@enricai/barnacle/scraper/bearer-token-source"');
    },
    60_000
  );
});
