import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const BASE = "https://shop.example/city/rooms/9/schedule.json";
const URLS = [
  `${BASE}?item_ids%5B%5D=9&date_from=2030-10-26&date_to=2030-11-01&_=1700000000001`,
  `${BASE}?item_ids%5B%5D=9&date_from=2030-11-02&date_to=2030-11-08&_=1700000000002`,
];

function generateContract(
  flowExtras: Record<string, unknown> | null,
  urls: readonly string[] = URLS
): string {
  const workDir = mkdtempSync(join(tmpdir(), "barnacle-get-payload-"));
  dirs.push(workDir);
  const runRoot = join(workDir, "run");
  const capturesDir = join(runRoot, "graphql");
  mkdirSync(capturesDir, { recursive: true });
  mkdirSync(join(runRoot, "replays"), { recursive: true });
  mkdirSync(join(runRoot, "aux"), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
  urls.forEach((url, i) => {
    writeFileSync(
      join(capturesDir, `00${i}-read.json`),
      JSON.stringify(
        buildCapture({
          url,
          requestPostData: null,
          responseBody: { slots: [{ time: "10:00", free: true }] },
          timestamp: `2024-02-01T00:00:0${i}Z`,
          method: "GET",
        })
      )
    );
  });
  // Unrelated non-GET 2xx on another host must not turn this into a submission flow.
  writeFileSync(
    join(capturesDir, "002-other.json"),
    JSON.stringify(
      buildCapture({
        url: "https://analytics.example/collect",
        requestPostData: JSON.stringify({ event: "view" }),
        responseBody: { ok: true },
        timestamp: "2024-02-01T00:00:09Z",
        method: "POST",
      })
    )
  );
  // Digit-leading siteId must still emit valid identifiers.
  const siteId = `7-get-payload-driven-${process.pid}`;
  const siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  dirs.push(siteOutDir);
  mkdirSync(siteOutDir, { recursive: true });
  if (flowExtras !== null) {
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "open the page" },
          { step: "pick a color", payloadField: "color" },
          { step: "pick a size", payloadField: "size" },
        ],
        ...flowExtras,
      })
    );
  }
  const result = spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  const output = `${result.stdout}\n${result.stderr}`;
  expect(result.status, output).toBe(0);
  return readFileSync(join(siteOutDir, "contract.ts"), "utf8");
}

function expectPayloadDrivenRead(contract: string): void {
  const http = contract.slice(contract.indexOf("async executeHttp("));
  expect(http).toContain(`encodeURIComponent(String(payload.item_ids ?? "9"))`);
  expect(http).toContain('["date_from", String(payload.date_from)]');
  expect(http).toContain('["date_to", String(payload.date_to)]');
  expect(http).toContain('["item_ids[]", String(payload.item_ids ?? "9")]');
  expect(http).not.toContain("item_ids%5B");
  expect(contract).not.toMatch(/^ {2}_: /m);
  expect(http).not.toContain("1700000000001");
  expect(http).not.toContain("1700000000002");
  expect(contract).not.toMatch(/\b(?:const|class|function)\s+\d/);
  expect(contract).toMatch(/\bSite7GetPayloadDriven/);
  // No captured window is replayed verbatim.
  for (const literal of ["2030-10-26", "2030-11-01", "2030-11-02", "2030-11-08"]) {
    expect(http).not.toContain(literal);
  }
  // Schema declares the derived and flow-declared fields.
  for (const f of ["date_from", "date_to", "item_ids", "color", "size"]) {
    expect(contract).toMatch(new RegExp(`^  ${f}: z\\.string\\(\\)`, "m"));
  }
  // Not a browser-only submission flow.
  expect(http).toContain("await httpClient(");
  expect(contract).not.toMatch(/submission/i);
}

describe("recon-generate CLI — payload-driven GET read flow, end to end", () => {
  it("drives path id, window and array-key values from payload and declares them in the schema", () => {
    expectPayloadDrivenRead(generateContract({}));
  }, 60_000);

  it("stays a payload-driven read when a declared submit pattern selects the same-route GET reads", () => {
    expectPayloadDrivenRead(generateContract({ submitEndpointPattern: "schedule" }));
  }, 60_000);

  it("derives the same inputs with no flow file at all", () => {
    const contract = generateContract(null);
    const http = contract.slice(contract.indexOf("async executeHttp("));
    expect(http).toContain(`encodeURIComponent(String(payload.item_ids ?? "9"))`);
    expect(http).toContain('["date_from", String(payload.date_from)]');
    expect(http).toContain("await httpClient(");
    for (const f of ["date_from", "date_to", "item_ids"]) {
      expect(contract).toMatch(new RegExp(`^  ${f}: z\\.string\\(\\)`, "m"));
    }
    expect(contract).not.toMatch(/submission/i);
  }, 60_000);

  it("treats an entity-id array key as an input even when every capture used the same id", () => {
    const urls = [
      `${BASE}?item_ids%5B%5D=9&date_from=2030-10-26&date_to=2030-11-01`,
      `${BASE}?item_ids%5B%5D=9&date_from=2030-10-26&date_to=2030-11-01`,
    ];
    const contract = generateContract(null, urls);
    const http = contract.slice(contract.indexOf("async executeHttp("));
    expect(http).toContain('["item_ids[]", String(payload.item_ids ?? "9")]');
    expect(http).toContain('["date_from", String(payload.date_from)]');
    expect(http).not.toContain("2030-10-26");
    expect(contract).toMatch(/^ {2}item_ids: z\.string\(\)/m);
    expect(contract).not.toMatch(/submission/i);
  }, 60_000);
});
