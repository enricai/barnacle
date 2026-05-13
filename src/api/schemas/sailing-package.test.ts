import { describe, expect, it } from "vitest";

import { sailingPackageResponseSchema } from "@/api/schemas/sailing-package";
import { loadVpsFixture } from "../../../test/helpers/vps-fixtures";

describe("sailing-package response schema", () => {
  it("parses every response in the RC sample fixture", () => {
    const { responses } = loadVpsFixture("sailing-package");
    expect(responses.length).toBeGreaterThan(0);
    for (const response of responses) {
      const parsed = sailingPackageResponseSchema.safeParse(response);
      if (!parsed.success) {
        throw new Error(
          `fixture failed to parse:\n${parsed.error.issues
            .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
            .join("\n")}`
        );
      }
      expect(parsed.data.sailingPackages.length).toBeGreaterThan(0);
    }
  });
});
