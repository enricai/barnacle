import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { REQUEST_BODY_UNAVAILABLE } from "@/scraper/request-body-marker";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import type { Capture } from "@/scripts/recon-shared";

const REPO_ROOT = join(__dirname, "..", "..");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");
const HOST = "https://shop.example.com";

/**
 * An opaque id whose separators tokenize as a compound path word: it must be
 * recognised as the value the create call minted, not as route structure.
 */
const ORDER_ID = "ord_8f3a91c2b7d4";
/** Concatenated so Biome does not read the emitted placeholders as stray template interpolations. */
const BASE = "$" + "{context.baseUrl}";
const ID = "$" + "{id}";

function write(method: string, path: string, body: string, response: unknown, n: number): Capture {
  return {
    timestamp: `2024-01-01T00:00:0${n}Z`,
    phase: "action",
    method,
    url: `${HOST}${path}`,
    status: 200,
    requestHeaders: { "content-type": "application/json" },
    requestPostData: body,
    responseHeaders: { "content-type": "application/json" },
    responseBody: response,
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

const create = write(
  "POST",
  "/orders",
  JSON.stringify({ items: [{ sku: "SKU-1", qty: 1 }] }),
  { id: ORDER_ID, status: "open" },
  0
);
const subResource = write(
  "PUT",
  `/orders/${ORDER_ID}/contact`,
  JSON.stringify({ contact: { name: "Jane Roe", email: "jane.roe@mail.example.org" } }),
  { id: ORDER_ID },
  1
);

let workDir: string | null = null;
let siteOutDir: string | null = null;
afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
});

function generate(captures: Capture[], tag: string): string {
  workDir = mkdtempSync(join(tmpdir(), `recon-id-keyed-${tag}-`));
  const runRoot = join(workDir, "run");
  const capturesDir = join(runRoot, "graphql");
  mkdirSync(capturesDir, { recursive: true });
  mkdirSync(join(runRoot, "replays"), { recursive: true });
  mkdirSync(join(runRoot, "aux"), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
  captures.forEach((c, i) => {
    writeFileSync(join(capturesDir, `00${i}-action.json`), JSON.stringify(c));
  });
  const siteId = `recon-id-keyed-${tag}-${process.pid}`;
  siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      GENERATE_SCRIPT,
      "--site-id",
      siteId,
      "--run-dir",
      runRoot,
      "--emit",
      "ts",
      "--force",
    ],
    {
      cwd: RECON_GENERATE_CWD,
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: join(REPO_ROOT, "node_modules") },
    }
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return readFileSync(join(siteOutDir, "contract.ts"), "utf8");
}

describe("recon-generate cart-then-update where later writes are keyed by the minted id in their path", () => {
  it("keeps a PUT sub-resource and a PUT member, threading the id into both", () => {
    const member = write(
      "PUT",
      `/orders/${ORDER_ID}`,
      JSON.stringify({ note: "leave at door" }),
      { id: ORDER_ID },
      2
    );
    const contract = generate([create, subResource, member], "put-put");
    expect(contract).toContain("const id = (r0 as { id: string }).id;");
    expect(contract).toContain(`${BASE}/orders/${ID}/contact`);
    expect(contract).toContain(`${BASE}/orders/${ID}\``);
    expect(contract.match(/method: "PUT"/g)?.length).toBe(2);
    expect(contract).toContain("payload.contactName");
    expect(contract).toContain("payload.note");
    expect(contract).not.toContain(ORDER_ID);
    expect(contract).not.toMatch(/\bBaseUrl\s*:\s*z\./);
  }, 60_000);

  it("keeps a PATCH member whose body is the unavailable marker, without emitting the marker", () => {
    const member = write(
      "PATCH",
      `/orders/${ORDER_ID}`,
      REQUEST_BODY_UNAVAILABLE,
      { id: ORDER_ID },
      2
    );
    const contract = generate([create, subResource, member], "patch-marker");
    expect(contract).toContain('method: "PATCH"');
    expect(contract).toContain(`${BASE}/orders/${ID}/contact`);
    expect(contract).not.toContain(REQUEST_BODY_UNAVAILABLE);
    expect(contract).not.toContain(ORDER_ID);
  }, 60_000);

  it("keeps a PATCH member with a body and exposes its fields as payload inputs", () => {
    const member = write(
      "PATCH",
      `/orders/${ORDER_ID}`,
      JSON.stringify({ status: "confirmed", note: "gift wrap" }),
      { id: ORDER_ID },
      2
    );
    const contract = generate([create, subResource, member], "patch-body");
    expect(contract).toContain('method: "PATCH"');
    expect(contract).toContain("payload.status");
    expect(contract).toContain("payload.note");
    expect(contract).not.toContain(ORDER_ID);
  }, 60_000);
});
