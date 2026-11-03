import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REQUEST_BODY_UNAVAILABLE } from "@/scraper/request-body-marker";

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

import {
  formatBodyUnavailableWarning,
  getBodyUnavailableCount,
  wireNetworkCapture,
} from "@/scripts/recon-browser";

describe("recon-browser unavailable-body accounting", () => {
  let tmp: string;
  const orig = process.env.RECON_OUT_DIR;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "recon-browser-body-"));
    process.env.RECON_OUT_DIR = tmp;
  });
  afterEach(() => {
    if (orig === undefined) delete process.env.RECON_OUT_DIR;
    else process.env.RECON_OUT_DIR = orig;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("formatBodyUnavailableWarning is null for 0 and names the count otherwise", () => {
    expect(formatBodyUnavailableWarning(0)).toBeNull();
    const w = formatBodyUnavailableWarning(3);
    expect(w).toContain("3 capture(s)");
    expect(w).toContain(REQUEST_BODY_UNAVAILABLE);
  });

  it("onCapture counts only marker-body captures", () => {
    wireNetworkCapture(
      {} as never,
      { n: 0 },
      { n: 0 },
      [],
      [],
      () => "p",
      () => "https://x.test"
    );
    expect(hooks.onCapture).not.toBeNull();
    const before = getBodyUnavailableCount();
    const base = {
      decodedParams: null,
      url: "https://x.test/a",
      method: "POST",
    };
    hooks.onCapture!({ ...base, requestPostData: "{}" }, "001.json");
    expect(getBodyUnavailableCount()).toBe(before);
    hooks.onCapture!({ ...base, requestPostData: REQUEST_BODY_UNAVAILABLE }, "002.json");
    expect(getBodyUnavailableCount()).toBe(before + 1);
  });
});
