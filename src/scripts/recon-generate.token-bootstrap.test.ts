import { stripTypeScriptTypes } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveRuntimeTokenSource,
  emitBearerBootstrapLines,
  setRuntimeTokenSource,
} from "@/scripts/recon-generate";

const tok = (c: object) =>
  `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(c)).toString("base64url")}.sig`;

describe("generated token bootstrap", () => {
  afterEach(() => setRuntimeTokenSource(null));

  it("extracts exact-length claim-selected token, even when followed by a row id", async () => {
    const decoy = tok({ tokenType: "refresh" });
    const want = tok({ tokenType: "access", exp: 9999999999 });
    const stream =
      `4:T${Buffer.byteLength(decoy).toString(16)},${decoy}` +
      `5:T${Buffer.byteLength(want).toString(16)},${want}6:I[1]`;
    const html = `<script>self.__n.push([1,${JSON.stringify(stream)}])</script>`;
    const code = emitBearerBootstrapLines({
      url: "https://a.test/p",
      claims: { tokenType: "access" },
    }).join("\n");
    expect(code).not.toContain("eyJhbGciOiJub25l");
    const js = stripTypeScriptTypes(code);
    const fn = new Function(
      "context",
      "fetch",
      "Buffer",
      `return (async()=>{${js}\nreturn mintBearer(false);})()`
    );
    const got = await fn(
      { baseUrl: "https://a.test" },
      async () => ({ status: 200, text: async () => html }),
      Buffer
    );
    expect(got).toBe(want);
  });

  it("derives a source only when a replay located one; literal never retained", () => {
    const want = tok({ tokenType: "access", exp: 1, sub: "u" });
    const cap = {
      url: "https://a.test/doc",
      requestHeaders: {},
      responseBody: `<script>self.__n.push([1,${JSON.stringify(`5:T${Buffer.byteLength(want).toString(16)},${want}`)}])</script>`,
    };
    const api = { url: "https://a.test/api", requestHeaders: { Authorization: `Bearer ${want}` }, responseBody: null };
    const caps = [cap, api] as never;
    const located = [{ authReplay: { tokenSource: { document: 0, source: "rsc-row" } } }] as never;
    expect(deriveRuntimeTokenSource(caps, [] as never)).toBeNull();
    const src = deriveRuntimeTokenSource(caps, located);
    expect(src).toEqual({ url: "https://a.test/doc", claims: { tokenType: "access" } });
  });
});
