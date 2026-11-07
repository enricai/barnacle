import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import type { Capture } from "@/scripts/recon-shared";

const REPO_ROOT = join(__dirname, "..", "..");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");
const HOST = "https://shop.example.com";

/** A short numeric id, below the state-value length floor. */
const ORDER_ID = "48213";
/** Concatenated so Biome does not read the emitted placeholder as a stray template interpolation. */
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

function formWrite(method: string, body: string): Capture {
  return {
    ...write(method, "/orders", body, { id: ORDER_ID }, 1),
    requestHeaders: { "content-type": "application/x-www-form-urlencoded" },
  };
}

const create = write(
  "POST",
  "/orders",
  JSON.stringify({ items: [{ sku: "SKU-1", qty: 1 }] }),
  { id: ORDER_ID, status: "open" },
  0
);

let workDir: string | null = null;
let siteOutDir: string | null = null;
afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
});
function generate(captures: Capture[], tag: string): string {
  workDir = mkdtempSync(join(tmpdir(), `recon-form-id-${tag}-`));
  const runRoot = join(workDir, "run");
  const capturesDir = join(runRoot, "graphql");
  mkdirSync(capturesDir, { recursive: true });
  mkdirSync(join(runRoot, "replays"), { recursive: true });
  mkdirSync(join(runRoot, "aux"), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
  captures.forEach((c, i) => {
    writeFileSync(join(capturesDir, `00${i}-action.json`), JSON.stringify(c));
  });
  const siteId = `recon-form-id-${tag}-${process.pid}`;
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

describe("recon-generate cart-then-update where a later form-encoded write re-sends the created short id", () => {
  it.each([
    ["flat key", "PUT", `orderId=${ORDER_ID}&contact_name=Jane+Roe`, `orderId=${ID}&`],
    ["bare id key", "PUT", `id=${ORDER_ID}&name=Jane+Roe`, `id=${ID}&`],
    [
      "Rails-style bracketed key",
      "PUT",
      `order[id]=${ORDER_ID}&order[contact_name]=Jane+Roe`,
      `order[id]=${ID}&`,
    ],
    [
      "percent-encoded bracketed key",
      "PUT",
      `order%5Bid%5D=${ORDER_ID}&order%5Bcontact%5D%5Bname%5D=Jane+Roe`,
      `order%5Bid%5D=${ID}&`,
    ],
    ["PATCH", "PATCH", `order_id=${ORDER_ID}&contact_name=Jane+Roe`, `order_id=${ID}&`],
  ])(
    "threads the id into a %s body instead of freezing it",
    (tag, method, body, expected) => {
      const contract = generate([create, formWrite(method, body)], tag.replace(/\W+/g, "-"));
      expect(contract).toContain(`method: "${method}"`);
      expect(contract).toContain("const id = (r0 as { id: string }).id;");
      expect(contract).toContain(expected);
      expect(contract).not.toContain(`=${ORDER_ID}`);
    },
    60_000
  );

  it("does not splice the id into a differently-named field that merely shares its digits", () => {
    const contract = generate(
      [create, formWrite("PUT", `order_id=${ORDER_ID}&zip=${ORDER_ID}`)],
      "coincidence"
    );
    expect(contract).toContain(`order_id=${ID}&zip=48213`);
  }, 60_000);
});
