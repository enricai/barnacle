import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readApplicantContract } from "@/scripts/recon-shared";

const DIR = mkdtempSync(join(tmpdir(), "ac-"));

function flow(name: string, body: string): string {
  const path = join(DIR, name);
  writeFileSync(path, body);
  return path;
}

describe("readApplicantContract", () => {
  it("returns the explicit boolean", () => {
    expect(readApplicantContract(flow("a.json", '{"applicantContract":false}'))).toBe(false);
    expect(readApplicantContract(flow("b.json", '{"applicantContract":true}'))).toBe(true);
  });
  it("returns undefined when absent, non-boolean, or bare array", () => {
    expect(readApplicantContract(flow("c.json", '{"steps":[]}'))).toBeUndefined();
    expect(readApplicantContract(flow("d.json", "[]"))).toBeUndefined();
    expect(readApplicantContract(flow("e.json", '{"applicantContract":"no"}'))).toBeUndefined();
  });
});
