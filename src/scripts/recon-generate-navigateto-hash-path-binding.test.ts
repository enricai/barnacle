import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const { warn, info } = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));
vi.mock("@/lib/logging", async (orig) => {
  const mod = await orig<typeof import("@/lib/logging")>();
  const stub = { warn, info, error: vi.fn(), debug: vi.fn(), child: () => stub };
  return { ...mod, getScriptLogger: () => stub };
});

import { deriveGetInputModel } from "@/scripts/recon-generate";

const capture = (url: string) =>
  buildCapture({
    url,
    requestPostData: null,
    responseBody: { ok: 1 },
    timestamp: "2024-02-01T00:00:00Z",
    method: "GET",
  });

describe("deriveGetInputModel — payload-hint path binding", () => {
  beforeEach(() => {
    warn.mockClear();
    info.mockClear();
  });
  const url = "https://shop.example.test/items/AB12/CD34.data.json";

  it("binds the parts of a composite hash value to their segments", () => {
    const w = capture(url);
    const m = deriveGetInputModel(w, [w], [], [{ field: "itemRef", value: "CD34_AB12" }]);
    expect(m?.pathVars).toEqual([
      { field: "itemRefPart1", segmentIndex: 3, queryKey: "", suffix: ".data.json" },
      { field: "itemRefPart2", segmentIndex: 2, queryKey: "" },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("binds a whole-value hint to the matching segment", () => {
    const w = capture(url);
    const m = deriveGetInputModel(w, [w], [], [{ field: "itemId", value: "AB12" }]);
    expect(m?.pathVars).toEqual([{ field: "itemId", segmentIndex: 2, queryKey: "" }]);
  });

  it("logs when a hash value matches no segment", () => {
    const w = capture(url);
    deriveGetInputModel(w, [w], [], [{ field: "itemRef", value: "ZZ99_YY88" }]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not bind payload field "itemRef"')
    );
  });
});
