import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type OnCapture = (capture: Record<string, unknown>, filename: string) => void;
const { hooks } = vi.hoisted(() => ({
  hooks: { onCapture: null as null | OnCapture },
}));

vi.mock("@/scraper/flow-runner", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    wireSignalCapture: (_page: unknown, params: { onCapture?: OnCapture }) => {
      hooks.onCapture = params.onCapture ?? null;
      return () => {};
    },
  };
});

import { flowHasSubmitSemantics } from "@/scraper/flow-runner";
import { createDeclaredCallTracker, wireNetworkCapture } from "@/scripts/recon-browser";

describe("recon-browser wireNetworkCapture feeds the declared-call tracker", () => {
  let tmp: string;
  const orig = process.env.RECON_OUT_DIR;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "recon-browser-declared-"));
    process.env.RECON_OUT_DIR = tmp;
  });
  afterEach(() => {
    if (orig === undefined) delete process.env.RECON_OUT_DIR;
    else process.env.RECON_OUT_DIR = orig;
    rmSync(tmp, { recursive: true, force: true });
  });

  const run = (body: string) => {
    const tracker = createDeclaredCallTracker("/graphql", null);
    wireNetworkCapture(
      {} as never,
      { n: 0 },
      { n: 0 },
      [],
      [],
      () => "p",
      () => "https://x.test",
      undefined,
      tracker
    );
    hooks.onCapture?.(
      {
        method: "POST",
        url: "https://x.test/graphql",
        status: 200,
        requestPostData: body,
      },
      "c.json"
    );
    return flowHasSubmitSemantics({
      steps: ["Click Continue", "Click Next"],
      submitEndpointPattern: "/graphql",
      declaredCallIsRead: tracker.isRead(),
    } as unknown as Parameters<typeof flowHasSubmitSemantics>[0]);
  };

  it("query capture arriving via onCapture skips the final-step submit judge", () => {
    expect(run(JSON.stringify({ query: "query Q { a }" }))).toBe(false);
  });
  it("mutation capture arriving via onCapture keeps submit semantics", () => {
    expect(run(JSON.stringify({ query: "mutation M { b }" }))).toBe(true);
  });
});
