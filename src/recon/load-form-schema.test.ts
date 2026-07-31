import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FORM_SCHEMA_NONE, loadReconFormSchema } from "@/recon/load-form-schema";

const written: string[] = [];

/** Writes a throwaway ESM form-schema module and returns an absolute specifier. */
function writeFormSchemaModule(name: string, source: string): string {
  const path = join(tmpdir(), `barnacle-formschema-${name}-${written.length}.mjs`);
  writeFileSync(path, source);
  written.push(path);
  return path;
}

const VALID = `export const formSchema = {
  fieldIdKey: "FieldId",
  fieldNameKeys: ["FieldSourceCode", "FieldName"],
  fieldOptionsKey: "FieldOptions",
  optionIdKey: "Id",
  optionValueKey: "Value",
  responseValueKey: "Value",
  responseOptionIdKey: "OptionId",
};`;

afterEach(() => {
  for (const p of written.splice(0)) {
    try {
      unlinkSync(p);
    } catch {
      // best effort — tmp files are disposable
    }
  }
});

describe("loadReconFormSchema — wire-key validation", () => {
  it("accepts a non-identifier wire key (keys anchor JSON strings, not code)", async () => {
    const spec = writeFormSchemaModule(
      "hyphen-key",
      VALID.replace('fieldIdKey: "FieldId"', 'fieldIdKey: "field-id"')
    );
    const schema = await loadReconFormSchema(spec, process.cwd());
    expect(schema?.fieldIdKey).toBe("field-id");
  });

  it("rejects an empty wire key (it would match every field)", async () => {
    const spec = writeFormSchemaModule(
      "empty-key",
      VALID.replace('fieldIdKey: "FieldId"', 'fieldIdKey: ""')
    );
    await expect(loadReconFormSchema(spec, process.cwd())).rejects.toThrow(/non-empty/);
  });

  it("rejects a wire key containing a quote (it would break the JSON string anchor)", async () => {
    const spec = writeFormSchemaModule(
      "quote-key",
      VALID.replace('fieldIdKey: "FieldId"', "fieldIdKey: 'Fie\\\"ld'")
    );
    await expect(loadReconFormSchema(spec, process.cwd())).rejects.toThrow(/quote or backslash/);
  });

  it("rejects an empty fieldNameKeys list (first-present-wins needs a candidate)", async () => {
    const spec = writeFormSchemaModule(
      "empty-namekeys",
      VALID.replace('fieldNameKeys: ["FieldSourceCode", "FieldName"]', "fieldNameKeys: []")
    );
    await expect(loadReconFormSchema(spec, process.cwd())).rejects.toThrow(/at least one key/);
  });
});

describe("loadReconFormSchema — export resolution", () => {
  it("returns null for the none sentinel without touching disk", async () => {
    expect(await loadReconFormSchema(FORM_SCHEMA_NONE, process.cwd())).toBeNull();
  });

  it("accepts a default export", async () => {
    const spec = writeFormSchemaModule(
      "default-export",
      VALID.replace("export const formSchema =", "export default")
    );
    const schema = await loadReconFormSchema(spec, process.cwd());
    expect(schema?.fieldNameKeys).toEqual(["FieldSourceCode", "FieldName"]);
  });

  it("throws naming the specifier when the module exports no form-schema", async () => {
    const spec = writeFormSchemaModule("empty", `export const somethingElse = 1;`);
    await expect(loadReconFormSchema(spec, process.cwd())).rejects.toThrow(
      /does not export a valid/
    );
  });
});
