import { describe, expect, it } from "vitest";

import { buildContractChecklist, emitContractTs } from "@/scripts/recon-generate";

/** Minimal opts that satisfy the emitter for a non-multipart plugin. */
const BASE_OPTS = {
  siteId: "test-site",
  pascal: "TestSite",
  baseUrl: "https://example.com",
  baseHeaders: { "Content-Type": "application/json" },
  minTime: 100,
  safeRps: 10,
  responseBody: { id: "abc", active: true },
  gql: false,
  gqlQuery: null,
  endpointPath: "/api/search",
  auxFiles: [],
};

describe("emitContractTs — review checklist is not embedded in the shipped file", () => {
  const source = emitContractTs(BASE_OPTS);

  it("does not contain the 'Checklist:' marker", () => {
    expect(source).not.toContain("Checklist:");
  });

  it("does not contain checkbox markers", () => {
    expect(source).not.toContain("[ ]");
  });

  it("does not contain the already-satisfied 'pnpm add bottleneck zod' reminder", () => {
    expect(source).not.toContain("pnpm add bottleneck zod");
  });
});

describe("buildContractChecklist — surfaces the same review items via a non-shipped channel", () => {
  const checklist = buildContractChecklist(BASE_OPTS);

  it("returns the out-of-tree pnpm add reminder", () => {
    expect(checklist).toContain(
      "Out-of-tree: `pnpm add bottleneck zod` — this file imports both directly, and a strict node_modules layout (pnpm) won't resolve them as transitive deps of @enricai/barnacle alone"
    );
  });

  it("returns the schema-narrowing reminder", () => {
    expect(checklist.some((line) => line.startsWith("Narrow TestSiteResponseSchema"))).toBe(true);
  });

  it("shares the exact same items emitContractTs's header used to embed, keyed off the same opts", () => {
    const shippedSource = emitContractTs(BASE_OPTS);
    for (const item of checklist) {
      expect(shippedSource).not.toContain(item);
    }
  });
});
