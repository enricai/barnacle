import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readHttpSteps } from "@/scripts/recon-shared";

const DIR = mkdtempSync(join(tmpdir(), "hs-"));
let n = 0;
function flow(body: string): string {
  const path = join(DIR, `f${n++}.json`);
  writeFileSync(path, body);
  return path;
}

describe("readHttpSteps", () => {
  it("parses a valid option", () => {
    expect(
      readHttpSteps(
        flow('{"httpSteps":{"actions":2,"tailFromStep":0,"handoverUrl":"https://example.test/x"}}')
      )
    ).toEqual({ actions: 2, tailFromStep: 0, handoverUrl: "https://example.test/x" });
    expect(readHttpSteps(flow('{"httpSteps":{"actions":1,"tailFromStep":3}}'))).toEqual({
      actions: 1,
      tailFromStep: 3,
    });
  });
  it("is null for absent, legacy array, and invalid shapes", () => {
    for (const b of [
      "[]",
      "null",
      "{}",
      '{"httpSteps":"x"}',
      '{"httpSteps":[]}',
      '{"httpSteps":{"actions":0,"tailFromStep":0}}',
      '{"httpSteps":{"actions":1.5,"tailFromStep":0}}',
      '{"httpSteps":{"actions":1,"tailFromStep":-1}}',
      '{"httpSteps":{"actions":1}}',
      '{"httpSteps":{"actions":1,"tailFromStep":0,"handoverUrl":3}}',
    ])
      expect(readHttpSteps(flow(b))).toBeNull();
  });
  it("throws with browserFlowOnly:true", () => {
    expect(() =>
      readHttpSteps(flow('{"browserFlowOnly":true,"httpSteps":{"actions":1,"tailFromStep":0}}'))
    ).toThrow(/browserFlowOnly/);
  });
});
