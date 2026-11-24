import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compareCaptureFilenames, readJsonDir } from "@/scripts/recon-shared";

describe("compareCaptureFilenames", () => {
  it("orders numerically, counter-less names after counters, lexical on ties", () => {
    expect(compareCaptureFilenames("148-a.json", "1177-a.json")).toBeLessThan(0);
    expect(compareCaptureFilenames("1-a.json", "x.json")).toBe(-1);
    expect(compareCaptureFilenames("x.json", "1-a.json")).toBe(1);
    expect(compareCaptureFilenames("x.json", "y.json")).toBe(-1);
    expect(compareCaptureFilenames("y.json", "x.json")).toBe(1);
    expect(compareCaptureFilenames("5-a.json", "5-a.json")).toBe(0);
  });

  it("readJsonDir returns numeric order and [] for an unreadable dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "cmp-"));
    try {
      mkdirSync(join(dir, "g"));
      for (const n of ["1177", "148"])
        writeFileSync(join(dir, "g", `${n}-x.json`), JSON.stringify({ n }));
      expect(readJsonDir<{ n: string }>(join(dir, "g")).map((c) => c.n)).toEqual(["148", "1177"]);
      expect(readJsonDir(join(dir, "missing"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
