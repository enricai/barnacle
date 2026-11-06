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
/** Concatenated so Biome does not read the emitted placeholder as a stray template interpolation. */
const BASE_URL_PLACEHOLDER = "$" + "{context.baseUrl}";

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
    expect(contract).toContain(`${BASE_URL_PLACEHOLDER}/order.json`);
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

  it("takes the origin only from context.baseUrl across URL, Origin/Referer headers and body values", () => {
    workDir = mkdtempSync(join(tmpdir(), "recon-cart-update-origin-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
    const ORIGIN = "https://shop.example.com";
    const headers = {
      "content-type": "application/json",
      origin: ORIGIN,
      referer: `${ORIGIN}/cart`,
    };
    const post: Capture = { ...create, requestHeaders: headers };
    const put: Capture = {
      ...update,
      requestHeaders: headers,
      requestPostData: JSON.stringify({
        data: {
          id: ORDER_ID,
          returnUrl: `${ORIGIN}/thanks`,
          contact: { name: "Jane Roe", email: "jane.roe@mail.example.org" },
        },
      }),
    };
    [post, put].forEach((c, i) => {
      writeFileSync(join(capturesDir, `00${i}-action.json`), JSON.stringify(c));
    });
    const siteId = `recon-cart-update-origin-${process.pid}`;
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
    expect(contract).not.toMatch(/\bBaseUrl\b/);
    expect(contract).not.toMatch(/payload\.(baseUrl|origin|returnUrl)/i);
    // The only literal origin is the plugin's defaultBaseUrl metadata; every
    // URL, header and body occurrence goes through context.baseUrl.
    expect(contract.split(ORIGIN).length - 1).toBe(1);
    expect(contract).toContain(`defaultBaseUrl: "${ORIGIN}"`);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting literal interpolation text in generated plugin source
    expect(contract).toContain('origin": `${context.baseUrl}`');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting literal interpolation text in generated plugin source
    expect(contract).toContain('referer": `${context.baseUrl}/cart`');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting literal interpolation text in generated plugin source
    expect(contract).toContain('"returnUrl":"${context.baseUrl}/thanks"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting literal interpolation text in generated plugin source
    expect(contract).toContain("${context.baseUrl}/order.json");
  }, 60_000);

  it.each(["orderId", "order_id"])(
    "threads a bare response id into a PUT body keyed %s instead of freezing it",
    (bodyKey) => {
      workDir = mkdtempSync(join(tmpdir(), "recon-cart-update-idkey-"));
      const runRoot = join(workDir, "run");
      const capturesDir = join(runRoot, "graphql");
      mkdirSync(capturesDir, { recursive: true });
      mkdirSync(join(runRoot, "replays"), { recursive: true });
      mkdirSync(join(runRoot, "aux"), { recursive: true });
      writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
      const put: Capture = {
        ...update,
        requestPostData: JSON.stringify({
          [bodyKey]: ORDER_ID,
          contact: { name: "Jane Roe", email: "jane.roe@mail.example.org" },
        }),
        responseBody: { status: "updated" },
      };
      const post: Capture = { ...create, responseBody: { order: { id: ORDER_ID } } };
      [post, put].forEach((c, i) => {
        writeFileSync(join(capturesDir, `00${i}-action.json`), JSON.stringify(c));
      });
      const siteId = `recon-cart-update-idkey-${bodyKey}-${process.pid}`;
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
      expect(contract).toContain("const id = (r0 as { order: { id: string } }).order.id;");
      expect(contract).toContain(`{"${bodyKey}":"\${id}"`);
      expect(contract).not.toContain(ORDER_ID);
    },
    60_000
  );
  it("threads a short numeric response id into a nested PUT order.id instead of freezing it", () => {
    workDir = mkdtempSync(join(tmpdir(), "recon-cart-update-shortid-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
    const SHORT_ID = 514391;
    const post: Capture = { ...create, responseBody: { id: SHORT_ID, state: "cart" } };
    const put: Capture = {
      ...update,
      requestPostData: JSON.stringify({ order: { id: SHORT_ID, contactName: "Jane Roe" } }),
      responseBody: { id: SHORT_ID, state: "cart" },
    };
    [post, put].forEach((c, i) => {
      writeFileSync(join(capturesDir, `00${i}-action.json`), JSON.stringify(c));
    });
    const siteId = `recon-cart-update-shortid-${process.pid}`;
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
    expect(contract).toContain('method: "PUT"');
    expect(contract).toContain("(r0 as { id: number }).id");
    expect(contract).not.toContain(String(SHORT_ID));
  }, 60_000);
  it("emits one payload field and one body use for a wrapped nested array", () => {
    workDir = mkdtempSync(join(tmpdir(), "recon-cart-update-wrapped-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
    const post: Capture = {
      ...create,
      requestPostData: JSON.stringify({
        order: { items_attributes: [{ sku: "SKU-1", qty: 1 }] },
      }),
    };
    const put: Capture = {
      ...update,
      requestPostData: JSON.stringify({
        order: { id: ORDER_ID, items_attributes: [{ sku: "SKU-1", qty: 2 }], contact_name: "Jane" },
      }),
    };
    [post, put].forEach((c, i) => {
      writeFileSync(join(capturesDir, `00${i}-action.json`), JSON.stringify(c));
    });
    const siteId = `recon-cart-update-wrapped-${process.pid}`;
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
    expect(contract).not.toContain("orderItems_attributes");
    expect(contract.match(/payload\.order\b/g)?.length ?? 0).toBeGreaterThan(0);
    const schema = contract.slice(
      contract.indexOf("PayloadSchema = "),
      contract.indexOf(".merge(JobTrackingSchema)")
    );
    expect(schema.match(/items_attributes: z\.array/g)).toHaveLength(1);
    expect(schema.match(/^ {2}\w+: multipartJsonObject/gm)).toHaveLength(1);
  }, 60_000);
  it("replays an HTML GET, a numeric-id POST and a marker-body PUT in order without leaking the marker", () => {
    workDir = mkdtempSync(join(tmpdir(), "recon-cart-update-html-csrf-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
    const CSRF = "csrf_a1b2c3d4e5f6a7b8";
    const SESS = "sess_9f8e7d6c5b4a";
    const NUM_ID = 514391;
    const page: Capture = {
      ...create,
      timestamp: "2024-01-01T00:00:00Z",
      phase: "navigation",
      method: "GET",
      url: "https://shop.example.com/cart",
      requestHeaders: {},
      requestPostData: null,
      responseHeaders: {
        "content-type": "text/html",
        "set-cookie": `sid=${SESS}; Path=/; HttpOnly`,
      },
      responseBody: `<html><head><meta name="csrf-token" content="${CSRF}"></head><body></body></html>`,
    };
    const hdrs = {
      "content-type": "application/json",
      "x-csrf-token": CSRF,
      cookie: `sid=${SESS}`,
    };
    const post: Capture = {
      ...create,
      timestamp: "2024-01-01T00:00:03Z",
      requestHeaders: hdrs,
      responseBody: { id: NUM_ID, state: "cart" },
    };
    const put: Capture = {
      ...update,
      requestHeaders: hdrs,
      requestPostData: REQUEST_BODY_UNAVAILABLE,
      responseBody: { id: NUM_ID, state: "updated" },
    };
    [page, post, put].forEach((c, i) => {
      writeFileSync(join(capturesDir, `00${i}-action.json`), JSON.stringify(c));
    });
    const siteId = `recon-cart-update-html-csrf-${process.pid}`;
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
    expect(contract.indexOf('method: "POST"')).toBeGreaterThan(-1);
    expect(contract.indexOf('method: "PUT"')).toBeGreaterThan(contract.indexOf('method: "POST"'));
    expect(contract).not.toContain(REQUEST_BODY_UNAVAILABLE);
    expect(contract).not.toContain(String(NUM_ID));
    expect(contract).toContain("x-csrf-token");
  }, 60_000);
});

describe("recon-generate cart-then-update flow with a numeric id and flat contact scalars", () => {
  it("threads the numeric id and exposes name and email as payload inputs", () => {
    workDir = mkdtempSync(join(tmpdir(), "recon-cart-update-flat-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
    const NUM_ID = 514391;
    const post: Capture = { ...create, responseBody: { id: NUM_ID, state: "cart" } };
    const put: Capture = {
      ...update,
      requestPostData: JSON.stringify({
        id: NUM_ID,
        name: "Jane Roe",
        email: "jane.roe@mail.example.org",
        phone: "5551234567",
      }),
      responseBody: { id: NUM_ID, state: "updated" },
    };
    [post, put].forEach((c, i) => {
      writeFileSync(join(capturesDir, `00${i}-action.json`), JSON.stringify(c));
    });
    const siteId = `recon-cart-update-flat-${process.pid}`;
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
    expect(contract).toContain("(r0 as { id: number }).id");
    expect(contract).not.toContain(String(NUM_ID));
    expect(contract).not.toContain("Jane Roe");
    expect(contract).not.toContain("jane.roe@mail.example.org");
    expect(contract).toMatch(/\bname: z\.string\(\)/);
    expect(contract).toMatch(/\bemail: z\.string\(\)/);
    expect(contract).toContain("payload.name");
    expect(contract).not.toContain("5551234567");
    expect(contract).not.toMatch(/\bBaseUrl\b/);
  }, 60_000);
});
