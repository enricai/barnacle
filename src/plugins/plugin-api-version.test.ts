import { describe, expect, it } from "vitest";

import { PLUGIN_API_VERSION } from "@/plugins/plugin-api-version";

describe("PLUGIN_API_VERSION", () => {
  it("exports the string 1.0.0 at runtime", () => {
    expect(PLUGIN_API_VERSION).toBe("1.0.0");
  });

  it("is a const literal type (not widened to string)", () => {
    const value: "1.0.0" = PLUGIN_API_VERSION;
    expect(value).toBe("1.0.0");
  });
});
