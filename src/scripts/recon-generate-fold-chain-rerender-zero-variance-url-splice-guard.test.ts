import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * The Pass-1 per-step render already bypasses interpolation for a capture
 * proven request-invariant by {@link isZeroVarianceRepeatCapture}
 * (recon-generate.ts L5372-5377). A fold/drill target's own chain re-render
 * (`parameterize(chainRendered.url, ...)`, recon-generate.ts L5906-5917)
 * starts from that already-rendered literal and re-runs
 * `substituteThreadedValues` over it a SECOND time, without re-checking the
 * same invariant — so a per-item join field whose value coincidentally
 * overlaps a byte of the beacon's opaque path still splices in on this
 * second pass, even though Pass 1 already proved the URL fixed.
 *
 * This fixture's beacon fires twice with an identical opaque path and only
 * its query's nonce varying (`clientId`/`siteId` fixed) — a shape that, if
 * routed through ordinary chain-param substitution instead of the
 * zero-variance bypass, ALSO trips `assertNoFrozenVaryingDrillParams` (no
 * threaded field explains the varying nonce), so any regression here fails
 * loudly rather than merely splicing.
 */
function emitFoldBeaconUrl(): string {
  const search = {
    capture: buildCapture({
      url: "https://api.example.com/catalog/search/",
      requestPostData: '{"page":1}',
      responseBody: {
        results: [
          { sku: "item-a", tag: "g0" },
          { sku: "item-b", tag: "g1" },
        ],
      },
      timestamp: "2026-01-01T00:00:01Z",
    }),
    varName: "r1",
    produces: [],
    isMultipart: false,
    isCrossDomain: false,
  };
  // The beacon's own opaque path segment ("item-a") coincidentally equals
  // the first fold item's `sku` — the exact splice temptation Pass 1's
  // bypass already defeats on the flat path.
  const drill = {
    capture: buildCapture({
      url: "https://api.example.com/beacon/item-a/verify?clientId=abc123&siteId=xyz&nonce=1",
      requestPostData: null,
      method: "GET",
      responseBody: {},
      timestamp: "2026-01-01T00:00:02Z",
    }),
    varName: "r2",
    produces: [],
    isMultipart: false,
    isCrossDomain: false,
  };
  // A second occurrence of the SAME opaque path (only the nonce query key
  // varies) — proof, via isZeroVarianceRepeatCapture's own two-occurrence +
  // fixed-key requirement, that the endpoint is request-invariant rather
  // than a single-shot capture that merely happens not to vary yet.
  const beaconRepeat = {
    capture: buildCapture({
      url: "https://api.example.com/beacon/item-a/verify?clientId=abc123&siteId=xyz&nonce=2",
      requestPostData: null,
      method: "GET",
      responseBody: {},
      timestamp: "2026-01-01T00:00:03Z",
    }),
    varName: "r3",
    produces: [],
    isMultipart: false,
    isCrossDomain: false,
  };

  const body = emitMultiStepExecuteHttp(
    [search, drill, beaconRepeat] as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
    null,
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

  const match = /httpClient\(`([^`]*beacon[^`]*)`/.exec(body);
  if (!match) throw new Error("fold chain beacon url not found in emitted code");
  return match[1]!;
}

describe("fold chain re-render — zero-variance-repeat URL splice guard", () => {
  it("emits the beacon's exact literal URL with zero interpolation", () => {
    const url = emitFoldBeaconUrl();

    expect(url).toBe(
      "https://api.example.com/beacon/item-a/verify?clientId=abc123&siteId=xyz&nonce=1"
    );
  });

  it("never opens an invalidly-nested placeholder", () => {
    const url = emitFoldBeaconUrl();

    expect(url).not.toMatch(/\$\{[^}]*\$\{/);
    expect(url).not.toContain("${");
  });
});
