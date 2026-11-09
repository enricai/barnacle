import { describe, expect, it } from "vitest";
import { scrubSecretEnvInValues, scrubSecretEnvValues } from "@/scripts/recon-browser";

describe("scrubSecretEnvValues", () => {
  it("restores ${VAR} for secret-named env values, longest first", () => {
    const env = { SITE_PASSWORD: "hunter22", API_TOKEN: "hunter22x", HOME: "/root/home" };
    const out = scrubSecretEnvValues('{"v":"hunter22x","w":"hunter22","h":"/root/home"}', env);
    expect(out).toBe('{"v":"${API_TOKEN}","w":"${SITE_PASSWORD}","h":"/root/home"}');
  });
  it("handles JSON-escaped values and skips short/empty secrets", () => {
    const env = { MY_SECRET: 'p"w\\d1', X_TOKEN: "ab", EMPTY_PASSWORD: "" };
    const text = JSON.stringify({ a: 'p"w\\d1', b: "ab" });
    expect(scrubSecretEnvValues(text, env)).toBe('{"a":"${MY_SECRET}","b":"ab"}');
  });
  it("scrubs only string values, leaving keys, booleans and numbers intact", () => {
    const env = { X_TOKEN_REFRESH: "true", A_SECRET_TTL: "3600", B_TOKEN_K: "optional" };
    const node = { optional: true, n: 3600, steps: ["type tokentrue 3600"] };
    const out = scrubSecretEnvInValues(node, env);
    expect(out.optional).toBe(true);
    expect(out.n).toBe(3600);
    expect(out.steps[0]).toBe("type token${X_TOKEN_REFRESH} ${A_SECRET_TTL}");
  });
});
