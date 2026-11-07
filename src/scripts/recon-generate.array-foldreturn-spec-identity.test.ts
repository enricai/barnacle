import { describe, expect, it } from "vitest";
import {
  applyDrillParamBindings,
  emitContractTs,
  type FoldReturnSpec,
  type FoldTarget,
  resolveFoldPlan,
  specForTarget,
  wholeArrayAttachKey,
} from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

/** The shape a real multi-entry flow has: entry [0] folds one per-item drill, a
 * later entry folds another and declares its OWN drillParamBindings. The two
 * endpointPatterns deliberately do NOT cross-match — that non-overlap is the
 * whole mechanism under test, since it is what makes passing the wrong spec to
 * `applyDrillParamBindings` a silent no-op rather than a visible error. */
const PRIMARY_SPEC: FoldReturnSpec = {
  endpointPattern: "catalog/v2/entry/[^/]+/variants",
  resultsPath: "items",
  joinFields: ["id"],
  drillParamBindings: { unitCount: { payloadField: "units", type: "int", default: 2 } },
};
const EXTRA_SPEC: FoldReturnSpec = {
  endpointPattern: "catalog/v2/stock-availability",
  resultsPath: "items",
  joinFields: ["id"],
  attachAs: "stock",
  payloadFlag: "includeStock",
  drillParamBindings: { unitCount: { payloadField: "units", type: "int", default: 2 } },
};

const target = (over: Partial<FoldTarget> = {}): FoldTarget => ({
  joinFields: ["id"],
  drillStepIndex: 1,
  drillArrayPath: [],
  primaryMatchedItemIndex: 0,
  chain: [1],
  chainArrayPath: [],
  chainTerminalIndex: 1,
  ...over,
});

/** A `Capture` built field-by-field rather than cast, so a test that later reads
 * another field gets a type error instead of `undefined`. Only `.url` is read on
 * the paths exercised here — `compileFoldReturnEndpointMatcher`'s predicate is
 * `(capture) => endpointRx.test(capture.url)` — but the rest are supplied so the
 * type still checks. `phase`/`operationName`/`query`/`variables`/`decodedParams`
 * are required by `Capture` and unread here: these flows are REST, not GraphQL. */
const capture = (url: string, responseBody: unknown = null, seconds = 1): Capture => ({
  url,
  requestPostData: null,
  method: "GET",
  status: 200,
  timestamp: `2026-01-01T00:00:0${seconds}.000Z`,
  responseBody,
  requestHeaders: {},
  responseHeaders: {},
  phase: "action",
  operationName: null,
  query: null,
  variables: null,
  decodedParams: null,
});

const EXTRA_URL = "https://api.example.com/catalog/v2/stock-availability?unitCount=2";

describe("specForTarget", () => {
  it("falls back to the primary spec when the target carries no key", () => {
    // Object form and the first array entry: unchanged behaviour.
    expect(specForTarget(target(), PRIMARY_SPEC, [EXTRA_SPEC])).toBe(PRIMARY_SPEC);
    expect(specForTarget(target(), null, [EXTRA_SPEC])).toBeNull();
  });

  it("resolves a non-first entry's own spec by drillSpecKey", () => {
    expect(
      specForTarget(target({ drillSpecKey: EXTRA_SPEC.endpointPattern }), PRIMARY_SPEC, [
        EXTRA_SPEC,
      ])
    ).toBe(EXTRA_SPEC);
  });

  it("falls back to the primary when the key matches no declared entry", () => {
    expect(specForTarget(target({ drillSpecKey: "gone" }), PRIMARY_SPEC, [EXTRA_SPEC])).toBe(
      PRIMARY_SPEC
    );
  });
});

describe("drillParamBindings on a non-first foldReturn entry", () => {
  it("binds when the target's OWN spec is resolved", () => {
    const text = `fetch("${EXTRA_URL}")`;
    const bound = applyDrillParamBindings(
      specForTarget(target({ drillSpecKey: EXTRA_SPEC.endpointPattern }), PRIMARY_SPEC, [
        EXTRA_SPEC,
      ]),
      capture(EXTRA_URL),
      text
    );
    expect(bound).toContain("payload.units");
    expect(bound).not.toBe(text);
  });

  it("is silently dropped when the PRIMARY spec is passed instead — the bug", () => {
    // PRIMARY_SPEC's endpoint matcher rejects the extra entry's capture, so
    // applyDrillParamBindings returns the text untouched and the emitted drill
    // keeps the recorded literal. This is what made the binding a no-op.
    const text = `fetch("${EXTRA_URL}")`;
    expect(applyDrillParamBindings(PRIMARY_SPEC, capture(EXTRA_URL), text)).toBe(text);
  });
});

describe("declared attachAs vs the whole-array inference heuristic", () => {
  const body = { stock: { price: 10 } };

  it("honours a declared attachAs even when the drill answers with one row", () => {
    expect(wholeArrayAttachKey(target({ attachAs: "stock" }), body, EXTRA_URL)).toBe("stock");
  });

  it("still infers nothing from a single row when no attachAs was declared", () => {
    // The heuristic is unchanged: several rows, none joinable, else null.
    expect(
      wholeArrayAttachKey(target({ chainArrayPath: ["rows"] }), { rows: [{ a: 1 }] }, EXTRA_URL)
    ).toBeNull();
  });
});

