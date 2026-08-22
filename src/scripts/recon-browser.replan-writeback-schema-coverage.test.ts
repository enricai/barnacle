/**
 * Schema-coverage drift guard for persistReplannedFlow's write-back path.
 *
 * recon-browser once silently dropped `frameSelector` (and any other
 * top-level flow-config key not explicitly threaded through
 * persistReplannedFlow's params) on write-back — see
 * recon-browser.test.ts's "preserves top-level keys not threaded through
 * explicit params" test for the named-key regression case. That test pins
 * TODAY's four keys; it says nothing about a key added to
 * RECON_FLOW_FILE_SCHEMA tomorrow.
 *
 * This file derives the key list from RECON_FLOW_FILE_SCHEMA itself (the
 * object branch's shape) rather than restating it, so a future schema
 * addition that isn't threaded through write-back — whether via an explicit
 * persistReplannedFlow param or via the extractUnmanagedFlowFileKeys
 * catch-all — turns this suite red without anyone updating this file.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type NormalizedStep,
  persistReplannedFlow,
  RECON_FLOW_FILE_SCHEMA,
  type ReplanEvent,
} from "@/scripts/recon-browser";
import type { Logger } from "@/types/logging";

vi.mock("@/config", () => ({
  config: {
    scraper: {
      useBedrock: false,
      anthropicApiKey: "test-key",
      model: "anthropic/claude-sonnet-4-6",
      proxyType: "residential",
      steelSessionTimeoutMs: 30000,
      frameReadyTimeoutMs: 20_000,
      frameDocumentReadyTimeoutMs: 5_000,
      frameEvaluateTimeoutMs: 30_000,
    },
    telemetry: {
      callsNdjsonPath: ".barnacle/calls.ndjson",
    },
  },
}));
vi.mock("@/lib/http", () => ({ configureHttpDispatcher: vi.fn() }));
vi.mock("@/scraper/session", () => ({ createBrowserSession: vi.fn() }));

const { loggerStub } = vi.hoisted(() => ({
  loggerStub: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    errorWithStack: vi.fn(),
  },
}));

const testLogger = loggerStub as unknown as Logger;

/**
 * Zod's public surface doesn't expose "list every key of the object branch
 * of a union" as a typed API, so this reaches into `.def` — a deliberately
 * narrow, well-commented escape hatch rather than restating the key list by
 * hand (which is exactly the drift this guard exists to prevent).
 */
interface IntrospectableZodDef {
  type: string;
  innerType?: { def: IntrospectableZodDef };
  shape?: Record<string, IntrospectableZodType>;
}
interface IntrospectableZodType {
  def: IntrospectableZodDef;
}
const objectBranch = (
  RECON_FLOW_FILE_SCHEMA as unknown as {
    def: { options: [unknown, { shape: Record<string, IntrospectableZodType> }] };
  }
).def.options[1];
const nonStepsKeys = Object.keys(objectBranch.shape).filter((key) => key !== "steps");

/**
 * Maps a schema field's zod primitive to a value guaranteed to survive
 * persistReplannedFlow's own truthiness gating (empty array / false boolean
 * are legitimately omitted by design, so a representative value must be
 * non-empty / true to distinguish "gated out on purpose" from "dropped by a
 * regression").
 */
function representativeValueFor(
  zodType: IntrospectableZodType
): string | string[] | boolean | Record<string, unknown> {
  const def = zodType.def;
  const unwrapped = def.type === "optional" && def.innerType ? def.innerType.def : def;
  switch (unwrapped.type) {
    case "string":
      return "guard-representative-value";
    case "array":
      return ["guard-representative-value"];
    case "boolean":
      return true;
    case "object": {
      const shape = unwrapped.shape ?? {};
      return Object.fromEntries(
        Object.entries(shape).map(([subKey, subType]) => [subKey, representativeValueFor(subType)])
      );
    }
    default:
      throw new Error(
        `replan-writeback-schema-coverage guard: no representative-value mapping for zod type "${unwrapped.type}" — add a case to representativeValueFor in this test`
      );
  }
}

describe("recon-browser/persistReplannedFlow — schema-coverage drift guard", () => {
  let tmpDir: string;
  let flowPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "recon-persist-schema-coverage-"));
    flowPath = join(tmpDir, "recon-flow.json");
    loggerStub.info.mockClear();
    loggerStub.warn.mockClear();
    loggerStub.error.mockClear();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("enumerates a non-empty, non-'steps' key set from RECON_FLOW_FILE_SCHEMA's object branch", () => {
    // Guards the guard: if schema introspection itself breaks (e.g. a zod
    // upgrade changes `.def` shape), this must fail loudly rather than let
    // the it.each below silently iterate zero times and report green.
    expect(nonStepsKeys.length).toBeGreaterThan(0);
    expect(nonStepsKeys).not.toContain("steps");
  });

  it.each(nonStepsKeys)(
    "carries schema key %s through persistReplannedFlow's write-back",
    (key) => {
      const value = representativeValueFor(objectBranch.shape[key]!);

      writeFileSync(flowPath, `${JSON.stringify({ steps: ["Step A"], [key]: value }, null, 2)}\n`);

      const finalPlan: NormalizedStep[] = [
        { instruction: "Step A", optional: false, upload: false, origin: "original" },
      ];
      const replanEvents: ReplanEvent[] = [
        {
          replanIndex: 1,
          cause: "probe-absent",
          indexAtFailure: 0,
          failedInstruction: "Step A",
          replanSteps: finalPlan,
          timestamp: "2026-06-03T20:00:00.000Z",
          pageState: { url: "https://example.com/apply", htmlLength: 50000 },
        },
      ];

      // Supplies the value both ways a real caller can: as part of the
      // on-disk original flow (the extractUnmanagedFlowFileKeys path) AND
      // as an explicit named param (the persistReplannedFlow-managed-key
      // path). A key that only survives via one path still passes; a key
      // dropped by BOTH paths is exactly the regression this guards.
      persistReplannedFlow({
        flowFile: flowPath,
        finalPlan,
        replanEvents,
        logger: testLogger,
        originalShape: "object",
        [key]: value,
      } as Parameters<typeof persistReplannedFlow>[0]);

      const parsed = JSON.parse(readFileSync(flowPath, "utf8")) as Record<string, unknown>;
      expect(parsed[key]).toEqual(value);
    }
  );
});
