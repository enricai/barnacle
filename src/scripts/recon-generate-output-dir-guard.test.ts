import { describe, expect, it } from "vitest";
import { findExistingGeneratedPaths } from "./recon-generate";

const has = (...present: string[]) => (p: string) => present.includes(p);

describe("findExistingGeneratedPaths", () => {
  it("allows a dir holding only recon-flow.json and telemetry/", () => {
    expect(
      findExistingGeneratedPaths("src/sites/x", has("src/sites/x", "src/sites/x/recon-flow.json", "src/sites/x/telemetry"))
    ).toEqual([]);
  });
  it.each(["contract.ts", "index.ts", "flows"])("reports %s", (n) => {
    expect(findExistingGeneratedPaths("src/sites/x", has(`src/sites/x/${n}`))).toEqual([`src/sites/x/${n}`]);
  });
});