const BASE_OPTS = {
  siteId: "catalog-like",
  pascal: "CatalogLike",
  baseUrl: "https://api.example.com",
  baseHeaders: {},
  minTime: 100,
  safeRps: 10,
  responseBody: { items: [{ id: "1" }] },
  gql: false,
  gqlQuery: null,
  endpointPath: "/catalog/search",
  auxFiles: [],
};

/** The emitted `const <X>PayloadSchema = ...` declaration, up to its terminating
 * semicolon — the chain can end in `.extend({...})` and/or `.merge(X)`. */
function payloadSchema(extra: object): string {
  const code = emitContractTs({ ...BASE_OPTS, ...extra } as never);
  const start = code.indexOf("PayloadSchema = z.object({");
  if (start < 0) return "";
  const end = code.indexOf(";", code.indexOf("})", start));
  return code.slice(start, end < 0 ? undefined : end);
}

describe("payload schema declares every declared foldReturn entry's caller inputs", () => {
  it("declares a non-first entry's drillParamBindings payloadField", () => {
    // The binding must be declared ONLY on the extra entry, or the primary
    // spec would supply the same field and the assertion would pass either
    // way. EXTRA_SPEC alone declares `extraOnly`; PRIMARY_SPEC declares `units`.
    const schema = payloadSchema({
      foldReturnSpec: PRIMARY_SPEC,
      extraFoldSpecs: [
        {
          ...EXTRA_SPEC,
          drillParamBindings: {
            extraOnly: { payloadField: "extraOnly", type: "int", default: 1 },
          },
        },
      ],
    });
    expect(schema).toContain("extraOnly:");
  });

  it("declares each entry's payloadFlag as an optional boolean", () => {
    // The emitted drill gates on this flag via a cast, so a caller passing it
    // worked — but Zod strips unknown keys, leaving it undocumented and
    // strippable before executeHttp sees it.
    const schema = payloadSchema({ foldReturnSpec: PRIMARY_SPEC, extraFoldSpecs: [EXTRA_SPEC] });
    expect(schema).toContain("includeStock: z.boolean().optional(),");
  });

  it("emits no flag field when no entry declares one", () => {
    const schema = payloadSchema({ foldReturnSpec: PRIMARY_SPEC, extraFoldSpecs: [] });
    expect(schema).not.toContain("includeStock");
  });
});

/** One action step shaped the way the resolver reads it. `resolveFoldPlan` is
 * generic over `{ capture: Capture; isMultipart: boolean }`, so the step type is
 * named rather than cast, and `capture` stays readable on the way back out. The
 * capture itself comes from the shared builder above. */
interface TestActionStep {
  capture: Capture;
  varName: string;
  produces: unknown[];
  isMultipart: boolean;
  isCrossDomain: boolean;
}

const step = (url: string, responseBody: unknown, seconds: number): TestActionStep => ({
  capture: capture(url, responseBody, seconds),
  varName: "r",
  produces: [],
  isMultipart: false,
  isCrossDomain: false,
});

/** The primary search plus two per-item drills, the second declared as an extra
 * `foldReturn` entry. Both drills thread the primary item's own `id`, which is
 * what lets the structural detector pair them in the first place. */
const PRIMARY: FoldReturnSpec = {
  endpointPattern: "/search",
  resultsPath: "items",
  joinFields: ["id"],
};
const EXTRA: FoldReturnSpec = {
  endpointPattern: "/stock",
  resultsPath: "items",
  joinFields: ["id"],
  attachAs: "stock",
  drillParamBindings: { n: { payloadField: "extraOnly", type: "int", default: 2 } },
};
const ACTIONS = [
  step("https://x/search?q=1", { items: [{ id: "A1" }, { id: "B2" }] }, 1),
  step("https://x/detail?id=A1", { items: [{ id: "A1", v: 1 }] }, 2),
  step("https://x/stock?id=A1&n=2", { items: [{ price: 10 }] }, 3),
];

describe("drillSpecKey survives the real resolveFoldPlan pipeline", () => {
  it("stamps the extra entry's target and leaves the primary's unstamped", () => {
    // The hand-built targets above cannot prove this: the key has to survive
    // resolveFoldPlanWithExtraDrills -> pinTargetToEndpointStep ->
    // collapseTargetsToDeclaredDrillPath.
    const targets = resolveFoldPlan(ACTIONS, PRIMARY, null, [EXTRA]).flatMap((p) => p.targets);
    const byStep = new Map(targets.map((t) => [t.drillStepIndex, t]));

    expect(byStep.get(2)?.drillSpecKey).toBe(EXTRA.endpointPattern);
    expect(byStep.get(2)?.attachAs).toBe("stock");
    expect(byStep.get(1)?.drillSpecKey).toBeUndefined();
  });

  it("renders a non-first entry's binding as a payload reference, not a frozen literal", () => {
    // The end-to-end shape of the bug: before the fix the emitted drill kept
    // `n=2` from the recording, so the caller could not drive it.
    const targets = resolveFoldPlan(ACTIONS, PRIMARY, null, [EXTRA]).flatMap((p) => p.targets);
    const extraTarget = targets.find((t) => t.drillSpecKey === EXTRA.endpointPattern);
    if (extraTarget === undefined) throw new Error("extra drill resolved no target");

    const text = 'fetch("https://x/stock?id=A1&n=2")';
    const bound = applyDrillParamBindings(
      specForTarget(extraTarget, PRIMARY, [EXTRA]),
      ACTIONS[extraTarget.drillStepIndex]!.capture,
      text
    );

    expect(bound).toContain("payload.extraOnly");
    expect(bound).not.toContain("n=2)");
  });
});
