import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Bottleneck from "bottleneck";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import { omitHeaderCaseInsensitive } from "@/lib/case-insensitive-headers";
import { mergeFoldedPrimaryBodies } from "@/lib/merge-folded-primary-bodies";
import { createHttpClient } from "@/scraper/http-client";
import {
  extractExecuteHttpBodyFromContract,
  stripEmitterTypeAssertions,
} from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Local variant of evalExecuteHttpBody that additionally binds
 * `omitHeaderCaseInsensitive` and `BASE_HEADERS` — the sibling helper only
 * covers `httpClient`/`z`/`mergeFoldedPrimaryBodies` since no prior caller
 * exercised a multipart step, whose emitted body unqualifiedly references
 * both (recon-generate.ts's multipart branch, ~line 7576).
 */
function evalExecuteHttpBodyWithMultipartBindings(
  body: string,
  httpClient: ReturnType<typeof createHttpClient>,
  z: unknown,
  baseHeaders: Record<string, string>
): (payload: Record<string, unknown>) => Promise<{ data: unknown }> {
  const stripped = stripEmitterTypeAssertions(body);
  const factory = new Function(
    "httpClient",
    "z",
    "mergeFoldedPrimaryBodies",
    "omitHeaderCaseInsensitive",
    "BASE_HEADERS",
    `return async function executeHttp(payload) {\n${stripped}\n};`
  ) as (
    httpClient: unknown,
    z: unknown,
    mergeFoldedPrimaryBodies: unknown,
    omitHeaderCaseInsensitive: unknown,
    baseHeaders: unknown
  ) => (payload: Record<string, unknown>) => Promise<{ data: unknown }>;
  return factory(httpClient, z, mergeFoldedPrimaryBodies, omitHeaderCaseInsensitive, baseHeaders);
}

/**
 * Runtime-execution counterpart to recon-generate-percall-cookie-header-
 * never-frozen.test.ts and recon-generate-volatile-correlation-id-header-
 * not-frozen.test.ts: those pin the fix at the source-text layer (contract.ts
 * never CONTAINS the frozen jar / captured correlation id). This actually
 * RUNS the generated executeHttp against a mocked fetch — covering both the
 * httpClient-routed non-multipart path and the raw-fetch multipart path in
 * the SAME flow — and inspects the headers that were genuinely sent on every
 * call, proving the fix holds at execution time, not merely in the emitted
 * template text.
 *
 * REGRESSION-PINNING: recon-generate.ts's per-call header loops (non-
 * multipart ~line 6856, multipart ~line 7523) must keep dropping a captured
 * Cookie header unconditionally, per commit ae3ab99 (restoring the
 * unconditional skip that commit bb32ee1/#474 had regressed back to a
 * partial per-cookie-pair interpolation after f0de9ad/#473 already fixed
 * it). If that skip is ever narrowed again, this test fails.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.session-header-runtime-execution-fixture.example.com";
const SEARCH_URL = `https://${OWN_BACKEND_HOST}/catalog/search/`;
const MINT_URL = `https://${OWN_BACKEND_HOST}/auth/mint/`;
const PRIVATE_URL = `https://${OWN_BACKEND_HOST}/catalog/private/`;
const UPLOAD_URL = `https://${OWN_BACKEND_HOST}/catalog/upload/`;

const CORRELATION_ID = "3f9e2b1a-6d4c-4a7e-9c2f-1a2b3c4d5e6f";
// Deliberately >= MIN_STATE_VALUE_LENGTH (8, recon-generate.ts:2986) and
// present verbatim in BOTH the cookie jar and the request body, so the
// generic same-value STATE-threading pass genuinely recognizes it as
// threadable and would partially interpolate the jar if the unconditional
// Cookie-drop were ever narrowed back to a per-pair splice-and-keep — the
// exact shape recon-generate-percall-cookie-header-never-frozen.test.ts pins
// at the source-text layer.
const FACET_VALUE = "december-2026-promo";
const MINTED_TOKEN = "MINTED_SESSION_TOKEN_ABC123DEF456";

const SESSION_ID_PAIR = "sessionId=sess-9f8e7d6c5b4a3210";
const ADOBE_PAIR_1 = "AMCV_ADOBEORG=1234567890%7CMCIDTS%7C19999";
const ADOBE_PAIR_2 = "AMCVS_ADOBEORG=1";
const BOT_MANAGER_PAIR = "ak_bmsc=AK_BMSC_LONG_OPAQUE_VALUE_1234567890ABCDEF";
const JWT_PAIR =
  "authJwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.4a3e2f1b9c8d7e6f5a4b3c2d1e0f9a8b";

/** Mixes session/analytics/bot-manager/JWT noise with a facet fragment that
 * partial-matches the registered payload accessor — none of these are
 * Set-Cookie-response origin values, so none may ever ride along frozen. */
function unboundCookieJar(): string {
  return [
    SESSION_ID_PAIR,
    ADOBE_PAIR_1,
    ADOBE_PAIR_2,
    BOT_MANAGER_PAIR,
    JWT_PAIR,
    `facetFilters=${FACET_VALUE},other-unrelated-value`,
  ].join("; ");
}

const NOISE_FRAGMENTS = [SESSION_ID_PAIR, ADOBE_PAIR_1, ADOBE_PAIR_2, BOT_MANAGER_PAIR, JWT_PAIR];

function fixtureCaptures(): Capture[] {
  const search = buildCapture({
    url: SEARCH_URL,
    requestPostData: JSON.stringify({ facetFilters: FACET_VALUE }),
    responseBody: { results: [{ itemId: "item-a" }] },
    requestHeaders: {
      "Content-Type": "application/json",
      Cookie: unboundCookieJar(),
      "X-Correlation-Id": CORRELATION_ID,
    },
    timestamp: "2026-01-01T00:00:00Z",
  });
  const mint = buildCapture({
    url: MINT_URL,
    requestPostData: "{}",
    responseBody: {},
    requestHeaders: {
      "Content-Type": "application/json",
      "X-Correlation-Id": CORRELATION_ID,
    },
    responseHeaders: {
      "content-type": "application/json",
      "set-cookie": `authToken=${MINTED_TOKEN}; Path=/; HttpOnly`,
    },
    timestamp: "2026-01-01T00:00:01Z",
  });
  const consumePrivate = buildCapture({
    url: PRIVATE_URL,
    method: "POST",
    requestPostData: "{}",
    responseBody: { products: [] },
    requestHeaders: {
      "Content-Type": "application/json",
      Cookie: `authToken=${MINTED_TOKEN}`,
      "X-Correlation-Id": CORRELATION_ID,
    },
    timestamp: "2026-01-01T00:00:02Z",
  });
  const upload = buildCapture({
    url: UPLOAD_URL,
    requestPostData: null,
    responseBody: { ok: true },
    requestHeaders: {
      "Content-Type": "multipart/form-data",
      Cookie: unboundCookieJar(),
      "X-Correlation-Id": CORRELATION_ID,
    },
    timestamp: "2026-01-01T00:00:03Z",
  });
  return [search, mint, consumePrivate, upload];
}

function writeRunDir(root: string, captures: Capture[]): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));
  captures.forEach((capture, index) => {
    writeFileSync(
      join(root, "graphql", `${String(index).padStart(3, "0")}-capture.json`),
      JSON.stringify(capture)
    );
  });
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("recon-generate emitted executeHttp — a captured Cookie jar and a volatile correlation id never reach a real outgoing request", () => {
  it("drops every noise-cookie fragment on both the non-multipart and multipart calls, re-mints the correlation id, and still threads a genuine Set-Cookie bind", async () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-session-header-runtime-execution-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `session-header-runtime-execution-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "search the catalog" },
          { step: "mint a session token" },
          { step: "load the private catalog view" },
          { step: "upload a supporting file", submitStep: true },
        ],
        submitEndpointPattern: "catalog/upload",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [OWN_BACKEND_HOST],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // Precondition sanity checks mirroring the sibling source-text tests —
    // kept only to fail fast with a clearer message before the runtime proof.
    expect(contract).not.toMatch(/["']?[Cc]ookie["']?\s*:\s*["`]/);
    expect(contract).not.toContain(CORRELATION_ID);
    expect(contract).toMatch(/bind:\s*\[\{[^}]*sourceHeader:\s*"set-cookie"/);
    expect(contract).toContain('cookieName: "authToken"');

    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);
    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });

    const bindMatch = /bind:\s*(\[\{[\s\S]*?\}\])/.exec(contract);
    const bind = bindMatch ? (new Function(`return ${bindMatch[1]};`)() as unknown) : undefined;

    const baseHeaders = { "Content-Type": "application/json" };
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders,
      // biome-ignore lint/suspicious/noExplicitAny: bind's literal shape is parsed out of the emitted contract source, not statically typed here
      bind: bind as any,
    });

    const responseForUrl = (url: string): unknown => {
      if (url.includes("catalog/search")) return { results: [{ itemId: "item-a" }] };
      if (url.includes("auth/mint")) return {};
      if (url.includes("catalog/private")) return { products: [] };
      return { ok: true };
    };

    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string, init?: { headers?: Record<string, string> }) => {
        calls.push({ url, headers: { ...(init?.headers ?? {}) } });
        const isMint = url.includes("auth/mint");
        return Promise.resolve({
          status: 200,
          ok: true,
          text: vi.fn().mockResolvedValue(JSON.stringify(responseForUrl(url))),
          json: vi.fn().mockResolvedValue(responseForUrl(url)),
          headers: isMint
            ? new Headers([["set-cookie", `authToken=${MINTED_TOKEN}; Path=/; HttpOnly`]])
            : new Headers(),
        });
      });
    vi.stubGlobal("fetch", fetchMock);

    const executeHttp = evalExecuteHttpBodyWithMultipartBindings(
      executeHttpBody,
      httpClient,
      z,
      baseHeaders
    );

    await executeHttp({
      BaseUrl: `https://${OWN_BACKEND_HOST}`,
      facetFilters: FACET_VALUE,
      Resume: Buffer.from("proof-file-bytes"),
      ResumeContentType: "application/pdf",
      ResumeFilename: "proof.pdf",
    });

    expect(calls.length).toBeGreaterThanOrEqual(4);

    // (a) none of the outgoing request headers, on ANY call (non-multipart
    // httpClient-routed OR multipart raw-fetch), ever carry a fragment of
    // the captured unbound cookie jar.
    for (const call of calls) {
      const headerValues = Object.values(call.headers);
      for (const fragment of NOISE_FRAGMENTS) {
        for (const value of headerValues) {
          expect(value).not.toContain(fragment);
        }
      }
      for (const value of headerValues) {
        expect(value).not.toBe(CORRELATION_ID);
        expect(value).not.toContain(CORRELATION_ID);
      }
    }

    // (b) a correlation-id-shaped header, when present, is a freshly minted
    // UUID different from the captured literal — same value reused across
    // every call in THIS invocation (one hoisted mint per executeHttp call,
    // per recon-generate.ts's volatileHeaderVarNames), but never the
    // captured one.
    const correlationValues = new Set(
      calls
        .map((call) => call.headers["X-Correlation-Id"] ?? call.headers["x-correlation-id"])
        .filter((v): v is string => v !== undefined)
    );
    expect(correlationValues.size).toBeGreaterThan(0);
    for (const value of correlationValues) {
      expect(value).toMatch(UUID_RE);
      expect(value).not.toBe(CORRELATION_ID);
    }
    expect(correlationValues.size).toBe(1);

    // (c) the genuine Set-Cookie-bound cookie minted by the mint call earlier
    // in the SAME run correctly threads onto the later private-view call's
    // Cookie header.
    const privateCall = calls.find((call) => call.url.includes("catalog/private"));
    expect(privateCall).toBeDefined();
    const privateCookieHeader = privateCall?.headers.Cookie ?? privateCall?.headers.cookie;
    expect(privateCookieHeader).toContain(MINTED_TOKEN);
  }, 30_000);
});
