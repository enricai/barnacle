import { stripTypeScriptTypes } from "node:module";
import { describe, expect, it } from "vitest";
import { emitContractTs } from "@/scripts/recon-generate";

const PREFIX_BODY = [
  "    const prefixCookies: Record<string, string> = {};",
  "    const httpClient = createHttpClient({ schema: z.unknown(), bottleneck: limiter, baseHeaders: BASE_HEADERS });",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: emitted source
  '    await httpClient(`${context.baseUrl}/api/cart`, { method: "POST", headers: BASE_HEADERS });',
  "    return { cookies: prefixCookies };",
].join("\n");

const BASE = {
  siteId: "shop",
  pascal: "Shop",
  baseUrl: "https://shop.example.com",
  baseHeaders: { accept: "application/json" },
  minTime: 100,
  safeRps: 10,
  responseBody: { ok: true },
  gql: false,
  gqlQuery: null,
  endpointPath: "/api/cart",
  auxFiles: [],
  isSubmissionFlow: true,
  inputBody: { sku: "x" },
};

describe("emitContractTs mixed HTTP-prefix mode", () => {
  const code = emitContractTs({
    ...BASE,
    multiStepBody: PREFIX_BODY,
    mixedHttpPrefix: true,
    mixedHandover: { tailFromStep: 0 },
  } as never);

  it("runs the prefix then hands the cookies to the browser flow, with no executeHttp", () => {
    expect(code).not.toContain("async executeHttp(");
    expect(code).toContain("async function runHttpPrefix(");
    const prefix = code.indexOf("await runHttpPrefix(payload, context)");
    const flow = code.indexOf("await runShopBrowserFlow(");
    expect(prefix).toBeGreaterThan(-1);
    expect(flow).toBeGreaterThan(prefix);
    expect(code).toContain("session.sessionProxy ?? null, cookies)");
  });

  it("imports what the prefix uses and parses as TypeScript", () => {
    expect(code).toContain('import Bottleneck from "bottleneck"');
    expect(code).toContain("createHttpClient");
    expect(code).toContain("const BASE_HEADERS");
    expect(code).toContain("const limiter = new Bottleneck");
    expect(code).toContain("SitePluginContext");
    expect(() => stripTypeScriptTypes(code)).not.toThrow();
  });

  it("leaves non-mixed emission unchanged", () => {
    const plain = emitContractTs({ ...BASE, multiStepBody: PREFIX_BODY } as never);
    expect(plain).toContain("async executeHttp(");
    expect(plain).not.toContain("runHttpPrefix");
  });
});

describe("emitContractTs mixed-mode guard", () => {
  it("throws when mixedHttpPrefix and mixedHandover are not set together", () => {
    expect(() =>
      emitContractTs({ ...BASE, multiStepBody: PREFIX_BODY, mixedHttpPrefix: true } as never)
    ).toThrow(/must be set together/);
    expect(() =>
      emitContractTs({
        ...BASE,
        multiStepBody: PREFIX_BODY,
        mixedHandover: { tailFromStep: 0 },
      } as never)
    ).toThrow(/must be set together/);
  });
});
