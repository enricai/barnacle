import { describe, expect, it } from "vitest";

import { detectFormSchemaFetchCapture } from "@/scripts/recon-generate";

const schema = {
  fieldIdKey: "id",
  fieldNameKeys: ["name"],
  fieldOptionsKey: "options",
  optionIdKey: "id",
  optionValueKey: "value",
  responseValueKey: "value",
  responseOptionIdKey: "optionId",
};
const body = { fields: [{ id: "11111111-1111-4111-8111-111111111111", name: "First" }] };
const cap = (url: string) => ({ method: "GET", status: 200, url, responseBody: body });

describe("detectFormSchemaFetchCapture", () => {
  it("skips telemetry-pattern captures and picks the real schema fetch", () => {
    const captures = [
      cap("https://site.test/blank/page"),
      cap("https://site.test/api/form"),
    ] as never;
    const hit = detectFormSchemaFetchCapture(captures, "https://site.test", schema);
    expect(hit?.index).toBe(1);
  });
  it("returns null when only telemetry captures carry the fields", () => {
    const captures = [cap("https://site.test/blank/page")] as never;
    expect(detectFormSchemaFetchCapture(captures, "https://site.test", schema)).toBeNull();
  });
});
