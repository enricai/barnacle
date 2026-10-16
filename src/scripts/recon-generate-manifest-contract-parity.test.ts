import { describe, expect, it } from "vitest";
import { emitConfigManifest } from "@/scripts/recon-generate";

/** Concatenation trick so Biome's noTemplateCurlyInString rule doesn't flag the literal. */
const RECON_PASSWORD_TOKEN = `$${"{RECON_PASSWORD}"}`;

interface ManifestShape {
  spec: {
    maxAttempts?: number;
    request?: { properties?: Record<string, unknown> };
  };
}

const emit = (flowSteps: string[], browserFlowOnly = false): ManifestShape =>
  JSON.parse(
    emitConfigManifest({
      siteId: "test-site",
      baseUrl: "https://example.org",
      flowSteps,
      isSubmissionFlow: true,
      browserFlowOnly,
    })
  );

describe("emitConfigManifest matches the .ts contract's account-creation and tracking decisions", () => {
  it("emits spec.maxAttempts: 1 when a step splices RECON_PASSWORD", () => {
    const manifest = emit([
      `Fill in the Password field with '${RECON_PASSWORD_TOKEN}'`,
      "Click the Sign up button",
    ]);
    expect(manifest.spec.maxAttempts).toBe(1);
  });

  it("omits spec.maxAttempts when no step splices RECON_PASSWORD", () => {
    expect(emit(["Click the Apply button"]).spec).not.toHaveProperty("maxAttempts");
  });

  it("keeps TrackingUrl in the request schema for browser-flow-only output", () => {
    const manifest = emit(["Click the Apply button"], true);
    expect(manifest.spec.request?.properties).toHaveProperty("TrackingUrl");
  });
});
