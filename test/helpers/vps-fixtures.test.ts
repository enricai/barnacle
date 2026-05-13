import { describe, expect, it } from "vitest";

import { VPS_FIXTURES, loadVpsFixture, type VpsFixtureKey } from "./vps-fixtures";

describe("vps-fixtures loader", () => {
  const keys = Object.keys(VPS_FIXTURES) as VpsFixtureKey[];

  it.each(keys)("loads at least one response from %s fixture", (key) => {
    const fixture = loadVpsFixture(key);
    expect(fixture.responses.length).toBeGreaterThan(0);
    for (const resp of fixture.responses) {
      expect(resp).toHaveProperty("status");
    }
  });
});
