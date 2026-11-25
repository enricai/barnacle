import { describe, expect, it } from "vitest";
import {
  bearerKindKey,
  compileActionSteps,
  emitMultiStepExecuteHttp,
  indexStateValues,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sigsigsigsig";
const COOKIE = "sessionid=abcdef123456zzz";

describe("recon-generate credential headers", () => {
  it("never emits Authorization/Cookie/x-*-token literals", () => {
    const captures = [
      buildCapture({
        url: "https://api.example.com/a/login/",
        requestPostData: JSON.stringify({ q: "one" }),
        responseBody: { ok: true },
        timestamp: "2024-09-01T00:00:00Z",
      }),
      buildCapture({
        url: "https://api.example.com/a/submit/",
        requestPostData: JSON.stringify({ q: "one" }),
        responseBody: { ok: true },
        requestHeaders: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${JWT}`,
          Cookie: COOKIE,
          "X-Csrf-Token": "csrfvalue987654321",
        },
        timestamp: "2024-09-01T00:00:01Z",
      }),
    ];
    const inputBody = JSON.parse(captures[0]!.requestPostData ?? "null") as unknown;
    const steps = compileActionSteps(
      captures.map((capture, index) => ({ capture, index })) as never,
      indexStateValues(captures)
    );
    const body = emitMultiStepExecuteHttp(
      steps as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
      inputBody,
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
    expect(body).not.toContain(JWT);
    expect(body).not.toContain("abcdef123456zzz");
    expect(body).not.toContain("csrfvalue987654321");
    expect(body).toContain("TODO: Authorization");
    expect(body).toContain("throw new Error");
  });

  const emit = (steps: unknown[], input: unknown) =>
    emitMultiStepExecuteHttp(
      steps as never,
      input,
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
  const step = (
    varName: string,
    url: string,
    headers: Record<string, string>,
    isMultipart: boolean
  ) => ({
    capture: {
      timestamp: "2024-01-01T00:00:00Z",
      phase: "action",
      method: "POST",
      url,
      status: 200,
      requestHeaders: headers,
      requestPostData: isMultipart ? null : JSON.stringify({ q: "one" }),
      responseHeaders: { "content-type": "application/json" },
      responseBody: { ok: true },
      operationName: null,
      query: null,
      variables: null,
      decodedParams: null,
    },
    varName,
    produces: [],
    isMultipart,
    isCrossDomain: false,
  });

  it("multipart upload throws at call time instead of freezing a credential header", () => {
    const body = emit(
      [
        step(
          "r0",
          "https://api.example.com/a/login/",
          { "Content-Type": "application/json" },
          false
        ),
        step(
          "r1",
          "https://api.example.com/upload/files",
          { "Content-Type": "multipart/form-data", Authorization: `Bearer ${JWT}` },
          true
        ),
      ],
      { q: "one" }
    );
    expect(body).not.toContain(JWT);
    expect(body).toContain("TODO: Authorization requires a runtime credential");
  });

  it("neutralizes backticks in a credential header name inside the emitted template", () => {
    const body = emit(
      [
        step(
          "r0",
          "https://api.example.com/a/login/",
          { "Content-Type": "application/json" },
          false
        ),
        step(
          "r1",
          "https://api.example.com/a/submit/",
          { "Content-Type": "application/json", "X-A`b-Token": "secretvalue123456789" },
          false
        ),
      ],
      { q: "one" }
    );
    expect(body).not.toContain("secretvalue123456789");
    expect(body).toContain("TODO: X-A'b-Token requires");
  });
  describe("runtime token bootstrap", () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const USER = `eyJhbGciOiJIUzI1NiJ9.${b64({ tokenType: "user", sub: "u1" })}.sigsigsig`;
    const emitWith = (tokenUrl: string | null) =>
      emitMultiStepExecuteHttp(
        [
          step(
            "r0",
            "https://app.example.test/a/login/",
            { "Content-Type": "application/json" },
            false
          ),
          step(
            "r1",
            "https://app.example.test/a/submit/",
            {
              "Content-Type": "application/json",
              Authorization: `Bearer ${USER}`,
              Cookie: COOKIE,
              "X-Csrf-Token": "csrfvalue987654321",
            },
            false
          ),
        ] as never,
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
        tokenUrl === null ? new Map() : new Map([[bearerKindKey(`Bearer ${USER}`) ?? "", { url: tokenUrl, source: "html" as const }]])
      );

    const noLiterals = (body: string) => {
      expect(body).not.toContain(USER);
      expect(body).not.toContain("sigsigsig");
      expect(body).not.toContain("abcdef123456zzz");
      expect(body).not.toContain("csrfvalue987654321");
    };

    it("with a token source: mints from the document by claims, no literal", async () => {
      const body = emitWith("https://app.example.test/dash");
      noLiterals(body);
      expect(body).toContain('mintBearerToken("https://app.example.test/dash"');
      expect(body).toContain('{"tokenType":"user"}');
      expect(body).toContain("Bearer ${/* bearer source: html */ await mintBearerToken(");
      expect(body).not.toContain("TODO: Authorization");
      // Cookie is dropped and x-*-token still throws; neither is frozen.
      expect(body).not.toContain("Cookie");
      expect(body).toContain("TODO: X-Csrf-Token requires");
      // The emitted body must be valid TypeScript: strip types (throws on a syntax
      // error), then compile as an async function body.
      const { stripTypeScriptTypes } = await import("node:module");
      const js = stripTypeScriptTypes(`async function f(context: any) {\n${body}\n}`);
      expect(() => new Function(`${js}; return f;`)).not.toThrow();
    });

    it("without a token source: throw-at-call-time stub with TODO, no bootstrap, no literal", () => {
      const body = emitWith(null);
      noLiterals(body);
      expect(body).toContain("TODO: Authorization requires a runtime credential");
      expect(body).toContain("throw new Error");
      expect(body).not.toContain("mintBearerToken");
    });
  });
});
