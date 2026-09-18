import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Targets `replaceGuardedAgainstExistingPlaceholders`'s protected-span guard
 * (recon-generate.ts ~4557-4573) against an ALREADY-nested `${a${b}c}` span
 * that predates this pass — e.g. an opaque analytics/beacon path that a
 * site's own backend has, for whatever reason, echoed back containing raw
 * `${...}` template syntax from an unrelated internal system. Before the
 * brace-depth `findBalancedPlaceholderSpans` fix, the protected-span regex
 * (`/\$\{[^{}]*\}/`) could only see the INNERMOST `${...}` of such a span
 * (here, a literal `${queueDepth14}` fragment) and left the OUTER wrapper's
 * flanking text — including another field's own NAME text, `retryCount3` —
 * unprotected, so a same-pass value coincidentally equal to that flanking
 * NAME text still got spliced in, widening the pre-existing nesting instead
 * of leaving the inert span alone (the report's own corrupted-output shape,
 * `${displayOrder${displayOrder212}11}`, is exactly this: an untouchable
 * span's own flanking text getting spliced into a new placeholder). The
 * fixed brace-depth scan reports the whole `${sortIndex7${queueDepth14}
 * retryCount3}` run as ONE span, so the coincidental value match on
 * `retryCount3` is correctly skipped and the span is left byte-for-byte
 * untouched.
 */

const QUEUE_DEPTH_VALUE = "MK7X3TQR";
// `statusLabel`'s bound VALUE deliberately equals `retryCount3` — another
// field's NAME text, not its value — reproducing the report's distinction
// between a value-substring collision and a NAME-text collision.
const STATUS_LABEL_VALUE = "retryCount3";

// A same-host, fixed-query beacon whose opaque path segment already
// contains, as raw literal data, a doubly-nested `${...}` run: outer text
// "sortIndex7", an inner `${queueDepth14}` literal, then outer text
// "retryCount3" — never produced by this generator, just pre-existing
// characters in the captured URL.
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal pre-existing "${...}" bytes captured from generator output, not a template literal
const OPAQUE_SEGMENT = "wJbfQL-${sortIndex7${queueDepth14}retryCount3}-K0X";

function beaconUrl(host: string): string {
  return `https://${host}/beacon/${OPAQUE_SEGMENT}/responder.html?env=prod`;
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: test title documents literal "${a${b}c}" nesting syntax, not a template literal
describe("replaceGuardedAgainstExistingPlaceholders — pre-existing nested ${a${b}c} span vs. a coincidental NAME-text value match", () => {
  function emitBeaconLine(): string {
    const producer = {
      capture: buildCapture({
        url: "https://api.example.com/queue/status",
        requestPostData: null,
        responseBody: {
          queueDepth14: QUEUE_DEPTH_VALUE,
          statusLabel: STATUS_LABEL_VALUE,
        },
        timestamp: "2026-01-01T00:00:00Z",
      }),
      varName: "r0",
      produces: [
        { kind: "body" as const, name: "queueDepth14", path: ["queueDepth14"] },
        { kind: "body" as const, name: "statusLabel", path: ["statusLabel"] },
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

  it("never widens the pre-existing nested span with a further placeholder", () => {
    const url = emitBeaconLine();
    const opaqueSlotMatch = url.match(/wJbfQL-(.*?)-K0X/);
    expect(opaqueSlotMatch, url).not.toBeNull();
    const opaqueSlot = opaqueSlotMatch![1]!;

    // The bug: `retryCount3` (another field's NAME text, left unprotected by
    // the old regex) gets spliced into `${statusLabel}`, producing a THIRD
    // brace level nested inside the pre-existing span.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting on literal "${statusLabel}" bytes captured from generator output, not a template literal
    expect(opaqueSlot).not.toContain("${statusLabel}");

    // The pre-existing nested span itself must survive completely
    // untouched — never widened, narrowed, or otherwise rewritten.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting on literal "${...}" bytes captured from generator output, not a template literal
    expect(opaqueSlot).toBe("${sortIndex7${queueDepth14}retryCount3}");
  });
});
