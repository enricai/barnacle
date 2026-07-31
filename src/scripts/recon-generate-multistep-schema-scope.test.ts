import { describe, expect, it } from "vitest";

import { emitContractTs, emitMultiStepExecuteHttp } from "@/scripts/recon-generate";
import { buildMulticallHeterogeneousActionSteps } from "@/scripts/recon-generate-multicall-fixture";

/** Minimal opts that satisfy the emitter for a non-multipart plugin — mirrors
 * BASE_OPTS in recon-generate.test.ts:31-43. */
const BASE_OPTS = {
  siteId: "test-site",
  pascal: "TestSite",
  baseUrl: "https://api.example.com",
  baseHeaders: { "Content-Type": "application/json" },
  minTime: 100,
  safeRps: 10,
  responseBody: { id: "abc", active: true },
  gql: false,
  gqlQuery: null,
  endpointPath: "/api/search",
  auxFiles: [],
};

/** True when `source` instructs the plugin author to narrow the client's
 * generated ResponseSchema — the emitted checklist line at
 * recon-generate.ts:2728. */
function instructsSchemaNarrowing(source: string): boolean {
  return /\[ \] Narrow \w+ResponseSchema to match the real response shape/.test(source);
}

/** True when `source` wires the (narrowable) generated ResponseSchema as the
 * SOLE validator on a client shared by every call — the single
 * `createHttpClient({ schema: ...ResponseSchema, ... })` at
 * recon-generate.ts:2692, with no per-call override threaded through. A
 * per-call override would show up as a `schema:` key on an individual
 * `httpClient(url, { ... })` call site (the runtime contract pinned by
 * per-call-response-schema-runtime-contract), which this regex does not
 * match — only the client-construction call does. */
function enforcesOneSchemaClientWide(source: string): boolean {
  return /createHttpClient\(\{\s*schema:\s*\w+ResponseSchema/.test(source);
}

describe("emitContractTs — G2 checklist/enforcement coherence (multi-call heterogeneous flow)", () => {
  const actionSteps = buildMulticallHeterogeneousActionSteps();
  const inputBody = JSON.parse(actionSteps[0]!.capture.requestPostData ?? "null") as unknown;

  const multiStepBody = emitMultiStepExecuteHttp(
    actionSteps,
    inputBody,
    { stringMessageKey: null, nestedErrorPaths: [] },
    new Map(),
    new Set(),
    new Map(),
    new Set(),
    new Map(),
    new Map(),
    "https://api.example.com",
    new Map(),
    new Map()
  );

  const source = emitContractTs({
    ...BASE_OPTS,
    inputBody,
    multiStepBody,
  });

  it("does not both instruct narrowing ResponseSchema AND enforce that same schema client-wide on every call", () => {
    // An either/or, not a hardcoded pick: the engine team may resolve G2 by
    // (a) dropping the checklist line for multi-step plugins (z.unknown() stays
    // client-wide, nothing to narrow), or (b) keeping the checklist line and
    // scoping the narrowed schema to the flow-subject call only (per-call
    // override, per-call-response-schema-runtime-contract). Either
    // satisfies this assertion; only "checklist says narrow, enforcement
    // applies that narrow schema to every call" (the reported contradiction)
    // fails it.
    const instructs = instructsSchemaNarrowing(source);
    const enforcesClientWide = enforcesOneSchemaClientWide(source);
    expect(instructs && enforcesClientWide).toBe(false);
  });

  it("tells the author the narrowed schema is the plugin's own caller contract, not a per-call gate", () => {
    // bugfix-002 makes narrowing safe (per-call override validates each call
    // independently); this pins that the wording itself says so, so an author
    // who only reads the checklist — not the implementation — doesn't
    // reintroduce the G2 footgun by assuming narrowing constrains every call.
    const checklistLine = source
      .split("\n")
      .find((line) => line.includes("[ ] Narrow TestSiteResponseSchema"));
    expect(checklistLine).toBeDefined();
    expect(checklistLine).toMatch(/executeHttp should promise ITS CALLER/);
    expect(checklistLine).toMatch(/not a per-call validator/);
    expect(checklistLine).toMatch(/already checked against its own inferred schema/);
  });

  it("following the checklist item on the multi-call fixture leaves every non-terminal call's schema untouched", () => {
    // Direct behavioral proof that the emitted instruction is safe to follow:
    // hand-substituting a narrowed client schema (exactly as the checklist
    // item instructs) does not change any individual httpClient(...) call's
    // own `schema:` override, since none of them reference
    // TestSiteResponseSchema.
    const perCallSchemaBlocks = source.match(/schema:\s*z\.[^,]+,/g) ?? [];
    expect(perCallSchemaBlocks.length).toBeGreaterThan(0);
    for (const block of perCallSchemaBlocks) {
      expect(block).not.toContain("TestSiteResponseSchema");
    }
    const narrowedSource = source.replace(
      "const TestSiteResponseSchema = z.unknown();",
      "const TestSiteResponseSchema = z.object({ verified: z.boolean() });"
    );
    const perCallSchemaBlocksAfterNarrowing = narrowedSource.match(/schema:\s*z\.[^,]+,/g) ?? [];
    expect(perCallSchemaBlocksAfterNarrowing).toEqual(perCallSchemaBlocks);
  });
});

describe("emitContractTs — single-endpoint plugin (positive control)", () => {
  const source = emitContractTs({
    ...BASE_OPTS,
    inputBody: { query: "widgets" },
  });

  it("still emits its inferred schema as the client schema, unchanged", () => {
    expect(source).toContain("const TestSiteResponseSchema = ");
    expect(source).not.toContain("TestSiteResponseSchema = z.unknown()");
    expect(enforcesOneSchemaClientWide(source)).toBe(true);
  });

  it("still emits the narrow-schema checklist item for a single-endpoint plugin", () => {
    // Single-endpoint plugins have exactly one call, so "narrow ResponseSchema"
    // and "enforce it client-wide" are consistent by construction — this test
    // pins that the (correct) single-endpoint behavior is untouched by
    // whichever multi-step resolution the engine team picks.
    expect(instructsSchemaNarrowing(source)).toBe(true);
  });
});
