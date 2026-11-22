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
