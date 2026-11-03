import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  dir: "",
  onCapture: undefined as undefined | ((c: never, f: string) => void),
}));

vi.mock("@/scripts/recon-shared", async (orig) => ({
  ...(await orig<typeof import("@/scripts/recon-shared")>()),
  resolveReconRunDir: () => ({ graphqlDir: hoisted.dir }),
}));
vi.mock("@/scraper/flow-runner", async (orig) => ({
  ...(await orig<typeof import("@/scraper/flow-runner")>()),
  wireSignalCapture: (_p: unknown, params: { onCapture: (c: never, f: string) => void }) => {
    hoisted.onCapture = params.onCapture;
    return () => {};
  },
}));

import { wireNetworkCapture } from "@/scripts/recon-browser";

describe("wireNetworkCapture onCapture", () => {
  beforeEach(() => {
    hoisted.dir = mkdtempSync(join(tmpdir(), "wnc-"));
  });
  afterEach(() => rmSync(hoisted.dir, { recursive: true, force: true }));

  it("persists capture and decoded sidecar via the callback", () => {
    wireNetworkCapture(
      {} as never,
      { n: 0 },
      { n: 0 },
      [],
      [],
      () => "p",
      () => "o"
    );
    hoisted.onCapture?.(
      { url: "https://x/", decodedParams: "a=1", requestPostData: "a%3D1" } as never,
      "0001.json"
    );
    expect(readdirSync(hoisted.dir).sort()).toEqual(["0001.decoded.txt", "0001.json"]);
  });

  it("swallows write failures instead of throwing", () => {
    wireNetworkCapture(
      {} as never,
      { n: 0 },
      { n: 0 },
      [],
      [],
      () => "p",
      () => "o"
    );
    rmSync(hoisted.dir, { recursive: true, force: true });
    hoisted.dir = "/proc/nonexistent/x";
    expect(() => hoisted.onCapture?.({ url: "https://x/" } as never, "0001.json")).not.toThrow();
  });
});
