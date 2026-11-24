import { describe, expect, it } from "vitest";
import { extractHtmlIssuedTokens } from "@/recon/html-state-producers";

describe("extractHtmlIssuedTokens", () => {
  it("indexes form action query values with &amp; decoded", () => {
    const html = `<form action="https://example.com/apply?csrf=abc123def456ghi789&amp;hashed=H4sh%2Bvalue00000"></form>`;
    const t = extractHtmlIssuedTokens(html);
    expect(t).toContainEqual({ value: "abc123def456ghi789", element: "form-action", name: "csrf" });
    expect(t).toContainEqual({ value: "H4sh+value00000", element: "form-action", name: "hashed" });
  });
  it("indexes path segments (job id, slug) but not plain words", () => {
    const html = `<a href="/jobs/8f3a2b1c-1111-2222-3333-444455556666/senior-engineer/candidate">x</a>`;
    const t = extractHtmlIssuedTokens(html).filter((x) => x.element === "path-segment");
    expect(t.map((x) => x.value)).toEqual([
      "8f3a2b1c-1111-2222-3333-444455556666",
      "senior-engineer",
    ]);
    expect(t[0]?.name).toBe("/jobs/*/senior-engineer/candidate");
  });
  it("still indexes hidden inputs", () => {
    const t = extractHtmlIssuedTokens(`<input type="hidden" name="tok" value="v-123456789">`);
    expect(t).toEqual([{ value: "v-123456789", element: "hidden-input", name: "tok" }]);
  });
  it("returns [] for non-HTML", () => {
    expect(extractHtmlIssuedTokens({ a: 1 })).toEqual([]);
  });
});

import { extractHtmlBearerTokens, locateHtmlBearerToken } from "@/recon/html-state-producers";

const jwt = (c: object) =>
  `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(c)).toString("base64url")}.sig_abc-123`;
const userT = jwt({ typ: "userToken" });
const clientT = jwt({ typ: "clientToken" });
const page = (rows: string) => `<script>self.__next_f.push([1,${JSON.stringify(rows)}])</script>`;

describe("HTML bearer token locator", () => {
  it("reads RSC row at exact length when next row id follows", () => {
    const html = page(`a:T${clientT.length.toString(16)},${clientT}b:["x"]\n`);
    const r = extractHtmlBearerTokens(html);
    expect(r).toHaveLength(1);
    expect(r[0]?.token).toBe(clientT);
    expect(r[0]?.row).toBe("a");
  });
  it("selects by claims, not position", () => {
    const html = page(
      `1:T${userT.length.toString(16)},${userT}2:T${clientT.length.toString(16)},${clientT}`
    );
    const r = locateHtmlBearerToken(["<p/>", html], { claims: { typ: "clientToken" } });
    expect(r?.token).toBe(clientT);
    expect(r?.document).toBe(1);
    expect(r?.row).toBe("2");
  });
  it("locates exact captured value with document and row", () => {
    const html = page(`7:T${userT.length.toString(16)},${userT}`);
    expect(locateHtmlBearerToken([html], { value: userT })).toMatchObject({
      document: 0,
      row: "7",
    });
  });
  it("returns null when absent", () => {
    expect(locateHtmlBearerToken(["<p>hi</p>", 5], { value: userT })).toBeNull();
  });
});

describe("emitBearerBootstrapSource", () => {
  it("emits no literal and extracts exact-length claim-selected token", async () => {
    const { emitBearerBootstrapSource, selectionClaims } = await import("./html-state-producers.js");
    const src = emitBearerBootstrapSource({
      documentUrl: "https://x.test/",
      claims: selectionClaims({ typ: "clientToken", exp: 1 }),
    });
    expect(src).not.toContain(clientT);
    expect(src).not.toContain("eyJhbGci");
    const html = page(
      `1:T${userT.length.toString(16)},${userT}2:T${clientT.length.toString(16)},${clientT}3:["x"]\n`
    );
    const { stripTypeScriptTypes } = await import("node:module");
    const js = stripTypeScriptTypes(src);
    const f = new Function("fetch", "Buffer", `${js}; return mintBearerToken;`)(
      async () => ({ text: async () => html }),
      Buffer
    );
    expect(await f()).toBe(clientT);
  });
});
