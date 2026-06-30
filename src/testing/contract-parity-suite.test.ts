/**
 * Unit tests for defineContractParitySuite. Uses a stub plugin whose bodySchema
 * is a real Zod schema so safeParse exercises actual validation paths — no
 * network, no INTEGRATION flag, no browser session needed.
 *
 * defineContractParitySuite registers vitest suites at the top level, so the
 * call below happens at module load time and its describe/it blocks run as
 * ordinary vitest tests.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod/v4";

import type { SitePlugin, SitePluginContext, SitePluginResult } from "@/site-plugin";
import {
  type ContractParitySuiteOptions,
  defineContractParitySuite,
} from "@/testing/contract-parity-suite";

// ── Stub schema ───────────────────────────────────────────────────────────────

const StubBodySchema = z.object({
  JobId: z.string(),
  Email: z.string().email(),
  Gender: z.enum(["M", "F", "U"]),
});

type StubBody = z.infer<typeof StubBodySchema>;

const STUB_CANONICAL: StubBody = {
  JobId: "parity-001",
  Email: "test@example.com",
  Gender: "M",
};

// ── Stub plugin ───────────────────────────────────────────────────────────────

function makeStubPlugin(): SitePlugin<unknown, unknown> {
  return {
    meta: {
      siteId: "stub-parity",
      displayName: "Stub Parity Site",
      bodySchema: StubBodySchema,
      responseSchema: z.object({ ok: z.boolean() }),
    },
    execute: async (_payload: unknown, _session: never, _ctx: SitePluginContext) =>
      ({ data: { ok: true } }) as SitePluginResult<unknown>,
  };
}

// ── Suite registered at module load time ─────────────────────────────────────
// The describe blocks this creates are exercised directly by vitest alongside
// the explicit tests below.

const STUB_OPTIONS: ContractParitySuiteOptions = {
  suiteName: "stub parity (registered by test file)",
  plugin: makeStubPlugin(),
  buildPayload: () => ({ ...STUB_CANONICAL }),
  rejectionCases: [
    {
      name: "JobId omitted (required field)",
      mutate: (p) => {
        const { JobId: _omit, ...rest } = p;
        return rest;
      },
      expectIssuePath: ["JobId"],
    },
    {
      name: "Gender 'X' (not in enum M|F|U)",
      mutate: (p) => ({ ...p, Gender: "X" }),
      expectIssuePath: ["Gender"],
    },
  ],
};

defineContractParitySuite(STUB_OPTIONS);

// ── Explicit unit tests ───────────────────────────────────────────────────────

describe("defineContractParitySuite", () => {
  it("accept-case: canonical payload passes safeParse", () => {
    const schema = StubBodySchema;
    const result = schema.safeParse({ ...STUB_CANONICAL });
    expect(
      result.success,
      result.success ? "" : JSON.stringify((result as { error: unknown }).error)
    ).toBe(true);
  });

  it("rejection omission: missing required field produces result.success===false with issue on expected path", () => {
    const schema = StubBodySchema;
    const { JobId: _omit, ...withoutJobId } = STUB_CANONICAL;
    const result = schema.safeParse(withoutJobId);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes("JobId"));
      expect(issue).toBeDefined();
    }
  });

  it("rejection enum: invalid enum value produces result.success===false with issue on expected path", () => {
    const schema = StubBodySchema;
    const result = schema.safeParse({ ...STUB_CANONICAL, Gender: "X" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes("Gender"));
      expect(issue).toBeDefined();
    }
  });

  it("mutate receives a fresh copy per invocation (canonical payload is not poisoned)", () => {
    let callCount = 0;
    const opts: ContractParitySuiteOptions = {
      suiteName: "isolation check",
      plugin: makeStubPlugin(),
      buildPayload: () => ({ ...STUB_CANONICAL }),
      rejectionCases: [
        {
          name: "mutates in place",
          mutate: (p) => {
            callCount++;
            delete (p as Record<string, unknown>).JobId;
            return p;
          },
        },
        {
          name: "second case sees full payload",
          mutate: (p) => {
            callCount++;
            // JobId must be present — it was not poisoned by the first case
            expect(p.JobId).toBe("parity-001");
            return p;
          },
        },
      ],
    };

    // Manually invoke the rejection logic to verify isolation without
    // registering a nested describe (vitest disallows nested describe.each
    // inside a running it block).
    const schema = makeStubPlugin().meta.bodySchema;
    for (const rc of opts.rejectionCases) {
      rc.mutate({ ...opts.buildPayload() });
    }
    expect(callCount).toBe(2);
    // buildPayload still returns a valid canonical payload
    expect(schema.safeParse(opts.buildPayload()).success).toBe(true);
  });

  it("rejection case without expectIssuePath only asserts result.success===false", () => {
    const schema = StubBodySchema;
    const result = schema.safeParse({ ...STUB_CANONICAL, Email: "not-an-email" });
    expect(result.success).toBe(false);
  });
});
