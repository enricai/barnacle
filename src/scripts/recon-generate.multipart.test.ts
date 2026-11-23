import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";

const BOUNDARY = "----WebKitFormBoundaryabc123";
const mk = (ct: string, data: string, varName: string) => ({
  capture: {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action",
    method: "POST",
    url: `https://api.example.com/${varName}`,
    status: 200,
    requestHeaders: { "Content-Type": ct },
    requestPostData: data,
    responseHeaders: { "content-type": "application/json" },
    responseBody: { ok: true },
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

const emit = (steps: unknown[]) =>
  emitMultiStepExecuteHttp(
    steps as never,
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
  );

describe("text-captured multipart steps", () => {
  const body = emit([
    mk(`multipart/form-data; boundary=${BOUNDARY}`, `--${BOUNDARY}\r\nx\r\n--${BOUNDARY}--`, "r0"),
    mk("application/json", JSON.stringify({ a: 1 }), "r1"),
  ]);
  it("sends the captured multipart Content-Type with boundary", () => {
    expect(body).toContain(`"Content-Type": \`multipart/form-data; boundary=${BOUNDARY}\``);
  });
  it("does not override JSON steps", () => {
    expect(body.match(/"Content-Type":/g)?.length).toBe(1);
  });
});

describe("text-captured multipart replaces a pre-existing per-call content-type", () => {
  it("drops the differently-cased entry and keeps body boundary/CRLFs", () => {
    const data = `--${BOUNDARY}\r\nx\r\n--${BOUNDARY}--`;
    const out = emitMultiStepExecuteHttp(
      [mk(`multipart/form-data; boundary=${BOUNDARY}`, data, "r0")] as never,
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
      new Map([["content-type", "x"]])
    );
    expect(out.match(/"content-type":/gi)?.length).toBe(1);
    expect(out).toContain(`"Content-Type": \`multipart/form-data; boundary=${BOUNDARY}\``);
    expect(out).toContain(BOUNDARY);
  });
});

describe("multipart content-type derived from body when capture header is absent/non-matching", () => {
  const data = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="a"\r\n\r\nv\r\n--${BOUNDARY}--`;
  const run = (headers: Record<string, string>) => {
    const s = mk("x", data, "r0");
    (s.capture as { requestHeaders: Record<string, string> }).requestHeaders = headers;
    return emit([s]);
  };
  it("derives from body when header missing", () => {
    const out = run({});
    expect(out).toContain(`"Content-Type": \`multipart/form-data; boundary=${BOUNDARY}\``);
  });
  it("derives from body when header is non-matching", () => {
    expect(run({ "content-type": "application/json" })).toContain("multipart/form-data; boundary=");
  });
  it("emits CRLF escaped so the literal keeps CRLF at runtime", () => {
    expect(run({})).toContain("\\r\n");
  });
});
