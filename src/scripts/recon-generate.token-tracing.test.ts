import { describe, expect, it } from "vitest";
import {
  compileActionSteps,
  emitMultiStepExecuteHttp,
  extractActionSequence,
  findFrozenRequestTokens,
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
        requestPostData: null,
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

describe("HTML-issued token emission", () => {
  const T = "Qw8rT5yU2iO9pLkJ4hGf";
  const mk = (markup: string, postData: string, urlSuffix: string) => [
    buildCapture({
      url: "https://shop.example.com/cart",
      method: "GET",
      requestPostData: null,
      responseBody: `<html>${markup}</html>`,
      timestamp: "2024-01-01T00:00:00Z",
    }),
    buildCapture({
      url: `https://shop.example.com/checkout${urlSuffix}`,
      requestPostData: postData,
      requestHeaders: { "Content-Type": "application/x-www-form-urlencoded" },
      responseBody: { ok: true },
      timestamp: "2024-01-01T00:00:01Z",
    }),
  ];
  it("extracts a form-action token from the response text and splices it into the URL", () => {
    const out = emit(mk(`<form action="/checkout?csrf=${T}"></form>`, "go=1", `?csrf=${T}`), true);
    expect(out).not.toContain(T);
    expect(out).toContain("await fetchFollowingRedirectsPreservingMethod(");
    expect(out).toContain("text_r0");
    expect(out).toContain('.get("csrf")');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting literal interpolation text in generated plugin source
    expect(out).toContain("?csrf=${csrfToken}");
  });
  it("extracts a hidden-input token and splices it into a urlencoded body", () => {
    const out = emit(
      mk(`<input type="hidden" name="nonce" value="${T}">`, `nonce=${T}&go=1`, ""),
      true
    );
    expect(out).not.toContain(T);
    expect(out).toContain('"nonce"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting literal interpolation text in generated plugin source
    expect(out).toContain("nonce=${nonceToken}");
  });
  it("disambiguates two HTML tokens whose names derive the same variable", () => {
    const T2 = "Zx3cV6bN1mAs8dFgHj5K";
    const out = emit(
      mk(
        `<input type="hidden" name="x-id" value="${T}"><input type="hidden" name="x.id" value="${T2}">`,
        `x-id=${T}&x.id=${T2}`,
        ""
      ),
      true
    );
    expect(out).not.toContain(T);
    expect(out).not.toContain(T2);
    expect(out).toMatch(/const idToken\b/);
    expect(out).toMatch(/const idToken2\b/);
  });
});

describe("percent-encoded token replay", () => {
  const B64 = "ab+cd/ef12GH34ij56KL==";
  const start = buildCapture({
    url: "https://shop.example.com/api/session/start",
    requestPostData: JSON.stringify({ intent: "begin" }),
    responseBody: { handle: B64 },
    timestamp: "2024-01-01T00:00:00Z",
  });
  it("threads a JSON-issued token re-sent percent-encoded in the next URL", () => {
    const out = emit([
      start,
      buildCapture({
        url: `https://shop.example.com/api/session/commit?handle=${encodeURIComponent(B64)}`,
        requestPostData: JSON.stringify({ qty: 2 }),
        responseBody: { done: true },
        timestamp: "2024-01-01T00:00:01Z",
      }),
    ]);
    expect(out).not.toContain(B64);
    expect(out).not.toContain(encodeURIComponent(B64));
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting literal interpolation text in generated plugin source
    expect(out).toContain("?handle=${encodeURIComponent(handle)}");
  });
  it("threads an HTML-issued token re-sent percent-encoded in the next URL", () => {
    const out = emit(
      [
        buildCapture({
          url: "https://shop.example.com/cart",
          method: "GET",
          requestPostData: null,
          responseBody: `<input type="hidden" name="nonce" value="${B64}">`,
          timestamp: "2024-01-01T00:00:00Z",
        }),
        buildCapture({
          url: `https://shop.example.com/checkout?n=${encodeURIComponent(B64)}`,
          requestPostData: JSON.stringify({ go: 1 }),
          responseBody: { ok: true },
          timestamp: "2024-01-01T00:00:01Z",
        }),
      ],
      true
    );
    expect(out).not.toContain(B64);
    expect(out).not.toContain(encodeURIComponent(B64));
    expect(out).toContain("await fetchFollowingRedirectsPreservingMethod(");
  });
});

describe("findFrozenRequestTokens", () => {
  const T = "Qw8rT5yU2iO9pLkJ4hGf";
  const steps = (caps: ReturnType<typeof buildCapture>[]) =>
    compileActionSteps(
      caps.map((capture, index) => ({ capture, index })),
      new Map()
    );
  const page = (body: unknown) =>
    buildCapture({
      url: "https://shop.example.com/cart",
      method: "GET",
      requestPostData: null,
      responseBody: body,
      timestamp: "2024-01-01T00:00:00Z",
    });
  const write = (url: string, n: number) =>
    buildCapture({
      url,
      requestPostData: JSON.stringify({ go: 1 }),
      responseBody: { ok: true },
      timestamp: `2024-01-01T00:00:0${n}Z`,
    });

  it("flags a token an earlier page carried in markup that emitted code still holds literally", () => {
    const caps = [
      page(`<script>var s = "${T}";</script>`),
      write(`https://shop.example.com/step?s=${T}`, 1),
    ];
    expect(findFrozenRequestTokens(steps(caps.slice(1)), caps, `/step?s=${T}`)).toEqual([T]);
  });
  it("flags an opaque query value seen on exactly one request and issued by nothing", () => {
    const caps = [write(`https://shop.example.com/step?s=${T}`, 1)];
    expect(findFrozenRequestTokens(steps(caps), caps, `/step?s=${T}`)).toEqual([T]);
  });
  it("does not flag a constant value every request carries", () => {
    const caps = [
      write(`https://shop.example.com/a?key=${T}`, 1),
      write(`https://shop.example.com/b?key=${T}`, 2),
    ];
    expect(findFrozenRequestTokens(steps(caps), caps, `/a?key=${T}`)).toEqual([]);
  });
  it("does not flag a token the emitted code no longer carries", () => {
    const caps = [
      page(`<script>var s = "${T}";</script>`),
      write(`https://shop.example.com/step?s=${T}`, 1),
    ];
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting literal interpolation text in generated plugin source
    expect(findFrozenRequestTokens(steps(caps.slice(1)), caps, "/step?s=${sToken}")).toEqual([]);
  });
  it("does not flag a slug-shaped value", () => {
    const caps = [write("https://shop.example.com/step?q=software-engineer-remote-2024", 1)];
    expect(
      findFrozenRequestTokens(steps(caps), caps, "/step?q=software-engineer-remote-2024")
    ).toEqual([]);
  });
});
