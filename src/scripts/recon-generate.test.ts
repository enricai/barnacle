import { afterEach, describe, expect, it } from "vitest";

import { CONFIG_PLUGIN_API_VERSION, CONFIG_PLUGIN_KIND } from "@/plugins/plugin-manifest-envelope";
import type { ReconFormSchema } from "@/recon/form-schema";
import {
  collectHeaderBindings,
  compileActionSteps,
  detectFormSchemaFieldNames,
  emitBrowserFlowTs,
  emitConfigManifest,
  emitContractTs,
  emitMultiStepExecuteHttp,
  extractActionSequence,
  indexStateValues,
  inferZodSchemaFromSamples,
  loadQuestionPromptKeywords,
  resolveStepPayloadField,
  selectEffectiveResponseBody,
  selectPayloadAction,
  selectReturnAction,
} from "@/scripts/recon-generate";
import {
  buildMulticallHeterogeneousActionSteps,
  buildMulticallHeterogeneousActionStepsWithDrillDown,
} from "@/scripts/recon-generate-multicall-fixture";

/** The recon env-var token for the applicant email, built by concatenation so
 * Biome's noTemplateCurlyInString rule doesn't flag the literal `${...}`. */
const RECON_EMAIL_TOKEN = `$${"{RECON_EMAIL}"}`;
/** Splice reference the emitter injects, e.g. `${payload.FirstName}`. */
function payloadRef(field: string): string {
  return `$${`{payload.${field}}`}`;
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
    multiStepBody: `    return { data: {} as unknown };`,
  });

  it("imports multipartBoolean from the package subpath, not the @/ alias", () => {
    expect(source).toContain(
      'import { multipartBoolean } from "@enricai/barnacle/lib/zod-multipart"'
    );
  });

  it("uses multipartBoolean() at boolean payload fields", () => {
    expect(source).toContain("multipartBoolean()");
  });

  it("does not emit an inline MULTIPART_BOOL const declaration", () => {
    expect(source).not.toContain("MULTIPART_BOOL");
    expect(source).not.toContain('z.preprocess(\n  (v) => (v === "true"');
  });
});

