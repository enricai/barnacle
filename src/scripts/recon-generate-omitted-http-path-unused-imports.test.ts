import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { emitContractTs } from "@/scripts/recon-generate";

/** Resolve the Biome binary from the repo's own `node_modules/.bin` rather than
 * bare PATH — matches the sibling binary-invoking tests
 * (recon-generate-biome-clean.test.ts, recon-generate-browser-flow-only.test.ts). */
const BIOME_BIN = resolve(__dirname, "..", "..", "node_modules", ".bin", "biome");

/**
 * Highest-fidelity regression coverage for a reported unused-import failure:
 * a browser-flow-only submission flow (omitExecuteHttp) with a multipart
 * upload step whose only additional-body-keys are non-boolean must not pull
 * in `multipartBoolean` — that import is gated on a boolean field actually
 * being wrapped in it, not on the multipart path alone. This runs the
 * emitter's own real `emitContractTs()` output through the repo's own Biome
 * binary with `noUnusedImports` enabled, rather than asserting on
 * substrings, so a regression that reintroduces the unused import under a
 * different guise (an aliased import, a re-export) is still caught.
 */
describe("emitContractTs — omitted-HTTP-path, multipart-step, non-boolean-only additional keys is Biome-clean", () => {
  const inputBody = { FirstName: "Reginald" };

  it("produces zero noUnusedImports diagnostics for the browser-flow-only + multipart + non-boolean-fields shape", () => {
    if (!existsSync(BIOME_BIN)) {
      throw new Error(`biome binary not found at ${BIOME_BIN} — run pnpm install`);
    }

    const source = emitContractTs({
      siteId: "test-site",
      pascal: "TestSite",
      baseUrl: "https://api.example.com",
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: { saved: true },
      gql: false,
      gqlQuery: null,
      endpointPath: "/apply/create",
      auxFiles: [],
      multiStepBody: undefined,
      omitExecuteHttp: true,
      hasMultipartStep: true,
      inputBody,
      discoveredAdditionalBodyKeys: new Map([
        ["ReferralSource", "string"],
        ["YearsOfExperience", "number"],
      ]),
    });

    expect(source).toContain("multipartJsonObject(z.record(z.string(), z.unknown()))");
    expect(source).toContain("ReferralSource: z.string(),");
    expect(source).toContain("YearsOfExperience: z.coerce.number(),");
    expect(source).not.toContain("multipartBoolean");
    expect(source).not.toContain("omitHeaderCaseInsensitive");

    const dir = mkdtempSync(join(tmpdir(), "barnacle-biome-omitted-http-path-"));
    try {
      writeFileSync(
        join(dir, "biome.json"),
        JSON.stringify({
          $schema: "https://biomejs.dev/schemas/2.3.11/schema.json",
          formatter: { enabled: false },
          assist: { enabled: false },
          linter: {
            enabled: true,
            rules: {
              recommended: false,
              correctness: { noUnusedImports: "error" },
            },
          },
        })
      );

      const file = join(dir, "contract.ts");
      writeFileSync(file, source);

      let stdout = "";
      let threw = false;
      try {
        execFileSync(BIOME_BIN, ["lint", "--config-path", dir, file], {
          cwd: dir,
          encoding: "utf8",
          stdio: "pipe",
        });
      } catch (error) {
        threw = true;
        stdout = (error as { stdout?: string }).stdout ?? "";
      }

      expect(threw, stdout).toBe(false);
      expect(stdout).not.toContain("noUnusedImports");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
