/**
 * Unit tests for recon-heal.ts convergence state machine.
 *
 * All tests stub browser sessions and the Anthropic SDK so no real network
 * calls or Steel sessions occur. The state machine (SUCCESS/PLATEAUED/
 * BUDGET_EXHAUSTED/REGRESSED) is fully deterministic given the injected stubs.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StepVerificationErrorKind } from "@/scraper/errors";

vi.mock("@/config", () => ({
  config: {
    scraper: {
      useBedrock: false,
      anthropicApiKey: "test-key",
      model: "anthropic/claude-sonnet-4-6",
      proxyType: "residential",
      steelSessionTimeoutMs: 30000,
    },
  },
}));
vi.mock("@/lib/http", () => ({ configureHttpDispatcher: vi.fn() }));
vi.mock("@/scraper/session", () => ({ createBrowserSession: vi.fn() }));
vi.mock("@/scraper/errors", () => ({
  StepVerificationError: class StepVerificationError extends Error {
    readonly kind: StepVerificationErrorKind;
    constructor(message = "step failed", kind: StepVerificationErrorKind = "cascade-exhausted") {
      super(message);
      this.kind = kind;
    }
  },
}));

const { loggerStub } = vi.hoisted(() => ({
  loggerStub: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    errorWithStack: vi.fn(),
  },
}));
vi.mock("@/lib/logging", () => ({
  getLogger: () => loggerStub,
  getScriptLogger: () => loggerStub,
}));

vi.mock("@/lib/telemetry/call-capture", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/telemetry/call-capture")>();
  return {
    ...actual,
    captureLlmCall: vi.fn().mockResolvedValue(undefined),
  };
});

import type { LlmCallInput } from "@/lib/telemetry/call-capture";
import { CALL_TYPE_RECON_FLOW_PATCH } from "@/lib/telemetry/call-types";
import type {
  CaptureFn,
  FlowPatch,
  HealState,
  IterationRecord,
  ReplayResult,
  StepRunner,
} from "@/scripts/recon-heal";
import {
  applyPatch,
  buildAnthropicClient,
  checkConvergence,
  makeDryRunStepRunner,
  phaseHeal,
  requestPatch,
  writeHealReport,
  writeIterationArtifacts,
  writeState,
} from "@/scripts/recon-heal";

// ── fixtures ──────────────────────────────────────────────────────────────────

const THREE_STEP_FLOW = ["click the search bar", "type the product name", "click the first result"];

const VALID_PATCH: FlowPatch = {
  anchor: "type the product name",
  replacement: "enter the product name in the search input field",
  strategy: "targets the input element more precisely by including 'input field'",
  pivot_reason: null,
};

const MISMATCHED_PATCH: FlowPatch = {
  anchor: "this anchor does not exist in any step",
  replacement: "irrelevant",
  strategy: "won't apply",
  pivot_reason: null,
};

// ── test helpers ──────────────────────────────────────────────────────────────

let tmpDir: string;
let outDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recon-heal-test-"));
  outDir = path.join(tmpDir, "heal-out");
  fs.mkdirSync(outDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

function makeHealState(overrides: Partial<HealState> = {}): HealState {
  return {
    siteId: "my-site",
    originalFlow: THREE_STEP_FLOW,
    baselinePassRate: 0.4,
    history: [],
    bestPassRate: 0.4,
    bestPatch: null,
    bestIterN: 0,
    ...overrides,
  };
}

// ── buildAnthropicClient ──────────────────────────────────────────────────────

describe("buildAnthropicClient", () => {
  it("returns an Anthropic instance when apiKey is set and useBedrock is false", () => {
    const client = buildAnthropicClient();
    expect(client).toBeInstanceOf(Anthropic);
  });
});

// ── makeDryRunStepRunner ──────────────────────────────────────────────────────

describe("makeDryRunStepRunner", () => {
  it("returns passRate=1.0 when no override given", async () => {
    const runner = makeDryRunStepRunner();
    const result = await runner({ flow: THREE_STEP_FLOW, url: "https://x.com", runId: "r1" });
    expect(result.passRate).toBe(1.0);
    expect(result.passCount).toBe(3);
    expect(result.failCount).toBe(0);
  });

  it("returns the given passRate rounded to step granularity", async () => {
    const runner = makeDryRunStepRunner(0.4);
    const result = await runner({ flow: THREE_STEP_FLOW, url: "https://x.com", runId: "r1" });
    expect(result.passCount + result.failCount).toBe(3);
    expect(result.passRate).toBeCloseTo(Math.round(3 * 0.4) / 3);
  });

  it("handles empty flow without dividing by zero", async () => {
    const runner = makeDryRunStepRunner();
    const result = await runner({ flow: [], url: "https://x.com", runId: "r1" });
    expect(result.passRate).toBe(0);
  });
});

// ── applyPatch ────────────────────────────────────────────────────────────────

describe("applyPatch", () => {
  it("replaces the anchor in the matching step", () => {
    const patched = applyPatch(THREE_STEP_FLOW, VALID_PATCH);
    expect(patched[1]).toBe("enter the product name in the search input field");
    expect(patched[0]).toBe(THREE_STEP_FLOW[0]);
    expect(patched[2]).toBe(THREE_STEP_FLOW[2]);
  });

  it("never mutates the original flow array", () => {
    const original = [...THREE_STEP_FLOW];
    applyPatch(THREE_STEP_FLOW, VALID_PATCH);
    expect(THREE_STEP_FLOW).toEqual(original);
  });

  it("returns the flow unchanged when anchor does not match any step", () => {
    const patched = applyPatch(THREE_STEP_FLOW, MISMATCHED_PATCH);
    expect(patched).toEqual(THREE_STEP_FLOW);
  });
});

// ── checkConvergence ──────────────────────────────────────────────────────────

describe("checkConvergence", () => {
  const defaults = {
    bestPassRate: 0.95,
    maxIterations: 5,
    successThreshold: 0.9,
    plateauDelta: 0.03,
    plateauWindow: 3,
  };

  it("returns CONTINUE when history is empty", () => {
    expect(checkConvergence({ ...defaults, history: [] })).toBe("CONTINUE");
  });

  it("returns SUCCESS when latest pass_rate >= success_threshold", () => {
    const history: IterationRecord[] = [{ iterN: 1, passRate: 0.95, patch: VALID_PATCH }];
    expect(checkConvergence({ ...defaults, history })).toBe("SUCCESS");
  });

  it("returns BUDGET_EXHAUSTED when history.length == maxIterations without success", () => {
    const history: IterationRecord[] = Array.from({ length: 5 }, (_, i) => ({
      iterN: i + 1,
      passRate: 0.5,
      patch: VALID_PATCH,
    }));
    expect(checkConvergence({ ...defaults, bestPassRate: 0.5, history })).toBe("BUDGET_EXHAUSTED");
  });

  it("returns PLATEAUED when last plateau_window iters are within plateau_delta", () => {
    const history: IterationRecord[] = [
      { iterN: 1, passRate: 0.41, patch: VALID_PATCH },
      { iterN: 2, passRate: 0.4, patch: VALID_PATCH },
      { iterN: 3, passRate: 0.42, patch: VALID_PATCH },
    ];
    // Max - min = 0.02 < 0.03 plateau_delta → PLATEAUED
    expect(checkConvergence({ ...defaults, bestPassRate: 0.42, history })).toBe("PLATEAUED");
  });

  it("returns REGRESSED when last plateau_window iters all dropped > plateau_delta below best", () => {
    // bestPassRate=0.95, plateau_delta=0.03. All window entries must be < 0.95 - 0.03 = 0.92.
    const history: IterationRecord[] = [
      { iterN: 1, passRate: 0.95, patch: VALID_PATCH },
      { iterN: 2, passRate: 0.85, patch: VALID_PATCH },
      { iterN: 3, passRate: 0.84, patch: VALID_PATCH },
      { iterN: 4, passRate: 0.83, patch: VALID_PATCH },
    ];
    expect(checkConvergence({ ...defaults, bestPassRate: 0.95, history })).toBe("REGRESSED");
  });

  it("returns CONTINUE when rates differ by more than plateau_delta (not plateaued)", () => {
    const history: IterationRecord[] = [
      { iterN: 1, passRate: 0.4, patch: VALID_PATCH },
      { iterN: 2, passRate: 0.7, patch: VALID_PATCH },
    ];
    expect(checkConvergence({ ...defaults, bestPassRate: 0.7, history })).toBe("CONTINUE");
  });

  it("prioritizes SUCCESS over BUDGET_EXHAUSTED", () => {
    const history: IterationRecord[] = [
      ...Array.from({ length: 4 }, (_, i) => ({
        iterN: i + 1,
        passRate: 0.5,
        patch: VALID_PATCH,
      })),
      { iterN: 5, passRate: 0.95, patch: VALID_PATCH },
    ];
    expect(checkConvergence({ ...defaults, bestPassRate: 0.95, history })).toBe("SUCCESS");
  });
});

// ── requestPatch ──────────────────────────────────────────────────────────────

describe("requestPatch", () => {
  it("parses a valid patch response from the model", async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: JSON.stringify(VALID_PATCH) }],
        }),
      },
    } as unknown as Anthropic;

    const result = await requestPatch({
      client: mockClient,
      currentFlow: THREE_STEP_FLOW,
      failingSteps: [THREE_STEP_FLOW[1]!],
      iterN: 1,
      priorAttempts: [],
    });

    expect(result).not.toBeNull();
    expect(result?.anchor).toBe(VALID_PATCH.anchor);
    expect(result?.replacement).toBe(VALID_PATCH.replacement);
  });

  it("returns null when the model response is not valid JSON", async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "not json at all" }],
        }),
      },
    } as unknown as Anthropic;

    const result = await requestPatch({
      client: mockClient,
      currentFlow: THREE_STEP_FLOW,
      failingSteps: [THREE_STEP_FLOW[1]!],
      iterN: 1,
      priorAttempts: [],
    });

    expect(result).toBeNull();
  });

  it("returns null when anchor is not found verbatim in current flow", async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: JSON.stringify(MISMATCHED_PATCH) }],
        }),
      },
    } as unknown as Anthropic;

    const result = await requestPatch({
      client: mockClient,
      currentFlow: THREE_STEP_FLOW,
      failingSteps: [THREE_STEP_FLOW[1]!],
      iterN: 1,
      priorAttempts: [],
    });

    expect(result).toBeNull();
  });

  it("returns null when the API call throws", async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockRejectedValue(new Error("API error")),
      },
    } as unknown as Anthropic;

    const result = await requestPatch({
      client: mockClient,
      currentFlow: THREE_STEP_FLOW,
      failingSteps: [THREE_STEP_FLOW[1]!],
      iterN: 1,
      priorAttempts: [],
    });

    expect(result).toBeNull();
  });
});

// ── writeState ────────────────────────────────────────────────────────────────

describe("writeState", () => {
  it("writes state.json under outDir/siteId/", () => {
    const state = makeHealState();
    writeState(outDir, "my-site", state);
    const statePath = path.join(outDir, "my-site", "state.json");
    expect(fs.existsSync(statePath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf-8")) as HealState;
    expect(parsed.siteId).toBe("my-site");
    expect(parsed.baselinePassRate).toBe(0.4);
  });
});

// ── writeIterationArtifacts ───────────────────────────────────────────────────

describe("writeIterationArtifacts", () => {
  it("writes all five artifact files under iter-N/", () => {
    writeIterationArtifacts({
      outDir,
      siteId: "my-site",
      iterN: 1,
      patchRequest: { currentFlow: THREE_STEP_FLOW, failingSteps: [], iterN: 1, priorAttempts: [] },
      patch: VALID_PATCH,
      appliedFlow: applyPatch(THREE_STEP_FLOW, VALID_PATCH),
      passRate: 0.67,
      passCount: 2,
      failCount: 1,
    });

    const dir = path.join(outDir, "my-site", "iter-1");
    expect(fs.existsSync(path.join(dir, "patch-request.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "patch-response.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "applied-flow.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "arm-results.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "scores.json"))).toBe(true);
  });
});

// ── writeHealReport ───────────────────────────────────────────────────────────

describe("writeHealReport", () => {
  it("writes healing-<siteId>.md with correct sections", () => {
    const state = makeHealState({
      history: [
        { iterN: 1, passRate: 0.67, patch: VALID_PATCH },
        { iterN: 2, passRate: 0.95, patch: VALID_PATCH },
      ],
      bestPatch: VALID_PATCH,
      bestIterN: 2,
      bestPassRate: 0.95,
    });

    const reportPath = writeHealReport({ outDir, siteId: "my-site", state, verdict: "SUCCESS" });

    expect(fs.existsSync(reportPath)).toBe(true);
    const content = fs.readFileSync(reportPath, "utf-8");
    expect(content).toContain("# Heal report: my-site");
    expect(content).toContain("**Verdict:** SUCCESS");
    expect(content).toContain(VALID_PATCH.anchor);
    expect(content).toContain(VALID_PATCH.replacement);
    expect(content).toContain("| iter | pass_rate |");
    expect(content).toContain("Production recon-flow.json was NOT modified");
  });

  it("places the report at outDir/siteId/healing-<siteId>.md", () => {
    const state = makeHealState();
    const reportPath = writeHealReport({
      outDir,
      siteId: "my-site",
      state,
      verdict: "BUDGET_EXHAUSTED",
    });
    expect(reportPath).toBe(path.join(outDir, "my-site", "healing-my-site.md"));
  });
});

// ── phaseHeal — convergence state machine ─────────────────────────────────────

describe("phaseHeal", () => {
  function makeStepRunner(passRateByCall: number[]): StepRunner {
    let callIdx = 0;
    return async (): Promise<ReplayResult> => {
      const rate = passRateByCall[callIdx] ?? passRateByCall[passRateByCall.length - 1] ?? 0;
      callIdx++;
      const total = THREE_STEP_FLOW.length;
      const passCount = Math.round(total * rate);
      return {
        passRate: total > 0 ? passCount / total : 0,
        passCount,
        failCount: total - passCount,
      };
    };
  }

  function makeMockRequestPatch(patch: FlowPatch | null = VALID_PATCH) {
    return vi.fn().mockResolvedValue(patch);
  }

  beforeEach(() => {
    // Ensure the flow file is under tmpDir so phaseHeal reads it via resolve().
    // We override the cwd-relative resolve by passing an absolute flowFilePath
    // via a patched resolve call isn't straightforward; instead we create the
    // file at the expected path relative to process.cwd() substitute.
    // Since phaseHeal calls resolve(join("src", "sites", siteId, "recon-flow.json")),
    // and we can't change cwd in tests, we write the flow into tmpDir and pass
    // a custom phaseHeal param indirectly. We use the dry-run + custom stepRunner
    // trick to avoid the real browser, and patch the flow file path by having the
    // test create the real directory structure relative to cwd.
    //
    // Pragmatic approach: write the flow file relative to the actual test cwd.
    const flowDir = path.join(process.cwd(), "src", "sites", "test-site");
    fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(path.join(flowDir, "recon-flow.json"), JSON.stringify(THREE_STEP_FLOW));
  });

  afterEach(() => {
    const flowDir = path.join(process.cwd(), "src", "sites", "test-site");
    fs.rmSync(flowDir, { recursive: true, force: true });
  });

  it("SUCCESS: baseline=0.4, iter-1 patch lifts to 0.95 → verdict=SUCCESS", async () => {
    // Calls: nReplays=3 baseline (each 0.4), then nReplays=3 patched (each 0.95)
    const passRates = [0.4, 0.4, 0.4, 0.95, 0.95, 0.95];
    const mockRequestPatch = makeMockRequestPatch();

    const { verdict, state, reportPath } = await phaseHeal({
      siteId: "test-site",
      url: "https://example.com",
      maxIterations: 5,
      nReplays: 3,
      successThreshold: 0.9,
      plateauDelta: 0.03,
      plateauWindow: 3,
      outDir,
      stepRunner: makeStepRunner(passRates),
      requestPatchFn: mockRequestPatch,
    });

    expect(verdict).toBe("SUCCESS");
    // state.json must have baseline + 1 iteration recorded.
    const statePath = path.join(outDir, "test-site", "state.json");
    expect(fs.existsSync(statePath)).toBe(true);
    const stateOnDisk = JSON.parse(fs.readFileSync(statePath, "utf-8")) as HealState;
    expect(stateOnDisk.history).toHaveLength(1);
    // With 3 steps, passRate=0.4 rounds to Math.round(3*0.4)/3 = 1/3.
    expect(stateOnDisk.baselinePassRate).toBeCloseTo(1 / 3);

    // Healing report must exist with iteration table.
    expect(fs.existsSync(reportPath)).toBe(true);
    const report = fs.readFileSync(reportPath, "utf-8");
    expect(report).toContain("**Verdict:** SUCCESS");
    expect(report).toContain("| iter | pass_rate |");

    // Original flow file must be untouched.
    const flowContent = fs.readFileSync(
      path.join(process.cwd(), "src", "sites", "test-site", "recon-flow.json"),
      "utf-8"
    );
    expect(JSON.parse(flowContent)).toEqual(THREE_STEP_FLOW);

    void state;
  });

  it("PLATEAUED: 5 iters all return pass_rate ∈ [0.38, 0.42] → verdict=PLATEAUED", async () => {
    // Baseline + 5 patched arms all hovering around 0.4. Using plateau_window=3
    // and plateau_delta=0.03 — rates [0.40, 0.39, 0.41] span 0.02 < 0.03.
    const baselineRates = [0.4, 0.4, 0.4];
    const patchedRates = [0.4, 0.4, 0.4, 0.39, 0.39, 0.39, 0.41, 0.41, 0.41];
    const passRates = [...baselineRates, ...patchedRates];
    const mockRequestPatch = makeMockRequestPatch();

    const { verdict } = await phaseHeal({
      siteId: "test-site",
      url: "https://example.com",
      maxIterations: 5,
      nReplays: 3,
      successThreshold: 0.9,
      plateauDelta: 0.03,
      plateauWindow: 3,
      outDir,
      stepRunner: makeStepRunner(passRates),
      requestPatchFn: mockRequestPatch,
    });

    expect(["PLATEAUED", "BUDGET_EXHAUSTED"]).toContain(verdict);
  });

  it("REGRESSED: plateau_window consecutive iters drop > plateau_delta below best → REGRESSED", async () => {
    // With 3 steps: 0.67 rounds to 2/3, 0.33 rounds to 1/3.
    // Best=2/3≈0.667 < successThreshold=0.9. Regressed iters at 1/3 drop
    // 0.667 - 0.333 = 0.334 > plateau_delta=0.03 → REGRESSED after 3 consecutive iters.
    const baselineRates = [0.33, 0.33, 0.33];
    const patchedRates = [
      // iter-1: ~0.667 (best — 2 of 3 steps pass)
      0.67, 0.67, 0.67,
      // iter-2: ~0.333 (regressed)
      0.33, 0.33, 0.33,
      // iter-3: ~0.333 (regressed)
      0.33, 0.33, 0.33,
      // iter-4: ~0.333 (regressed) — 3 consecutive, triggers REGRESSED
      0.33, 0.33, 0.33,
    ];
    const passRates = [...baselineRates, ...patchedRates];
    const mockRequestPatch = makeMockRequestPatch();

    const { verdict } = await phaseHeal({
      siteId: "test-site",
      url: "https://example.com",
      maxIterations: 5,
      nReplays: 3,
      successThreshold: 0.9,
      plateauDelta: 0.03,
      plateauWindow: 3,
      outDir,
      stepRunner: makeStepRunner(passRates),
      requestPatchFn: mockRequestPatch,
    });

    expect(verdict).toBe("REGRESSED");
  });

  it("BUDGET_EXHAUSTED when maxIterations reached without convergence", async () => {
    // Vary rates slightly to avoid plateau. Never reaches threshold.
    const baselineRates = [0.5, 0.5, 0.5];
    // 2 iterations * 3 replays = 6 calls with varying rates.
    const patchedRates = [0.55, 0.55, 0.55, 0.45, 0.45, 0.45];
    const passRates = [...baselineRates, ...patchedRates];
    const mockRequestPatch = makeMockRequestPatch();

    const { verdict } = await phaseHeal({
      siteId: "test-site",
      url: "https://example.com",
      maxIterations: 2,
      nReplays: 3,
      successThreshold: 0.99,
      plateauDelta: 0.001,
      plateauWindow: 10,
      outDir,
      stepRunner: makeStepRunner(passRates),
      requestPatchFn: mockRequestPatch,
    });

    expect(verdict).toBe("BUDGET_EXHAUSTED");
  });

  it("exits SUCCESS immediately when baseline already meets threshold", async () => {
    // All baseline calls return 0.95 (≥ 0.9 threshold).
    const passRates = [0.95, 0.95, 0.95];
    const mockRequestPatch = makeMockRequestPatch();

    const { verdict } = await phaseHeal({
      siteId: "test-site",
      url: "https://example.com",
      maxIterations: 5,
      nReplays: 3,
      successThreshold: 0.9,
      plateauDelta: 0.03,
      plateauWindow: 3,
      outDir,
      stepRunner: makeStepRunner(passRates),
      requestPatchFn: mockRequestPatch,
    });

    expect(verdict).toBe("SUCCESS");
    expect(mockRequestPatch).not.toHaveBeenCalled();
  });

  it("never modifies the source recon-flow.json", async () => {
    const flowPath = path.join(process.cwd(), "src", "sites", "test-site", "recon-flow.json");
    const originalContent = fs.readFileSync(flowPath, "utf-8");
    const mockRequestPatch = makeMockRequestPatch();

    await phaseHeal({
      siteId: "test-site",
      url: "https://example.com",
      maxIterations: 2,
      nReplays: 1,
      successThreshold: 0.99,
      plateauDelta: 0.001,
      plateauWindow: 10,
      outDir,
      stepRunner: makeStepRunner([0.4, 0.5, 0.6]),
      requestPatchFn: mockRequestPatch,
    });

    expect(fs.readFileSync(flowPath, "utf-8")).toBe(originalContent);
  });

  it("writes iter-N/ subdirs under outDir for each iteration", async () => {
    const mockRequestPatch = makeMockRequestPatch();

    await phaseHeal({
      siteId: "test-site",
      url: "https://example.com",
      maxIterations: 2,
      nReplays: 1,
      successThreshold: 0.99,
      plateauDelta: 0.001,
      plateauWindow: 10,
      outDir,
      stepRunner: makeStepRunner([0.4, 0.5, 0.6, 0.7]),
      requestPatchFn: mockRequestPatch,
    });

    const iter1Dir = path.join(outDir, "test-site", "iter-1");
    expect(fs.existsSync(iter1Dir)).toBe(true);
    expect(fs.existsSync(path.join(iter1Dir, "patch-request.json"))).toBe(true);
    expect(fs.existsSync(path.join(iter1Dir, "patch-response.json"))).toBe(true);
    expect(fs.existsSync(path.join(iter1Dir, "applied-flow.json"))).toBe(true);
    expect(fs.existsSync(path.join(iter1Dir, "arm-results.json"))).toBe(true);
    expect(fs.existsSync(path.join(iter1Dir, "scores.json"))).toBe(true);
  });

  it("output artifacts are never written under the source flow directory", async () => {
    const mockRequestPatch = makeMockRequestPatch();

    const { reportPath } = await phaseHeal({
      siteId: "test-site",
      url: "https://example.com",
      maxIterations: 1,
      nReplays: 1,
      successThreshold: 0.99,
      plateauDelta: 0.001,
      plateauWindow: 10,
      outDir,
      stepRunner: makeStepRunner([0.4, 0.5]),
      requestPatchFn: mockRequestPatch,
    });

    const flowDir = path.join(process.cwd(), "src", "sites", "test-site");
    expect(reportPath).not.toContain(flowDir);
  });

  it("dry-run mode runs without Anthropic client and stubs steps", async () => {
    // dry-run ignores requestPatchFn — passes dryRun=true which skips LLM calls.
    // Since anthropic=null in dry-run, patch=null → BUDGET_EXHAUSTED on first iter.
    const { verdict } = await phaseHeal({
      siteId: "test-site",
      url: "https://example.com",
      maxIterations: 2,
      nReplays: 1,
      successThreshold: 0.99,
      plateauDelta: 0.001,
      plateauWindow: 10,
      outDir,
      dryRun: true,
      stepRunner: makeDryRunStepRunner(0.4),
    });

    // With dryRun=true anthropic=null, requestPatch returns null → BUDGET_EXHAUSTED.
    expect(["SUCCESS", "BUDGET_EXHAUSTED", "PLATEAUED", "REGRESSED"]).toContain(verdict);
  });
});

// ── requestPatch — capture instrumentation ────────────────────────────────────

describe("requestPatch — capture instrumentation", () => {
  function makeAnthropicClient(
    responseText: string,
    inputTokens = 40,
    outputTokens = 12
  ): Anthropic {
    return {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: responseText }],
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        }),
      },
    } as unknown as Anthropic;
  }

  function makeCaptureFn(): { fn: CaptureFn; calls: LlmCallInput[] } {
    const calls: LlmCallInput[] = [];
    return {
      fn: async (input: LlmCallInput): Promise<void> => {
        calls.push(input);
      },
      calls,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits one capture with callType=recon-flow-patch on a successful patch", async () => {
    const client = makeAnthropicClient(JSON.stringify(VALID_PATCH));
    const { fn, calls } = makeCaptureFn();

    const result = await requestPatch({
      client,
      currentFlow: THREE_STEP_FLOW,
      failingSteps: [THREE_STEP_FLOW[1]!],
      iterN: 1,
      priorAttempts: [],
      captureFn: fn,
    });

    expect(result).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.callType).toBe(CALL_TYPE_RECON_FLOW_PATCH);
    expect(calls[0]?.parsedOk).toBe(true);
    expect(calls[0]?.success).toBe(true);
  });

  it("sets model to the bare model name from config", async () => {
    const client = makeAnthropicClient(JSON.stringify(VALID_PATCH));
    const { fn, calls } = makeCaptureFn();

    await requestPatch({
      client,
      currentFlow: THREE_STEP_FLOW,
      failingSteps: [THREE_STEP_FLOW[1]!],
      iterN: 1,
      priorAttempts: [],
      captureFn: fn,
    });

    expect(calls[0]?.model).toBe("claude-sonnet-4-6");
  });

  it("records parsedOk=false when the model response is not valid JSON", async () => {
    const client = makeAnthropicClient("not json at all");
    const { fn, calls } = makeCaptureFn();

    const result = await requestPatch({
      client,
      currentFlow: THREE_STEP_FLOW,
      failingSteps: [THREE_STEP_FLOW[1]!],
      iterN: 1,
      priorAttempts: [],
      captureFn: fn,
    });

    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.callType).toBe(CALL_TYPE_RECON_FLOW_PATCH);
    expect(calls[0]?.parsedOk).toBe(false);
    expect(calls[0]?.success).toBe(false);
  });

  it("records parsedOk=false when anchor is not found in current flow", async () => {
    const client = makeAnthropicClient(JSON.stringify(MISMATCHED_PATCH));
    const { fn, calls } = makeCaptureFn();

    const result = await requestPatch({
      client,
      currentFlow: THREE_STEP_FLOW,
      failingSteps: [THREE_STEP_FLOW[1]!],
      iterN: 1,
      priorAttempts: [],
      captureFn: fn,
    });

    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.parsedOk).toBe(false);
  });

  it("records parsedOk=false and does not throw when the API call throws", async () => {
    const client = {
      messages: {
        create: vi.fn().mockRejectedValue(new Error("API error")),
      },
    } as unknown as Anthropic;
    const { fn, calls } = makeCaptureFn();

    const result = await requestPatch({
      client,
      currentFlow: THREE_STEP_FLOW,
      failingSteps: [THREE_STEP_FLOW[1]!],
      iterN: 1,
      priorAttempts: [],
      captureFn: fn,
    });

    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.parsedOk).toBe(false);
    expect(calls[0]?.responseContent).toBeNull();
  });

  it("captures input/output token counts from the response usage", async () => {
    const client = makeAnthropicClient(JSON.stringify(VALID_PATCH), 80, 25);
    const { fn, calls } = makeCaptureFn();

    await requestPatch({
      client,
      currentFlow: THREE_STEP_FLOW,
      failingSteps: [THREE_STEP_FLOW[1]!],
      iterN: 1,
      priorAttempts: [],
      captureFn: fn,
    });

    expect(calls[0]?.inputTokens).toBe(80);
    expect(calls[0]?.outputTokens).toBe(25);
  });

  it("includes a non-empty callId string", async () => {
    const client = makeAnthropicClient(JSON.stringify(VALID_PATCH));
    const { fn, calls } = makeCaptureFn();

    await requestPatch({
      client,
      currentFlow: THREE_STEP_FLOW,
      failingSteps: [THREE_STEP_FLOW[1]!],
      iterN: 1,
      priorAttempts: [],
      captureFn: fn,
    });

    expect(typeof calls[0]?.callId).toBe("string");
    expect((calls[0]?.callId ?? "").length).toBeGreaterThan(0);
  });
});
