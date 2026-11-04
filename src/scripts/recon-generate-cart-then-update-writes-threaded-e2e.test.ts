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

const ORDER_ID = "ord_8f3a91c2b7d4";

const create: Capture = {
  timestamp: "2024-01-01T00:00:00Z",
  phase: "action",
  method: "POST",
  url: "https://shop.example.com/order.json",
  status: 200,
  requestHeaders: { "content-type": "application/json" },
  requestPostData: JSON.stringify({ items: [{ sku: "SKU-1", qty: 1 }] }),
  responseHeaders: { "content-type": "application/json" },
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
  requestHeaders: { "content-type": "application/json" },
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

describe("recon-generate cart-then-update flow", () => {
  it("keeps a PUT whose body is unavailable as an ordered step with the id threaded", () => {
    workDir = mkdtempSync(join(tmpdir(), "recon-cart-update-marker-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
    [create, { ...update, requestPostData: REQUEST_BODY_UNAVAILABLE }].forEach((c, i) => {
      writeFileSync(join(capturesDir, `00${i}-action.json`), JSON.stringify(c));
    });
    const siteId = `recon-cart-update-marker-${process.pid}`;
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
    expect(contract).not.toContain(REQUEST_BODY_UNAVAILABLE);
    expect(contract).not.toMatch(/\bBaseUrl\s*:\s*z\./);
    expect(contract).toContain("${context.baseUrl}/order.json");
    expect(contract.match(/items: multipartJsonObject/g)?.length).toBe(1);
    expect(contract).not.toContain(ORDER_ID);
  }, 60_000);

  it("emits both writes, threads the created id, and exposes contact fields as payload inputs", () => {
    workDir = mkdtempSync(join(tmpdir(), "recon-cart-update-e2e-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
    [create, update].forEach((c, i) => {
      writeFileSync(join(capturesDir, `00${i}-action.json`), JSON.stringify(c));
    });
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
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    expect(contract).toContain('{"id":"${id}","contact":${JSON.stringify(payload.contact)}}');
    expect(contract).toMatch(
      /contact: multipartJsonObject\(z\.object\(\{\s*name: z\.string\(\),\s*email: z\.string\(\)/
    );
    expect(contract).not.toContain(ORDER_ID);
    expect(contract).not.toContain("Jane Roe");
  }, 60_000);
});
