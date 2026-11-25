import { describe, expect, it } from "vitest";
import {
  bearerKindKey,
  compileActionSteps,
  emitMultiStepExecuteHttp,
  indexStateValues,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: object) => `eyJhbGciOiJIUzI1NiJ9.${b64(claims)}.sigsigsig`;
const USER = jwt({ tokenType: "user", sub: "u1" });

const emit = (tokenUrl: string | null, multipart = false) => {
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
  if (multipart) (steps[1] as { isMultipart: boolean }).isMultipart = true;
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
    tokenUrl === null ? new Map() : new Map([[bearerKindKey(`Bearer ${USER}`) ?? "", tokenUrl]])
  );
};

describe("recon-generate runtime bearer bootstrap", () => {
  it("emits a claims-based document bootstrap and no literal bearer", () => {
    const body = emit("https://app.example.test/dash?x=1");
    expect(body).not.toContain(USER);
    expect(body).not.toContain("sigsigsig");
    expect(body).toContain('mintBearerToken("https://app.example.test/dash?x=1"');
    expect(body).toContain('{"tokenType":"user"}');
    expect(body).toContain("Bearer ${await mintBearerToken(");
    expect(body).not.toContain("TODO: Authorization");
  });

  it("keeps the throwing stub without a token source", () => {
    const body = emit(null);
    expect(body).toContain("TODO: Authorization requires a runtime credential");
    expect(body).not.toContain("mintBearerToken");
  });
});
