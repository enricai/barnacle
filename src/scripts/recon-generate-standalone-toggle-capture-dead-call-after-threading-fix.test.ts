import { describe, expect, it } from "vitest";
import {
  compileActionSteps,
  emitMultiStepExecuteHttp,
  indexStateValues,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Follow-up to the report's "Minor residual" note: once value-coincidence
 * threading only splices a field when its own name correlates with the
 * target (see recon-generate-1-12-50-auxiliary-toggle-capture-boolean-
 * threading-guard-e2e.test.ts, already green — bugfix-004's investigation
 * found nothing left to patch there), a standalone feature-toggle-shaped
 * capture whose fields have no name-correlated consumer is emitted as a
 * single, unbound `httpClient` call — never as a fold target, never bound to
 * a variable, never spliced into an unrelated field. Confirmed here directly
 * against `compileActionSteps`/`emitMultiStepExecuteHttp`.
 *
 * This is deliberately NOT pruned further (i.e. dropped from emission
 * entirely) by this subtask. The generator's job is to faithfully replay
 * the site's own observed HTTP call sequence, not just the subset whose
 * response is read afterward — a captured call can be load-bearing for
 * reasons the generator cannot see from response-field usage alone (e.g. a
 * server-side session/cookie side effect, rate-limit/bot-fingerprint
 * bookkeeping, or an A/B cohort assignment the real site's later requests
 * depend on being called even if the reply itself is unread). There is no
 * existing mechanism anywhere in this file that drops a structurally
 * legitimate, non-isolated capture purely because its response fields go
 * unread, and the sibling e2e test above already hard-asserts (as a
 * non-vacuity check) that this exact shape of call must survive into the
 * emitted contract. Introducing a new drop-if-unread rule would be a
 * speculative behavior change with no evidence it matches real site
 * requirements — exactly what the report flagged this residual as
 * ("Worth another look ... ", not a confirmed defect). Confirmed: no code
 * change.
 */

const SEARCH_URL = "https://api.example.com/catalog/search/";
const TOGGLE_URL = "https://api.example.com/config/feature-toggles/";
const DETAIL_URL = "https://api.example.com/catalog/item-detail/";

function buildFixtureCaptures(): ReturnType<typeof buildCapture>[] {
  return [
    buildCapture({
      url: SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: { itemId: "item-a" },
      timestamp: "2024-11-15T00:00:00Z",
    }),
    // Standalone, out-of-loop feature-toggle-shaped capture whose own field
    // names have nothing to do with anything downstream references.
    buildCapture({
      url: TOGGLE_URL,
      requestPostData: "[]",
      responseBody: { specialOfferRefactor: true, homepageLocaleStorage: false },
      timestamp: "2024-11-15T00:00:00.5Z",
    }),
    buildCapture({
      url: DETAIL_URL,
      requestPostData: '{"itemId":"item-a"}',
      responseBody: { detailToken: "detail-token-item-a" },
      timestamp: "2024-11-15T00:00:01Z",
    }),
  ];
}

describe("recon-generate standalone toggle-shaped capture — dead call after value-coincidence threading fix", () => {
  it("emits the toggle call exactly once, unbound, with its response fields never spliced anywhere", () => {
    const captures = buildFixtureCaptures();
    const inputBody = JSON.parse(captures[0]!.requestPostData ?? "null") as unknown;
    const actionCaptures = captures.map((capture, index) => ({ capture, index }));
    const stateIndex = indexStateValues(captures);
    const actionSteps = compileActionSteps(actionCaptures as never, stateIndex);

    const body = emitMultiStepExecuteHttp(
      actionSteps as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
      inputBody,
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

    // Emitted exactly once, as an ordinary standalone step.
    const toggleCallCount = (body.match(/config\/feature-toggles\//g) ?? []).length;
    expect(toggleCallCount).toBe(1);

    // Left unbound — nothing downstream reads its response, so the same
    // referencedNames-gated bind suppression emitMultiStepExecuteHttp
    // already applies elsewhere leaves it a bare `await httpClient(...)`.
    expect(body).toMatch(/await httpClient\(`\$\{payload\.BaseUrl\}\/config\/feature-toggles\/`/);
    expect(body).not.toMatch(
      /const \w+ = \(await httpClient\(`\$\{payload\.BaseUrl\}\/config\/feature-toggles\/`/
    );

    // Its own field names never leak into any interpolation anywhere in the
    // emitted body (they're expected to still appear inside the inferred
    // response schema for the toggle call itself — that's a declaration,
    // not a splice) — confirming zero fields are consumed, dead or
    // otherwise, by any other call.
    expect(body).not.toMatch(/\$\{[^}]*specialOfferRefactor[^}]*\}/);
    expect(body).not.toMatch(/\$\{[^}]*homepageLocaleStorage[^}]*\}/);

    // The genuine drill call is unaffected.
    expect(body).toMatch(/catalog\/item-detail\//);
  });
});
