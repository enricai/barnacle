import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CONFIG_PLUGIN_API_VERSION, CONFIG_PLUGIN_KIND } from "@/plugins/plugin-manifest-envelope";
import type { ReconFormSchema } from "@/recon/form-schema";
import type { ReconVocabulary } from "@/recon/vocabulary";
import { EMPTY_VOCABULARY } from "@/recon/vocabulary";
import {
  buildKnownFieldValues,
  collectHeaderBindings,
  compileActionSteps,
  detectFormSchemaFieldNames,
  emitBrowserFlowTs,
  emitConfigManifest,
  emitContractTs,
  emitMultiStepExecuteHttp,
  extractActionSequence,
  extractGraphQLActionSequence,
  gatherResponseBodySamples,
  indexStateValues,
  inferZodSchemaFromSamples,
  resolveManifestActionSequence,
  resolveStepPayloadField,
  sanitizeFixtureIdentifier,
  selectEffectiveResponseBody,
  selectPayloadAction,
  selectPrimaryGraphQLOperation,
  selectReturnAction,
} from "@/scripts/recon-generate";
import {
  buildMulticallDependentDrillDownActionSteps,
  buildMulticallHeterogeneousActionSteps,
  buildMulticallHeterogeneousActionStepsWithDrillDown,
  buildMulticallSingleShotSearchDrillDownChainedDependentActionSteps,
  buildMulticallSingleShotSearchDrillDownShortCookieChainedJoinFieldActionSteps,
  buildMulticallSingleShotSearchDrillDownShortNumericChainedJoinFieldActionSteps,
  buildStep,
} from "@/scripts/recon-generate-multicall-fixture";
import { buildRepeatedSectionSubmissionCaptures } from "@/scripts/recon-generate-repeated-section-fixture";
import type { Capture } from "@/scripts/recon-shared";

/** The recon env-var token for the applicant email, built by concatenation so
 * Biome's noTemplateCurlyInString rule doesn't flag the literal `${...}`. */
const RECON_EMAIL_TOKEN = `$${"{RECON_EMAIL}"}`;
/** Splice reference the emitter injects, e.g. `${payload.FirstName}`. */
function payloadRef(field: string): string {
  return `$${`{payload.${field}}`}`;
}

/** A bare template-literal reference the emitter injects, e.g. `${draftId}`.
 * Built by concatenation so Biome's noTemplateCurlyInString rule doesn't flag
 * the literal placeholder in this test source. */
function interpRef(name: string): string {
  return `$${`{${name}}`}`;
}

/** Minimal opts that satisfy the emitter for a non-multipart plugin. */
const BASE_OPTS = {
  siteId: "test-site",
  pascal: "TestSite",
  baseUrl: "https://example.com",
  baseHeaders: { "Content-Type": "application/json" },
  minTime: 100,
  safeRps: 10,
  responseBody: { id: "abc", active: true },
  gql: false,
  gqlQuery: null,
  endpointPath: "/api/search",
  auxFiles: [],
};

describe("emitContractTs — multipart plugin", () => {
  const source = emitContractTs({
    ...BASE_OPTS,
    hasMultipartStep: true,
    inputBody: { Name: "Alice", SmsOptIn: true, Score: 1 },
    discoveredAdditionalBodyKeys: new Map([["SmsOptIn", "boolean"]]),
    multiStepBody: `    return { data: {} as unknown };`,
  });

  it("imports multipartBoolean and multipartJsonObject from the package subpath, not the @/ alias", () => {
    expect(source).toContain(
      'import { multipartBoolean, multipartJsonObject } from "@enricai/barnacle/lib/zod-multipart"'
    );
  });

  it("uses multipartBoolean() at boolean payload fields", () => {
    expect(source).toContain("multipartBoolean()");
  });

  it("does not emit an inline MULTIPART_BOOL const declaration", () => {
    expect(source).not.toContain("MULTIPART_BOOL");
    expect(source).not.toContain('z.preprocess(\n  (v) => (v === "true"');
  });

  it("does not emit a redundant Resume field extend — ApplicantContactSchema already declares it", () => {
    expect(source.match(/^\s*Resume:/gm)).toBeNull();
  });
});

describe("emitContractTs — query-type plugin with a multipart step", () => {
  const source = emitContractTs({
    ...BASE_OPTS,
    hasMultipartStep: true,
  });

  it("still extends Resume/ResumeContentType/ResumeFilename onto the query-type base, since basePayloadSchemaExpr has no ApplicantContactSchema to supply them from", () => {
    expect(source).toContain("Resume: z.instanceof(Buffer)");
    expect(source).toContain("ResumeContentType: z.string()");
    expect(source).toContain("ResumeFilename: z.string()");
  });
});

describe("emitContractTs — submission-flow default candidate-payload bodySchema", () => {
  const source = emitContractTs({
    ...BASE_OPTS,
    hasMultipartStep: true,
    inputBody: { ddoKey: "applySubmit", formData: {} },
    multiStepBody: `    return { data: {} as unknown };`,
  });

  it("imports ApplicantContactSchema from the package's applicant-payload subpath", () => {
    expect(source).toContain(
      'import { ApplicantContactSchema } from "@enricai/barnacle/lib/applicant-payload"'
    );
  });

  it("imports multipartJsonObject from the zod-multipart subpath, without multipartBoolean since inputBody has no boolean field", () => {
    expect(source).toContain(
      'import { multipartJsonObject } from "@enricai/barnacle/lib/zod-multipart"'
    );
    expect(source).not.toContain("multipartBoolean");
  });

  it("extends ApplicantContactSchema with Email, ClickUrl, and Answers", () => {
    expect(source).toContain("ApplicantContactSchema.extend({");
    expect(source).toContain("Email: z.email()");
    expect(source).toContain("ClickUrl: z.string().min(1)");
    expect(source).toContain("Answers: multipartJsonObject(");
  });

  it("marks the plugin meta as multipart", () => {
    expect(source).toContain("multipart: true,");
  });

  it("does not emit the site-shaped inputBody keys as bodySchema fields", () => {
    const payloadSchemaBlock = source.slice(
      source.indexOf("const TestSitePayloadSchema"),
      source.indexOf("export type TestSitePayload")
    );
    expect(payloadSchemaBlock).not.toContain("ddoKey");
  });

  it("demotes the site-shaped inputBody keys to the internal-reference scaffold instead", () => {
    expect(source).toContain("export const TestSiteInternalRequestReference");
    expect(source).toContain("ddoKey: z.string()");
  });
});

describe("emitContractTs — non-multipart plugin", () => {
  const source = emitContractTs({
    ...BASE_OPTS,
    hasMultipartStep: false,
    inputBody: { Name: "Alice", Active: true },
    discoveredAdditionalBodyKeys: new Map([["Active", "boolean"]]),
  });

  it("does not import multipartBoolean", () => {
    expect(source).not.toContain("multipartBoolean");
  });

  it("uses z.boolean() for boolean fields", () => {
    expect(source).toContain("z.boolean()");
  });
});

describe("emitContractTs — responseBodySamples widens the client-level ResponseSchema across multiple captures", () => {
  it("marks a leaf key present in only one sample .optional() (previously required from a single capture)", () => {
    const singleSample = emitContractTs({
      ...BASE_OPTS,
      responseBody: { id: "abc", active: true, tags: ["a"] },
    });
    expect(singleSample).toContain("tags: z.array(z.string()),");

    const multiSample = emitContractTs({
      ...BASE_OPTS,
      responseBody: { id: "abc", active: true, tags: ["a"] },
      responseBodySamples: [
        { id: "abc", active: true, tags: ["a"] },
        { id: "def", active: false },
      ],
    });
    expect(multiSample).toContain("tags: z.array(z.string()).optional(),");
  });

  it("defaults to [responseBody] when responseBodySamples is omitted, keeping existing single-capture call sites unchanged", () => {
    const withoutSamples = emitContractTs(BASE_OPTS);
    const withExplicitSingleSample = emitContractTs({
      ...BASE_OPTS,
      responseBodySamples: [BASE_OPTS.responseBody],
    });
    expect(withoutSamples).toBe(withExplicitSingleSample);
  });
});

describe("gatherResponseBodySamples — groups by operation identity, filters to 2xx, dedupes", () => {
  const BASE = "https://jobs.example.com";
  const restCapture = (path: string, status: number, responseBody: unknown): Capture => ({
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action",
    method: "GET",
    url: `${BASE}${path}?page=1`,
    status,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody,
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  });

  it("collects every 2xx same-endpoint capture's response body, deduplicated, ignoring a non-2xx re-fire", () => {
    const winning = restCapture("/api/listings", 200, { id: "1", tags: ["a"] });
    const captures = [
      winning,
      restCapture("/api/listings", 200, { id: "2" }),
      restCapture("/api/listings", 200, { id: "1", tags: ["a"] }),
      restCapture("/api/listings", 500, { error: "boom" }),
      restCapture("/api/other", 200, { unrelated: true }),
    ];

    const samples = gatherResponseBodySamples(winning, false, captures);

    expect(samples).toEqual([{ id: "1", tags: ["a"] }, { id: "2" }]);
  });

  it("falls back to [winningCapture.responseBody] when nothing else in the run shares its identity", () => {
    const winning = restCapture("/api/listings", 200, { id: "1" });
    const samples = gatherResponseBodySamples(winning, false, [winning]);
    expect(samples).toEqual([{ id: "1" }]);
  });

  it("returns [null] when there is no winning capture", () => {
    expect(gatherResponseBodySamples(null, false, [])).toEqual([null]);
  });
});

describe("emitContractTs — non-scalar discoveredStructuredKeys field forces multipart, no upload step", () => {
  const source = emitContractTs({
    ...BASE_OPTS,
    hasMultipartStep: false,
    discoveredStructuredKeys: new Map([["eventData", "z.object({ a: z.string() })"]]),
  });

  it("emits multipart: true in meta even though hasMultipartStep is false", () => {
    expect(source).toContain("multipart: true,");
  });

  it("wraps the structured field in multipartJsonObject(...)", () => {
    expect(source).toContain("eventData: multipartJsonObject(z.object({ a: z.string() })),");
  });

  it("imports multipartJsonObject from the package subpath", () => {
    expect(source).toContain('multipartJsonObject } from "@enricai/barnacle/lib/zod-multipart"');
  });
});

describe("emitContractTs — purely scalar payload, no upload step, no structured keys", () => {
  const source = emitContractTs({
    ...BASE_OPTS,
    hasMultipartStep: false,
    discoveredAdditionalBodyKeys: new Map([["Active", "boolean"]]),
  });

  it("still omits multipart: true (no regression)", () => {
    expect(source).not.toContain("multipart: true,");
  });

  it("still uses z.boolean(), not multipartBoolean()", () => {
    expect(source).toContain("Active: z.boolean(),");
    expect(source).not.toContain("multipartBoolean");
  });
});

describe("emitContractTs — hasMultipartStep:true with no structured keys keeps unwrapped Resume shape", () => {
  const source = emitContractTs({
    ...BASE_OPTS,
    hasMultipartStep: true,
  });
  const priorFixSource = emitContractTs({
    ...BASE_OPTS,
    hasMultipartStep: true,
    discoveredStructuredKeys: new Map(),
  });

  it("keeps the current unwrapped Resume-extend shape unchanged", () => {
    expect(source).toContain(
      ".extend({\n  Resume: z.instanceof(Buffer),\n  ResumeContentType: z.string(),\n  ResumeFilename: z.string(),\n})"
    );
    expect(source).not.toContain("multipartJsonObject(z.instanceof(Buffer))");
  });

  it("is byte-for-byte identical to an explicit empty discoveredStructuredKeys map (no regression from the size-based multipart gate)", () => {
    expect(source).toBe(priorFixSource);
  });

  it("does not import multipartBoolean — payloadNeedsMultipart alone never wraps a boolean field", () => {
    expect(source).not.toContain("multipartBoolean");
  });
});

describe("emitContractTs — plain file-upload flow with no boolean fields does not import multipartBoolean", () => {
  const source = emitContractTs({
    ...BASE_OPTS,
    hasMultipartStep: true,
    discoveredStructuredKeys: new Map([["eventData", "z.object({ a: z.string() })"]]),
  });

  it("imports multipartJsonObject (Answers/structured field, genuinely used)", () => {
    expect(source).toContain("multipartJsonObject");
  });

  it("does not import multipartBoolean — no boolean field is ever wrapped in it", () => {
    expect(source).not.toContain("multipartBoolean");
  });
});

describe("emitContractTs — multipartCoerce boolean inside inputBody alone (no additional-body-key) still imports multipartBoolean", () => {
  const source = emitContractTs({
    ...BASE_OPTS,
    hasMultipartStep: true,
    inputBody: { active: true },
    multiStepBody: `    return { data: {} as unknown };`,
  });

  it("imports multipartBoolean", () => {
    expect(source).toContain(
      'import { multipartBoolean, multipartJsonObject } from "@enricai/barnacle/lib/zod-multipart"'
    );
  });

  it("emits a multipartBoolean() call site in the internal request reference", () => {
    expect(source).toContain("active: multipartBoolean()");
  });
});

describe("emitContractTs — hasMultipartStep:false with no structured keys keeps pre-change output byte-for-byte", () => {
  const withoutStructuredKeysArg = emitContractTs({
    ...BASE_OPTS,
    hasMultipartStep: false,
    discoveredAdditionalBodyKeys: new Map([["Active", "boolean"]]),
  });
  const withEmptyStructuredKeysMap = emitContractTs({
    ...BASE_OPTS,
    hasMultipartStep: false,
    discoveredAdditionalBodyKeys: new Map([["Active", "boolean"]]),
    discoveredStructuredKeys: new Map(),
  });

  it("is byte-for-byte identical whether discoveredStructuredKeys is omitted or an empty map", () => {
    expect(withoutStructuredKeysArg).toBe(withEmptyStructuredKeysMap);
  });

  it("omits multipart: true and uses plain z.boolean()", () => {
    expect(withoutStructuredKeysArg).not.toContain("multipart: true,");
    expect(withoutStructuredKeysArg).toContain("Active: z.boolean(),");
  });
});

describe("emitContractTs — hasMultipartStep:true combined with non-empty discoveredStructuredKeys stays multipart (both drivers agree)", () => {
  const source = emitContractTs({
    ...BASE_OPTS,
    hasMultipartStep: true,
    inputBody: { Name: "Alice" },
    discoveredStructuredKeys: new Map([["eventData", "z.object({ a: z.string() })"]]),
  });

  it("still emits multipart: true", () => {
    expect(source).toContain("multipart: true,");
  });

  it("still wraps the structured field in multipartJsonObject(...)", () => {
    expect(source).toContain("eventData: multipartJsonObject(z.object({ a: z.string() })),");
  });

  it("does not import multipartBoolean — no boolean field is ever wrapped in it, even though multipartJsonObject is genuinely used", () => {
    expect(source).not.toContain("multipartBoolean");
  });
});

describe("emitContractTs — incrediblehealth-shaped regression: resume-upload submission flow with a structured Answers field", () => {
  // Models the recon-generate-payload-schema-mismatch.md incrediblehealth case
  // study (lines 48-51): a submission flow with a resume-upload step
  // (hasMultipartStep: true) whose captured request carries a non-scalar
  // Answers-like block. autoapply PR #118 had to hand-fix the generated
  // contract.ts to add meta.multipart:true and wrap that field in
  // multipartJsonObject() because the generator emitted neither by default.
  const source = emitContractTs({
    ...BASE_OPTS,
    hasMultipartStep: true,
    inputBody: {
      ddoKey: "applySubmit",
      Answers: [{ questionId: "q1", answer: "yes" }],
    },
    discoveredStructuredKeys: new Map([
      ["Answers", "z.array(z.object({ questionId: z.string(), answer: z.string() }))"],
    ]),
    multiStepBody: `    return { data: {} as unknown };`,
  });

  it("defaults meta.multipart to true with no hand-fix", () => {
    expect(source).toContain("multipart: true,");
  });

  it("wraps the Answers-derived field in multipartJsonObject(...)", () => {
    expect(source).toContain(
      "Answers: multipartJsonObject(z.array(z.object({ questionId: z.string(), answer: z.string() }))),"
    );
  });
});

/** Minimal ActionStep with a multipart upload request. */
const MULTIPART_ACTION_STEP = {
  capture: {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action",
    method: "POST",
    url: "https://api.example.com/upload/files",
    status: 200,
    requestHeaders: { "Content-Type": "multipart/form-data", Accept: "application/json" },
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    responseBody: { success: true },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  },
  varName: "r0",
  produces: [],
  isMultipart: true,
  isCrossDomain: false,
};

