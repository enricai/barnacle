import { describe, expect, it } from "vitest";
import {
  compileActionSteps,
  emitMultiStepExecuteHttp,
  indexStateValues,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: object) => `eyJhbGciOiJIUzI1NiJ9.${b64(claims)}.sigsigsig`;
const USER = jwt({ tokenType: "user", sub: "u1" });
const CLIENT = jwt({ tokenType: "client", sub: "c1" });

const emit = (tokenSource: { url: string } | null, multipart = false) => {
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
    tokenSource
  );
};

describe("recon-generate runtime bearer bootstrap", () => {
  it("emits a claims-based document bootstrap and no literal bearer", () => {
    const body = emit({ url: "https://app.example.test/dash?x=1" });
    expect(body).not.toContain(USER);
    expect(body).not.toContain("sigsigsig");
    expect(body).toContain('context.baseUrl + "/dash?x=1"');
    expect(body).toContain("parseInt(m[2] as string, 16)");
    expect(body).toContain('{"tokenType":"user"}');
    expect(body).toContain("Bearer ${await mintBearerToken(");
    expect(body).not.toContain("TODO: Authorization");
  });

  it("keeps the throwing stub without a token source", () => {
    const body = emit(null);
    expect(body).toContain("TODO: Authorization requires a runtime credential");
    expect(body).not.toContain("mintBearerToken");
  });

  it("extracts the right token when the next row id follows with no separator", async () => {
    const body = emit({ url: "/dash" });
    const start = body.indexOf("const mintBearerToken");
    const end = body.indexOf("\n    };\n", start) + "\n    };\n".length;
    const ts = body.slice(start, end).replace(/^\s*const mintBearerToken/, "const mintBearerToken");
    const { stripTypeScriptTypes } = await import("node:module");
    const js = stripTypeScriptTypes(ts);
    const row = (id: string, t: string) => `${id}:T${Buffer.byteLength(t).toString(16)},${t}`;
    const stream = row("a", CLIENT) + row("b", USER) + "c:[]";
    const html = `<script>self.__next_f.push([1,${JSON.stringify(stream)}])</script>`;
    const run = new Function(
      "context",
      "fetch",
      `${js}; return mintBearerToken({tokenType:"user"}, []);`
    );
    const out = await run({ baseUrl: "https://app.example.test" }, async () => ({
      ok: true,
      status: 200,
      text: async () => html,
    }));
    expect(out).toBe(USER);
  });
});
