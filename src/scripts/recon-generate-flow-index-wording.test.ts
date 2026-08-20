import { describe, expect, it } from "vitest";

import { emitBrowserFlowTs, emitIndexTs } from "@/scripts/recon-generate";

/**
 * Wording regressions from the a flowless recon capture:
 * - FAILURE 4: the empty-`FLOW_STEPS` stub pointed at a `recon-flow.json` this tool
 *   never writes.
 * - FAILURE 6: the emitted index.ts (correctly) says no core edits are required,
 *   which the completion log contradicted. These lock the generated-file side.
 */

describe("emitBrowserFlowTs empty-steps TODO (FAILURE 4)", () => {
  it("does not point the operator at a recon-flow.json the generator never writes", () => {
    const { code } = emitBrowserFlowTs({
      siteId: "some-site",
      pascal: "SomeSite",
      baseUrl: "https://example.com",
      flowSteps: [],
      isSubmissionFlow: false,
    });

    expect(code).not.toContain("recon-flow.json");
    expect(code).toContain("Re-run recon-browser");
  });
});

describe("emitIndexTs registration guidance (FAILURE 6)", () => {
  it("directs the operator to BARNACLE_PLUGINS, not a core-file edit", () => {
    const code = emitIndexTs({ siteId: "some-site", pascal: "SomeSite" });

    expect(code).toContain("BARNACLE_PLUGINS");
    expect(code).not.toContain("src/plugins/loader.ts");
  });
});
