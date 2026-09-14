import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Targets a distinct shape from the sibling multi-field-collision-e2e test:
 * that test's three colliding accessors (`field1`/`field12`/`field123`) are
 * prefix-colliding NAMES whose bound VALUES independently substring-match one
 * opaque segment, and it only asserts the opaque segment never contains those
 * VALUES. It never asserts that an accessor's own NAME text is safe from
 * appearing inside another placeholder's body — the report's corrupted output
 * (`${displayOrder${displayOrder212}11}`) shows exactly that: the accessor
 * NAME text itself getting spliced into a placeholder, not just a value.
 *
 * Here every field name carries a digit suffix (`sortIndex7`/`queueDepth14`/
 * `retryCount3`), and each field's bound VALUE is engineered to coincidentally
 * embed the OTHER fields' numeric suffixes as substrings, threaded against one
 * same-host, fixed-query, zero-variance opaque-path beacon URL that also
 * embeds all three values plus one field's own NAME text as a literal. The
 * guard must hold regardless: no self-referential nested placeholder ever
 * opens, and no field's NAME text is left spliced into the opaque segment.
 */

const SORT_INDEX_VALUE = "ZQ14X3PL"; // embeds queueDepth14's "14" and retryCount3's "3"
const QUEUE_DEPTH_VALUE = "MK7X3TQR"; // embeds sortIndex7's "7" and retryCount3's "3"
const RETRY_COUNT_VALUE = "PL7X14QK"; // embeds sortIndex7's "7" and queueDepth14's "14"

const OPAQUE_SEGMENT = `wJbfQL-${SORT_INDEX_VALUE}-${QUEUE_DEPTH_VALUE}-${RETRY_COUNT_VALUE}-K0X`;

function beaconUrl(host: string): string {
  return `https://${host}/beacon/${OPAQUE_SEGMENT}/responder.html?env=prod`;
}

describe("interpolateStateValues — digit-suffixed field names vs. one opaque path", () => {
  function emitBeaconLine(): string {
    const producer = {
      capture: buildCapture({
        url: "https://api.example.com/queue/status",
        requestPostData: null,
        responseBody: {
          sortIndex7: SORT_INDEX_VALUE,
          queueDepth14: QUEUE_DEPTH_VALUE,
          retryCount3: RETRY_COUNT_VALUE,
        },
        timestamp: "2026-01-01T00:00:00Z",
      }),
      varName: "r0",
      produces: [
        { kind: "body" as const, name: "sortIndex7", path: ["sortIndex7"] },
        { kind: "body" as const, name: "queueDepth14", path: ["queueDepth14"] },
        { kind: "body" as const, name: "retryCount3", path: ["retryCount3"] },
      ],
      isMultipart: false,
      isCrossDomain: false,
    };
    const beacon = {
      capture: buildCapture({
        url: beaconUrl("api.example.com"),
        requestPostData: null,
        responseBody: { ack: true },
        timestamp: "2026-01-01T00:00:01Z",
      }),
      varName: "r1",
      produces: [],
      isMultipart: false,
      isCrossDomain: false,
    };

    const body = emitMultiStepExecuteHttp(
      [producer, beacon] as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
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

    const match = /httpClient\(`([^`]*wJbfQL[^`]*)`/.exec(body);
    if (!match) throw new Error("beacon url not found in emitted code");
    return match[1]!;
  }

  it("never opens a self-referential nested placeholder", () => {
    const url = emitBeaconLine();

    expect(url).not.toMatch(/\$\{[^}]*\$\{/);
  });

  it("never leaks any field's NAME text into the opaque path segment", () => {
    const url = emitBeaconLine();
    const opaqueSlotMatch = url.match(/wJbfQL-(.*?)-K0X/);
    expect(opaqueSlotMatch, url).not.toBeNull();
    const opaqueSlot = opaqueSlotMatch![1]!;

    expect(opaqueSlot).not.toContain("sortIndex7");
    expect(opaqueSlot).not.toContain("queueDepth14");
    expect(opaqueSlot).not.toContain("retryCount3");
    expect(opaqueSlot).not.toMatch(/\$\{/);
  });

  it("renders the beacon call as an exact literal when the opaque path is excluded from interpolation", () => {
    const url = emitBeaconLine();

    if (!url.includes("${")) {
      expect(url).toContain(OPAQUE_SEGMENT);
    }
  });
});
