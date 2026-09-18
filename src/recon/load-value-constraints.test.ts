import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadReconValueConstraints,
  VALUE_CONSTRAINTS_NONE,
} from "@/recon/load-value-constraints";
import { EMPTY_VALUE_CONSTRAINTS } from "@/recon/value-constraints";

const written: string[] = [];

/** Writes a throwaway ESM value-constraints module and returns an absolute specifier. */
function writeValueConstraintsModule(name: string, source: string): string {
  const path = join(tmpdir(), `barnacle-value-constraints-${name}-${written.length}.mjs`);
  writeFileSync(path, source);
  written.push(path);
  return path;
}

afterEach(() => {
  for (const p of written.splice(0)) {
    try {
      unlinkSync(p);
    } catch {
      // best effort — tmp files are disposable
    }
  }
});

describe("loadReconValueConstraints — none sentinel", () => {
  it("returns EMPTY_VALUE_CONSTRAINTS without touching disk", async () => {
    expect(await loadReconValueConstraints(VALUE_CONSTRAINTS_NONE, process.cwd())).toBe(
      EMPTY_VALUE_CONSTRAINTS
    );
  });
});

describe("loadReconValueConstraints — export resolution", () => {
  it("resolves a named export", async () => {
    const spec = writeValueConstraintsModule(
      "named",
      `export const valueConstraints = { seatCount: { min: 1, max: 4 } };`
    );
    const v = await loadReconValueConstraints(spec, process.cwd());
    expect(v.seatCount).toEqual({ min: 1, max: 4 });
  });

  it("resolves a default export", async () => {
    const spec = writeValueConstraintsModule(
      "default",
      `export default { tierCode: { enumValues: ["gold", "silver"] } };`
    );
    const v = await loadReconValueConstraints(spec, process.cwd());
    expect(v.tierCode).toEqual({ enumValues: ["gold", "silver"] });
  });

  it("throws naming the specifier when the module exports no constraints", async () => {
    const spec = writeValueConstraintsModule("empty", `export const somethingElse = 1;`);
    await expect(loadReconValueConstraints(spec, process.cwd())).rejects.toThrow(
      /does not export a valid/
    );
  });
});

describe("loadReconValueConstraints — payload field names must be identifiers", () => {
  it("rejects a field name that is not a JS identifier", async () => {
    const spec = writeValueConstraintsModule(
      "bad-ident",
      `export const valueConstraints = { "not a valid ident!": { min: 1, max: 4 } };`
    );
    await expect(loadReconValueConstraints(spec, process.cwd())).rejects.toThrow(
      /valid JS identifier/
    );
  });

  it("rejects a field name starting with a digit", async () => {
    const spec = writeValueConstraintsModule(
      "digit-ident",
      `export const valueConstraints = { "1Field": { min: 1, max: 4 } };`
    );
    await expect(loadReconValueConstraints(spec, process.cwd())).rejects.toThrow(
      /valid JS identifier/
    );
  });
});

describe("loadReconValueConstraints — bound validation", () => {
  it("rejects min greater than max", async () => {
    const spec = writeValueConstraintsModule(
      "bad-bounds",
      `export const valueConstraints = { seatCount: { min: 10, max: 1 } };`
    );
    await expect(loadReconValueConstraints(spec, process.cwd())).rejects.toThrow(
      /min must not be greater than max/
    );
  });

  it("round-trips a well-formed module's enumValues/min/max unchanged", async () => {
    const spec = writeValueConstraintsModule(
      "well-formed",
      `export const valueConstraints = {
        tierCode: { enumValues: ["gold", "silver", "bronze"] },
        seatCount: { min: 1, max: 8 },
      };`
    );
    const v = await loadReconValueConstraints(spec, process.cwd());
    expect(v).toEqual({
      tierCode: { enumValues: ["gold", "silver", "bronze"] },
      seatCount: { min: 1, max: 8 },
    });
  });
});
