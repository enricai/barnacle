import { describe, expect, it } from "vitest";

import { successEnvelope } from "@/api/helpers/envelope";
import { vpsStatusSchema } from "@/api/schemas/common";

describe("api/helpers/envelope", () => {
  it("merges the status block with a domain payload", () => {
    const env = successEnvelope({ submissions: [] });
    expect(env.status.httpStatus).toBe("OK");
    expect(env.status.details).toEqual([]);
    expect(env.submissions).toEqual([]);
  });

  it("status block round-trips through vpsStatusSchema", () => {
    const env = successEnvelope({ keys: [] });
    expect(vpsStatusSchema.safeParse(env.status).success).toBe(true);
  });

  it("preserves extra payload keys alongside status", () => {
    const env = successEnvelope({ results: [] as unknown[] });
    expect(env.results).toEqual([]);
    expect(env.status.httpStatus).toBe("OK");
  });
});
