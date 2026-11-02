import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import type { Capture } from "@/scripts/recon-shared";

const REPO_ROOT = join(__dirname, "..", "..");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const ORDER_ID = "ord_8f3a91c2b7d4";
const CSRF = "csrf_a1b2c3d4e5f6a7b8";
const SESS = "sess_9f8e7d6c5b4a";

const create: Capture = {
  timestamp: "2024-01-01T00:00:00Z",
  phase: "action",
  method: "POST",
  url: "https://shop.example.com/order.json",
  status: 200,
  requestHeaders: { "content-type": "application/json" },
  requestPostData: JSON.stringify({ items: [{ sku: "SKU-1", qty: 1 }] }),
  responseHeaders: {
    "content-type": "application/json",
    "set-cookie": `sid=${SESS}; Path=/; HttpOnly`,
    "x-csrf-token": CSRF,
  },
  responseBody: { id: ORDER_ID, status: "open" },
  operationName: null,
  query: null,
  variables: null,
  decodedParams: null,
};

const update: Capture = {
  timestamp: "2024-01-01T00:00:05Z",
  phase: "action",
  method: "PUT",
  url: "https://shop.example.com/order.json",
  status: 200,
  requestHeaders: {
    "content-type": "application/json",
    "x-csrf-token": CSRF,
    cookie: `sid=${SESS}`,
  },
  requestPostData: JSON.stringify({
    id: ORDER_ID,
    contact: { name: "Jane Roe", email: "jane.roe@mail.example.org" },
  }),
  responseHeaders: { "content-type": "application/json" },
  responseBody: { id: ORDER_ID, status: "updated" },
  operationName: null,
  query: null,
  variables: null,
  decodedParams: null,
};

let workDir: string | null = null;
let siteOutDir: string | null = null;
afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
});

describe("recon-generate session-minted csrf header and cookie", () => {
  it("binds the response-minted csrf header and session cookie instead of freezing recorded values", () => {
    workDir = mkdtempSync(join(tmpdir(), "recon-cart-update-e2e-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
    [create, update].forEach((c, i) =>
      writeFileSync(join(capturesDir, `00${i}-action.json`), JSON.stringify(c))
    );
    const siteId = `recon-cart-update-e2e-${process.pid}`;
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
    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).toContain('method: "POST"');
    expect(contract).toContain('method: "PUT"');
    expect(contract).toContain("const id = (r0 as { id: string }).id;");
    expect(contract).toContain('{"id":"${id}","contact":${JSON.stringify(payload.contact)}}');
    expect(contract).toMatch(
      /contact: multipartJsonObject\(z\.object\(\{\s*name: z\.string\(\),\s*email: z\.string\(\)/
    );
    expect(contract).toContain(
      '{ sourceHeader: "set-cookie", cookieName: "sid", targetHeader: "cookie" }'
    );
    expect(contract).toContain('{ sourceHeader: "x-csrf-token", targetHeader: "x-csrf-token" }');
    expect(contract).not.toContain(CSRF);
    expect(contract).not.toContain(SESS);
    expect(contract).not.toContain(ORDER_ID);
    expect(contract).not.toContain("Jane Roe");
  }, 60_000);
});
