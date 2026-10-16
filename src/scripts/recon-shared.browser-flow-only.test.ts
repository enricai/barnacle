import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readBrowserFlowOnly } from "@/scripts/recon-shared";

const DIR = mkdtempSync(join(tmpdir(), "bfo-"));

function flow(name: string, body: string): string {
  const path = join(DIR, name);
  writeFileSync(path, body);
  return path;
}

describe("readBrowserFlowOnly", () => {
  it("is true only for literal true", () => {
    expect(readBrowserFlowOnly(flow("a.json", '{"steps":[],"browserFlowOnly":true}'))).toBe(true);
  });
  it("is false for array, missing key, non-boolean, and null", () => {
    expect(readBrowserFlowOnly(flow("b.json", "[]"))).toBe(false);
    expect(readBrowserFlowOnly(flow("c.json", '{"steps":[]}'))).toBe(false);
    expect(readBrowserFlowOnly(flow("d.json", '{"browserFlowOnly":"true"}'))).toBe(false);
    expect(readBrowserFlowOnly(flow("e.json", "null"))).toBe(false);
  });
  it("reports malformed and unreadable files instead of treating them as not opted in", () => {
    expect(() => readBrowserFlowOnly(flow("f.json", "not json"))).toThrow();
    expect(() => readBrowserFlowOnly(join(DIR, "missing.json"))).toThrow();
  });
});