describe("emitMultiStepExecuteHttp — multipart upload step", () => {
  const body = emitMultiStepExecuteHttp(
    [MULTIPART_ACTION_STEP],
    null,
    { stringMessageKey: null, nestedErrorPaths: [] },
    new Map(),
    new Set(),
    new Map(),
    new Set(),
    new Map(),
    new Map(),
    "https://api.example.com",
    new Map(),
    new Map()
  );

  it('emits omitHeaderCaseInsensitive(BASE_HEADERS, "Content-Type") for the upload headers', () => {
    expect(body).toContain('omitHeaderCaseInsensitive(BASE_HEADERS, "Content-Type")');
  });

  it("does not emit the inline Object.fromEntries filter idiom", () => {
    expect(body).not.toContain("Object.fromEntries(Object.entries(BASE_HEADERS)");
  });
});

/** Second action step whose URL echoes an inputBody array element, forcing
 * the payload-accessor substitution pass to emit a bracket-indexed path. */
const ARRAY_PAYLOAD_ACTION_STEP = {
  capture: {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "action",
    method: "GET",
    url: "https://api.example.com/search?criteria=longcriteriavalue",
    status: 200,
    requestHeaders: { Accept: "application/json" },
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    responseBody: { results: [] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  },
  varName: "r1",
  produces: [],
  isMultipart: false,
  isCrossDomain: false,
};

describe("emitMultiStepExecuteHttp — payload accessor through an array-indexed path", () => {
  const body = emitMultiStepExecuteHttp(
    [MULTIPART_ACTION_STEP, ARRAY_PAYLOAD_ACTION_STEP],
    { sorts: ["longcriteriavalue"] },
    { stringMessageKey: null, nestedErrorPaths: [] },
    new Map(),
    new Set(),
    new Map(),
    new Set(),
    new Map(),
    new Map(),
    "https://api.example.com",
    new Map(),
    new Map()
  );

  it("emits a non-null-asserted bracket accessor for the array element", () => {
    expect(body).toContain(`$${'{payload.sorts["0"]!}'}`);
  });
});

describe("extractActionSequence — error-reporting sinks never reach the emitted flow", () => {
  const capture = (url: string, body: string) => ({
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action" as const,
    method: "POST",
    url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: body,
    responseHeaders: {},
    responseBody: {},
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  });

  const BASE = "https://listings-fixture.example.com";
  // The real shape: a browser's Angular error handler posting a frozen crash —
  // a stack trace and a recon-time timestamp that a replayed plugin would send
  // to the site as a fabricated error report on every invocation.
  const errorReport = capture(
    `${BASE}/listings-avail-spa/error`,
    '[["Error logged by WDPR RA Angular Error handler service","{\\"timestamp\\":1784247853926,\\"message\\":\\"Script load error for //connect.facebook.net/en_US/fbevents.js\\"}"]]'
  );

  it("drops error sinks while keeping the calls that carry the flow", () => {
    const kept = extractActionSequence([
      capture(`${BASE}/listings-avail-api/authz/private`, "{}"),
      errorReport,
      capture(`${BASE}/listings-avail-api/available-products/`, '{"page":1}'),
      errorReport,
    ]).map((a) => new URL(a.capture.url).pathname);

    expect(kept).toEqual([
      "/listings-avail-api/authz/private",
      "/listings-avail-api/available-products/",
    ]);
  });

  it("matches a whole path segment, so data endpoints that merely spell 'error' survive", () => {
    const kept = extractActionSequence([
      capture(`${BASE}/api/error-codes`, "{}"),
      capture(`${BASE}/api/terrorism-screening`, "{}"),
      capture(`${BASE}/api/errors`, "{}"),
    ]).map((a) => new URL(a.capture.url).pathname);

    expect(kept).toEqual(["/api/error-codes", "/api/terrorism-screening"]);
  });
});

describe("extractActionSequence — host is not a filter criterion", () => {
  const capture = (url: string, body: string) => ({
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action" as const,
    method: "POST",
    url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: body,
    responseHeaders: {},
    responseBody: {},
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  });

  it("keeps non-GET 2xx non-noise captures whose host differs from every other capture's host", () => {
    // Mirrors a real multi-step submission: an account-creation redirect
    // lands the flow on a tenant API subdomain distinct from the landing page.
    const kept = extractActionSequence([
      capture("https://api.tenant.example.com/account/create", "{}"),
      capture("https://api.tenant.example.com/sections/name", '{"name":"x"}'),
      capture("https://api.tenant.example.com/submit", "{}"),
    ]).map((a) => a.capture.url);

    expect(kept).toEqual([
      "https://api.tenant.example.com/account/create",
      "https://api.tenant.example.com/sections/name",
      "https://api.tenant.example.com/submit",
    ]);
  });

  it("retains a capture whose host differs from every sibling capture in the same fixture", () => {
    // The landing page is on the marketing host, but the actual submission
    // redirects to a distinct tenant API host — neither is noise per isNoiseUrl.
    const kept = extractActionSequence([
      capture("https://www.example-corp.com/apply", "{}"),
      capture("https://api.tenant.example.com/submit", "{}"),
    ]).map((a) => a.capture.url);

    expect(kept).toEqual([
      "https://www.example-corp.com/apply",
      "https://api.tenant.example.com/submit",
    ]);
  });
});

describe("extractActionSequence — submit patterns isolate the submission from same-URL chrome", () => {
  const capture = (url: string, body: string) => ({
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action" as const,
    method: "POST",
    url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: body,
    responseHeaders: {},
    responseBody: {},
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  });

  const BASE = "https://www.example-ats.org";
  // Matches a real ATS endpoint overload: /applySubmit is hit by the real
  // submission (ddoKey applySubmit) AND page-chrome reference-lookups (ddoKey
  // applyGetReferences), plus unrelated /widgets bootstrap chrome.
  const realSubmit = capture(`${BASE}/applySubmit`, '{"ddoKey":"applySubmit","formData":{}}');
  const chromeRefs = capture(`${BASE}/applySubmit`, '{"ddoKey":"applyGetReferences"}');
  const chromeWidget = capture(`${BASE}/widgets`, '{"ddoKey":"canvasGetWidgetContent"}');

  it("with no patterns, keeps every same-origin POST (today's behavior)", () => {
    const kept = extractActionSequence([realSubmit, chromeRefs, chromeWidget]).map(
      (a) => a.capture.url
    );
    expect(kept).toEqual([realSubmit.url, chromeRefs.url, chromeWidget.url]);
  });

  it("with an endpoint pattern, drops non-matching chrome but keeps same-URL chrome", () => {
    const kept = extractActionSequence([realSubmit, chromeRefs, chromeWidget], {
      endpoint: "/applySubmit",
      body: null,
    }).map((a) => a.capture.requestPostData);
    // /widgets dropped; both /applySubmit POSTs kept (URL cannot separate them).
    expect(kept).toEqual([realSubmit.requestPostData, chromeRefs.requestPostData]);
  });

  it("with an endpoint + body pattern, isolates the real submission", () => {
    const kept = extractActionSequence([realSubmit, chromeRefs, chromeWidget], {
      endpoint: "/applySubmit",
      body: '"ddoKey":"applySubmit"',
    }).map((a) => a.capture.requestPostData);
    expect(kept).toEqual([realSubmit.requestPostData]);
  });

  it("throws on a malformed pattern rather than silently reverting to unfiltered", () => {
    expect(() => extractActionSequence([realSubmit], { endpoint: "(", body: null })).toThrow();
  });
});

describe("extractActionSequence — foldReturnSpec-scoped GET admission", () => {
  const capture = (method: string, url: string) => ({
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action" as const,
    method,
    url,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: {},
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  });

  const BASE = "https://api.example.com";
  const foldReturnSpec = {
    endpointPattern: "/orders/[^/]+/detail",
    resultsPath: "orderSearch.results.orders",
    joinFields: ["orderId"],
  };

  it("drops every GET when no foldReturnSpec is given (today's behavior)", () => {
    const kept = extractActionSequence([
      capture("POST", `${BASE}/orders/search`),
      capture("GET", `${BASE}/orders/1/detail`),
    ]).map((a) => a.capture.method);

    expect(kept).toEqual(["POST"]);
  });

  it("admits a GET capture whose URL matches the flow's own foldReturnSpec.endpointPattern", () => {
    const kept = extractActionSequence(
      [capture("POST", `${BASE}/orders/search`), capture("GET", `${BASE}/orders/1/detail`)],
      null,
      foldReturnSpec
    ).map((a) => a.capture.url);

    expect(kept).toEqual([`${BASE}/orders/search`, `${BASE}/orders/1/detail`]);
  });

  it("still drops a GET that does not match the declared endpointPattern", () => {
    const kept = extractActionSequence(
      [capture("POST", `${BASE}/orders/search`), capture("GET", `${BASE}/orders/1/unrelated`)],
      null,
      foldReturnSpec
    ).map((a) => a.capture.url);

    expect(kept).toEqual([`${BASE}/orders/search`]);
  });
});

describe("resolveManifestActionSequence — authoritative submission selection", () => {
  const capture = (url: string) => ({
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action" as const,
    method: "POST",
    url,
    status: 200,
    requestHeaders: {},
    requestPostData: "{}",
    responseHeaders: {},
    responseBody: {},
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  });
  const BASE = "https://www.example-ats.org";
  const captures = [
    capture(`${BASE}/widgets`),
    capture(`${BASE}/applySubmit`),
    capture(`${BASE}/applySubmit`),
  ];

  it("returns null when no manifest exists (falls back to extraction)", () => {
    const dir = mkdtempSync(join(tmpdir(), "recon-manifest-"));
    expect(resolveManifestActionSequence(dir, captures)).toBeNull();
  });

  it("resolves manifest indices to the exact captures, cross-checked on url", () => {
    const dir = mkdtempSync(join(tmpdir(), "recon-manifest-"));
    writeFileSync(
      join(dir, "submit-manifest.json"),
      JSON.stringify([{ index: 1, filename: "001-x.json", url: `${BASE}/applySubmit` }])
    );
    const resolved = resolveManifestActionSequence(dir, captures);
    expect(resolved).not.toBeNull();
    expect(resolved!.map((a) => a.index)).toEqual([1]);
    expect(resolved![0]!.capture).toBe(captures[1]);
  });

  it("returns null when a manifest url no longer matches its index (capture set drifted)", () => {
    const dir = mkdtempSync(join(tmpdir(), "recon-manifest-"));
    writeFileSync(
      join(dir, "submit-manifest.json"),
      JSON.stringify([{ index: 0, filename: "000-x.json", url: `${BASE}/applySubmit` }])
    );
    // index 0 is /widgets, not /applySubmit — mismatch → null (safe fallback).
    expect(resolveManifestActionSequence(dir, captures)).toBeNull();
  });

  it("returns null for an empty manifest (nothing matched at run time)", () => {
    const dir = mkdtempSync(join(tmpdir(), "recon-manifest-"));
    writeFileSync(join(dir, "submit-manifest.json"), "[]");
    expect(resolveManifestActionSequence(dir, captures)).toBeNull();
  });
});

describe("extractGraphQLActionSequence — GraphQL submission flows get state-threaded, not the first-query fallback", () => {
  const BASE = "https://aidfinder.example.com";
  const gqlCapture = (
    operationName: string,
    kind: "query" | "mutation",
    responseBody: unknown,
    requestPostData: string
  ) => ({
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action" as const,
    method: "POST",
    url: `${BASE}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData,
    responseHeaders: {},
    responseBody,
    operationName,
    query: `${kind} ${operationName}($input: Input) {\n  ${operationName}(input: $input) { id }\n}`,
    variables: null,
    decodedParams: null,
  });

  // A textbook transactional flow: page-bootstrap read query first (the one
  // the old chronologically-first fallback would have picked), then the
  // mutation sequence a real submission drives.
  const captures = [
    gqlCapture("ListForms", "query", { forms: [] }, '{"op":"ListForms"}'),
    gqlCapture("Form", "mutation", { formId: "f-1" }, '{"op":"Form"}'),
    gqlCapture(
      "UpsertSavedApplication",
      "mutation",
      { applicationId: "app-1" },
      '{"op":"UpsertSavedApplication"}'
    ),
    gqlCapture("SubmitForm", "mutation", { submissionId: "sub-1" }, '{"op":"SubmitForm"}'),
    gqlCapture(
      "FinalizeFormSubmission",
      "mutation",
      { finalized: true },
      '{"op":"FinalizeFormSubmission"}'
    ),
  ];

  it("drops the read-only bootstrap query and keeps only the mutation sequence", () => {
    const kept = extractGraphQLActionSequence(captures).map((a) => a.capture.operationName);
    expect(kept).toEqual([
      "Form",
      "UpsertSavedApplication",
      "SubmitForm",
      "FinalizeFormSubmission",
    ]);
  });

  it("threads through to isSubmissionFlow === true and a multi-step executeHttp covering every operation", () => {
    const actionCaptures = extractGraphQLActionSequence(captures);
    const stateIndex = indexStateValues(
      captures,
      new Set(),
      new Set(actionCaptures.map((a) => a.index))
    );
    const actionSteps = compileActionSteps(actionCaptures, stateIndex);
    const isSubmissionFlow = actionSteps.length > 1;

    expect(isSubmissionFlow).toBe(true);

    const body = emitMultiStepExecuteHttp(
      actionSteps,
      null,
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      new Set(),
      new Map(),
      new Set(),
      new Map(),
      new Map(),
      BASE,
      new Map(),
      new Map()
    );

    expect(actionSteps).toHaveLength(4);
    expect(actionSteps.map((s) => s.capture.operationName)).toEqual([
      "Form",
      "UpsertSavedApplication",
      "SubmitForm",
      "FinalizeFormSubmission",
    ]);
    expect(body).not.toContain("ListForms");
  });

  it("keeps a mutation capture whose top-level operationName is null, matching a same-shaped named mutation", () => {
    const named = gqlCapture(
      "SubmitApplication",
      "mutation",
      { applicationId: "app-1" },
      '{"op":"SubmitApplication"}'
    );
    const nullNamed = {
      ...named,
      operationName: null,
      query:
        "mutation SubmitApplication($input: Input) {\n  SubmitApplication(input: $input) { id }\n}",
    };

    const kept = extractGraphQLActionSequence([named, nullNamed]);
    expect(kept).toHaveLength(2);
    expect(kept.map((a) => a.capture.query)).toEqual([named.query, nullNamed.query]);
  });
});

describe("extractGraphQLActionSequence — foldReturnSpec-scoped non-mutation admission", () => {
  const BASE = "https://aidfinder.example.com";
  const gqlCapture = (operationName: string, kind: "query" | "mutation") => ({
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action" as const,
    method: "POST",
    url: `${BASE}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: `{"op":"${operationName}"}`,
    responseHeaders: {},
    responseBody: {},
    operationName,
    query: `${kind} ${operationName}($input: Input) {\n  ${operationName}(input: $input) { id }\n}`,
    variables: null,
    decodedParams: null,
  });

  const foldReturnSpec = {
    endpointPattern: "/graphql",
    resultsPath: "orderSearch.results.orders",
    joinFields: ["orderId"],
  };

  it("drops every query when no foldReturnSpec is given (today's behavior)", () => {
    const kept = extractGraphQLActionSequence([
      gqlCapture("OrderDetail", "query"),
      gqlCapture("SubmitForm", "mutation"),
    ]).map((a) => a.capture.operationName);

    expect(kept).toEqual(["SubmitForm"]);
  });

  it("admits a non-mutation capture whose URL matches the flow's own foldReturnSpec.endpointPattern", () => {
    const kept = extractGraphQLActionSequence(
      [gqlCapture("OrderDetail", "query"), gqlCapture("SubmitForm", "mutation")],
      null,
      foldReturnSpec
    ).map((a) => a.capture.operationName);

    expect(kept).toEqual(["OrderDetail", "SubmitForm"]);
  });

  it("still drops a non-mutation capture that does not match the declared endpointPattern", () => {
    const kept = extractGraphQLActionSequence(
      [gqlCapture("OrderDetail", "query"), gqlCapture("SubmitForm", "mutation")],
      null,
      { ...foldReturnSpec, endpointPattern: "/unrelated" }
    ).map((a) => a.capture.operationName);

    expect(kept).toEqual(["SubmitForm"]);
  });

  const restCapture = (path: string) => ({
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action" as const,
    method: "GET",
    url: `${BASE}${path}`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: {},
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  });

  it("admits a REST GET capture (capture.query === null) whose URL matches the declared endpointPattern", () => {
    const kept = extractGraphQLActionSequence(
      [restCapture("/inventory-lookup"), gqlCapture("SubmitForm", "mutation")],
      null,
      { ...foldReturnSpec, endpointPattern: "/inventory-lookup" }
    ).map((a) => a.capture.operationName ?? a.capture.url);

    expect(kept).toEqual([`${BASE}/inventory-lookup`, "SubmitForm"]);
  });

  it("scopes admission to the declared pattern: a matching capture is kept, an unrelated one is still dropped, in the same input", () => {
    const kept = extractGraphQLActionSequence(
      [
        gqlCapture("OrderDetail", "query"),
        restCapture("/unrelated-lookup"),
        gqlCapture("SubmitForm", "mutation"),
      ],
      null,
      foldReturnSpec
    ).map((a) => a.capture.operationName);

    expect(kept).toEqual(["OrderDetail", "SubmitForm"]);
  });
});

describe("foldReturn-admitted read+drill classification — no mutation present (#bugfix-001)", () => {
  const BASE = "https://aidfinder.example.com";
  const gqlQueryCapture = (operationName: string, url: string) => ({
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action" as const,
    method: "POST",
    url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: `{"op":"${operationName}"}`,
    responseHeaders: {},
    // Matches foldReturnSpec.resultsPath below so extractGraphQLActionSequence's
    // matchesFoldReturnResults predicate admits this as the primary results
    // source the drill-down folds onto.
    responseBody: { data: { searchResults: { items: [{ id: "1" }] } } },
    operationName,
    query: `query ${operationName}($input: Input) {\n  ${operationName}(input: $input) { id }\n}`,
    variables: null,
    decodedParams: null,
  });

  const restGetCapture = (path: string) => ({
    timestamp: "2024-01-01T00:00:01Z",
    phase: "action" as const,
    method: "GET",
    url: `${BASE}${path}`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: {},
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  });

  const foldReturnSpec = {
    endpointPattern: "/itinerary/api/v1/sailings",
    resultsPath: "data.searchResults.items",
    joinFields: ["id"],
  };

  // Mirrors main()'s own derivation (recon-generate.ts ~8476-8489, ~8672-8674):
  // graphqlActionSequence is the same array fed to both the primary-operation
  // gate and isSubmissionFlow, so it must not conflate "admitted 2+ entries"
  // with "is a transactional submission" when none of those entries is an
  // actual mutation.
  it("a query primary plus a foldReturn-admitted GET drill, with zero mutations, keeps primaryGraphQLOperation non-null and isSubmissionFlow false", () => {
    const primaryQuery = gqlQueryCapture("SearchResults", `${BASE}/graphql`);
    const drillCapture = restGetCapture("/itinerary/api/v1/sailings");
    const captures = [primaryQuery, drillCapture];

    const graphqlActionSequence = extractGraphQLActionSequence(captures, null, foldReturnSpec);
    expect(graphqlActionSequence.map((a) => a.capture.operationName ?? a.capture.url)).toEqual([
      "SearchResults",
      `${BASE}/itinerary/api/v1/sailings`,
    ]);

    const graphqlActionSequenceHasMutation = graphqlActionSequence.some(
      (a) => a.capture.query !== null && /^\s*mutation\b/.test(a.capture.query)
    );
    expect(graphqlActionSequenceHasMutation).toBe(false);

    const primaryGraphQLOperation = graphqlActionSequenceHasMutation
      ? null
      : selectPrimaryGraphQLOperation(captures, [], EMPTY_VOCABULARY, {}, [], null);
    expect(primaryGraphQLOperation).not.toBeNull();
    expect(primaryGraphQLOperation?.capture.operationName).toBe("SearchResults");

    const actionCaptures = [
      { capture: primaryQuery, index: 0 },
      { capture: drillCapture, index: 1 },
    ];
    const stateIndex = indexStateValues(
      captures,
      new Set(),
      new Set(actionCaptures.map((a) => a.index))
    );
    const actionSteps = compileActionSteps(actionCaptures, stateIndex);
    const isSubmissionFlow = actionSteps.length > 1 && graphqlActionSequenceHasMutation;
    expect(isSubmissionFlow).toBe(false);
  });
});

describe("detectFormSchemaFieldNames — consumer-supplied wire keys (#57)", () => {
  const UUID_A = "11111111-1111-1111-1111-111111111111";
  const UUID_B = "22222222-2222-2222-2222-222222222222";

  const capture = (responseBody: unknown) => ({
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action" as const,
    method: "GET",
    url: "https://example.com/schema",
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody,
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  });

  /** The wire format the engine used to hardcode, now supplied as data. */
  const HISTORICAL: ReconFormSchema = {
    fieldIdKey: "FieldId",
    fieldNameKeys: ["FieldSourceCode", "FieldName"],
    fieldOptionsKey: "FieldOptions",
    optionIdKey: "Id",
    optionValueKey: "Value",
    responseValueKey: "Value",
    responseOptionIdKey: "OptionId",
  };

  it("recovers a field from the historical wire keys", () => {
    const body = [
      { FieldId: UUID_A, FieldSourceCode: "contact.first.name" },
      { FieldId: UUID_B, FieldSourceCode: "contact.email" },
    ];
    const { fieldNameMap } = detectFormSchemaFieldNames([capture(body)], HISTORICAL);
    expect(fieldNameMap.get(UUID_A)).toBe("ContactFirstName");
    expect(fieldNameMap.get(UUID_B)).toBe("ContactEmail");
  });

  it("recovers the SAME field from a differing vendor's wire keys — the whole point of #57", () => {
    // A vendor that lowercases its keys and uses hyphenated option keys.
    const vendor: ReconFormSchema = {
      fieldIdKey: "field-id",
      fieldNameKeys: ["source-code"],
      fieldOptionsKey: "options",
      optionIdKey: "id",
      optionValueKey: "label",
      responseValueKey: "value",
      responseOptionIdKey: "option-id",
    };
    const body = [
      { "field-id": UUID_A, "source-code": "contact.first.name" },
      { "field-id": UUID_B, "source-code": "contact.email" },
    ];
    const { fieldNameMap } = detectFormSchemaFieldNames([capture(body)], vendor);
    expect(fieldNameMap.get(UUID_A)).toBe("ContactFirstName");
    expect(fieldNameMap.get(UUID_B)).toBe("ContactEmail");
  });

  it("recovers option enums via the schema's option keys", () => {
    const body = [
      {
        FieldId: UUID_A,
        FieldSourceCode: "contact.state",
        FieldOptions: [
          { Id: "opt-tx", Value: "Texas" },
          { Id: "opt-ca", Value: "California" },
        ],
      },
    ];
    const { fieldOptionsMap } = detectFormSchemaFieldNames([capture(body)], HISTORICAL);
    expect(fieldOptionsMap.get(UUID_A)?.options.map((o) => o.value)).toEqual([
      "Texas",
      "California",
    ]);
  });

  it("recovers nothing when no form-schema is supplied — the engine hardcodes no vendor format", () => {
    const body = [{ FieldId: UUID_A, FieldSourceCode: "contact.first.name" }];
    const { fieldNameMap, allSchemaUuids } = detectFormSchemaFieldNames([capture(body)], null);
    expect(fieldNameMap.size).toBe(0);
    expect(allSchemaUuids.size).toBe(0);
  });
});

describe("indexStateValues — cookie-origin values get a separate, more permissive length cap", () => {
  /** A 272-char JWT, long enough to exceed MAX_STATE_VALUE_LENGTH (256) but
   * still under the cookie-specific cap. */
  const longJwt = [
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyLCJyb2xlIjoiYWRtaW4iLCJzY29wZSI6InJlYWQ6d3JpdGUiLCJvcmciOiJhY21lLWNvcnAiLCJzZXNzaW9uIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoifQ",
    "dozjgNryPQwerty1234567890abcdefghijk",
  ].join(".");

  const tokenMintCapture = {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action",
    method: "POST",
    url: "https://api.example.com/authz/private",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: "{}",
    responseHeaders: {
      "set-cookie": [
        "ADRUM_BTa=R:0|g:abc123; Path=/; HttpOnly",
        "ADRUM_BTa=R:1|g:def456; Path=/; HttpOnly",
        "ADRUM_BT1=R:0; Path=/",
        "ADRUM_BT1=R:1; Path=/",
        "ADRUM_BT1=R:2; Path=/",
        `__pa=${longJwt}; Path=/; HttpOnly; Secure`,
        "bm_sv=ABCDEF1234567890; Path=/; HttpOnly; Secure",
      ].join("\n"),
    },
    responseBody: {},
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };

  const statefulCallCapture = {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "action",
    method: "POST",
    url: "https://api.example.com/available-products/",
    status: 200,
    requestHeaders: { "Content-Type": "application/json", Cookie: `__pa=${longJwt}` },
    requestPostData: "{}",
    responseHeaders: { "content-type": "application/json" },
    responseBody: { products: [{ productId: "p1" }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };

  it("indexes the 272-char JWT cookie value despite exceeding MAX_STATE_VALUE_LENGTH", () => {
    expect(longJwt.length).toBe(272);
    const stateIndex = indexStateValues([tokenMintCapture, statefulCallCapture]);
    const sv = stateIndex.get(longJwt);
    expect(sv).toBeDefined();
    expect(sv?.headerOrigin).toEqual({ sourceHeader: "set-cookie", cookieName: "__pa" });
  });

  it("still excludes a 300-char body-origin string — the exemption is scoped to cookie origins only", () => {
    const longBodyString = "x".repeat(300);
    const bodyCapture = {
      ...statefulCallCapture,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { blob: longBodyString },
    };
    const stateIndex = indexStateValues([tokenMintCapture, bodyCapture]);
    expect(stateIndex.has(longBodyString)).toBe(false);
  });

  it("still applies MIN_STATE_VALUE_LENGTH to cookie-origin values — the raised ceiling doesn't drop the floor", () => {
    const shortCookieCapture = {
      ...tokenMintCapture,
      responseHeaders: { "set-cookie": "sid=abc; Path=/; HttpOnly" },
    };
    const stateIndex = indexStateValues([shortCookieCapture, statefulCallCapture]);
    expect(stateIndex.has("abc")).toBe(false);
  });

  it("admits a short Set-Cookie value confirmed as a dependent-drilldown chain join field, unlike the no-fold-plan case above", () => {
    const steps = buildMulticallSingleShotSearchDrillDownShortCookieChainedJoinFieldActionSteps();
    const captures = steps.map((step) => step.capture);
    const stateIndex = indexStateValues(captures);
    expect(stateIndex.has("tok1")).toBe(true);
  });

  it("still skips PLACEHOLDER_STATE_VALUES for cookie-origin values — the raised ceiling doesn't bypass the placeholder gate", () => {
    const placeholderCookieCapture = {
      ...tokenMintCapture,
      responseHeaders: {
        "set-cookie": "sid=00000000-0000-0000-0000-000000000000; Path=/; HttpOnly",
      },
    };
    const stateIndex = indexStateValues([placeholderCookieCapture, statefulCallCapture]);
    expect(stateIndex.has("00000000-0000-0000-0000-000000000000")).toBe(false);
  });
});

describe("compileActionSteps — Set-Cookie state binding (listings-fixture-style token mint)", () => {
  /** Capture 1: mints an anonymous bearer via Set-Cookie, response body is empty. */
  const tokenMintCapture = {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action",
    method: "POST",
    url: "https://api.example.com/authz/private",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: "{}",
    responseHeaders: { "set-cookie": "__pa=abc.def.ghi; Path=/; HttpOnly" },
    responseBody: {},
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };

  /** Capture 2: the stateful call that 401s without the minted cookie —
   * carries it back as a Cookie request header, exactly as the browser sent it. */
  const statefulCallCapture = {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "action",
    method: "POST",
    url: "https://api.example.com/available-products/",
    status: 200,
    requestHeaders: { "Content-Type": "application/json", Cookie: "__pa=abc.def.ghi" },
    requestPostData: "{}",
    responseHeaders: { "content-type": "application/json" },
    responseBody: { products: [{ productId: "p1" }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };

  const captures = [tokenMintCapture, statefulCallCapture];
  const actionCaptures = captures.map((capture, index) => ({ capture, index }));
  const stateIndex = indexStateValues(captures);
  const actionSteps = compileActionSteps(actionCaptures, stateIndex);

  it("indexes the Set-Cookie value with a header origin, not a body path", () => {
    const sv = stateIndex.get("abc.def.ghi");
    expect(sv).toBeDefined();
    expect(sv?.headerOrigin).toEqual({ sourceHeader: "set-cookie", cookieName: "__pa" });
    expect(sv?.path).toEqual([]);
  });

  it("produces a header-kind binding on the token-mint step, not a body accessor", () => {
    const [mintStep] = actionSteps;
    const headerProduce = mintStep?.produces.find((p) => p.kind === "header");
    expect(headerProduce).toBeDefined();
    expect(headerProduce).toMatchObject({
      kind: "header",
      sourceHeader: "set-cookie",
      cookieName: "__pa",
      targetHeader: "Cookie",
    });
  });

  it("does not fabricate a body-path produce for the cookie value", () => {
    const [mintStep] = actionSteps;
    expect(mintStep?.produces.some((p) => p.kind === "body")).toBe(false);
  });

  it("renders a bind: [...] entry on createHttpClient instead of dropping the token", () => {
    const contract = emitContractTs({
      ...BASE_OPTS,
      inputBody: JSON.parse(tokenMintCapture.requestPostData) as unknown,
      multiStepBody: emitMultiStepExecuteHttp(
        actionSteps,
        JSON.parse(tokenMintCapture.requestPostData) as unknown,
        { stringMessageKey: null, nestedErrorPaths: [] },
        new Map(),
        new Set(),
        new Map(),
        new Set(),
        new Map(),
        new Map(),
        "https://api.example.com",
        new Map(),
        new Map()
      ),
      headerBindings: actionSteps.flatMap((s) => s.produces).filter((p) => p.kind === "header"),
    });

    expect(contract).toContain(
      'bind: [{ sourceHeader: "set-cookie", cookieName: "__pa", targetHeader: "Cookie" }]'
    );
  });

  it("generated executeHttp body never references the raw JWT or emits an any-typed accessor", () => {
    const body = emitMultiStepExecuteHttp(
      actionSteps,
      JSON.parse(tokenMintCapture.requestPostData) as unknown,
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      new Set(),
      new Map(),
      new Set(),
      new Map(),
      new Map(),
      "https://api.example.com",
      new Map(),
      new Map()
    );
    expect(body).not.toContain("abc.def.ghi");
    expect(body).not.toContain(": any");
    expect(body).not.toContain("<any>");
  });
});

describe("indexStateValues / compileActionSteps — bare numeric response-body leaf threads as state", () => {
  /** Capture 1: a status-check call returns a bare numeric token in the body,
   * not wrapped in a string — e.g. `{ statusToken: 12345678 }`. */
  const numericMintCapture = {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action",
    method: "POST",
    url: "https://api.example.com/status/check",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: "{}",
    responseHeaders: { "content-type": "application/json" },
    responseBody: { statusToken: 12345678 },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };

  /** Capture 2: a follow-up call re-sends that number, wrapped inside an
   * array, in its JSON request body. */
  const statefulCallCapture = {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "action",
    method: "POST",
    url: "https://api.example.com/status/confirm",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ tokens: [12345678] }),
    responseHeaders: { "content-type": "application/json" },
    responseBody: { confirmed: true },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };

  const captures = [numericMintCapture, statefulCallCapture];
  const actionCaptures = captures.map((capture, index) => ({ capture, index }));
  const stateIndex = indexStateValues(captures);
  const actionSteps = compileActionSteps(actionCaptures, stateIndex);

  it("indexes the bare numeric leaf keyed by its String() form", () => {
    const sv = stateIndex.get("12345678");
    expect(sv).toBeDefined();
    expect(sv?.path).toEqual(["statusToken"]);
  });

  it("produces a body-kind entry on the originating step for the numeric value", () => {
    const [mintStep] = actionSteps;
    const bodyProduce = mintStep?.produces.find((p) => p.kind === "body");
    expect(bodyProduce).toBeDefined();
    expect(bodyProduce).toMatchObject({ kind: "body", path: ["statusToken"] });
  });
});

/** The `${${` double-interpolation sentinel, built by concatenation so Biome's
 * noTemplateCurlyInString rule doesn't flag the literal placeholder. */
const DOUBLE_INTERP = `$${"{"}$${"{"}`;

describe("compileActionSteps — a response value used downstream ONLY as a JSON key is not reuse", () => {
  // Regression for the malformed-template-literal bug: a submit response echoed
  // the form's field NAMES (`tokens: ["firstName","lastName"]`), and a later
  // POST body used those same strings as JSON keys (`"firstName":"…"`). The old
  // substring produces-filter mistook the key match for value reuse, bound them
  // as `tokens`/`tokens2`, then spliced them into key positions — emitting
  // uncompilable `"${tokens}":` and `${${tokens2}}`. The fix matches body
  // consumption against JSON *values* only (keys are never JSON leaves), so a
  // key-only string never produces a binding.
  const producerCapture = {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action",
    method: "POST",
    url: "https://api.example.com/applySubmit",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: '{"ddoKey":"applySubmit","firstName":"Reginald","lastName":"Reconaldo"}',
    responseHeaders: { "content-type": "application/json" },
    responseBody: { thankYouEmailParams: { tokens: ["firstName", "lastName"] } },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };

  /** A later step whose body reuses `firstName`/`lastName` ONLY as JSON keys. */
  const keyOnlyConsumerCapture = {
    ...producerCapture,
    timestamp: "2024-01-01T00:00:01Z",
    requestPostData: '{"ddoKey":"applySubmit","firstName":"Reginald","lastName":"Reconaldo"}',
    responseBody: { ok: true },
  };

  const captures = [producerCapture, keyOnlyConsumerCapture];
  const actionCaptures = captures.map((capture, index) => ({ capture, index }));
  const stateIndex = indexStateValues(captures);
  const actionSteps = compileActionSteps(actionCaptures, stateIndex);

  it("does not produce a body binding for a value that only appears downstream as a JSON key", () => {
    const producedNames = actionSteps.flatMap((s) => s.produces).map((p) => p.name);
    expect(producedNames).not.toContain("tokens");
    expect(producedNames).not.toContain("tokens2");
    const bodyProducedForFieldNames = actionSteps
      .flatMap((s) => s.produces)
      .filter((p) => p.kind === "body")
      .some((p) => p.path.at(-1) === "0" || p.path.at(-1) === "1");
    expect(bodyProducedForFieldNames).toBe(false);
  });

  it("emits a body with no key-position splice and no double interpolation", () => {
    const body = emitMultiStepExecuteHttp(
      actionSteps,
      JSON.parse(producerCapture.requestPostData) as unknown,
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      new Set(),
      new Map(),
      new Set(),
      new Map(),
      new Map(),
      "https://api.example.com",
      new Map(),
      new Map()
    );
    expect(body).not.toContain(DOUBLE_INTERP);
    expect(body).not.toContain(`"${interpRef("tokens")}"`);
    expect(body).not.toContain(`"${interpRef("tokens2")}"`);
    expect(body).toContain('"lastName":');
  });
});

describe("compileActionSteps — a response value genuinely re-sent as a JSON value still produces", () => {
  // Guards the fix from over-filtering: matching body consumption against JSON
  // values must still recognize real cross-step reuse (an id minted in one
  // response and re-sent as a JSON body value in the next request), including
  // when the id is embedded inside a longer composite value.
  const mintCapture = {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action",
    method: "POST",
    url: "https://api.example.com/draft",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: "{}",
    responseHeaders: { "content-type": "application/json" },
    responseBody: { draftId: "draft-8f81e44c-4561" },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };

  const consumerCapture = {
    ...mintCapture,
    timestamp: "2024-01-01T00:00:01Z",
    url: "https://api.example.com/submit",
    requestPostData: '{"applicationDraftId":"draft-8f81e44c-4561"}',
    responseBody: { ok: true },
  };

  const captures = [mintCapture, consumerCapture];
  const actionCaptures = captures.map((capture, index) => ({ capture, index }));
  const stateIndex = indexStateValues(captures);
  const actionSteps = compileActionSteps(actionCaptures, stateIndex);

  it("still produces a binding for the re-sent value", () => {
    const producedNames = actionSteps.flatMap((s) => s.produces).map((p) => p.name);
    expect(producedNames).toContain("draftId");
  });

  it("interpolates the re-sent value into the consuming body", () => {
    const body = emitMultiStepExecuteHttp(
      actionSteps,
      JSON.parse(mintCapture.requestPostData) as unknown,
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      new Set(),
      new Map(),
      new Set(),
      new Map(),
      new Map(),
      "https://api.example.com",
      new Map(),
      new Map()
    );
    expect(body).toContain(interpRef("draftId"));
    expect(body).not.toContain("draft-8f81e44c-4561");
    expect(body).not.toContain(DOUBLE_INTERP);
  });

  it("still produces a value reused only as a substring inside a longer composite value", () => {
    // A jobId (26158515) is reused downstream only inside a longer composite
    // jobSeqNo (AAA26158515EXTERNALENUS) — never as its own JSON leaf and not in
    // the URL. Value-substring matching must keep binding it (exact-equality
    // matching would have dropped it).
    const producer = {
      ...mintCapture,
      url: "https://api.example.com/job",
      responseBody: { jobId: "26158515" },
    };
    const consumer = {
      ...mintCapture,
      timestamp: "2024-01-01T00:00:02Z",
      url: "https://api.example.com/apply",
      requestPostData: '{"jobSeqNo":"AAA26158515EXTERNALENUS"}',
      responseBody: { ok: true },
    };
    const steps = compileActionSteps(
      [producer, consumer].map((capture, index) => ({ capture, index })),
      indexStateValues([producer, consumer])
    );
    const names = steps.flatMap((s) => s.produces).map((p) => p.name);
    expect(names).toContain("jobId");
  });
});

describe("indexStateValues — a short numeric value threaded through a dependent drill-down chain is indexed despite MIN_STATE_VALUE_LENGTH", () => {
  // Regression for the length-floor bug: `r1`'s response is a bare two-digit
  // JSON number (`42`), well under MIN_STATE_VALUE_LENGTH's 8-char floor.
  // Without the chain-produced-value carve-out, indexStateValues drops it
  // entirely, so compileActionSteps never emits a produces[] accessor for it
  // and r2's templated body has nothing to substitute for the per-item token.
  const steps = buildMulticallSingleShotSearchDrillDownShortNumericChainedJoinFieldActionSteps();
  const captures = steps.map((step) => step.capture);
  const actionCaptures = captures.map((capture, index) => ({ capture, index }));
  const stateIndex = indexStateValues(captures);
  const actionSteps = compileActionSteps(actionCaptures, stateIndex);

  it("indexes the short numeric chain-produced token despite it being under MIN_STATE_VALUE_LENGTH", () => {
    const sv = stateIndex.get("42");
    expect(sv).toBeDefined();
  });

  it("produces a body accessor on the originating chain step for the short numeric token", () => {
    const orderStatusStep = actionSteps.find((step) => step.capture.url === captures[1]!.url);
    const bodyProduce = orderStatusStep?.produces.find((p) => p.kind === "body");
    expect(bodyProduce).toBeDefined();
  });
});

describe("indexStateValues — a non-cookie response header value threaded through a dependent drill-down chain is indexed with its real header name", () => {
  // Regression: the drill step (`r1`) mints a session token on a plain
  // response header (`X-Session-Token`, not Set-Cookie), which the terminal
  // step (`r2`) echoes back as a request header. Without a general
  // non-cookie header scan, indexStateValues never creates a StateValue for
  // it at all — only Set-Cookie values are ever indexed from headers.
  const steps = [
    buildStep("r0", {
      url: "https://api.example.com/catalog/search/",
      requestPostData: '{"page":1}',
      responseBody: { results: [{ orderId: "order-a" }, { orderId: "order-b" }] },
      timestamp: "2024-10-05T00:00:00Z",
    }),
    buildStep("r1", {
      url: "https://api.example.com/catalog/order-status/",
      requestPostData: '{"orderId":"order-a"}',
      responseBody: {},
      responseHeaders: { "x-session-token": "sess-a1b2c3d4e5f6" },
      timestamp: "2024-10-05T00:00:01Z",
    }),
    buildStep("r2", {
      url: "https://api.example.com/order-history/bulk/",
      requestPostData: "{}",
      requestHeaders: {
        "Content-Type": "application/json",
        "X-Session-Token": "sess-a1b2c3d4e5f6",
      },
      responseBody: { entries: [{ ts: "2024-10-05T00:00:02Z", event: "shipped" }] },
      timestamp: "2024-10-05T00:00:02Z",
    }),
  ];
  const captures = steps.map((step) => step.capture);
  const stateIndex = indexStateValues(captures);

  it("indexes the non-cookie header value with kind header and its real header name", () => {
    const sv = stateIndex.get("sess-a1b2c3d4e5f6");
    expect(sv).toBeDefined();
    expect(sv?.headerOrigin).toEqual({ sourceHeader: "x-session-token" });
    expect(sv?.path).toEqual([]);
  });

  it("does not index an unrelated response header value that the chain never threads", () => {
    const untouchedSteps = [
      steps[0]!,
      {
        ...steps[1]!,
        capture: {
          ...steps[1]!.capture,
          responseHeaders: { "x-request-id": "req-untouched-99999999" },
        },
      },
      steps[2]!,
    ];
    const untouchedIndex = indexStateValues(untouchedSteps.map((step) => step.capture));
    expect(untouchedIndex.has("req-untouched-99999999")).toBe(false);
  });

  it("indexes a chain-confirmed header value shorter than MIN_STATE_VALUE_LENGTH (mirrors the body-value force-include bypass)", () => {
    const shortValueSteps = [
      steps[0]!,
      {
        ...steps[1]!,
        capture: { ...steps[1]!.capture, responseHeaders: { "x-session-token": "s1a2b3" } },
      },
      {
        ...steps[2]!,
        capture: {
          ...steps[2]!.capture,
          requestHeaders: { "Content-Type": "application/json", "X-Session-Token": "s1a2b3" },
        },
      },
    ];
    const shortValueIndex = indexStateValues(shortValueSteps.map((step) => step.capture));
    const sv = shortValueIndex.get("s1a2b3");
    expect(sv).toBeDefined();
    expect(sv?.headerOrigin).toEqual({ sourceHeader: "x-session-token" });
  });
});

describe("indexStateValues — a short Set-Cookie value threaded through a dependent drill-down chain is indexed despite MIN_STATE_VALUE_LENGTH", () => {
  // Cookie-origin counterpart of the short-numeric chain regression above:
  // r1 mints `tok1` (4 chars, well under MIN_STATE_VALUE_LENGTH's 8-char
  // floor) via Set-Cookie rather than the response body, and r2 threads it
  // back via its request body. Without the chain-produced-value carve-out on
  // the Set-Cookie branch, indexStateValues drops it, so compileActionSteps
  // never emits a header-kind produces[] accessor for it.
  const steps = buildMulticallSingleShotSearchDrillDownShortCookieChainedJoinFieldActionSteps();
  const captures = steps.map((step) => step.capture);
  const stateIndex = indexStateValues(captures);

  it("indexes the short cookie-sourced chain-produced token despite it being under MIN_STATE_VALUE_LENGTH", () => {
    const sv = stateIndex.get("tok1");
    expect(sv).toBeDefined();
    expect(sv?.headerOrigin).toEqual({ sourceHeader: "set-cookie", cookieName: "sess" });
  });
});

describe("collectHeaderBindings — multi-cookie regression (listings-fixture __pa first-wins bug)", () => {
  /** Step 0: the feature-toggle call mints three geo/analytics cookies (all
   * later threaded back on the `Cookie` request header) plus a conversation
   * id threaded back on a distinct `X-Conversation-Id` header. */
  const toggleCapture = {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action",
    method: "GET",
    url: "https://api.example.com/toggles/product-avail",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: null,
    responseHeaders: {
      "set-cookie": [
        "latestGeoIP=US-TX-AUSTIN-1; Path=/",
        "GeoIP=US-TX-AUSTIN-2; Path=/",
        "bm_sv=BMSVSESSIONVALUE1; Path=/; HttpOnly; Secure",
        "Conversation_UUID=conv-uuid-abcdefgh; Path=/",
      ].join("\n"),
    },
    responseBody: {},
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };

  /** Step 1: the auth call — mints `__pa` LAST among the Cookie-targeting
   * cookies, which is exactly the ordering that trips first-wins. */
  const authzCapture = {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "action",
    method: "POST",
    url: "https://api.example.com/listings-avail-api/authz/private",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: "{}",
    responseHeaders: { "set-cookie": "__pa=eyJhbGciOiJIUzI1NiJ9.payload.sig; Path=/; HttpOnly" },
    responseBody: {},
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };

  /** Step 2: the stateful call that 401s without `__pa` — carries every
   * minted cookie back as a `Cookie` request header, plus the conversation
   * id back as `X-Conversation-Id`, exactly as the browser sent them. */
  const availableProductsCapture = {
    timestamp: "2024-01-01T00:00:02Z",
    phase: "action",
    method: "GET",
    url: "https://api.example.com/listings-avail-api/available-products/",
    status: 200,
    requestHeaders: {
      "Content-Type": "application/json",
      Cookie:
        "latestGeoIP=US-TX-AUSTIN-1; GeoIP=US-TX-AUSTIN-2; bm_sv=BMSVSESSIONVALUE1; __pa=eyJhbGciOiJIUzI1NiJ9.payload.sig",
      "X-Conversation-Id": "conv-uuid-abcdefgh",
    },
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    responseBody: { products: [{ productId: "p1" }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };

  const captures = [toggleCapture, authzCapture, availableProductsCapture];
  const actionCaptures = captures.map((capture, index) => ({ capture, index }));
  const stateIndex = indexStateValues(captures);
  const actionSteps = compileActionSteps(actionCaptures, stateIndex);
  const headerBindings = collectHeaderBindings(actionSteps);

  it("indexes __pa with a header origin on the authz/private capture", () => {
    const sv = stateIndex.get("eyJhbGciOiJIUzI1NiJ9.payload.sig");
    expect(sv).toBeDefined();
    expect(sv?.headerOrigin).toEqual({ sourceHeader: "set-cookie", cookieName: "__pa" });
  });

  it("produces a header-kind binding for __pa on the authz/private step, not just the toggle step", () => {
    const [, authzStep] = actionSteps;
    const pa = authzStep?.produces.find((p) => p.kind === "header" && p.cookieName === "__pa");
    expect(pa).toBeDefined();
    expect(pa).toMatchObject({ kind: "header", cookieName: "__pa", targetHeader: "Cookie" });
  });

  it("collectHeaderBindings returns all four Cookie-targeting bindings, __pa included — does not drop it in favour of latestGeoIP", () => {
    const cookieBindings = headerBindings.filter((b) => b.targetHeader === "Cookie");
    expect(cookieBindings.map((b) => b.cookieName).sort()).toEqual(
      ["GeoIP", "__pa", "bm_sv", "latestGeoIP"].sort()
    );
    expect(cookieBindings.some((b) => b.cookieName === "__pa")).toBe(true);
  });

  it("returns exactly one X-Conversation-Id binding", () => {
    const conversationBindings = headerBindings.filter(
      (b) => b.targetHeader === "X-Conversation-Id"
    );
    expect(conversationBindings).toHaveLength(1);
    expect(conversationBindings[0]).toMatchObject({
      cookieName: "Conversation_UUID",
      targetHeader: "X-Conversation-Id",
    });
  });

  it("emits a bind entry for __pa in the generated contract source", () => {
    const contract = emitContractTs({
      ...BASE_OPTS,
      inputBody: {},
      multiStepBody: emitMultiStepExecuteHttp(
        actionSteps,
        {},
        { stringMessageKey: null, nestedErrorPaths: [] },
        new Map(),
        new Set(),
        new Map(),
        new Set(),
        new Map(),
        new Map(),
        "https://api.example.com",
        new Map(),
        new Map()
      ),
      headerBindings,
    });

    expect(contract).toContain('cookieName: "__pa"');
  });
});

describe("emitContractTs — multipart plugin imports omitHeaderCaseInsensitive", () => {
  const source = emitContractTs({
    ...BASE_OPTS,
    hasMultipartStep: true,
    inputBody: { Name: "Alice", SmsOptIn: true },
    multiStepBody: `    return { data: {} as unknown };`,
  });

  it("imports omitHeaderCaseInsensitive from the package subpath, not the @/ alias", () => {
    expect(source).toContain(
      'import { omitHeaderCaseInsensitive } from "@enricai/barnacle/lib/case-insensitive-headers"'
    );
  });
});

describe("emitContractTs — non-multipart plugin does not import omitHeaderCaseInsensitive", () => {
  const source = emitContractTs({
    ...BASE_OPTS,
    hasMultipartStep: false,
    inputBody: { Name: "Alice" },
  });

  it("does not import omitHeaderCaseInsensitive", () => {
    expect(source).not.toContain("omitHeaderCaseInsensitive");
  });
});

/** Recruiting-domain test vocabulary, exercised only by these unit tests. */
const TEST_RECRUITING_VOCABULARY: ReconVocabulary = {
  subject: /\b(the\s+)?(test\s+)?(candidate|applicant)'?s\b/i,
  exclusions: [
    /reference\s*#?\s*\d/i,
    /employment history/i,
    /\bcompany (name|phone)\b/i,
    /\bemployer\b/i,
    /signature/i,
    /\bfull name\b/i,
    /today'?s date/i,
    /school|institution|degree|major|education/i,
    /^\s*for\s+'/i,
    /\bquestion\b/i,
    /\bsecondary\b[^.]*\bphone\b/i,
  ],
  table: [
    [/\bfirst name\b/i, "FirstName"],
    [/\blast name\b/i, "LastName"],
    [/\b(e-?mail|email address)\b/i, "Email"],
    [/\b(mobile phone|primary phone|phone number|mobile)\b/i, "MobilePhone"],
    [/\b(street address|address line 1)\b/i, "AddressLine1"],
    [/\bcity\b/i, "City"],
    [/\b(state|province|state\/region)\b/i, "State"],
    [/\b(zip|postal)\b/i, "PostalCode"],
    [/\bcountry\b/i, "Country"],
  ],
};

describe("resolveStepPayloadField — wizard-ATS-shaped positives", () => {
  const cases: Array<[string, string]> = [
    ["Fill in the First Name field with 'Reginald'", "FirstName"],
    ["Fill in the Last Name field with 'Barrington'", "LastName"],
    [`Enter ${RECON_EMAIL_TOKEN} in the Email Address field`, "Email"],
    ["Type '5125551234' into the Mobile Phone field", "MobilePhone"],
    ["Fill in the Street Address with '123 Main St'", "AddressLine1"],
    ["Enter 'Austin' in the City field", "City"],
    ["Select 'Texas' from the State dropdown", "State"],
    ["Type '78701' into the Zip Code field", "PostalCode"],
    ["Select 'United States' from the Country dropdown", "Country"],
  ];
  for (const [instruction, field] of cases) {
    it(`maps ${JSON.stringify(instruction)} → ${field}`, () => {
      expect(
        resolveStepPayloadField(instruction, undefined, false, TEST_RECRUITING_VOCABULARY)
      ).toBe(field);
    });
  }
});

describe("resolveStepPayloadField — trap negatives", () => {
  const traps = [
    "Fill in Reference #1 First Name with 'Priya'",
    "Enter the Company Phone in Employment History Row 1 as '5551239999'",
    "Type 'Reginald Barrington' into the Signature Name field",
    "Fill in any Full Name field with 'Reginald Barrington'",
    "Enter Today's Date as '2026-07-09'",
    "Type '5125550000' into the Secondary Phone Number field",
    // Screening questions: a candidate-label word ("state", "city") inside the
    // QUESTION text must not splice — the first quote is the question, not a
    // value. This is a real wizard-ATS step 42 shape (regression: "state" matched
    // the State label and corrupted the question quote into ${payload.State}).
    "For 'Are you currently licensed to work as a Registered Nurse in this state?' select 'Yes'",
    "For 'In which settings have you worked as a Registered Nurse during the past three years?' select 'Hospital'",
    "Click the 'No' answer for the question about common domicile with any employee",
    // A control's own NAME mentions a field-label word ("email") but carries no
    // applicant datum — the button/link/tab guard must reject it regardless of
    // the vocabulary label match.
    "Click the 'Sign in with email' button",
    // Yes/No screening answers are never a persona datum, even when the
    // question text elsewhere mentions a field-label word.
    "Select 'No' for the previously excluded or debarred question",
    "Select 'Yes' for the actively licensed in this state question",
  ];
  for (const instruction of traps) {
    it(`leaves ${JSON.stringify(instruction)} literal (null)`, () => {
      expect(
        resolveStepPayloadField(instruction, undefined, false, TEST_RECRUITING_VOCABULARY)
      ).toBeNull();
    });
  }
});

describe("resolveStepPayloadField — Select answer must match the field's known value", () => {
  it("does not splice a device-type dropdown answer onto a phone-number field it merely mentions", () => {
    // "MobilePhone" is bound to a real number by the Fill step; the device-type
    // dropdown's answer ('Mobile') is a category, not that number, even though
    // its label mentions "mobile" too.
    const steps = [
      "Type '5125550000' into the Mobile Phone field",
      "Select 'Mobile' from the phone device type popup list",
    ];
    const known = buildKnownFieldValues(steps, TEST_RECRUITING_VOCABULARY, {} as NodeJS.ProcessEnv);
    expect(known.get("MobilePhone")).toBe("5125550000");
    expect(
      resolveStepPayloadField(steps[1]!, undefined, false, TEST_RECRUITING_VOCABULARY, known)
    ).toBeNull();
  });

  it("still splices a matching field once the answer equals the known value", () => {
    const steps = [
      "Type '5125550000' into the Mobile Phone field",
      "Select '5125550000' from the phone number confirmation list",
    ];
    const known = buildKnownFieldValues(steps, TEST_RECRUITING_VOCABULARY, {} as NodeJS.ProcessEnv);
    expect(
      resolveStepPayloadField(steps[1]!, undefined, false, TEST_RECRUITING_VOCABULARY, known)
    ).toBe("MobilePhone");
  });
});

describe("resolveStepPayloadField — override + opt-out + no-constant", () => {
  it("honors an explicit payloadField override", () => {
    expect(resolveStepPayloadField("Click the Continue button", "FirstName")).toBe("FirstName");
  });

  it("returns null when forceNone is set even for a matching label", () => {
    expect(
      resolveStepPayloadField("Fill in the First Name field with 'Reginald'", undefined, true)
    ).toBeNull();
  });

  it("returns null when the instruction carries no spliceable constant", () => {
    expect(resolveStepPayloadField("Fill in the First Name field")).toBeNull();
  });
});

describe("emitBrowserFlowTs — payload splicing", () => {
  const { code, payloadFieldNames } = emitBrowserFlowTs({
    siteId: "test-site",
    pascal: "TestSite",
    baseUrl: "https://example.com",
    isSubmissionFlow: true,
    flowSteps: [
      "Fill in the First Name field with 'Reginald'",
      `Enter ${RECON_EMAIL_TOKEN} in the Email Address field`,
      "Select 'Decline to self-identify' from the Gender dropdown",
      { step: "Click the Submit Application button", submitStep: true },
    ],
    vocabulary: TEST_RECRUITING_VOCABULARY,
  });

  it("splices a payload.FirstName reference for the Reginald step", () => {
    expect(code).toContain(payloadRef("FirstName"));
  });

  it("splices a payload.Email reference for the RECON_EMAIL step", () => {
    expect(code).toContain(payloadRef("Email"));
  });

  it("leaves the operational-default dropdown literal", () => {
    expect(code).toContain("Decline to self-identify");
  });

  it("emits no un-spliced Reginald or RECON_EMAIL token", () => {
    expect(code).not.toContain("Reginald");
    expect(code).not.toContain(RECON_EMAIL_TOKEN);
  });

  it("calls runHealingFlow and emits a FLOW_STEPS array", () => {
    expect(code).toContain("runHealingFlow(");
    expect(code).toContain("const FLOW_STEPS: HealingFlowStep[] = [");
  });

  it("waits for SPA hydration after navigating (so early steps don't skip a shell page)", () => {
    expect(code).toContain("import { type HealingFlowStep, runHealingFlow }");
    expect(code).toContain('import { waitForSpaReady } from "');
    expect(code).toContain("await waitForSpaReady(page, logger);");
  });

  it("wires the shared Anthropic client and rephrase model so the cascade can rephrase/replan", () => {
    expect(code).toContain(
      'import { buildAnthropicClient, buildRephraseModel } from "@enricai/barnacle/lib/llm/anthropic-client"'
    );
    expect(code).toContain("anthropic: buildAnthropicClient(),");
    expect(code).toContain("rephraseModel: buildRephraseModel(),");
    expect(code).not.toContain("anthropic: null");
  });

  it("accumulates the spliced field names", () => {
    expect(payloadFieldNames).toEqual(new Set(["FirstName", "Email"]));
  });
});

describe("emitBrowserFlowTs — payload splicing — Yes/No screening answers stay literal", () => {
  const { code } = emitBrowserFlowTs({
    siteId: "test-site",
    pascal: "TestSite",
    baseUrl: "https://example.com",
    isSubmissionFlow: true,
    flowSteps: [
      "Select 'No' for previously excluded from state health care programs",
      "Select 'Yes' for currently licensed in this state",
    ],
    vocabulary: TEST_RECRUITING_VOCABULARY,
  });

  it("keeps the excluded-from-state-programs answer a literal 'No', not payload.State", () => {
    expect(code).toContain("'No'");
    expect(code).not.toContain(payloadRef("State"));
  });

  it("keeps the licensed-in-this-state answer a literal 'Yes', not payload.State", () => {
    expect(code).toContain("'Yes'");
  });
});

describe("emitBrowserFlowTs — uploadFixture guard (upload vs multipart)", () => {
  const uploadFlow = [{ step: "Upload the resume PDF using the upload control", upload: true }];

  it("wires a Buffer-based uploadFixture when the contract is multipart", () => {
    const { code } = emitBrowserFlowTs({
      siteId: "s",
      pascal: "S",
      baseUrl: "https://x",
      isSubmissionFlow: true,
      flowSteps: uploadFlow,
      hasMultipartStep: true,
    });
    expect(code).toContain("Buffer.from(payload.Resume");
    expect(code).not.toContain("base64");
    expect(code).toContain("payload.ResumeFilename");
  });

  it("emits null + TODO (never a Resume field ref) when uploading but not multipart", () => {
    const { code } = emitBrowserFlowTs({
      siteId: "s",
      pascal: "S",
      baseUrl: "https://x",
      isSubmissionFlow: true,
      flowSteps: uploadFlow,
      hasMultipartStep: false,
    });
    expect(code).not.toContain("payload.Resume");
    expect(code).toContain("uploadFixture: null");
    expect(code).toContain("TODO: this flow uploads");
  });
});

describe("emitBrowserFlowTs + emitContractTs — schema/flow anti-drift", () => {
  const flowSteps = [
    "Fill in the First Name field with 'Reginald'",
    `Enter ${RECON_EMAIL_TOKEN} in the Email Address field`,
    "Type '5125551234' into the Mobile Phone field",
    "Enter 'Austin' in the City field",
  ];
  const { code, payloadFieldNames } = emitBrowserFlowTs({
    siteId: "test-site",
    pascal: "TestSite",
    baseUrl: "https://example.com",
    isSubmissionFlow: true,
    flowSteps,
    vocabulary: TEST_RECRUITING_VOCABULARY,
  });
  const contract = emitContractTs({
    ...BASE_OPTS,
    inputBody: { Name: "Alice" },
    payloadFieldNames,
  });

  // Fields ApplicantContactSchema itself already declares (see
  // src/lib/applicant-payload.ts) don't get a redundant explicit key in the
  // merged `.extend({...})` — the single-extend dedup (bugfix-004) reserves
  // them so the schema stays a single, non-shadowing extend call.
  const applicantContactFieldNames = new Set(["FirstName", "LastName", "Phone", "City"]);

  it("every payload.X the flow references appears as a contract schema key, unless ApplicantContactSchema already declares it", () => {
    const referenced = [...code.matchAll(/\$\{payload\.([A-Za-z0-9_]+)\}/g)].map((m) => m[1]!);
    expect(referenced.length).toBeGreaterThan(0);
    for (const field of referenced) {
      if (applicantContactFieldNames.has(field)) continue;
      const decl = field === "Email" ? `${field}: z.email()` : `${field}: z.string()`;
      expect(contract).toContain(decl);
    }
  });
});

describe("emitBrowserFlowTs — splice site lands on the fill VALUE, never the selector", () => {
  const { code, payloadFieldNames } = emitBrowserFlowTs({
    siteId: "test-site",
    pascal: "TestSite",
    baseUrl: "https://example.com",
    isSubmissionFlow: true,
    flowSteps: [
      "Fill in the Legal Name First Name field (data-automation-id='legalName--firstName') with 'Reginald'",
      "Select 'Texas' from the State dropdown (data-automation-id='address--state')",
    ],
    vocabulary: TEST_RECRUITING_VOCABULARY,
  });

  it("leaves the data-automation-id selector unchanged", () => {
    expect(code).toContain("data-automation-id='legalName--firstName'");
    expect(code).toContain("data-automation-id='address--state'");
  });

  it("splices payload.FirstName only at the trailing value position", () => {
    expect(code).toContain(payloadRef("FirstName"));
    expect(code).not.toContain(`${payloadRef("FirstName")}'firstName'`);
  });

  it("splices payload.State at the leading answer position for a Select step", () => {
    expect(code).toContain(payloadRef("State"));
    expect(code).not.toContain("Texas");
  });

  it("emits no un-spliced Reginald literal", () => {
    expect(code).not.toContain("Reginald");
  });

  it("accumulates the FirstName field name", () => {
    expect(payloadFieldNames.has("FirstName")).toBe(true);
  });
});

describe("emitBrowserFlowTs — a reserved RECON_PHONE env token resolves to payload.MobilePhone", () => {
  const RECON_PHONE_TOKEN = `$${"{RECON_PHONE}"}`;
  const { code } = emitBrowserFlowTs({
    siteId: "test-site",
    pascal: "TestSite",
    baseUrl: "https://example.com",
    isSubmissionFlow: true,
    flowSteps: [`Enter ${RECON_PHONE_TOKEN} in the Mobile Phone field`],
    vocabulary: TEST_RECRUITING_VOCABULARY,
  });

  it("splices a payload.MobilePhone reference", () => {
    expect(code).toContain(payloadRef("MobilePhone"));
  });

  it("emits no un-spliced or escaped RECON_PHONE token", () => {
    expect(code).not.toContain(RECON_PHONE_TOKEN);
    expect(code).not.toContain(`\\${RECON_PHONE_TOKEN}`);
  });
});

describe("emitBrowserFlowTs — a reserved RECON_PASSWORD env token splices a generated throwaway credential", () => {
  const RECON_PASSWORD_TOKEN = `$${"{RECON_PASSWORD}"}`;
  const { code, payloadFieldNames } = emitBrowserFlowTs({
    siteId: "test-site",
    pascal: "TestSite",
    baseUrl: "https://example.com",
    isSubmissionFlow: true,
    flowSteps: [
      `Fill in the Email field with ${`$${"{RECON_EMAIL}"}`}`,
      `Enter ${RECON_PASSWORD_TOKEN} in the Password field`,
    ],
    vocabulary: TEST_RECRUITING_VOCABULARY,
  });

  it("declares a local throwaway credential minted from the shared crypto-backed helper, never a hand-rolled RNG", () => {
    expect(code).toContain(
      'import { generateThrowawayPassword } from "@enricai/barnacle/lib/random";'
    );
    expect(code).toContain("const throwawayPassword = generateThrowawayPassword();");
  });

  it("splices the Password step to the generated throwaway, not a payload accessor", () => {
    expect(code).toContain(`$${"{throwawayPassword}"}`);
    expect(code).not.toContain("payload.Password");
  });

  it("never routes the Password step through vocabulary/payload-field resolution", () => {
    expect(payloadFieldNames.has("Password")).toBe(false);
  });

  it("emits no literal RECON_PASSWORD substring anywhere, resolved or escaped", () => {
    expect(code).not.toContain(RECON_PASSWORD_TOKEN);
    expect(code).not.toContain(`\\${RECON_PASSWORD_TOKEN}`);
    expect(code).not.toContain("RECON_PASSWORD");
  });
});

describe("emitBrowserFlowTs — no throwaway-password import/declaration when no step uses RECON_PASSWORD", () => {
  it("omits both the import and the local declaration", () => {
    const { code } = emitBrowserFlowTs({
      siteId: "test-site",
      pascal: "TestSite",
      baseUrl: "https://example.com",
      isSubmissionFlow: true,
      flowSteps: ["Fill in the First Name field with 'Reginald'"],
      vocabulary: TEST_RECRUITING_VOCABULARY,
    });
    expect(code).not.toContain("generateThrowawayPassword");
    expect(code).not.toContain("throwawayPassword");
  });
});

describe("selectPayloadAction", () => {
  /** Minimal action step — only the fields selection reads. */
  const step = (url: string, requestPostData: string | null, responseBody: unknown) => ({
    capture: { url, requestPostData, responseBody } as unknown as Parameters<
      typeof selectPayloadAction
    >[0][number]["capture"],
  });

  it("keeps the first action for a transactional flow, where each endpoint is hit once", () => {
    // The regression that matters: an apply flow puts the caller's data in the
    // opening POST, and later steps only carry the transaction forward.
    const steps = [
      step("https://ats.test/api/application/create", '{"FirstName":"Reginald"}', { id: "a1" }),
      step("https://ats.test/api/form-schema", '{"jobId":"9"}', { sections: [{ fields: [] }] }),
      step("https://ats.test/api/application/a1/submit", '{"confirm":true}', { success: true }),
    ];
    expect(selectPayloadAction(steps)).toBe(steps[0]);
  });

  it("prefers an endpoint re-issued with a different body over whatever fired first", () => {
    // A search page re-queries on every filter change; the toggle fetch that
    // happened to load first is incidental.
    const steps = [
      step("https://shop.test/toggles", '{"flags":["a"]}', { featureA: true }),
      step("https://shop.test/search", '{"page":1,"filters":[]}', { total: 699 }),
      step("https://shop.test/search", '{"page":1,"filters":["2-bed"]}', { total: 151 }),
    ];
    expect(selectPayloadAction(steps)).toBe(steps[1]);
  });

  it("ignores a chattering endpoint that returns nothing", () => {
    // Client-side error reporting re-posts with varying bodies and an empty
    // response — repetition alone must not make it look like the subject.
    const steps = [
      step("https://shop.test/config", '{"k":"v"}', { config: 1 }),
      step("https://shop.test/error", '{"msg":"boom"}', null),
      step("https://shop.test/error", '{"msg":"other"}', null),
    ];
    expect(selectPayloadAction(steps)).toBe(steps[0]);
  });

  it("keeps the first action when the same endpoint repeats with an identical body", () => {
    // A retry is not a re-query: nothing varies, so nothing is learned.
    const steps = [
      step("https://shop.test/a", '{"x":1}', { ok: true }),
      step("https://shop.test/b", '{"y":2}', { ok: true }),
      step("https://shop.test/b", '{"y":2}', { ok: true }),
    ];
    expect(selectPayloadAction(steps)).toBe(steps[0]);
  });

  it("treats query strings on the same endpoint as one endpoint", () => {
    const steps = [
      step("https://shop.test/toggles", '{"f":1}', { on: true }),
      step("https://shop.test/search?page=1", '{"page":1}', { total: 9 }),
      step("https://shop.test/search?page=2", '{"page":2}', { total: 9 }),
    ];
    expect(selectPayloadAction(steps)).toBe(steps[1]);
  });

  it("prefers a re-issued draft over an opening call that carries none of the caller's data", () => {
    // A transactional flow can re-issue an endpoint too: an applicant record is
    // built up across several writes while the call that opened the flow only
    // ever sent a job id. Selection lands on the writes, which is where the
    // caller's fields actually are.
    const steps = [
      step("https://ats.test/hcm/sourceTrackings", '{"jobId":"1"}', { items: [{ id: 1 }] }),
      step("https://ats.test/hcm/applicationDrafts", '{"FirstName":"Reginald"}', { draftId: "d1" }),
      step("https://ats.test/hcm/applicationDrafts", '{"MobilePhone":"5125550123"}', {
        draftId: "d1",
      }),
    ];
    expect(selectPayloadAction(steps)).toBe(steps[1]);
  });

  it("returns null when there are no actions to choose from", () => {
    expect(selectPayloadAction([])).toBeNull();
  });
});

describe("selectReturnAction", () => {
  /** Minimal action step — only the fields selection reads. */
  const step = (url: string, requestPostData: string | null, responseBody: unknown) => ({
    capture: { url, requestPostData, responseBody } as unknown as Parameters<
      typeof selectReturnAction
    >[0][number]["capture"],
  });

  it("prefers the re-queried search endpoint's last call over a terminal drill-down (G1)", () => {
    // The listings-fixture shape: toggles (once) → authz mint (once) →
    // available-products/ re-queried with varying filters → a drill-down
    // into one building fires last. The search result is the flow's
    // subject, not the drill-down's single-building body.
    const steps = [
      step("https://listings.test/toggles/product-avail", '["a"]', [{ name: "a" }]),
      step("https://listings.test/authz/private", "{}", { result: "ok", successful: true }),
      step("https://listings.test/available-products/", '{"filters":[]}', {
        totalAvailableListings: 699,
        products: [{ id: "p1" }],
      }),
      step("https://listings.test/available-products/", '{"filters":["2-bed"]}', {
        totalAvailableListings: 151,
        products: [{ id: "p2" }],
      }),
      step("https://listings.test/available-units/", '{"buildingId":"i1"}', {
        units: [{ id: "s1" }],
        exchangeRate: 1,
      }),
    ];
    expect(selectReturnAction(steps)).toBe(steps[3]);
  });

  it("falls through to the terminal call for a genuine single-pass submission flow", () => {
    // Every endpoint fires exactly once — nothing is re-queried, so the
    // fallback must be the LAST action (the terminal success signal), not
    // the FIRST (that's selectPayloadAction's fallback).
    const steps = [
      step("https://ats.test/api/application/create", '{"FirstName":"Reginald"}', { id: "a1" }),
      step("https://ats.test/api/form-schema", '{"jobId":"9"}', { sections: [{ fields: [] }] }),
      step("https://ats.test/api/application/a1/submit", '{"confirm":true}', { success: true }),
    ];
    expect(selectReturnAction(steps)).toBe(steps[2]);
  });

  it("ignores a chattering endpoint that returns nothing, even when it fires last", () => {
    const steps = [
      step("https://shop.test/config", '{"k":"v"}', { config: 1 }),
      step("https://shop.test/error", '{"msg":"boom"}', null),
      step("https://shop.test/error", '{"msg":"other"}', null),
    ];
    expect(selectReturnAction(steps)).toBe(steps[2]);
  });

  it("returns the single action for a one-call flow", () => {
    const steps = [step("https://shop.test/search", '{"q":"a"}', { total: 1 })];
    expect(selectReturnAction(steps)).toBe(steps[0]);
  });

  it("returns null when there are no actions to choose from", () => {
    expect(selectReturnAction([])).toBeNull();
  });
});

describe("emitMultiStepExecuteHttp — relevance-selected return value (G1)", () => {
  const capture = (
    url: string,
    requestPostData: string | null,
    responseBody: unknown,
    varName: string
  ) => ({
    capture: {
      timestamp: "2024-01-01T00:00:00Z",
      phase: "action" as const,
      method: "POST",
      url,
      status: 200,
      requestHeaders: { "Content-Type": "application/json" },
      requestPostData,
      responseHeaders: { "content-type": "application/json" },
      responseBody,
      operationName: null,
      query: null,
      variables: null,
      decodedParams: null,
    },
    varName,
    produces: [],
    isMultipart: false,
    isCrossDomain: false,
  });

  it("returns the re-queried search call's var, not the terminal drill-down's, when they differ", () => {
    const steps = [
      capture("https://listings.test/toggles", '["a"]', [{ name: "a" }], "r0"),
      capture("https://listings.test/authz/private", "{}", { successful: true }, "r1"),
      capture(
        "https://listings.test/available-products/",
        '{"filters":[]}',
        { totalAvailableListings: 699, products: [{ id: "p1" }] },
        "r2"
      ),
      capture(
        "https://listings.test/available-products/",
        '{"filters":["2-bed"]}',
        { totalAvailableListings: 151, products: [{ id: "p2" }] },
        "r3"
      ),
      capture(
        "https://listings.test/available-units/",
        '{"buildingId":"i1"}',
        { units: [{ id: "s1" }], exchangeRate: 1 },
        "r4"
      ),
    ];
    const body = emitMultiStepExecuteHttp(
      steps,
      null,
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      new Set(),
      new Map(),
      new Set(),
      new Map(),
      new Map(),
      "https://listings.test",
      new Map(),
      new Map()
    );

    expect(body).toContain("return { data: r3 };");
    expect(body).not.toContain("return { data: r4 };");
    // The selected var's `const` must actually be declared — otherwise the
    // emitted code references an undeclared variable.
    expect(body).toContain("const r3 = (await httpClient(");
  });

  it("returns the terminal call's var for a genuine single-pass submission flow", () => {
    const steps = [
      capture(
        "https://ats.test/api/application/create",
        '{"FirstName":"Reginald"}',
        { id: "a1" },
        "r0"
      ),
      capture("https://ats.test/api/form-schema", '{"jobId":"9"}', { sections: [] }, "r1"),
      capture(
        "https://ats.test/api/application/a1/submit",
        '{"confirm":true}',
        { success: true },
        "r2"
      ),
    ];
    const body = emitMultiStepExecuteHttp(
      steps,
      null,
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      new Set(),
      new Map(),
      new Set(),
      new Map(),
      new Map(),
      "https://ats.test",
      new Map(),
      new Map()
    );

    expect(body).toContain("return { data: r2 };");
    expect(body).toContain("const r2 = (await httpClient(");
  });
});

describe("emitMultiStepExecuteHttp — per-call response schema override (G2)", () => {
  const steps = buildMulticallHeterogeneousActionSteps();
  // MulticallFixtureStep.produces is typed unknown[] (its own module doesn't
  // export recon-generate.ts's internal Produce type — see the fixture's
  // docstring); every step's produces is [] at runtime, which structurally
  // satisfies ActionStep.produces: Produce[].
  const body = emitMultiStepExecuteHttp(
    steps as Parameters<typeof emitMultiStepExecuteHttp>[0],
    null,
    { stringMessageKey: null, nestedErrorPaths: [] },
    new Map(),
    new Set(),
    new Map(),
    new Set(),
    new Map(),
    new Map(),
    "https://api.example.com",
    new Map(),
    new Map()
  );
  const callBlocks = body
    .split(/(?=(?:const \w+ = )?\(?await httpClient\()/)
    .filter((b) => b.includes("await httpClient("));

  function callBlockForUrl(urlSubstring: string): string {
    const block = callBlocks.find((b) => b.includes(urlSubstring));
    if (!block)
      throw new Error(`no httpClient call block found for URL containing ${urlSubstring}`);
    return block;
  }

  it("emits a distinct per-call schema for the toggles array response", () => {
    const block = callBlockForUrl("toggles/product-avail");
    expect(block).toMatch(/schema:\s*z\.array\(/);
    expect(block).toContain("name: z.string()");
    expect(block).toContain("enabled: z.boolean()");
  });

  it("emits a distinct per-call schema for the {result,successful} auth-mint response", () => {
    const block = callBlockForUrl("authz/private");
    expect(block).toContain("result: z.string()");
    expect(block).toContain("successful: z.boolean()");
    expect(block).not.toContain("totalPages");
  });

  it("emits the inventory shape's own schema on the available-products call, not the toggles shape", () => {
    // r2's varying `page` field is threaded to `payload.page` (selectPayloadAction's
    // re-query signature), distinguishing its block from r3's literal `body:
    // \`{"page":2}\``.
    const block = callBlockForUrl("payload.page");
    expect(block).toContain("totalPages: z.number()");
    expect(block).toContain("totalAvailableListings: z.number()");
    expect(block).toContain("products: z.array(");
    expect(block).not.toMatch(/schema:\s*z\.array\(z\.object/);
  });

  it("the toggles call's schema is not the products/inventory schema (the G2 reproduction)", () => {
    const togglesBlock = callBlockForUrl("toggles/product-avail");
    expect(togglesBlock).not.toContain("totalPages");
    expect(togglesBlock).not.toContain("totalAvailableListings");
  });

  it("every httpClient(...) call carries its own schema: override rather than relying on the client default", () => {
    const httpClientCallCount = (body.match(/await httpClient\(/g) ?? []).length;
    const schemaOverrideCount = (body.match(/\n\s*schema: /g) ?? []).length;
    expect(schemaOverrideCount).toBe(httpClientCallCount);
  });

  it("the client-level ResponseSchema is not referenced by any per-call schema, so narrowing it leaves non-terminal calls' schemas unchanged (the G2 reproduction)", () => {
    // emitContractTs infers the client-level ResponseSchema from the SAME
    // body executeHttp returns (BASE_OPTS.responseBody here), independent of
    // any individual call's own per-call `schema:` override — the report's
    // repro is the author narrowing that client schema further and
    // expecting it to leave every other call's own inferred schema alone.
    const contract = emitContractTs({ ...BASE_OPTS, multiStepBody: body });
    expect(contract).toContain(
      "const TestSiteResponseSchema = z.object({\n  id: z.string(),\n  active: z.boolean(),\n}).loose();"
    );
    const narrowedContract = contract.replace(
      "const TestSiteResponseSchema = z.object({\n  id: z.string(),\n  active: z.boolean(),\n}).loose();",
      "const TestSiteResponseSchema = z.object({\n  totalPages: z.number(),\n  totalAvailableListings: z.number(),\n  products: z.array(z.object({ productId: z.string() })),\n});"
    );

    // The toggles call carries its own inferred `schema:` literal, so the
    // narrowed client schema is unreferenced by it.
    const togglesBlock = callBlockForUrl("toggles/product-avail");
    expect(togglesBlock).toMatch(/schema:\s*z\.array\(/);
    expect(togglesBlock).not.toContain("schema: TestSiteResponseSchema");
    expect(togglesBlock).not.toContain("totalPages");
    expect(narrowedContract).toContain("totalPages: z.number()");
  });
});

describe("inferZodSchemaFromSamples — __typename dropped and objects .loose() on server-response call sites", () => {
  it("never emits __typename in the client-level ResponseSchema, even nested", () => {
    const source = emitContractTs({
      ...BASE_OPTS,
      gql: true,
      gqlQuery: "{ widget { __typename id nested { __typename label } } }",
      responseBody: {
        __typename: "Widget",
        id: "abc",
        nested: { __typename: "Nested", label: "x" },
      },
      multiStepBody: `    return { data: {} as unknown };`,
    });
    const schemaMatch = source.match(/export const TestSiteResponseSchema = [\s\S]*?;\n/);
    expect(schemaMatch).not.toBeNull();
    expect(schemaMatch?.[0]).not.toContain("__typename");
  });

  it("wraps every emitted nested z.object({...}) in the client-level ResponseSchema with .loose()", () => {
    const source = emitContractTs({
      ...BASE_OPTS,
      responseBody: { id: "abc", nested: { label: "x" } },
      multiStepBody: `    return { data: {} as unknown };`,
    });
    const schemaMatch = source.match(/export const TestSiteResponseSchema = ([\s\S]*?);\n/);
    expect(schemaMatch).not.toBeNull();
    const schemaText = schemaMatch?.[1] ?? "";
    const objectOpens = schemaText.match(/z\.object\(\{/g) ?? [];
    const looseCloses = schemaText.match(/\}\)\.loose\(\)/g) ?? [];
    expect(objectOpens.length).toBeGreaterThan(0);
    expect(looseCloses.length).toBe(objectOpens.length);
  });

  it("drops __typename and looses objects in emitMultiStepExecuteHttp's per-call schema", () => {
    const capture = (
      url: string,
      requestPostData: string | null,
      responseBody: unknown,
      varName: string
    ) => ({
      capture: {
        timestamp: "2024-01-01T00:00:00Z",
        phase: "action" as const,
        method: "POST",
        url,
        status: 200,
        requestHeaders: { "Content-Type": "application/json" },
        requestPostData,
        responseHeaders: { "content-type": "application/json" },
        responseBody,
        operationName: null,
        query: null,
        variables: null,
        decodedParams: null,
      },
      varName,
      produces: [],
      isMultipart: false,
      isCrossDomain: false,
    });
    const steps = [
      capture("https://api.example.com/graphql", null, { __typename: "Widget", id: "abc" }, "r0"),
    ];
    const body = emitMultiStepExecuteHttp(
      steps,
      null,
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      new Set(),
      new Map(),
      new Set(),
      new Map(),
      new Map(),
      "https://api.example.com",
      new Map(),
      new Map()
    );
    expect(body).not.toContain("__typename");
    expect(body).toMatch(/schema:\s*z\.object\(\{\n\s*id: z\.string\(\),\n\s*\}\)\.loose\(\)/);
  });

  it("leaves the input-body-derived payload schema and structured-key inference unaffected by __typename/.loose()", () => {
    const source = emitContractTs({
      ...BASE_OPTS,
      inputBody: { __typename: "Ignored", Name: "Alice" },
      discoveredStructuredKeys: new Map([["eventData", "z.object({ a: z.string() })"]]),
      multiStepBody: `    return { data: {} as unknown };`,
    });
    expect(source).toContain("__typename");
    expect(source).toContain("eventData: multipartJsonObject(z.object({ a: z.string() })),");
  });
});

describe("query-constant comment", () => {
  it("no longer promises a trim the generator never performs", () => {
    const source = emitContractTs({
      ...BASE_OPTS,
      gql: true,
      gqlQuery: "{ widget { id } }",
      multiStepBody: `    return { data: {} as unknown };`,
    });
    expect(source).not.toContain("trim UI-only fields before shipping");
  });
});

describe("selectEffectiveResponseBody — shape source agrees with the return value (G1)", () => {
  it("derives from the fold-merged primary call, not the plain re-queried page or the raw drill-down, for the drill-down-terminal fixture", () => {
    const steps = buildMulticallHeterogeneousActionStepsWithDrillDown();

    const shapeSource = selectEffectiveResponseBody(true, steps, null);
    const returnAction = selectReturnAction(steps);

    // r4's drill-down request threads r2's (page 1) sole item's productId, so
    // detectDrillDownFoldPlan finds a fold plan over [r2, r4] — this bypasses
    // selectReturnAction entirely (see emitMultiStepExecuteHttp's own
    // "A detected drill-down fold plan bypasses selectReturnAction" comment),
    // so the inferred shape has to follow the fold, not selectReturnAction's
    // freshest-re-query pick (r3, page 2) or the raw unmerged r2/r4 bodies.
    expect(returnAction?.varName).toBe("r3");
    expect(shapeSource).not.toEqual(returnAction?.capture.responseBody);
    expect(shapeSource).toEqual({
      totalPages: 5,
      totalAvailableListings: 699,
      products: [{ productId: "p1", unitId: "s1" }],
    });
  });

  it("derives from the terminal call for a genuine single-pass submission flow, agreeing with the return value", () => {
    const steps = [
      {
        capture: {
          timestamp: "2024-01-01T00:00:00Z",
          phase: "action" as const,
          method: "POST",
          url: "https://ats.test/api/application/create",
          status: 200,
          requestHeaders: { "Content-Type": "application/json" },
          requestPostData: '{"FirstName":"Reginald"}',
          responseHeaders: { "content-type": "application/json" },
          responseBody: { id: "a1" },
          operationName: null,
          query: null,
          variables: null,
          decodedParams: null,
        },
        varName: "r0",
        produces: [],
        isMultipart: false,
        isCrossDomain: false,
      },
      {
        capture: {
          timestamp: "2024-01-01T00:00:01Z",
          phase: "action" as const,
          method: "POST",
          url: "https://ats.test/api/application/a1/submit",
          status: 200,
          requestHeaders: { "Content-Type": "application/json" },
          requestPostData: '{"confirm":true}',
          responseHeaders: { "content-type": "application/json" },
          responseBody: { success: true },
          operationName: null,
          query: null,
          variables: null,
          decodedParams: null,
        },
        varName: "r1",
        produces: [],
        isMultipart: false,
        isCrossDomain: false,
      },
    ];

    const shapeSource = selectEffectiveResponseBody(true, steps, null);
    const returnAction = selectReturnAction(steps);

    expect(returnAction?.varName).toBe("r1");
    expect(shapeSource).toEqual(returnAction?.capture.responseBody);
    expect(shapeSource).toEqual({ success: true });
  });

  it("merges by join key, not position: each drill-down response matches the primary item it was built from", () => {
    // The primary page's items are [i-b, i-a] (deliberately not alphabetical)
    // and the two drill-down calls fire in the OPPOSITE order (i-a's call
    // first). Both drill-downs independently thread a primary item's join
    // value, so detectDrillDownFoldPlan resolves both as separate targets,
    // and each one's response must land onto its OWN item by join key — not
    // onto items[0], and not with only the earliest-firing target winning —
    // a positional/index-based merge would wrongly pair items[0] with
    // whichever drill-down call happened to fire first.
    const steps = buildMulticallDependentDrillDownActionSteps();

    const shapeSource = selectEffectiveResponseBody(true, steps, null);

    expect(shapeSource).toEqual({
      totalPages: 2,
      items: [
        { itemId: "i-b", detailId: "d-b" },
        { itemId: "i-a", detailId: "d-a" },
      ],
    });
  });

  it("folds the chain's terminal (price-history) response onto the primary item, not the drill step's own foldable prices[]", () => {
    const steps = buildMulticallSingleShotSearchDrillDownChainedDependentActionSteps();

    const shapeSource = selectEffectiveResponseBody(true, steps, null);

    expect(shapeSource).toEqual({
      results: [{ sku: "sku-a", amount: 18.5, asOf: "2024-11-01" }, { sku: "sku-b" }],
    });
  });
});

describe("emitMultiStepExecuteHttp — chained per-item drill dependency", () => {
  it("emits the full chain inside the fold loop instead of throwing when the drill step's own response is both foldable and depended on further", () => {
    const steps = buildMulticallSingleShotSearchDrillDownChainedDependentActionSteps();

    expect(() =>
      emitMultiStepExecuteHttp(
        steps as Parameters<typeof emitMultiStepExecuteHttp>[0],
        null,
        { stringMessageKey: null, nestedErrorPaths: [] },
        new Map(),
        new Set(),
        new Map(),
        new Set(),
        new Map(),
        new Map(),
        "https://api.example.com",
        new Map(),
        new Map()
      )
    ).not.toThrow();

    const body = emitMultiStepExecuteHttp(
      steps as Parameters<typeof emitMultiStepExecuteHttp>[0],
      null,
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      new Set(),
      new Map(),
      new Set(),
      new Map(),
      new Map(),
      "https://api.example.com",
      new Map(),
      new Map()
    );

    expect(body).toContain("for (const item of foldItems) {");
    expect(body).toContain("const r1 = (await httpClient(");
    expect(body).toContain("const r2 = (await httpClient(");
    expect(body).toContain("const foldMatches = (r2 as");
    expect(body).toContain(
      "Object.assign(item, Object.fromEntries(Object.entries(foldMatch ?? {}).filter(([k]) => !(k in item))));"
    );
    // r1/r2 are only ever issued inside the fold loop — never a second time
    // outside it.
    expect(body.match(/const r1 = \(await httpClient\(/g)).toHaveLength(1);
    expect(body.match(/const r2 = \(await httpClient\(/g)).toHaveLength(1);
  });
});

describe("emitMultiStepExecuteHttp — fold-loop parameterize re-keys a boolean join field per item", () => {
  it("swaps the captured boolean join literal for a per-item accessor instead of freezing it as a shared constant", () => {
    // r0's primary items carry a boolean `primary` field; r1's drill request
    // threads that field's own captured value (`true`, from item 0) as a
    // literal query param. Without boolean support at the join-detection and
    // parameterize layers, the drill call is either never folded into the
    // loop at all, or (if it were) `primary=true` would stay frozen as a
    // shared literal instead of re-keying to each item's own boolean.
    const steps = [
      buildStep("r0", {
        url: "https://api.example.com/catalog/search/",
        requestPostData: '{"page":1}',
        responseBody: {
          results: [
            { sku: "sku-a", primary: true },
            { sku: "sku-b", primary: false },
          ],
        },
        timestamp: "2024-11-15T00:00:00Z",
      }),
      buildStep("r1", {
        url: "https://api.example.com/catalog/detail/?primary=true",
        requestPostData: null,
        method: "GET",
        responseBody: { detail: "d1" },
        timestamp: "2024-11-15T00:00:01Z",
      }),
    ];

    const body = emitMultiStepExecuteHttp(
      steps as Parameters<typeof emitMultiStepExecuteHttp>[0],
      null,
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      new Set(),
      new Map(),
      new Set(),
      new Map(),
      new Map(),
      "https://api.example.com",
      new Map(),
      new Map()
    );

    expect(body).toContain("for (const item of foldItems) {");
    expect(body).toContain(`$${"{"}item.primary}`);
    expect(body).not.toContain("primary=true");
  });
});

describe("inferZodSchemaFromSamples", () => {
  it("marks a key absent from some samples optional rather than requiring it of every response", () => {
    const schema = inferZodSchemaFromSamples([{ a: 1, b: "x" }, { a: 2 }]);
    expect(schema).toContain("b: z.string().optional()");
    expect(schema).toContain("a: z.number()");
  });

  it("treats a field seen as null in one sample and a string in another as nullable, not z.null()", () => {
    const schema = inferZodSchemaFromSamples([{ p: null }, { p: "str" }]);
    expect(schema).toContain("p: z.string().nullable()");
    expect(schema).not.toContain("z.null()");
  });

  it("stays permissive when every observation of a field is null", () => {
    // A z.null() here would reject the string the endpoint returns tomorrow.
    expect(inferZodSchemaFromSamples([{ p: null }])).toContain("p: z.unknown()");
  });

  it("merges every array element so a field missing from element 0 is still discovered", () => {
    const schema = inferZodSchemaFromSamples([[{ x: 1 }, { x: 2, y: 3 }]]);
    expect(schema).toContain("y: z.number().optional()");
  });

  it("falls back to unknown for a field whose type varies across samples", () => {
    expect(inferZodSchemaFromSamples([{ v: "s" }, { v: 1 }])).toContain("v: z.unknown()");
  });

  it("infers past four levels so deeply nested inventory fields survive", () => {
    // products[].buildings[].units[].price.summary.total — the shape real
    // listing inventory arrives in; a depth-4 cap erases exactly this.
    const deep = {
      products: [
        {
          buildings: [{ units: [{ unitId: "UU1522", price: { summary: { total: 1402 } } }] }],
        },
      ],
    };
    const schema = inferZodSchemaFromSamples([deep]);
    expect(schema).toContain("unitId: z.string()");
    expect(schema).toContain("total: z.number()");
  });

  it("collapses to unknown past the configured depth so pathological payloads stay bounded", () => {
    const deep = { a: { b: { c: { d: { e: "too far" } } } } };
    expect(inferZodSchemaFromSamples([deep], 0, "", { maxDepth: 2 })).toContain("z.unknown()");
  });
});

describe("emitBrowserFlowTs + emitContractTs — read-flow payload", () => {
  // A read flow (no submission POSTs) reaches emitContractTs with inputBody
  // undefined. The flow emitter and the contract emitter must still agree on
  // the payload shape: the flow's extract instruction interpolates payload
  // fields, and every one it names has to exist in the contract's bodySchema
  // or the generated site fails to compile.
  const { code } = emitBrowserFlowTs({
    siteId: "read-site",
    pascal: "ReadSite",
    baseUrl: "https://example.com",
    isSubmissionFlow: false,
    flowSteps: ["Open the results list"],
  });

  it("keeps the flow's payload references and the contract's schema keys in sync with no inputBody", () => {
    const contract = emitContractTs({ ...BASE_OPTS, inputBody: undefined });
    const referenced = [...code.matchAll(/\$\{payload\.([A-Za-z0-9_]+)\}/g)].map((m) => m[1]!);
    expect(referenced.length).toBeGreaterThan(0);
    for (const field of referenced) {
      expect(contract).toContain(`${field}:`);
    }
  });

  it("emits the standard candidate-payload schema, not a search-string fallback, when a request body was captured", () => {
    // A captured request body means this isn't the query-string fallback case
    // (see the "no inputBody" test above) — recon-generate-payload-schema-mismatch.md's
    // fix option (a) makes the standard candidate payload the unconditional
    // default here, regardless of what the captured body's own shape was.
    const contract = emitContractTs({
      ...BASE_OPTS,
      inputBody: { page: 1, region: "INTL", filters: [], sorts: [{ criteria: "RECOMMENDED" }] },
    });
    expect(contract).toContain("ApplicantContactSchema.extend({");
    expect(contract).not.toContain("query: z.string().min(1)");
  });

  it("demotes the captured request shape to a documented internal-reference const, distinct from the payload schema", () => {
    const contract = emitContractTs({
      ...BASE_OPTS,
      inputBody: { page: 1, region: "INTL", filters: [], sorts: [{ criteria: "RECOMMENDED" }] },
    });
    const referenceConst = `${BASE_OPTS.pascal}InternalRequestReference`;
    expect(contract).toContain(`export const ${referenceConst} =`);
    expect(contract).toContain("region: z.");
    expect(contract).toContain(
      `const ${BASE_OPTS.pascal}PayloadSchema = ApplicantContactSchema.extend({`
    );
    // The reference const must carry TSDoc explaining it is builder input for
    // reconstructing the site's own request, not the public /run contract —
    // and must never itself become (or be assigned to) the exported bodySchema.
    const docBlockMatch = contract.match(
      new RegExp(`/\\*\\*[\\s\\S]*?\\*/\\s*\\nexport const ${referenceConst} =`)
    );
    expect(docBlockMatch).not.toBeNull();
    const docBlock = docBlockMatch![0];
    expect(docBlock).toMatch(/builder module/i);
    expect(docBlock).toMatch(/site's own request/i);
    expect(docBlock).toMatch(/NOT the public/i);
    expect(contract).not.toMatch(new RegExp(`bodySchema:\\s*${referenceConst}\\b`));
  });

  it("emits no internal-reference construct when no request body was captured", () => {
    const contract = emitContractTs({ ...BASE_OPTS, inputBody: undefined });
    expect(contract).not.toContain("InternalRequestReference");
  });

  it("keeps the raw inferred query-fallback schema, not ApplicantContactSchema, when isSubmissionFlow is false", () => {
    // generateSitePlugin only ever populates inputBody when isSubmissionFlow
    // is true (`const inputBody = isSubmissionFlow ? ... : undefined`) —
    // mirror that guard here so a non-submission (read/search) flow can
    // never reach emitContractTs with a candidate-shaped inputBody, and the
    // pre-existing query-object bodySchema stays exactly as before.
    const isSubmissionFlow = false;
    const candidateShapedBody = { Name: "Alice", Email: "alice@example.com" };
    const inputBody = isSubmissionFlow ? candidateShapedBody : undefined;
    const contract = emitContractTs({ ...BASE_OPTS, inputBody });
    expect(contract).not.toContain("ApplicantContactSchema.extend(");
    expect(contract).not.toContain("multipartJsonObject");
    expect(contract).toContain("query: z.string().min(1)");
  });
});

describe("emitConfigManifest — config-only plugin emission", () => {
  const manifestStr = emitConfigManifest({
    siteId: "acme-demo",
    displayName: "AcmeDemo",
    baseUrl: "https://apply.acme.example",
    flowSteps: [
      "click the apply button",
      { step: "fill the First Name field with 'Jane'", payloadField: "FirstName" },
      { step: `fill the Email field with ${RECON_EMAIL_TOKEN}`, payloadField: "Email" },
      { step: "click Submit", submitStep: true },
      { step: "upload resume", upload: true, optional: true },
    ],
  });
  const manifest = JSON.parse(manifestStr) as {
    apiVersion: string;
    kind: string;
    spec: {
      request: { properties: Record<string, unknown> };
      flow: { steps: unknown[] };
    };
  };

  it("emits the K8s-style envelope", () => {
    expect(manifest.apiVersion).toBe(CONFIG_PLUGIN_API_VERSION);
    expect(manifest.kind).toBe(CONFIG_PLUGIN_KIND);
  });

  it("rewrites recon splices into {{ .request.X }} templates", () => {
    expect(manifestStr).toContain("{{ .request.FirstName }}");
    expect(manifestStr).toContain("{{ .request.Email }}");
    expect(manifestStr).not.toContain("'Jane'");
    expect(manifestStr).not.toContain(RECON_EMAIL_TOKEN);
  });

  it("promotes every spliced field into the request schema (no drift)", () => {
    expect(Object.keys(manifest.spec.request.properties).sort()).toEqual(["Email", "FirstName"]);
  });

  it("preserves submit and upload/optional flags on object-form steps", () => {
    const objectSteps = manifest.spec.flow.steps.filter(
      (s): s is { step: string; submitStep?: boolean; upload?: boolean; optional?: boolean } =>
        typeof s === "object" && s !== null
    );
    expect(objectSteps.some((s) => s.submitStep === true)).toBe(true);
    expect(objectSteps.some((s) => s.upload === true && s.optional === true)).toBe(true);
  });
});

describe("emitConfigManifest — displayName omitted rather than derived from siteId", () => {
  it("never bakes a PascalCase(siteId) brand string into metadata.displayName", () => {
    const manifestStr = emitConfigManifest({
      siteId: "wholesale-fish-market",
      baseUrl: "https://apply.example.com",
      flowSteps: ["click the apply button"],
    });
    const manifest = JSON.parse(manifestStr) as { metadata: Record<string, unknown> };
    expect(manifest.metadata).not.toHaveProperty("displayName");
    expect(manifestStr).not.toContain("WholesaleFishMarket");
  });
});

describe("recon-generate CLI — flow-authored displayName reaches emitConfigManifest's metadata", () => {
  const REPO_ROOT = join(__dirname, "..", "..");
  const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
  const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

  let workDir: string | null = null;
  let siteOutDir: string | null = null;

  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
    workDir = null;
    siteOutDir = null;
  });

  it("threads recon-flow.json's real displayName (not a PascalCase(siteId) fabrication) into the --emit config manifest", () => {
    workDir = mkdtempSync(join(tmpdir(), "recon-cli-config-displayname-"));
    const runRoot = join(workDir, "run");
    mkdirSync(join(runRoot, "graphql"), { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
    writeFileSync(
      join(runRoot, "graphql", "000-search.json"),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        phase: "home",
        method: "POST",
        url: "https://example.com/api/search",
        status: 200,
        requestHeaders: { "Content-Type": "application/json" },
        requestPostData: JSON.stringify({ query: "widgets" }),
        responseHeaders: { "content-type": "application/json" },
        responseBody: { id: "abc", active: true },
        operationName: null,
        query: null,
        variables: null,
        decodedParams: null,
      } satisfies Capture)
    );

    const siteId = `recon-cli-config-displayname-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({ steps: [{ step: "search for widgets" }], displayName: "Widget Depot" })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "config", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const manifest = JSON.parse(
      readFileSync(join(siteOutDir, `${siteId}.plugin.json`), "utf8")
    ) as { metadata: Record<string, unknown> };
    expect(manifest.metadata.displayName).toBe("Widget Depot");
  }, 30_000);
});

describe("recon-generate CLI — no displayName override never fabricates PascalCase(siteId) at the extraction site", () => {
  const REPO_ROOT = join(__dirname, "..", "..");
  const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
  const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

  let workDir: string | null = null;
  let siteOutDir: string | null = null;

  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
    workDir = null;
    siteOutDir = null;
  });

  it("omits displayName from both the contract.ts meta block and the config manifest's metadata, with no PascalCase-split fabrication", () => {
    workDir = mkdtempSync(join(tmpdir(), "recon-cli-no-displayname-"));
    const runRoot = join(workDir, "run");
    mkdirSync(join(runRoot, "graphql"), { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
    writeFileSync(
      join(runRoot, "graphql", "000-search.json"),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        phase: "home",
        method: "POST",
        url: "https://example.com/api/search",
        status: 200,
        requestHeaders: { "Content-Type": "application/json" },
        requestPostData: JSON.stringify({ query: "widgets" }),
        responseHeaders: { "content-type": "application/json" },
        responseBody: { id: "abc", active: true },
        operationName: null,
        query: null,
        variables: null,
        decodedParams: null,
      } satisfies Capture)
    );

    const siteId = "wholesale-fish-market";
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({ steps: [{ step: "search for widgets" }] })
    );

    const tsResult = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    expect(tsResult.status, `${tsResult.stdout}\n${tsResult.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).not.toContain("displayName");
    expect(contract).not.toContain("Wholesale Fish Market");

    const configResult = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "config", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    expect(configResult.status, `${configResult.stdout}\n${configResult.stderr}`).toBe(0);

    const manifestStr = readFileSync(join(siteOutDir, `${siteId}.plugin.json`), "utf8");
    const manifest = JSON.parse(manifestStr) as { metadata: Record<string, unknown> };
    expect(manifest.metadata).not.toHaveProperty("displayName");
    expect(manifestStr).not.toContain("Wholesale Fish Market");
  }, 30_000);
});

describe("emitConfigManifest — a reserved RECON_PASSWORD env token never leaks as a literal", () => {
  const RECON_PASSWORD_TOKEN = `$${"{RECON_PASSWORD}"}`;
  const manifestStr = emitConfigManifest({
    siteId: "acme-demo",
    displayName: "AcmeDemo",
    baseUrl: "https://apply.acme.example",
    flowSteps: [`Enter ${RECON_PASSWORD_TOKEN} in the Password field`],
  });
  const manifest = JSON.parse(manifestStr) as {
    spec: { request: { properties: Record<string, unknown> }; flow: { steps: unknown[] } };
  };

  it("emits no literal RECON_PASSWORD substring anywhere", () => {
    expect(manifestStr).not.toContain(RECON_PASSWORD_TOKEN);
    expect(manifestStr).not.toContain("RECON_PASSWORD");
  });

  it("routes the splice through an explicit Password request field, not vocabulary", () => {
    expect(manifest.spec.flow.steps).toEqual([
      "Enter {{ .request.Password }} in the Password field",
    ]);
    expect(manifest.spec.request.properties).toHaveProperty("Password");
  });
});

describe("emitConfigManifest — splice site lands on the fill VALUE, never the selector", () => {
  const manifestStr = emitConfigManifest({
    siteId: "acme-demo",
    displayName: "AcmeDemo",
    baseUrl: "https://apply.acme.example",
    flowSteps: [
      {
        step: "Fill in the Legal Name First Name field (data-automation-id='legalName--firstName') with 'Reginald'",
        payloadField: "FirstName",
      },
    ],
  });

  it("leaves the data-automation-id selector unchanged", () => {
    expect(manifestStr).toContain("data-automation-id='legalName--firstName'");
  });

  it("splices {{ .request.FirstName }} only at the trailing value position", () => {
    expect(manifestStr).toContain("{{ .request.FirstName }}");
    expect(manifestStr).not.toContain("Reginald");
  });
});

describe("emitConfigManifest — recovered request contract", () => {
  const manifest = JSON.parse(
    emitConfigManifest({
      siteId: "acme-demo",
      displayName: "AcmeDemo",
      baseUrl: "https://apply.acme.example",
      flowSteps: [{ step: "fill the First Name field with 'Jane'", payloadField: "FirstName" }],
      inputBody: {
        page: 1,
        filters: [],
        currency: "USD",
        includeAdvancedBookingPrices: true,
        region: { country: "US" },
      },
      recoveredFields: new Set(["AddressLine1"]),
    })
  ) as { spec: { request: { properties: Record<string, { type: string }> } } };
  const props = manifest.spec.request.properties;

  it("carries each first-POST-body key with its real JSON-Schema type", () => {
    expect(props.page).toEqual({ type: "number" });
    expect(props.filters).toEqual({ type: "array" });
    expect(props.currency).toEqual({ type: "string" });
    expect(props.includeAdvancedBookingPrices).toEqual({ type: "boolean" });
    expect(props.region).toEqual({ type: "object" });
  });

  it("merges flow splices and recovered fields as caller-supplied strings", () => {
    expect(props.FirstName).toEqual({ type: "string" });
    expect(props.AddressLine1).toEqual({ type: "string" });
  });

  it("lets a body key's real type win over the string default when names overlap", () => {
    const overlapped = JSON.parse(
      emitConfigManifest({
        siteId: "acme-demo",
        displayName: "AcmeDemo",
        baseUrl: "https://apply.acme.example",
        flowSteps: [],
        inputBody: { page: 1 },
        recoveredFields: new Set(["page"]),
      })
    ) as { spec: { request: { properties: Record<string, { type: string }> } } };
    expect(overlapped.spec.request.properties.page).toEqual({ type: "number" });
  });

  it("emits a spec.httpModule reference when a direct-HTTP path exists", () => {
    const withHttp = JSON.parse(
      emitConfigManifest({
        siteId: "acme-demo",
        displayName: "AcmeDemo",
        baseUrl: "https://apply.acme.example",
        flowSteps: [],
        httpModulePath: "./acme-demo.http.js",
      })
    ) as { spec: { httpModule?: string } };
    expect(withHttp.spec.httpModule).toBe("./acme-demo.http.js");
  });

  it("omits spec.httpModule for a browser-only site", () => {
    const browserOnly = JSON.parse(
      emitConfigManifest({
        siteId: "acme-demo",
        displayName: "AcmeDemo",
        baseUrl: "https://apply.acme.example",
        flowSteps: [],
      })
    ) as { spec: { httpModule?: string } };
    expect(browserOnly.spec.httpModule).toBeUndefined();
  });
});

describe("emitContractTs — vendor-dump golden fixture (recon-generate-payload-schema-mismatch.md)", () => {
  // Synthetic fixture modeled on the report's own field list: a vendor
  // /applySubmit dump that shipped as the generated payload schema before the
  // hand-fix — ddoKey/formData/dqData/eventData/experienceData/educationData,
  // none of which the plugin's buildBarnacleFormData sends. isSubmissionFlow:
  // true mirrors generateSitePlugin's own gate — inputBody is only ever
  // populated on a submission flow.
  const vendorDumpInputBody = {
    ddoKey: "hrc-example",
    formData: {
      applyddokey: "hrc-example",
      atsCode: "VENDOR",
      refNum: "REF-00417",
    },
    dqData: {
      GenderCode: "U",
      questions: [{ id: "q1", answer: "yes" }],
    },
    eventData: {
      jobSeqNo: 42,
      jobId: "JOB-9981",
      jobTitle: "Registered Nurse",
      location: "Springfield, ST",
      visibilitySiteType: "external",
    },
    experienceData: [{ employer: "Prior Health System", title: "RN", years: 3 }],
    educationData: [{ school: "State University", degree: "BSN" }],
  };

  const contract = emitContractTs({
    ...BASE_OPTS,
    siteId: "examplesite",
    pascal: "Examplesite",
    inputBody: vendorDumpInputBody,
    hasMultipartStep: true,
  });

  it("emits the ApplicantContactSchema-based candidate payload as the public bodySchema", () => {
    expect(contract).toContain("const ExamplesitePayloadSchema = ApplicantContactSchema.extend({");
    expect(contract).toContain("Answers: multipartJsonObject(");
  });

  it("does not leak the vendor site-dump field names into the public bodySchema", () => {
    const payloadSchemaMatch = contract.match(
      /const ExamplesitePayloadSchema = ApplicantContactSchema\.extend\(\{[\s\S]*?\n\}\)(?:\.extend\(\{[\s\S]*?\n\}\))*;/
    );
    expect(payloadSchemaMatch).not.toBeNull();
    const payloadSchemaSource = payloadSchemaMatch![0];
    expect(payloadSchemaSource).not.toContain("ddoKey:");
    expect(payloadSchemaSource).not.toContain("formData:");
    expect(payloadSchemaSource).not.toContain("dqData:");
    expect(payloadSchemaSource).not.toContain("eventData:");
    expect(payloadSchemaSource).not.toContain("experienceData:");
    expect(payloadSchemaSource).not.toContain("educationData:");
  });

  it("demotes the vendor site-dump shape to the exported internal-reference const", () => {
    expect(contract).toContain("export const ExamplesiteInternalRequestReference =");
    const referenceMatch = contract.match(
      /export const ExamplesiteInternalRequestReference = [\s\S]*?;\n/
    );
    expect(referenceMatch).not.toBeNull();
    const referenceSource = referenceMatch![0];
    expect(referenceSource).toContain("ddoKey:");
    expect(referenceSource).toContain("formData:");
    expect(referenceSource).toContain("dqData:");
    expect(referenceSource).toContain("eventData:");
    expect(referenceSource).toContain("experienceData:");
    expect(referenceSource).toContain("educationData:");
  });
});

describe("emitContractTs — single merged `.extend()` payload schema (bugfix-004)", () => {
  it("emits exactly one `.extend(` call even when discovered/spliced fields collide with the base extend's own Email key", () => {
    // payloadFieldNames (browser-flow-spliced fields) redeclares Email, which
    // basePayloadSchemaExpr's own extend already declares. The old chain-of-
    // extends shape re-added Email as a second `.extend({ Email: ... })`
    // block; the merged shape must collapse it to one Email key with no
    // second `.extend(` call.
    const contract = emitContractTs({
      ...BASE_OPTS,
      siteId: "collision-site",
      pascal: "CollisionSite",
      inputBody: { some: "data" },
      payloadFieldNames: new Set(["Email", "JobId"]),
    });
    const payloadSchemaMatch = contract.match(/const CollisionSitePayloadSchema = [\s\S]*?;\n/);
    expect(payloadSchemaMatch).not.toBeNull();
    const payloadSchemaSource = payloadSchemaMatch![0];

    const extendOccurrences = payloadSchemaSource.match(/\.extend\(/g) ?? [];
    expect(extendOccurrences.length).toBe(1);

    const emailOccurrences = payloadSchemaSource.match(/^\s*Email:/gm) ?? [];
    expect(emailOccurrences.length).toBe(1);
    expect(payloadSchemaSource).toContain("Email: z.email(),");
    expect(payloadSchemaSource).toContain("JobId: z.string(),");
  });

  it("never redeclares a field ApplicantContactSchema's own identity/address/resume merge already supplies", () => {
    // City collides with ApplicantAddressSchema's own City field, and
    // FirstName collides with ApplicantIdentitySchema's own FirstName field
    // — both merged into ApplicantContactSchema. A discovered/spliced field
    // of either name must not shadow the base schema's declaration.
    const contract = emitContractTs({
      ...BASE_OPTS,
      siteId: "shadow-site",
      pascal: "ShadowSite",
      inputBody: { some: "data" },
      discoveredFormFields: new Set(["City"]),
      payloadFieldNames: new Set(["FirstName"]),
    });
    const payloadSchemaMatch = contract.match(/const ShadowSitePayloadSchema = [\s\S]*?;\n/);
    expect(payloadSchemaMatch).not.toBeNull();
    const payloadSchemaSource = payloadSchemaMatch![0];

    expect(payloadSchemaSource).not.toMatch(/^\s*City:/m);
    expect(payloadSchemaSource).not.toMatch(/^\s*FirstName:/m);
    const extendOccurrences = payloadSchemaSource.match(/\.extend\(/g) ?? [];
    expect(extendOccurrences.length).toBe(1);
  });
});

describe("extractActionSequence + compileActionSteps — repeated-section flow with id threaded into URL path", () => {
  it("keeps the flow as a genuine multi-step action sequence instead of collapsing it to a single-endpoint query", () => {
    const captures = buildRepeatedSectionSubmissionCaptures();
    const actionCaptures = extractActionSequence(captures, null);
    const actionCaptureIndices = new Set(actionCaptures.map((a) => a.index));
    const stateIndex = indexStateValues(captures, new Set(), actionCaptureIndices);
    const actionSteps = compileActionSteps(actionCaptures, stateIndex);

    expect(actionSteps.length).toBeGreaterThan(1);
  });
});

describe("emitContractTs — sanitizeFixtureIdentifier keeps loadFixture comments valid JS (G2)", () => {
  const VALID_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

  function fixtureConstLines(auxFiles: string[]): string[] {
    const source = emitContractTs({ ...BASE_OPTS, hasMultipartStep: false, auxFiles });
    return source
      .split("\n")
      .filter((line) => line.trimStart().startsWith("// const ") && line.includes("loadFixture("));
  }

  it("never emits an invalid identifier for a digit-leading, dotted, or hyphenated fixture filename", () => {
    const lines = fixtureConstLines([
      "10219132.json",
      "vendorwidget.config-a.example-net.json",
      "acme-domains-configuration.json",
    ]);

    expect(lines.length).toBe(3);
    for (const line of lines) {
      const match = line.match(/^\/\/ const ([^\s=]+)\s*=/);
      expect(match).not.toBeNull();
      expect(match![1]).toMatch(VALID_IDENTIFIER);
    }
  });

  it("emits a const name not starting with a digit for auxFiles:['10219132.json']", () => {
    const line = fixtureConstLines(["10219132.json"])[0]!;
    expect(line).toMatch(/^\/\/ const [A-Za-z_$][A-Za-z0-9_$]*\s*=/);
    expect(line).not.toContain("const 10219132");
  });

  it("emits a dot/hyphen-free identifier for dotted+hyphenated vendor-style config filenames", () => {
    for (const filename of [
      "vendorwidget.config-a.example-net.json",
      "pixel-config.example-vendor.net-config.json",
    ]) {
      const line = fixtureConstLines([filename])[0]!;
      const match = line.match(/^\/\/ const ([^\s=]+)\s*=/);
      expect(match![1]).not.toContain(".");
      expect(match![1]).not.toContain("-");
    }
  });

  it("emits a hyphen-free identifier for auxFiles:['acme-domains-configuration.json']", () => {
    const line = fixtureConstLines(["acme-domains-configuration.json"])[0]!;
    const match = line.match(/^\/\/ const ([^\s=]+)\s*=/);
    expect(match![1]).not.toContain("-");
  });

  it("every emitted `// const <name> =` identifier satisfies the same regex isValidJsIdentifier enforces internally", () => {
    const lines = fixtureConstLines([
      "10219132.json",
      "vendorwidget.config-a.example-net.json",
      "acme-domains-configuration.json",
      "abc123.json",
    ]);

    for (const line of lines) {
      const match = line.match(/^\/\/ const ([^\s=]+)\s*=/);
      expect(match![1]).toMatch(VALID_IDENTIFIER);
    }
  });

  it("still emits a valid JS identifier for both sides of a punctuation-only-differing filename pair, even where sanitization collapses them to the same base", () => {
    for (const filename of ["10219132.json", "1-0219132.json"]) {
      expect(sanitizeFixtureIdentifier(filename)).toMatch(VALID_IDENTIFIER);
      const line = fixtureConstLines([filename])[0]!;
      const match = line.match(/^\/\/ const ([^\s=]+)\s*=/);
      expect(match![1]).toMatch(VALID_IDENTIFIER);
    }
  });
});
