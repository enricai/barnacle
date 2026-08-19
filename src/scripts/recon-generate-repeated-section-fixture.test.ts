import { describe, expect, it } from "vitest";
import { buildRepeatedSectionSubmissionCaptures } from "@/scripts/recon-generate-repeated-section-fixture";

function pathname(url: string): string {
  return new URL(url).pathname;
}

describe("buildRepeatedSectionSubmissionCaptures", () => {
  const captures = buildRepeatedSectionSubmissionCaptures();

  it("mints a record id in the first call's response body via POST", () => {
    const created = captures[0];
    expect(created?.method).toBe("POST");
    const createdBody = created?.responseBody as { applicationId: string };
    expect(createdBody.applicationId).toBeTruthy();
  });

  it("threads the created id into 5+ later calls' URL PATH segments", () => {
    const created = captures[0];
    const createdBody = created?.responseBody as { applicationId: string };
    const laterWithIdInPath = captures
      .slice(1)
      .filter((c) => pathname(c.url).includes(createdBody.applicationId));
    expect(laterWithIdInPath.length).toBeGreaterThanOrEqual(5);
  });

  it("hits at least one leaf path 3+ times with distinct request bodies", () => {
    const byPath = new Map<string, string[]>();
    for (const c of captures) {
      const path = pathname(c.url);
      const bodies = byPath.get(path) ?? [];
      bodies.push(c.requestPostData ?? "");
      byPath.set(path, bodies);
    }

    const repeatedLeaf = [...byPath.values()].find((bodies) => bodies.length >= 3);
    expect(repeatedLeaf).toBeDefined();
    expect(new Set(repeatedLeaf).size).toBe(repeatedLeaf?.length);
  });

  it("shares one host and uses only POST/PUT methods", () => {
    const origins = new Set(captures.map((c) => new URL(c.url).origin));
    expect(origins.size).toBe(1);

    for (const c of captures) {
      expect(["POST", "PUT"]).toContain(c.method);
    }
  });
});
