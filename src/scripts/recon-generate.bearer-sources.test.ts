import { describe, expect, it } from "vitest";

import {
  type BearerSource,
  bearerKindKey,
  compileActionSteps,
  deriveReadFlowBearer,
  emitContractTsParts,
  emitMultiStepExecuteHttp,
  indexStateValues,
  locateBearerSources,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { ReplayResult } from "@/scripts/recon-shared";

const b64 = (o: object): string => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (tokenType: string): string => `eyJhbGciOiJIUzI1NiJ9.${b64({ tokenType })}.sigsigsig`;
const call = (url: string, tokenType?: string) =>
  buildCapture({
    url,
    requestPostData: "{}",
    responseBody: {},
    requestHeaders: tokenType ? { authorization: `Bearer ${jwt(tokenType)}` } : {},
    timestamp: "2024-09-01T00:00:00Z",
  });
const replay = (url: string, documentUrl: string): ReplayResult =>
  ({
    url,
    authReplay: {
      status: 200,
      tokenReplayable: true,
      tokenSource: { document: 0, url: documentUrl, source: "html" },
    },
  }) as ReplayResult;

const USER = jwt({ tokenType: "user", sub: "u1" });
const emitMulti = (entry: BearerSource) => {
  const captures = [
    buildCapture({
      url: "https://app.example.test/a/login/",
      requestPostData: JSON.stringify({ q: "one" }),
      responseBody: { ok: true },
      timestamp: "2024-09-01T00:00:00Z",
    }),
    buildCapture({
      url: "https://app.example.test/a/submit/",
      requestPostData: JSON.stringify({ q: "one" }),
      responseBody: { ok: true },
      requestHeaders: { "Content-Type": "application/json", Authorization: `Bearer ${USER}` },
      timestamp: "2024-09-01T00:00:01Z",
    }),
  ];
  const steps = compileActionSteps(
    captures.map((capture, index) => ({ capture, index })) as never,
    indexStateValues(captures)
  );
  return emitMultiStepExecuteHttp(
    steps as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
    { q: "one" },
    { stringMessageKey: null, nestedErrorPaths: [] },
    new Map(),
    new Set(),
    new Map(),
    new Set(),
    new Map(),
    new Map(),
    "https://app.example.test",
    new Map(),
    new Map(),
    null,
    new Map(),
    new Map(),
    new Set(),
    [],
    new Map(),
    new Map(),
    null,
    null,
    [],
    undefined,
    undefined,
    undefined,
    null,
    new Map([[bearerKindKey(`Bearer ${USER}`) ?? "", entry]])
  );
};

describe("bearer sources", () => {
  const captures = [
    call("https://a.test:8443/gql", "client"),
    call("https://z.test/other", "user"),
    call("https://cdn.test:9443/x"),
  ] as never;
  const replays = [
    replay("https://z.test/other", "https://z.test/users"),
    replay("https://a.test:8443/gql", "https://a.test:8443/right"),
  ];

  it("takes the document proven for the token, not the first one located", () => {
    expect(locateBearerSources(captures, replays).size).toBe(2);
    const bearer = deriveReadFlowBearer(captures, replays, "https://a.test:8443/gql");
    expect(bearer?.document).toBe("https://a.test:8443/right");
  });

  it("carries the source kind and RSC row of the located document", () => {
    const rsc = [
      {
        url: "https://a.test:8443/gql",
        authReplay: {
          status: 200,
          tokenReplayable: true,
          tokenSource: { document: 0, url: "https://a.test:8443/r", source: "rsc-row", row: "1a" },
        },
      } as unknown as ReplayResult,
    ];
    const located = [...locateBearerSources(captures, rsc).values()];
    expect(located).toEqual([{ url: "https://a.test:8443/r", source: "rsc-row", row: "1a" }]);
    const bearer = deriveReadFlowBearer(captures, rsc, "https://a.test:8443/gql");
    expect(bearer?.source).toBe("rsc-row");
    expect(bearer?.row).toBe("1a");
  });

  it("carries the html source kind with no row", () => {
    const located = [...locateBearerSources(captures, replays).values()];
    expect(located).toContainEqual({
      url: "https://a.test:8443/right",
      source: "html",
      row: undefined,
    });
    const bearer = deriveReadFlowBearer(captures, replays, "https://a.test:8443/gql");
    expect(bearer?.source).toBe("html");
    expect(bearer?.row).toBeUndefined();
  });

  it("keeps ports, so hosts compare equal to the runtime's", () => {
    const bearer = deriveReadFlowBearer(captures, replays, "https://a.test:8443/gql");
    expect(bearer?.bearerHosts).toEqual(["a.test:8443", "z.test"]);
    expect(bearer?.otherHosts).toEqual(["cdn.test:9443"]);
  });

  it("is null when no replay proved the endpoint needs the bearer", () => {
    expect(deriveReadFlowBearer(captures, [], "https://a.test:8443/gql")).toBeNull();
  });

  it("states the source kind and RSC row in the multi-step emitted plugin", () => {
    const rsc = emitMulti({ url: "https://app.example.test/d", source: "rsc-row", row: "1a" });
    expect(rsc).toContain("/* bearer source: rsc-row row 1a */ await mintBearerToken(");
    const html = emitMulti({ url: "https://app.example.test/d", source: "html" });
    expect(html).toContain("/* bearer source: html */ await mintBearerToken(");
  });

  it("states the source kind and RSC row in the read-flow emitted plugin", () => {
    const emit = (source: "rsc-row" | "html", row?: string) =>
      emitContractTsParts({
        siteId: "recon-site-9",
        pascal: "ReconSite9",
        baseUrl: "https://shop.example.test",
        baseHeaders: {},
        minTime: 100,
        safeRps: 10,
        responseBody: { ok: true },
        gql: false,
        gqlQuery: null,
        endpointPath: "/api",
        auxFiles: [],
        readFlowBearer: {
          document: "https://shop.example.test/d",
          source,
          row,
          headerName: "Authorization",
          prefix: "Bearer ",
          claims: { tokenType: "user" },
          claimNames: ["tokenType"],
          bearerHosts: ["shop.example.test"],
          otherHosts: [],
        },
      }).code;
    expect(emit("rsc-row", "1a")).toContain("// bearer source: rsc-row row 1a\n");
    expect(emit("html")).toContain("// bearer source: html\n");
  });
});
