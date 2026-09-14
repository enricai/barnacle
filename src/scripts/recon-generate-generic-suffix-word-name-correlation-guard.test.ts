import { describe, expect, it } from "vitest";
import { compileActionSteps, indexStateValues } from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * `keyNamesCorrelate`'s camelCase word-overlap check treats ANY shared word
 * ≥3 chars as proof of correlation. A GENERIC naming suffix/prefix like
 * `date`/`name`/`email` is shared by semantically OPPOSITE fields —
 * `startDate`/`endDate`, `firstName`/`lastName` — so a bare word-overlap
 * check would wrongly correlate them whenever both sides also carry a
 * differing, more specific word (`start` vs `end`, `first` vs `last`),
 * reintroducing the exact name-uncorrelated value-coincidence bug class the
 * correlation gate exists to block.
 */
const ENTRY_URL = "https://api.example.com/reservation";
const CONFIRM_URL = "https://api.example.com/reservation/confirm";

function buildGenericSuffixCaptures() {
  const entry = buildCapture({
    url: ENTRY_URL,
    requestPostData: '{"query":"single-day"}',
    // The response carries only `startDate` — its later re-appearance under
    // the differently-named `endDate` request field is a coincidence (a
    // single-day booking where both dates are equal), never a real thread.
    responseBody: { startDate: "2026-03-01" },
    timestamp: "2026-01-01T00:00:00Z",
  });
  const confirm = buildCapture({
    url: CONFIRM_URL,
    requestPostData: '{"endDate":"2026-03-01"}',
    responseBody: { ok: true },
    timestamp: "2026-01-01T00:00:01Z",
  });
  return [entry, confirm];
}

describe("keyNamesCorrelate — a shared generic naming suffix must not false-correlate opposite fields", () => {
  it("never produces startDate on the strength of a differently-named endDate consumer sharing only the generic 'date' word", () => {
    const captures = buildGenericSuffixCaptures();
    const actionCaptures = captures.map((capture, index) => ({ capture, index }));
    const stateIndex = indexStateValues(captures);
    const actionSteps = compileActionSteps(actionCaptures, stateIndex);

    const entryStep = actionSteps.find((step) => step.capture.url === captures[0]!.url);
    const startDateProduce = entryStep?.produces.find(
      (p) => p.kind === "body" && p.path.at(-1) === "startDate"
    );

    // Pre-fix, `keyNamesCorrelate("startDate", "endDate")` returned true
    // (both share the generic word "date"), so the pre-scan would have
    // marked "2026-03-01" as used and produced startDate here.
    expect(startDateProduce).toBeUndefined();
  });
});
