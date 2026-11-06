import { describe, expect, it } from "vitest";
import {
  compileActionSteps,
  emitMultiStepExecuteHttp,
  extractActionSequence,
  indexStateValues,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const TOKEN = "k9Zq81XvT3mWb7LpR2dYc5Hn";

function emit(captures: ReturnType<typeof buildCapture>[], viaExtract = false): string {
  const seq = viaExtract
    ? extractActionSequence(captures)
    : captures.map((capture, index) => ({ capture, index }));
  const idx = new Set(seq.map((a) => a.index));
  const state = indexStateValues(captures, new Set(), idx);
  const steps = compileActionSteps(seq, state);
  return emitMultiStepExecuteHttp(
    steps,
    null,
    { stringMessageKey: null, nestedErrorPaths: [] },
    new Map(),
    new Set(),
    new Map(),
    new Set(),
    new Map(),
    new Map(),
    "https://shop.example.com",
    new Map(),
    new Map()
  );
}

describe("token tracing across a multi-step flow", () => {
  const start = buildCapture({
    url: "https://shop.example.com/api/session/start",
    requestPostData: JSON.stringify({ intent: "begin" }),
    responseBody: { sessionToken: TOKEN, ok: true },
    timestamp: "2024-01-01T00:00:00Z",
  });

  it("threads a body-reused token", () => {
    const out = emit([
      start,
      buildCapture({
        url: "https://shop.example.com/api/session/commit",
        requestPostData: JSON.stringify({ sessionToken: TOKEN, qty: 2 }),
        responseBody: { done: true },
        timestamp: "2024-01-01T00:00:01Z",
      }),
    ]);
    expect(out).not.toContain(TOKEN);
    expect(out).toMatch(/sessionToken/);
  });

  it("threads a header-reused token", () => {
    const out = emit([
      start,
      buildCapture({
        url: "https://shop.example.com/api/session/commit",
        requestPostData: JSON.stringify({ qty: 2 }),
        requestHeaders: { "Content-Type": "application/json", "X-Session": TOKEN },
        responseBody: { done: true },
        timestamp: "2024-01-01T00:00:01Z",
      }),
    ]);
    expect(out).not.toContain(TOKEN);
  });

  it("emits no threading for independent calls", () => {
    const out = emit([
      start,
      buildCapture({
        url: "https://shop.example.com/api/session/commit",
        requestPostData: JSON.stringify({ qty: 2 }),
        responseBody: { done: true },
        timestamp: "2024-01-01T00:00:01Z",
      }),
    ]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting literal interpolation text in generated plugin source
    expect(out).not.toContain("${sessionToken}");
    expect(out).not.toContain("${r0");
  });

  describe("token issued by a GET (extractActionSequence admission)", () => {
    const getStep = buildCapture({
      url: "https://shop.example.com/api/form/new",
      requestPostData: null,
      method: "GET",
      responseBody: { formHandle: TOKEN },
      timestamp: "2024-01-01T00:00:00Z",
    });
    const post = (body: unknown, n: number) =>
      buildCapture({
        url: "https://shop.example.com/api/form/submit",
        requestPostData: JSON.stringify(body),
        responseBody: { done: true },
        timestamp: `2024-01-01T00:00:0${n}Z`,
      });

    it("admits the GET and threads its token into the later POST", () => {
      const caps = [
        getStep,
        post({ handle: TOKEN, qty: 1 }, 1),
        post({ handle: TOKEN, qty: 2 }, 2),
      ];
      expect(extractActionSequence(caps).map((a) => a.index)).toEqual([0, 1, 2]);
      const out = emit(caps, true);
      expect(out).not.toContain(TOKEN);
      expect(out).toContain('method: "GET"');
    });

    it("still drops a GET whose response is never reused", () => {
      const caps = [getStep, post({ qty: 1 }, 1), post({ qty: 2 }, 2)];
      expect(extractActionSequence(caps).map((a) => a.index)).toEqual([1, 2]);
    });
  });
});

describe("HTML-issued tokens", () => {
  const T = "Qw8rT5yU2iO9pLkJ4hGf";
  const html = (extra = "") =>
    `<html><form action="/checkout?csrf=${T}"><input type="hidden" name="nonce" value="${T}x"/></form>${extra}</html>`;
  const mk = (reuse: boolean) => [
    buildCapture({
      url: "https://shop.example.com/cart",
      method: "GET",
      requestPostData: null,
      responseBody: html(),
      timestamp: "2024-01-01T00:00:00Z",
    }),
    buildCapture({
      url: reuse
        ? `https://shop.example.com/checkout?csrf=${T}`
        : "https://shop.example.com/checkout",
      requestPostData: JSON.stringify({ go: 1 }),
      responseBody: { ok: true },
      timestamp: "2024-01-01T00:00:01Z",
    }),
  ];
  it("admits the GET and indexes the value with html origin", () => {
    const caps = mk(true);
    const seq = extractActionSequence(caps);
    expect(seq.map((s) => s.index)).toContain(0);
    const st = indexStateValues(caps, new Set(), new Set(seq.map((s) => s.index)));
    expect(st.get(T)?.htmlOrigin).toEqual({ element: "form-action", name: "csrf" });
  });
  it("still drops a GET whose HTML tokens are not reused", () => {
    const seq = extractActionSequence(mk(false));
    expect(seq.map((s) => s.index)).not.toContain(0);
  });
});

describe("HTML-issued tokens from anchors and realistic markup", () => {
  const T = "Zx9cV3bN7mAsDfGh2JkL";
  const page = `<!DOCTYPE html><html><body>
    <nav><a class="n" href="/home">Home</a></nav>
    <A HREF='/confirm?token=${T}&amp;step=2'>Confirm</A>
    <a href=/plain?x=1>plain</a>
    <input type=HIDDEN name=sid value=${T}y>
  </body></html>`;
  it("admits the GET and indexes an anchor-issued value as link origin", () => {
    const caps = [
      buildCapture({
        url: "https://shop.example.com/inbox",
        method: "GET",
        responseBody: page,
        timestamp: "2024-01-01T00:00:00Z",
      }),
      buildCapture({
        url: `https://shop.example.com/confirm?token=${T}`,
        requestPostData: JSON.stringify({ go: 1 }),
        responseBody: { ok: true },
        timestamp: "2024-01-01T00:00:01Z",
      }),
    ];
    const seq = extractActionSequence(caps);
    expect(seq.map((s) => s.index)).toContain(0);
    const st = indexStateValues(caps, new Set(), new Set(seq.map((s) => s.index)));
    expect(st.get(T)?.htmlOrigin).toEqual({ element: "link", name: "token" });
  });
});
