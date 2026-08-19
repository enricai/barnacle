import { describe, expect, it } from "vitest";
import { buildMultiEndpointSubmissionActionSteps } from "@/scripts/recon-generate-multiendpoint-fixture";

function pathname(url: string): string {
  return new URL(url).pathname;
}

describe("buildMultiEndpointSubmissionActionSteps", () => {
  const steps = buildMultiEndpointSubmissionActionSteps();

  it("has non-GET action captures spanning 6+ distinct URL pathnames under one host", () => {
    const nonGet = steps.filter((s) => s.capture.method !== "GET");
    expect(nonGet.length).toBeGreaterThan(0);

    const origins = new Set(nonGet.map((s) => new URL(s.capture.url).origin));
    expect(origins.size).toBe(1);

    const paths = new Set(nonGet.map((s) => pathname(s.capture.url)));
    expect(paths.size).toBeGreaterThanOrEqual(6);
  });

  it("threads the created resource id from the first response into later request URLs' bodies", () => {
    const created = steps[0];
    const createdBody = created?.capture.responseBody as { applicationId: string };
    expect(createdBody.applicationId).toBeTruthy();

    const laterSteps = steps.slice(1);
    for (const step of laterSteps) {
      expect(step.capture.requestPostData).toContain(createdBody.applicationId);
    }
  });

  it("includes two PUT validate calls with distinct request bodies", () => {
    const putSteps = steps.filter((s) => s.capture.method === "PUT");
    expect(putSteps).toHaveLength(2);
    expect(new Set(putSteps.map((s) => s.capture.requestPostData)).size).toBe(2);
    for (const step of putSteps) {
      expect(pathname(step.capture.url)).toContain("validate");
    }
  });

  it("has pairwise disjoint top-level response-body key sets across distinct endpoint paths", () => {
    const keySetByPath = new Map<string, Set<string>>();
    for (const s of steps) {
      const path = pathname(s.capture.url);
      if (keySetByPath.has(path)) continue;
      const body = s.capture.responseBody;
      const keySet = Array.isArray(body)
        ? new Set(["<array>"])
        : new Set(Object.keys(body as Record<string, unknown>));
      keySetByPath.set(path, keySet);
    }

    const keySets = [...keySetByPath.values()];
    for (let i = 0; i < keySets.length; i++) {
      for (let j = i + 1; j < keySets.length; j++) {
        const a = keySets[i];
        const b = keySets[j];
        if (!a || !b) throw new Error("unreachable");
        const intersection = [...a].filter((k) => b.has(k));
        expect(intersection).toEqual([]);
      }
    }
  });
});
