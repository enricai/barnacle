import { describe, expect, it } from "vitest";
import { findCaptchaResponseFields, parseMultipartTextParts } from "@/recon/captcha-detect";
import { compileActionSteps, findFrozenRequestTokens } from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const mp = (parts: Array<[string, string]>) =>
  `${parts
    .map(([n, v]) => `--XB\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`)
    .join("")}--XB--\r\n`;

const run = (body: string) => {
  const caps = [
    buildCapture({
      url: "https://shop.example.com/submit",
      requestPostData: body,
      responseBody: { ok: true },
      timestamp: "2024-01-01T00:00:01Z",
    }),
  ];
  const st = compileActionSteps(
    caps.map((capture, index) => ({ capture, index })),
    new Map()
  );
  return findFrozenRequestTokens(st, caps, "x");
};

describe("captcha detection", () => {
  it("parses multipart parts", () => {
    expect(
      parseMultipartTextParts(
        mp([
          ["a", "1"],
          ["b", "2"],
        ])
      )
    ).toEqual([
      { name: "a", value: "1" },
      { name: "b", value: "2" },
    ]);
  });
  it("finds fields in each body shape", () => {
    expect(findCaptchaResponseFields(mp([["h-captcha-response", "t"]]))).toHaveLength(1);
    expect(findCaptchaResponseFields("g-recaptcha-response=t")).toHaveLength(1);
    expect(findCaptchaResponseFields('{"cf-turnstile-response":"t"}')).toHaveLength(1);
    expect(findCaptchaResponseFields(mp([["name", "a"]]))).toEqual([]);
  });
  it("makes multipart captcha flow untraceable (browser-only)", () => {
    expect(
      run(
        mp([
          ["name", "a"],
          ["h-captcha-response", "tok"],
        ])
      ).length
    ).toBe(1);
  });
  it("leaves bodies without captcha unaffected", () => {
    expect(run(mp([["name", "a"]]))).toEqual([]);
    expect(run("a=b")).toEqual([]);
    expect(run(JSON.stringify({ a: "b" }))).toEqual([]);
  });
});
