/**
 * Unit tests for llm-heal.ts convergence state machine.
 *
 * All tests inject stub replayFn and requestPatchFn so no real API calls or
 * file I/O beyond a temp directory occur. The convergence state machine
 * (SUCCESS/PLATEAUED/BUDGET_EXHAUSTED/REGRESSED) is fully deterministic given
 * the injected stubs.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@/lib/telemetry/call-capture", () => ({
  captureLlmCall: vi.fn().mockResolvedValue(undefined),
}));

import type { JudgeVerdict } from "@/api/schemas/telemetry";
import {
  buildAnthropicClient,
  type LlmHealState,
  makeDryRunReplayFn,
  phaseLlmHeal,
  type ReplayFn,
  type RequestPromptPatchFn,
  replayPromptArm,
  writeLlmHealReport,
  writeLlmHealState,
} from "@/scripts/llm-heal";
import type { FlowPatch } from "@/scripts/recon-heal";

// ── fixtures ──────────────────────────────────────────────────────────────────

const VALID_PATCH: FlowPatch = {
  anchor: "Judge each response",
  replacement: "Carefully judge each response",
  strategy: "adds the adverb 'carefully' to increase scrutiny",
  pivot_reason: null,
};

function makeVerdict(overrides: Partial<JudgeVerdict> = {}): JudgeVerdict {
  return {
    callType: "act",
    batchIndex: 0,
    judgedAt: "2026-05-30T00:00:00Z",
    judgeModel: "claude-sonnet-4-6",
    verdicts: [
      {
        callId: "call-001",
        schemaOk: false,
        schemaRationale: "missing required field",
        factuallyGrounded: false,
        factualRationale: "contradicts userContent",
        hallucinationFree: false,
        hallucinationRationale: "fabricated URL",
        pass: false,
      },
      {
        callId: "call-002",
        schemaOk: false,
        schemaRationale: "wrong type for field",
        factuallyGrounded: true,
        factualRationale: "grounded",
        hallucinationFree: true,
        hallucinationRationale: "no hallucinations",
        pass: false,
      },
    ],
    aggregate: {
      n: 2,
      schemaPass: 0,
      factualPass: 1,
      hallucinationFreePass: 1,
      overallPass: 0,
    },
    ...overrides,
  };
}

function makeAllPassVerdict(): JudgeVerdict {
  return {
    callType: "act",
    batchIndex: 0,
    judgedAt: "2026-05-30T00:00:00Z",
    judgeModel: "claude-sonnet-4-6",
    verdicts: [
      {
        callId: "call-001",
        schemaOk: true,
        schemaRationale: "ok",
        factuallyGrounded: true,
        factualRationale: "ok",
        hallucinationFree: true,
        hallucinationRationale: "ok",
        pass: true,
      },
    ],
    aggregate: { n: 1, schemaPass: 1, factualPass: 1, hallucinationFreePass: 1, overallPass: 1 },
  };
}

// ── test helpers ──────────────────────────────────────────────────────────────

let tmpDir: string;
let outDir: string;
let verdictPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-heal-test-"));
  outDir = path.join(tmpDir, "llm-heal-out");
  fs.mkdirSync(outDir, { recursive: true });
  verdictPath = path.join(tmpDir, "verdict-act-0.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

function writeVerdictFile(verdict: JudgeVerdict): void {
  fs.writeFileSync(verdictPath, JSON.stringify(verdict, null, 2), "utf-8");
}

function makeReplayFnWithRates(passRates: number[]): ReplayFn {
  let callIdx = 0;
  return async ({ samples, nReplays }) => {
    const rate = passRates[callIdx] ?? passRates[passRates.length - 1] ?? 0;
    callIdx++;
    const total = samples.length * nReplays;
    const passCount = Math.round(total * rate);
    return {
      passRate: total > 0 ? passCount / total : 0,
      passCount,
      failCount: total - passCount,
    };
  };
}

function makeMockRequestPatch(patch: FlowPatch | null = VALID_PATCH): RequestPromptPatchFn {
  return vi.fn().mockResolvedValue(patch);
}

// ── buildAnthropicClient ──────────────────────────────────────────────────────

describe("buildAnthropicClient", () => {
  it("returns an Anthropic instance when apiKey is set and useBedrock is false", async () => {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = buildAnthropicClient();
    expect(client).toBeInstanceOf(Anthropic);
  });
});

// ── makeDryRunReplayFn ────────────────────────────────────────────────────────

describe("makeDryRunReplayFn", () => {
  it("returns passRate=1.0 by default", async () => {
    const fn = makeDryRunReplayFn();
    const result = await fn({
      samples: [
        {
          callId: "c1",
          callType: "act",
          model: "m",
          systemPrompt: null,
          userContent: "u",
          responseContent: null,
          parsedOk: false,
          inputTokens: null,
          outputTokens: null,
          latencyMs: null,
          success: false,
          errorMessage: null,
          failureKind: null,
          ts: "",
        },
      ],
      promptTemplate: "template",
      scorerFn: async () => ({
        schemaOk: true,
        schemaRationale: "",
        factuallyGrounded: true,
        factualRationale: "",
        hallucinationFree: true,
        hallucinationRationale: "",
      }),
      nReplays: 3,
    });
    expect(result.passRate).toBe(1.0);
    expect(result.passCount).toBe(3);
    expect(result.failCount).toBe(0);
  });

  it("returns the given passRate", async () => {
    const fn = makeDryRunReplayFn(0.5);
    const result = await fn({
      samples: [
        {
          callId: "c1",
          callType: "act",
          model: "m",
          systemPrompt: null,
          userContent: "u",
          responseContent: null,
          parsedOk: false,
          inputTokens: null,
          outputTokens: null,
          latencyMs: null,
          success: false,
          errorMessage: null,
          failureKind: null,
          ts: "",
        },
      ],
      promptTemplate: "template",
      scorerFn: async () => ({
        schemaOk: true,
        schemaRationale: "",
        factuallyGrounded: true,
        factualRationale: "",
        hallucinationFree: true,
        hallucinationRationale: "",
      }),
      nReplays: 4,
    });
    expect(result.passCount + result.failCount).toBe(4);
    expect(result.passRate).toBeCloseTo(Math.round(4 * 0.5) / 4);
  });

  it("handles zero samples without dividing by zero", async () => {
    const fn = makeDryRunReplayFn();
    const result = await fn({
      samples: [],
      promptTemplate: "template",
      scorerFn: async () => ({
        schemaOk: true,
        schemaRationale: "",
        factuallyGrounded: true,
        factualRationale: "",
        hallucinationFree: true,
        hallucinationRationale: "",
      }),
      nReplays: 5,
    });
    expect(result.passRate).toBe(0);
  });
});

// ── replayPromptArm ───────────────────────────────────────────────────────────

describe("replayPromptArm", () => {
  it("returns passRate=0 for empty samples", async () => {
    const result = await replayPromptArm({
      samples: [],
      promptTemplate: "template",
      scorerFn: async () => ({
        schemaOk: true,
        schemaRationale: "",
        factuallyGrounded: true,
        factualRationale: "",
        hallucinationFree: true,
        hallucinationRationale: "",
      }),
      nReplays: 3,
    });
    expect(result.passRate).toBe(0);
    expect(result.passCount).toBe(0);
    expect(result.failCount).toBe(0);
  });

  it("uses the patched prompt as systemPrompt when calling scorer", async () => {
    const capturedSystemPrompts: (string | null)[] = [];
    const result = await replayPromptArm({
      samples: [
        {
          callId: "c1",
          callType: "act",
          model: "m",
          systemPrompt: "old-prompt",
          userContent: "u",
          responseContent: null,
          parsedOk: false,
          inputTokens: null,
          outputTokens: null,
          latencyMs: null,
          success: false,
          errorMessage: null,
          failureKind: null,
          ts: "",
        },
      ],
      promptTemplate: "new-patched-prompt",
      scorerFn: async (sample) => {
        capturedSystemPrompts.push(sample.systemPrompt);
        return {
          schemaOk: true,
          schemaRationale: "",
          factuallyGrounded: true,
          factualRationale: "",
          hallucinationFree: true,
          hallucinationRationale: "",
        };
      },
      nReplays: 2,
    });
    expect(capturedSystemPrompts.every((p) => p === "new-patched-prompt")).toBe(true);
    expect(result.passRate).toBe(1.0);
  });

  it("counts passes correctly when scorer returns mixed results", async () => {
    let callCount = 0;
    const result = await replayPromptArm({
      samples: [
        {
          callId: "c1",
          callType: "act",
          model: "m",
          systemPrompt: null,
          userContent: "u",
          responseContent: null,
          parsedOk: false,
          inputTokens: null,
          outputTokens: null,
          latencyMs: null,
          success: false,
          errorMessage: null,
          failureKind: null,
          ts: "",
        },
      ],
      promptTemplate: "template",
      scorerFn: async () => {
        const pass = callCount++ % 2 === 0;
        return {
          schemaOk: pass,
          schemaRationale: "",
          factuallyGrounded: pass,
          factualRationale: "",
          hallucinationFree: pass,
          hallucinationRationale: "",
        };
      },
      nReplays: 4,
    });
    // Alternating pass/fail over 4 replays → 2 pass, 2 fail
    expect(result.passCount).toBe(2);
    expect(result.failCount).toBe(2);
    expect(result.passRate).toBe(0.5);
  });
});

// ── writeLlmHealState ─────────────────────────────────────────────────────────

describe("writeLlmHealState", () => {
  it("writes state.json under outDir/callType/", () => {
    const state: LlmHealState = {
      callType: "act",
      baselinePassRate: 0.3,
      history: [],
      bestPassRate: 0.3,
      bestPatch: null,
      bestIterN: 0,
    };
    writeLlmHealState(outDir, "act", state);
    const statePath = path.join(outDir, "act", "state.json");
    expect(fs.existsSync(statePath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf-8")) as LlmHealState;
    expect(parsed.callType).toBe("act");
    expect(parsed.baselinePassRate).toBe(0.3);
  });
});

// ── writeLlmHealReport ────────────────────────────────────────────────────────

describe("writeLlmHealReport", () => {
  it("writes healing-<callType>.md with required sections", () => {
    const state: LlmHealState = {
      callType: "act",
      baselinePassRate: 0.2,
      history: [
        { iterN: 1, passRate: 0.6, patch: VALID_PATCH },
        { iterN: 2, passRate: 0.95, patch: VALID_PATCH },
      ],
      bestPassRate: 0.95,
      bestPatch: VALID_PATCH,
      bestIterN: 2,
    };
    const reportPath = writeLlmHealReport({ outDir, callType: "act", state, verdict: "SUCCESS" });
    expect(fs.existsSync(reportPath)).toBe(true);
    const content = fs.readFileSync(reportPath, "utf-8");
    expect(content).toContain("# Heal report: act");
    expect(content).toContain("**Verdict:** SUCCESS");
    expect(content).toContain("**Baseline pass rate:** 20%");
    expect(content).toContain("**Best pass rate:** 95%");
    expect(content).toContain(VALID_PATCH.anchor);
    expect(content).toContain(VALID_PATCH.replacement);
    expect(content).toContain("| iter | pass_rate |");
    expect(content).toContain("Production prompt templates were NOT modified");
  });

  it("places the report at outDir/callType/healing-<callType>.md", () => {
    const state: LlmHealState = {
      callType: "act",
      baselinePassRate: 0.0,
      history: [],
      bestPassRate: 0.0,
      bestPatch: null,
      bestIterN: 0,
    };
    const reportPath = writeLlmHealReport({
      outDir,
      callType: "act",
      state,
      verdict: "BUDGET_EXHAUSTED",
    });
    expect(reportPath).toBe(path.join(outDir, "act", "healing-act.md"));
  });

  it("shows '(no patch improved the baseline)' when bestPatch is null", () => {
    const state: LlmHealState = {
      callType: "act",
      baselinePassRate: 0.1,
      history: [],
      bestPassRate: 0.1,
      bestPatch: null,
      bestIterN: 0,
    };
    const reportPath = writeLlmHealReport({ outDir, callType: "act", state, verdict: "PLATEAUED" });
    const content = fs.readFileSync(reportPath, "utf-8");
    expect(content).toContain("(no patch improved the baseline)");
  });
});

// ── phaseLlmHeal — convergence state machine ──────────────────────────────────

describe("phaseLlmHeal", () => {
  it("SUCCESS: baseline low, iter-1 patch lifts pass_rate above threshold → verdict=SUCCESS", async () => {
    writeVerdictFile(makeVerdict());
    const replayFn = makeReplayFnWithRates([0.2, 0.95]);
    const mockRequestPatch = makeMockRequestPatch();

    const { verdict, state, reportPath } = await phaseLlmHeal({
      verdictPath,
      callType: "act",
      maxIterations: 5,
      nReplays: 1,
      successThreshold: 0.9,
      plateauDelta: 0.03,
      plateauWindow: 3,
      outDir,
      dryRun: true,
      replayFn,
      requestPatchFn: mockRequestPatch,
    });

    expect(verdict).toBe("SUCCESS");
    expect(state.history).toHaveLength(1);
    expect(state.bestPassRate).toBeGreaterThanOrEqual(0.9);

    expect(fs.existsSync(reportPath)).toBe(true);
    const report = fs.readFileSync(reportPath, "utf-8");
    expect(report).toContain("**Verdict:** SUCCESS");
    expect(report).toContain("| iter | pass_rate |");
  });

  it("BUDGET_EXHAUSTED: maxIterations reached without convergence", async () => {
    writeVerdictFile(makeVerdict());
    // Vary rates slightly so plateau doesn't trigger first.
    const replayFn = makeReplayFnWithRates([0.3, 0.35, 0.32, 0.38]);
    const mockRequestPatch = makeMockRequestPatch();

    const { verdict } = await phaseLlmHeal({
      verdictPath,
      callType: "act",
      maxIterations: 2,
      nReplays: 1,
      successThreshold: 0.99,
      plateauDelta: 0.001,
      plateauWindow: 10,
      outDir,
      dryRun: true,
      replayFn,
      requestPatchFn: mockRequestPatch,
    });

    expect(verdict).toBe("BUDGET_EXHAUSTED");
  });

  it("PLATEAUED: last plateau_window iters within plateau_delta → verdict=PLATEAUED", async () => {
    writeVerdictFile(makeVerdict());
    // baseline=0.4, iter1=0.41, iter2=0.40, iter3=0.42 — span 0.02 < 0.03
    const replayFn = makeReplayFnWithRates([0.4, 0.41, 0.4, 0.42]);
    const mockRequestPatch = makeMockRequestPatch();

    const { verdict } = await phaseLlmHeal({
      verdictPath,
      callType: "act",
      maxIterations: 5,
      nReplays: 1,
      successThreshold: 0.9,
      plateauDelta: 0.03,
      plateauWindow: 3,
      outDir,
      dryRun: true,
      replayFn,
      requestPatchFn: mockRequestPatch,
    });

    expect(["PLATEAUED", "BUDGET_EXHAUSTED"]).toContain(verdict);
  });

  it("REGRESSED: plateau_window consecutive iters drop below best → verdict=REGRESSED", async () => {
    // Use a verdict with 10 failing samples so passRates don't accidentally round to 1.0.
    const bigVerdict = makeVerdict({
      verdicts: Array.from({ length: 10 }, (_, i) => ({
        callId: `call-${i}`,
        schemaOk: false,
        schemaRationale: "fail",
        factuallyGrounded: false,
        factualRationale: "fail",
        hallucinationFree: false,
        hallucinationRationale: "fail",
        pass: false,
      })),
      aggregate: { n: 10, schemaPass: 0, factualPass: 0, hallucinationFreePass: 0, overallPass: 0 },
    });
    writeVerdictFile(bigVerdict);

    // baseline=0.3, iter1=0.7 (best), iter2/3/4=0.1 (all > 0.03 below best=0.7)
    // success threshold=0.99 so iter1's 0.7 can't trigger SUCCESS.
    const replayFn = makeReplayFnWithRates([0.3, 0.7, 0.1, 0.1, 0.1]);
    const mockRequestPatch = makeMockRequestPatch();

    const { verdict } = await phaseLlmHeal({
      verdictPath,
      callType: "act",
      maxIterations: 5,
      nReplays: 1,
      successThreshold: 0.99,
      plateauDelta: 0.03,
      plateauWindow: 3,
      outDir,
      dryRun: true,
      replayFn,
      requestPatchFn: mockRequestPatch,
    });

    expect(verdict).toBe("REGRESSED");
  });

  it("SUCCESS immediately when all samples already pass in the verdict", async () => {
    writeVerdictFile(makeAllPassVerdict());
    const mockRequestPatch = makeMockRequestPatch();

    const { verdict } = await phaseLlmHeal({
      verdictPath,
      callType: "act",
      maxIterations: 5,
      nReplays: 1,
      successThreshold: 0.9,
      plateauDelta: 0.03,
      plateauWindow: 3,
      outDir,
      dryRun: true,
      replayFn: makeDryRunReplayFn(1.0),
      requestPatchFn: mockRequestPatch,
    });

    expect(verdict).toBe("SUCCESS");
    expect(mockRequestPatch).not.toHaveBeenCalled();
  });

  it("BUDGET_EXHAUSTED when patch generator returns null on first iter", async () => {
    writeVerdictFile(makeVerdict());
    const replayFn = makeReplayFnWithRates([0.2]);
    const mockRequestPatch = makeMockRequestPatch(null);

    const { verdict } = await phaseLlmHeal({
      verdictPath,
      callType: "act",
      maxIterations: 5,
      nReplays: 1,
      successThreshold: 0.9,
      plateauDelta: 0.03,
      plateauWindow: 3,
      outDir,
      dryRun: true,
      replayFn,
      requestPatchFn: mockRequestPatch,
    });

    expect(verdict).toBe("BUDGET_EXHAUSTED");
  });

  it("writes state.json and iter-1/ artifacts on each iteration", async () => {
    writeVerdictFile(makeVerdict());
    const replayFn = makeReplayFnWithRates([0.2, 0.5, 0.6]);
    const mockRequestPatch = makeMockRequestPatch();

    await phaseLlmHeal({
      verdictPath,
      callType: "act",
      maxIterations: 2,
      nReplays: 1,
      successThreshold: 0.99,
      plateauDelta: 0.001,
      plateauWindow: 10,
      outDir,
      dryRun: true,
      replayFn,
      requestPatchFn: mockRequestPatch,
    });

    const statePath = path.join(outDir, "act", "state.json");
    expect(fs.existsSync(statePath)).toBe(true);
    const iter1Dir = path.join(outDir, "act", "iter-1");
    expect(fs.existsSync(iter1Dir)).toBe(true);
    expect(fs.existsSync(path.join(iter1Dir, "patch-response.json"))).toBe(true);
    expect(fs.existsSync(path.join(iter1Dir, "patched-prompt.txt"))).toBe(true);
    expect(fs.existsSync(path.join(iter1Dir, "scores.json"))).toBe(true);
  });

  it("production prompts not mutated — verdict file is NOT modified", async () => {
    writeVerdictFile(makeVerdict());
    const originalContent = fs.readFileSync(verdictPath, "utf-8");
    const replayFn = makeReplayFnWithRates([0.2, 0.5]);
    const mockRequestPatch = makeMockRequestPatch();

    await phaseLlmHeal({
      verdictPath,
      callType: "act",
      maxIterations: 1,
      nReplays: 1,
      successThreshold: 0.99,
      plateauDelta: 0.001,
      plateauWindow: 10,
      outDir,
      dryRun: true,
      replayFn,
      requestPatchFn: mockRequestPatch,
    });

    expect(fs.readFileSync(verdictPath, "utf-8")).toBe(originalContent);
  });

  it("throws on a missing verdict file", async () => {
    await expect(
      phaseLlmHeal({
        verdictPath: path.join(tmpDir, "nonexistent.json"),
        callType: "act",
        outDir,
        dryRun: true,
        replayFn: makeDryRunReplayFn(),
        requestPatchFn: makeMockRequestPatch(),
      })
    ).rejects.toThrow();
  });

  it("throws on a verdict file with invalid schema", async () => {
    fs.writeFileSync(verdictPath, JSON.stringify({ bad: "shape" }), "utf-8");

    await expect(
      phaseLlmHeal({
        verdictPath,
        callType: "act",
        outDir,
        dryRun: true,
        replayFn: makeDryRunReplayFn(),
        requestPatchFn: makeMockRequestPatch(),
      })
    ).rejects.toThrow();
  });
});
