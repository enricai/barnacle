import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import {
  extractActionSequence,
  firstEndpointCapture,
  type FoldReturnSpec,
} from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");
const HOST = "https://www.example.com";

const ts = (i: number) => `2024-01-01T00:00:${String(i).padStart(2, "0")}Z`;

const searchGet = (i: number, adults: string, dest: string): Capture =>
  buildCapture({
    url: `${HOST}/search/api/search?numadults=${adults}&dest=${dest}`,
    method: "GET",
    requestPostData: null,
    responseBody: { results: [{ id: `r${i}`, name: `Result ${i}` }] },
    timestamp: ts(i),
  });

const beacon = (i: number): Capture =>
  buildCapture({
    url: `${HOST}/tracking/log`,
    method: "POST",
    requestPostData: JSON.stringify({ url: `www.example.com/page-${i}`, pageTitle: `Page ${i}` }),
    // Intermittent ack: `{"result":"ok"}` or null; never depends on the request.
    responseBody: i % 3 === 0 ? null : { result: "ok" },
    timestamp: ts(20 + i),
  });

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

function writeRunDir(runRoot: string, captures: Capture[]): void {
  const dir = join(runRoot, "graphql");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(runRoot, "replays"), { recursive: true });
  mkdirSync(join(runRoot, "aux"), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
  captures.forEach((c, i) =>
    writeFileSync(join(dir, `${String(i).padStart(3, "0")}-capture.json`), JSON.stringify(c))
  );
}

describe("recon-generate: read-only GET search with an intermittent-ack analytics beacon", () => {
  it("stays read-only, emits no self-fold/drill, and generation succeeds", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-ro-intermittent-beacon-"));
    const runRoot = join(workDir, "run");
    const gets = [searchGet(1, "2", "C"), searchGet(2, "3", "A"), searchGet(3, "2", "A")];
    const beacons = Array.from({ length: 13 }, (_, i) => beacon(i + 1));
    expect(beacons.filter((b) => b.responseBody === null).length).toBeGreaterThan(0);
    expect(beacons.filter((b) => b.responseBody !== null).length).toBeGreaterThan(0);
    writeRunDir(runRoot, [...gets, ...beacons]);

    const siteId = `ro-intermittent-ack-beacon-test-${process.pid}`;
    siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "search" }],
        ownBackendHostnames: ["www.example.com", "example.com"],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: RECON_GENERATE_CWD, encoding: "utf8" }
    );
    const out = `${result.stdout}\n${result.stderr}`;
    expect(result.status, out).toBe(0);
    expect(out).not.toContain("would freeze a value that varied");

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).toContain("/search/api/search");
    expect(contract).not.toContain("/tracking/log");
  }, 60_000);
});

describe("beacon answer-independence controls", () => {
  it("a recurring POST whose body-bearing responses differ is not a beacon", () => {
    const real = [1, 2, 3].map((i) =>
      buildCapture({
        url: `${HOST}/orders/create`,
        method: "POST",
        requestPostData: JSON.stringify({ n: i }),
        responseBody: i === 2 ? null : { data: [`order-${i}`] },
        timestamp: ts(i),
      })
    );
    expect(firstEndpointCapture(real)?.url).toBe(`${HOST}/orders/create`);
  });

  it("a declared foldReturn drill is still kept in the action sequence", () => {
    const fold = {
      endpointPattern: "/lookup/",
      resultsPath: "rows",
      joinFields: ["id"],
    } as unknown as FoldReturnSpec;
    const get = (path: string, body: unknown, t: number) =>
      buildCapture({
        url: `${HOST}${path}`,
        method: "GET",
        requestPostData: null,
        responseBody: body,
        timestamp: ts(t),
      });
    const caps = [
      get("/search?q=a&page=1", { rows: [{ id: "x1" }, { id: "x2" }] }, 1),
      get("/search?q=a&page=2", { rows: [{ id: "x3" }] }, 2),
      get("/lookup/x1", { rows: [{ id: "x1" }] }, 3),
      get("/lookup/x3", { rows: [{ id: "x3" }] }, 4),
      ...[1, 2, 3].map(beacon),
    ];
    const out = extractActionSequence(caps, null, fold, [], "example.com", true, null);
    const urls = out.map((a) => new URL(a.capture.url).pathname);
    expect(urls).toContain("/search");
    expect(urls.some((u) => u.startsWith("/lookup/"))).toBe(true);
  });
});
