/**
 * Eliminates the duplicated offline schema-parity scaffold that every contract
 * parity test repeats: build canonical payload → assert safeParse succeeds →
 * assert each rejection case (omission, enum violation, etc.) fails with an
 * issue on the expected path. Mirrors the shape of defineReplayIntegrationSuite
 * so adding a parity guard for a new site is a one-call drop-in.
 */

import { describe, expect, it } from "vitest";

import type { SitePluginMeta } from "@/site-plugin";

/** One case that must be rejected by the plugin's bodySchema. */
export interface ParityRejectionCase {
  /** Human-readable label for the `it` test title. */
  name: string;
  /**
   * Transforms the canonical payload into the invalid variant.
   * The function receives a shallow copy — mutating it in place is safe.
   */
  mutate: (payload: Record<string, unknown>) => Record<string, unknown>;
  /**
   * When provided, the test asserts that at least one Zod issue has a `path`
   * that includes this element (string or index). Omit when the rejection
   * is asserted solely by `result.success === false`.
   */
  expectIssuePath?: (string | number)[];
}

/**
 * Options for `defineContractParitySuite`. Accepting `{ meta: SitePluginMeta }`
 * rather than the generic `SitePlugin<TPayload, TResult>` sidesteps contravariance
 * on `execute(payload: TPayload, …)` — the helper only reads `plugin.meta.bodySchema`.
 */
export interface ContractParitySuiteOptions {
  /** Human-readable suite name, passed to `describe`. */
  suiteName: string;
  /** The plugin under test — only `meta.bodySchema` is accessed. */
  plugin: { meta: SitePluginMeta };
  /**
   * Returns the canonical, fully-valid payload for the plugin. Called once per
   * test case so each case receives a fresh object.
   */
  buildPayload: () => Record<string, unknown>;
  /**
   * Cases that must be rejected by `plugin.meta.bodySchema.safeParse`. Each
   * receives a shallow copy of the canonical payload; the `mutate` function
   * introduces exactly one invalid state (field omission, enum violation, etc.).
   */
  rejectionCases: ParityRejectionCase[];
}

/**
 * Defines an offline schema-parity suite. Runs unconditionally — no
 * INTEGRATION environment variable needed. The suite has one accept case and
 * one `it` per rejection case.
 */
export function defineContractParitySuite(opts: ContractParitySuiteOptions): void {
  const { suiteName, plugin, buildPayload, rejectionCases } = opts;
  const schema = plugin.meta.bodySchema;

  describe(suiteName, () => {
    it("accepts the canonical payload", () => {
      const result = schema.safeParse(buildPayload());
      expect(
        result.success,
        result.success ? "" : JSON.stringify((result as { error: unknown }).error)
      ).toBe(true);
    });

    for (const rc of rejectionCases) {
      it(`rejects: ${rc.name}`, () => {
        const mutated = rc.mutate({ ...buildPayload() });
        const result = schema.safeParse(mutated);
        expect(result.success).toBe(false);
        if (!result.success && rc.expectIssuePath !== undefined) {
          const path = rc.expectIssuePath;
          const hit = result.error.issues.find((issue) =>
            path.every((segment) => issue.path.includes(segment))
          );
          expect(
            hit,
            `expected an issue whose path includes ${JSON.stringify(path)}, got: ${JSON.stringify(result.error.issues.map((i) => i.path))}`
          ).toBeDefined();
        }
      });
    }
  });
}
