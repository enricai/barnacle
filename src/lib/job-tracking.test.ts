import { describe, expect, it } from "vitest";
import { z } from "zod/v4";

import { JobTrackingSchema } from "@/lib/job-tracking";

describe("JobTrackingSchema", () => {
  it("accepts a valid https URL", () => {
    const result = JobTrackingSchema.safeParse({
      TrackingUrl: "https://example.com/track?id=123",
    });
    expect(result.success).toBe(true);
  });

  it("accepts omission (field is optional)", () => {
    const result = JobTrackingSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.TrackingUrl).toBeUndefined();
    }
  });

  it("rejects a non-URL string", () => {
    const result = JobTrackingSchema.safeParse({ TrackingUrl: "not-a-url" });
    expect(result.success).toBe(false);
  });

  it("composes into any plugin schema via spread — not coupled to a specific plugin", () => {
    // A hypothetical plugin schema with its own fields; TrackingUrl is injected
    // via JobTrackingSchema.shape, exactly as every plugin contract does it.
    const GenericPluginSchema = z.object({ JobId: z.string() }).extend({
      ...JobTrackingSchema.shape,
    });
    const withTracking = GenericPluginSchema.safeParse({
      JobId: "abc-123",
      TrackingUrl: "https://track.example.org/click?src=test",
    });
    expect(withTracking.success).toBe(true);

    const withoutTracking = GenericPluginSchema.safeParse({ JobId: "abc-123" });
    expect(withoutTracking.success).toBe(true);
    if (withoutTracking.success) {
      expect(withoutTracking.data.TrackingUrl).toBeUndefined();
    }
  });
});
