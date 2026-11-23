import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RECON_FLOW_FILE_SCHEMA } from "@/scripts/recon-browser";
import { readExtraPayloadFields } from "@/scripts/recon-shared";

const step = { step: "Click Apply", optional: false, upload: false };
const parse = (extra: unknown) =>
  RECON_FLOW_FILE_SCHEMA.safeParse({ steps: [step], extraPayloadFields: extra });
const write = (content: unknown): string => {
  const f = join(mkdtempSync(join(tmpdir(), "epf-")), "flow.json");
  writeFileSync(f, JSON.stringify(content));
  return f;
};

describe("extraPayloadFields schema", () => {
  it("accepts valid entries and defaults type to string", () => {
    const r = parse([{ name: "idempotencyKey" }, { name: "cardNumber", sensitive: true }]);
    expect(r.success).toBe(true);
    if (r.success && !Array.isArray(r.data)) {
      expect(r.data.extraPayloadFields?.[0]?.type).toBe("string");
    }
  });
  it("rejects invalid identifiers, unknown types, non-string sensitive", () => {
    expect(parse([{ name: "1bad" }]).success).toBe(false);
    expect(parse([{ name: "a-b" }]).success).toBe(false);
    expect(parse([{ name: "a", type: "date" }]).success).toBe(false);
    expect(parse([{ name: "a", type: "number", sensitive: true }]).success).toBe(false);
  });
});

describe("readExtraPayloadFields", () => {
  it("returns [] for bare arrays, missing files, absent key", () => {
    expect(readExtraPayloadFields(write([step]))).toEqual([]);
    expect(readExtraPayloadFields("/nonexistent/flow.json")).toEqual([]);
    expect(readExtraPayloadFields(write({ steps: [step] }))).toEqual([]);
  });
  it("returns typed entries", () => {
    const out = readExtraPayloadFields(
      write({ steps: [step], extraPayloadFields: [{ name: "n", type: "number", optional: true }] })
    );
    expect(out).toEqual([{ name: "n", type: "number", optional: true }]);
  });
});
