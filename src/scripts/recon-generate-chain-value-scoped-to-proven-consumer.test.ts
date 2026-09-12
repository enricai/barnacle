import { describe, expect, it } from "vitest";
import {
  compileActionSteps,
  emitMultiStepExecuteHttp,
  type FoldReturnSpec,
  indexStateValues,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Reproduces the report's authenticator-URL defect at the layer it actually
 * lives: a genuinely threaded, SHORT value (`sessionCode`, only 2 characters
 * — well under MIN_STATE_VALUE_LENGTH) that `indexStateValues`' chain/force-
 * include exemption lets into the state index, PROVEN threaded ONLY between
 * the login step and the confirm step that actually echoes it back. A third,
 * wholly unrelated capture — a same-host authenticator/sensor call with an
 * opaque path — happens to carry the SAME digits as a standalone,
 * slash-delimited path segment. Its own request/response carry no
 * relationship to `sessionCode` at all.
 *
 * Before this fix, `indexStateValues`' exemption bypassed
 * `MIN_STATE_VALUE_LENGTH` globally: once "77" qualified for the index via
 * the login->confirm relationship, `compileActionSteps`' pre-scan treated
 * ANY capture whose URL/body/headers happened to contain "77" as a genuine
 * consumer — including the authenticator, which the chain detector never
 * proved any relationship with — so `interpolateStateValues` spliced
 * `${sessionCode}` into its opaque path.
 *
 * Flat (non-array) response bodies throughout, deliberately: this pins the
 * PLAIN per-step URL render path (`emitMultiStepExecuteHttp`'s Pass 1 /
 * `interpolateStateValues`), not the fold/drill per-item pass, which already
 * has its own coverage (recon-generate-fold-drill-value-splice-nested-
 * placeholder-guard.test.ts, recon-generate-multi-value-opaque-splice-guard-
 * e2e.test.ts) and its own, structurally distinct absorption logic.
 */

const HOST = "https://jobs.example.com";

const QUOTE_SPEC: FoldReturnSpec = {
  endpointPattern: "never-matches",
  resultsPath: "never",
  joinFields: [],
};

function buildActions() {
  const login = buildCapture({
    method: "POST",
    url: `${HOST}/api/v1/login`,
    requestPostData: '{"user":"alice"}',
    responseBody: { sessionCode: "77", ack: true },
    timestamp: "2024-01-01T00:00:00Z",
  });
  const confirm = buildCapture({
    method: "POST",
    url: `${HOST}/api/v1/confirm`,
    requestPostData: null,
    requestHeaders: { "Content-Type": "application/json", "X-Session-Code": "77" },
    responseBody: { confirmed: true },
    timestamp: "2024-01-01T00:00:01Z",
  });
  // Same-host authenticator/sensor call — no relationship to `sessionCode` at
  // all. Its opaque path's standalone "77" segment is NOT hyphen/dot-flanked
  // (that shape is already guarded by `buildValueAlternationPattern`'s
  // lookaround), so only capture-level scoping — not the value's surrounding
  // characters — can tell it apart from a real threaded value.
  const authenticator = buildCapture({
    method: "POST",
    url: `${HOST}/authenticator/wJbfQL/77/K0X/responder.html?clientId=TPR-TEST&environment=PROD`,
    requestPostData: '{"clientId":"TPR-TEST"}',
    responseBody: { ack: true, sessionId: "sess-noise-value" },
    timestamp: "2024-01-01T00:00:02Z",
  });
  return [login, confirm, authenticator];
}

function emitContract(): string {
  const [login, confirm, authenticator] = buildActions();
  const captures = [login!, confirm!, authenticator!];
  const actionCaptures = captures.map((capture, index) => ({ capture, index }));
  // Simulates exactly what `collectDependentDrillDownChainValues` proves for
  // a genuine dependent-drill-down chain hop: "sessionCode" is threaded ONLY
  // from `login`'s response into `confirm`'s request — `authenticator` is
  // never named as a consumer, even though its own path coincidentally
  // contains the same digits.
  const forceIncludeValues = new Map([["77", new Set([confirm!])]]);
  const stateIndex = indexStateValues(captures, new Set(), new Set([0, 1, 2]), forceIncludeValues);
  const actionSteps = compileActionSteps(actionCaptures, stateIndex);
  return emitMultiStepExecuteHttp(
    actionSteps as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
    JSON.parse(captures[0]!.requestPostData!),
    { stringMessageKey: null, nestedErrorPaths: [] },
    new Map(),
    new Set(),
    new Map(),
    new Set(),
    new Map(),
    new Map(),
    HOST,
    new Map(),
    new Map(),
    null,
    new Map(),
    new Map(),
    new Set(),
    [],
    new Map(),
    new Map(),
    QUOTE_SPEC
  );
}

describe("recon-generate — a chain-proven short state value is scoped to its proven consumer, not spliced into an unrelated capture", () => {
  it("threads sessionCode into the confirm call's header but never splices it into the unrelated authenticator capture's opaque path", () => {
    const body = emitContract();

    // No invalidly-nested placeholder anywhere in the emitted file — the
    // report's own symptom shape.
    expect(body).not.toMatch(/\$\{[^}]*\$\{/);

    // The genuine relationship still threads: confirm's request carries the
    // login-produced sessionCode as a header binding.
    expect(body).toMatch(/sessionCode/);

    // Locate the authenticator call's rendered path text.
    const authLineMatch = body.match(/`[^`]*wJbfQL[^`]*K0X[^`]*`/);
    expect(authLineMatch, body).not.toBeNull();
    const authUrlTemplate = authLineMatch![0];

    // `${payload.BaseUrl}` is the only legitimate interpolation any emitted
    // URL template carries.
    const pathPortion = authUrlTemplate.replace("${payload.BaseUrl}", "");

    // The authenticator's own path contains zero state-value references —
    // no `${` at all — despite coincidentally sharing "77" with the
    // genuinely threaded, chain-proven sessionCode value.
    expect(pathPortion).not.toContain("${");
    expect(authUrlTemplate).toBe(
      `\`\${payload.BaseUrl}/authenticator/wJbfQL/77/K0X/responder.html?clientId=TPR-TEST&environment=PROD\``
    );
  });
});
