import { readFileSync } from "node:fs";
import path from "node:path";
import semver from "semver";
import { describe, expect, it } from "vitest";

/**
 * Locks the @browserbasehq/stagehand range below 3.7.0 so the 3.7.0/3.7.1
 * shutdown-supervisor regression (docs/recon-1123-flow-truncates-at-step-9-stagehand-370-shutdown.md)
 * cannot be silently re-admitted by a future range bump.
 */
describe("dependency-pins/stagehand", () => {
  const rootDir = path.resolve(__dirname, "..");
  const packageJson = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf-8"));
  const declaredRange = packageJson.dependencies["@browserbasehq/stagehand"];

  it("does not admit the 3.7.0 shutdown-supervisor regression via package.json's declared range", () => {
    expect(semver.satisfies("3.7.0", declaredRange)).toBe(false);
    expect(semver.satisfies("3.7.1", declaredRange)).toBe(false);
  });

  it("keeps package.json's declared range floor within 3.6.x", () => {
    const minVersion = semver.minVersion(declaredRange);
    expect(minVersion?.major).toBe(3);
    expect(minVersion?.minor).toBe(6);
  });

  it("resolves to a 3.6.x version in pnpm-lock.yaml", () => {
    const lockfile = readFileSync(path.join(rootDir, "pnpm-lock.yaml"), "utf-8");
    const match = lockfile.match(/'@browserbasehq\/stagehand@(\d+)\.(\d+)\.(\d+)/);
    expect(
      match,
      "expected a resolved @browserbasehq/stagehand@x.y.z entry in pnpm-lock.yaml"
    ).not.toBeNull();
    const [, major, minor] = match as RegExpMatchArray;
    expect(major).toBe("3");
    expect(minor).toBe("6");
  });
});
