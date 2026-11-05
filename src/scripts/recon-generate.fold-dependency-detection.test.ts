import { describe, expect, it } from "vitest";
import {
  collectRequestValuesIncludingHeaders,
  computeFoldChain,
  collectResponseLeafValues,
} from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

function cap(over: Record<string, unknown>): Capture {
  return {
    url: "https://x.test/a",
    method: "POST",
    requestHeaders: {},
    responseHeaders: {},
    requestPostData: null,
    responseBody: {},
    ...over,
  } as unknown as Capture;
}

describe("fold dependency value detection", () => {
  it("ignores cookie and content-type header values", () => {
    const c = cap({
      requestHeaders: { Cookie: "sess=abc12345", "Content-Type": "application/json" },
      responseHeaders: { "set-cookie": "sess=abc12345", "content-type": "application/json" },
    });
    expect(collectRequestValuesIncludingHeaders(c).has("sess=abc12345")).toBe(false);
    expect(collectResponseLeafValues(c).has("application/json")).toBe(false);
  });
  it("keeps custom minted header tokens", () => {
    const c = cap({ requestHeaders: { "X-Price-Token": "tok-a1" } });
    expect(collectRequestValuesIncludingHeaders(c).has("tok-a1")).toBe(true);
  });
  it("independent drills sharing only trivial/ambient values chain separately", () => {
    const hdr = { Cookie: "sess=abc12345", "Content-Type": "application/json" };
    const mk = (id: string) =>
      cap({
        url: `https://x.test/item/${id}`,
        method: "GET",
        requestHeaders: hdr,
        responseHeaders: { "set-cookie": "sess=abc12345", "content-type": "application/json" },
        responseBody: { id, count: "0", flag: "3", kind: "application/json" },
      });
    const actions = [{ capture: mk("aaa111") }, { capture: mk("bbb222") }];
    // each drill keeps only its own key: neither pulls the other into its chain
    expect(computeFoldChain(actions, 0, []).chain).toEqual([0]);
    expect(computeFoldChain(actions, 1, []).chain).toEqual([1]);
  });
  it("a real minted id in a later URL still chains", () => {
    const a = cap({ url: "https://x.test/s", method: "GET", responseBody: { id: "item-9f3a" } });
    const b = cap({ url: "https://x.test/item/item-9f3a", method: "GET", responseBody: { id: "item-9f3a", n: 1 } });
    expect(computeFoldChain([{ capture: a }, { capture: b }], 0, []).chain).toEqual([0, 1]);
  });
});
