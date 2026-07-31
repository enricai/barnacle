import { describe, expect, it } from "vitest";

import { walkSetCookiePairs } from "@/scripts/recon-generate";

describe("walkSetCookiePairs — newline-folded multi-cookie Set-Cookie strings", () => {
  it("yields every cookie in a newline-joined 7-cookie string, including one buried mid-string", () => {
    const rawSetCookie = [
      "ADRUM_BTa=R:0|g:abc123; Path=/; HttpOnly",
      "ADRUM_BTa=R:1|g:def456; Path=/; HttpOnly",
      "ADRUM_BT1=R:0; Path=/",
      "ADRUM_BT1=R:1; Path=/",
      "ADRUM_BT1=R:2; Path=/",
      "__pa=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP; Path=/; HttpOnly; Secure",
      "bm_sv=ABCDEF1234567890; Path=/; HttpOnly; Secure",
    ].join("\n");

    const pairs = [...walkSetCookiePairs(rawSetCookie)];

    expect(pairs).toHaveLength(7);
    expect(pairs.map((p) => p.name)).toEqual([
      "ADRUM_BTa",
      "ADRUM_BTa",
      "ADRUM_BT1",
      "ADRUM_BT1",
      "ADRUM_BT1",
      "__pa",
      "bm_sv",
    ]);
    expect(pairs.find((p) => p.name === "__pa")?.value).toBe(
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP"
    );
  });

  it("yields exactly one pair for a single-cookie string, with attributes stripped", () => {
    const pairs = [...walkSetCookiePairs("session=tok123; Path=/; HttpOnly; Secure")];
    expect(pairs).toEqual([{ name: "session", value: "tok123" }]);
  });

  it("skips a newline entry with no '=' instead of aborting the remaining entries", () => {
    const rawSetCookie = ["malformed-entry-no-equals", "session=tok123; Path=/"].join("\n");
    const pairs = [...walkSetCookiePairs(rawSetCookie)];
    expect(pairs).toEqual([{ name: "session", value: "tok123" }]);
  });
});