describe("emitContractTs — non-multipart plugin", () => {
  const source = emitContractTs({
    ...BASE_OPTS,
    hasMultipartStep: false,
    inputBody: { Name: "Alice", Active: true },
  });

  it("does not import multipartBoolean", () => {
    expect(source).not.toContain("multipartBoolean");
  });

  it("uses z.boolean() for boolean fields", () => {
    expect(source).toContain("z.boolean()");
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

  const BASE = "https://disneycruise.example.com";
  // The real shape: a browser's Angular error handler posting a frozen crash —
  // a stack trace and a recon-time timestamp that a replayed plugin would send
  // to the site as a fabricated error report on every invocation.
  const errorReport = capture(
    `${BASE}/dcl-apps-productavail-spa/error`,
    '[["Error logged by WDPR RA Angular Error handler service","{\\"timestamp\\":1784247853926,\\"message\\":\\"Script load error for //connect.facebook.net/en_US/fbevents.js\\"}"]]'
  );

  it("drops error sinks while keeping the calls that carry the flow", () => {
    const kept = extractActionSequence(
      [
        capture(`${BASE}/dcl-apps-productavail-vas/authz/private`, "{}"),
        errorReport,
        capture(`${BASE}/dcl-apps-productavail-vas/available-products/`, '{"page":1}'),
        errorReport,
      ],
      BASE
    ).map((a) => new URL(a.capture.url).pathname);

    expect(kept).toEqual([
      "/dcl-apps-productavail-vas/authz/private",
      "/dcl-apps-productavail-vas/available-products/",
    ]);
  });

  it("matches a whole path segment, so data endpoints that merely spell 'error' survive", () => {
    const kept = extractActionSequence(
      [
        capture(`${BASE}/api/error-codes`, "{}"),
        capture(`${BASE}/api/terrorism-screening`, "{}"),
        capture(`${BASE}/api/errors`, "{}"),
      ],
      BASE
    ).map((a) => new URL(a.capture.url).pathname);

    expect(kept).toEqual(["/api/error-codes", "/api/terrorism-screening"]);
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

describe("compileActionSteps — Set-Cookie state binding (disneycruise-style token mint)", () => {
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

describe("collectHeaderBindings — multi-cookie regression (disneycruise __pa first-wins bug)", () => {
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
        "latestWDPROGeoIP=US-TX-AUSTIN-1; Path=/",
        "WDPROGeoIP=US-TX-AUSTIN-2; Path=/",
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
    url: "https://api.example.com/dcl-apps-productavail-vas/authz/private",
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
    url: "https://api.example.com/dcl-apps-productavail-vas/available-products/",
    status: 200,
    requestHeaders: {
      "Content-Type": "application/json",
      Cookie:
        "latestWDPROGeoIP=US-TX-AUSTIN-1; WDPROGeoIP=US-TX-AUSTIN-2; bm_sv=BMSVSESSIONVALUE1; __pa=eyJhbGciOiJIUzI1NiJ9.payload.sig",
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

  it("collectHeaderBindings returns all four Cookie-targeting bindings, __pa included — does not drop it in favour of latestWDPROGeoIP", () => {
    const cookieBindings = headerBindings.filter((b) => b.targetHeader === "Cookie");
    expect(cookieBindings.map((b) => b.cookieName).sort()).toEqual(
      ["WDPROGeoIP", "__pa", "bm_sv", "latestWDPROGeoIP"].sort()
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
      expect(resolveStepPayloadField(instruction)).toBe(field);
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
  ];
  for (const instruction of traps) {
    it(`leaves ${JSON.stringify(instruction)} literal (null)`, () => {
      expect(resolveStepPayloadField(instruction)).toBeNull();
    });
  }
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
    expect(code).toContain("import { type HealingFlowStep, runHealingFlow, waitForSpaReady }");
    expect(code).toContain("await waitForSpaReady(page, logger);");
  });

  it("wires the shared Anthropic client so the cascade can rephrase/replan", () => {
    expect(code).toContain(
      'import { buildAnthropicClient } from "@enricai/barnacle/lib/llm/anthropic-client"'
    );
    expect(code).toContain("anthropic: buildAnthropicClient(),");
    expect(code).not.toContain("anthropic: null");
  });

  it("accumulates the spliced field names", () => {
    expect(payloadFieldNames).toEqual(new Set(["FirstName", "Email"]));
  });
});

describe("emitBrowserFlowTs — resumeFixture guard (upload vs multipart)", () => {
  const uploadFlow = [{ step: "Upload the resume PDF using the upload control", upload: true }];

  it("wires a Buffer-based resumeFixture when the contract is multipart", () => {
    const { code } = emitBrowserFlowTs({
      siteId: "s",
      pascal: "S",
      baseUrl: "https://x",
      isSubmissionFlow: true,
      flowSteps: uploadFlow,
      hasMultipartStep: true,
    });
    expect(code).toContain("Buffer.from(payload.Resume");
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
    expect(code).toContain("resumeFixture: null");
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
  });
  const contract = emitContractTs({
    ...BASE_OPTS,
    inputBody: { Name: "Alice" },
    payloadFieldNames,
  });

  it("every payload.X the flow references appears as a contract schema key", () => {
    const referenced = [...code.matchAll(/\$\{payload\.([A-Za-z0-9_]+)\}/g)].map((m) => m[1]!);
    expect(referenced.length).toBeGreaterThan(0);
    for (const field of referenced) {
      const decl = field === "Email" ? `${field}: z.email()` : `${field}: z.string()`;
      expect(contract).toContain(decl);
    }
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
      step("https://shop.test/search", '{"page":1,"filters":["7-night"]}', { total: 151 }),
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
    // The reported disneycruise shape: toggles (once) → authz mint (once) →
    // available-products/ re-queried with varying filters → a drill-down
    // into one itinerary fires last. The search result is the flow's
    // subject, not the drill-down's single-itinerary body.
    const steps = [
      step("https://dcl.test/toggles/product-avail", '["a"]', [{ name: "a" }]),
      step("https://dcl.test/authz/private", "{}", { result: "ok", successful: true }),
      step("https://dcl.test/available-products/", '{"filters":[]}', {
        totalAvailableCruises: 699,
        products: [{ id: "p1" }],
      }),
      step("https://dcl.test/available-products/", '{"filters":["7-night"]}', {
        totalAvailableCruises: 151,
        products: [{ id: "p2" }],
      }),
      step("https://dcl.test/available-sailings/", '{"itineraryId":"i1"}', {
        sailings: [{ id: "s1" }],
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
      capture("https://dcl.test/toggles", '["a"]', [{ name: "a" }], "r0"),
      capture("https://dcl.test/authz/private", "{}", { successful: true }, "r1"),
      capture(
        "https://dcl.test/available-products/",
        '{"filters":[]}',
        { totalAvailableCruises: 699, products: [{ id: "p1" }] },
        "r2"
      ),
      capture(
        "https://dcl.test/available-products/",
        '{"filters":["7-night"]}',
        { totalAvailableCruises: 151, products: [{ id: "p2" }] },
        "r3"
      ),
      capture(
        "https://dcl.test/available-sailings/",
        '{"itineraryId":"i1"}',
        { sailings: [{ id: "s1" }], exchangeRate: 1 },
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
      "https://dcl.test",
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
    expect(block).toContain("totalAvailableCruises: z.number()");
    expect(block).toContain("products: z.array(");
    expect(block).not.toMatch(/schema:\s*z\.array\(z\.object/);
  });

  it("the toggles call's schema is not the products/inventory schema (the G2 reproduction)", () => {
    const togglesBlock = callBlockForUrl("toggles/product-avail");
    expect(togglesBlock).not.toContain("totalPages");
    expect(togglesBlock).not.toContain("totalAvailableCruises");
  });

  it("every httpClient(...) call carries its own schema: override rather than relying on the client default", () => {
    const httpClientCallCount = (body.match(/await httpClient\(/g) ?? []).length;
    const schemaOverrideCount = (body.match(/\n\s*schema: /g) ?? []).length;
    expect(schemaOverrideCount).toBe(httpClientCallCount);
  });

  it("the client-level ResponseSchema is not referenced by any per-call schema, so narrowing it leaves non-terminal calls' schemas unchanged (the G2 reproduction)", () => {
    // emitContractTs emits `${pascal}ResponseSchema = z.unknown()` for every
    // multi-step flow and hands the author the `[ ] Narrow ResponseSchema`
    // checklist item — the report's repro is the author following that item
    // by hand-substituting the narrowed available-products/ shape (the same
    // shape r2's own per-call schema below already carries) in place of
    // z.unknown(), exactly as they would in the emitted file.
    const contract = emitContractTs({ ...BASE_OPTS, multiStepBody: body });
    expect(contract).toContain("const TestSiteResponseSchema = z.unknown();");
    const narrowedContract = contract.replace(
      "const TestSiteResponseSchema = z.unknown();",
      "const TestSiteResponseSchema = z.object({\n  totalPages: z.number(),\n  totalAvailableCruises: z.number(),\n  products: z.array(z.object({ productId: z.string() })),\n});"
    );

    // Pre-fix (no per-call override), the toggles call had no `schema:` of
    // its own and validated against the client's TestSiteResponseSchema —
    // narrowing it here would have applied the products shape to the toggles
    // call. Post-fix, the toggles call carries its own inferred `schema:`
    // literal, so the narrowed client schema is unreferenced by it.
    const togglesBlock = callBlockForUrl("toggles/product-avail");
    expect(togglesBlock).toMatch(/schema:\s*z\.array\(/);
    expect(togglesBlock).not.toContain("schema: TestSiteResponseSchema");
    expect(togglesBlock).not.toContain("totalPages");
    expect(narrowedContract).toContain("totalPages: z.number()");
  });
});

describe("selectEffectiveResponseBody — shape source agrees with the return value (G1)", () => {
  it("derives from the re-queried search call, not the terminal drill-down, for the drill-down-terminal fixture", () => {
    const steps = buildMulticallHeterogeneousActionStepsWithDrillDown();

    const shapeSource = selectEffectiveResponseBody(steps, null);
    const returnAction = selectReturnAction(steps);

    // The search call (r3, the second available-products/ query) is what
    // executeHttp returns — assert the inferred shape comes from that SAME
    // call, not the terminal available-sailings/ drill-down (r4).
    expect(returnAction?.varName).toBe("r3");
    expect(shapeSource).toEqual(returnAction?.capture.responseBody);
    expect(shapeSource).toEqual({
      totalPages: 5,
      totalAvailableCruises: 699,
      products: [{ productId: "p2" }],
    });
    expect(shapeSource).not.toEqual({
      sailings: [{ sailingId: "s1" }],
      exchangeRate: 1.0,
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

    const shapeSource = selectEffectiveResponseBody(steps, null);
    const returnAction = selectReturnAction(steps);

    expect(returnAction?.varName).toBe("r1");
    expect(shapeSource).toEqual(returnAction?.capture.responseBody);
    expect(shapeSource).toEqual({ success: true });
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
    // products[].itineraries[].sailings[].price.summary.total — the shape real
    // cruise inventory arrives in; a depth-4 cap erases exactly this.
    const deep = {
      products: [
        {
          itineraries: [
            { sailings: [{ sailingId: "DD1522", price: { summary: { total: 1402 } } }] },
          ],
        },
      ],
    };
    const schema = inferZodSchemaFromSamples([deep]);
    expect(schema).toContain("sailingId: z.string()");
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

  it("derives the payload schema from a captured request body when one is available", () => {
    // Real read-flow endpoints take a structured JSON body, not a search string.
    const contract = emitContractTs({
      ...BASE_OPTS,
      inputBody: { page: 1, region: "INTL", filters: [], sorts: [{ criteria: "RECOMMENDED" }] },
    });
    expect(contract).toContain("page:");
    expect(contract).toContain("region:");
    expect(contract).toContain("sorts:");
    expect(contract).not.toContain("query: z.string().min(1)");
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

describe("loadQuestionPromptKeywords", () => {
  const original = process.env.RECON_QUESTION_KEYWORDS;
  afterEach(() => {
    if (original === undefined) delete process.env.RECON_QUESTION_KEYWORDS;
    else process.env.RECON_QUESTION_KEYWORDS = original;
  });

  it("defaults to empty so the engine ships no product's question vocabulary", () => {
    delete process.env.RECON_QUESTION_KEYWORDS;
    expect(loadQuestionPromptKeywords()).toEqual({});
  });

  it("takes the operator's field-to-keyword map from the env", () => {
    process.env.RECON_QUESTION_KEYWORDS = JSON.stringify({
      RelatedToEmployee: ["related", "employee"],
      VisaSponsorship: ["visa", "sponsor"],
    });
    expect(loadQuestionPromptKeywords()).toEqual({
      RelatedToEmployee: ["related", "employee"],
      VisaSponsorship: ["visa", "sponsor"],
    });
  });

  it("degrades to empty on malformed JSON rather than killing the run", () => {
    process.env.RECON_QUESTION_KEYWORDS = "{not-json";
    expect(() => loadQuestionPromptKeywords()).not.toThrow();
    expect(loadQuestionPromptKeywords()).toEqual({});
  });
});
