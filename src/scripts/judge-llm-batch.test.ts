/**
 * Unit tests for judge-llm-batch.ts.
 *
 * All tests use a fixture NDJSON string and an injected scorer stub — no live
 * model calls, no API keys, no filesystem side-effects beyond a temp dir.
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
    },
    telemetry: {
      callsNdjsonPath: ".barnacle/calls.ndjson",
    },
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

import { judgeVerdictSchema, type LlmCallSample } from "@/api/schemas/telemetry";
import {
  aggregate,
  computeVerdict,
  filterByCallType,
  makeDryRunScorer,
  parseSamples,
  runJudge,
  type SampleScore,
  writeVerdict,
} from "@/scripts/judge-llm-batch";

// ── fixtures ──────────────────────────────────────────────────────────────────

function makeSample(overrides: Partial<LlmCallSample> = {}): LlmCallSample {
  return {
    callId: "call-001",
    callType: "act",
    model: "anthropic/claude-sonnet-4-6",
    systemPrompt: "You are a browser automation agent.",
    userContent: "Click the login button.",
    responseContent: '{"success": true}',
    parsedOk: true,
    inputTokens: 42,
    outputTokens: 8,
    latencyMs: 312,
    success: true,
    errorMessage: null,
    failureKind: null,
    ts: "2026-05-30T00:00:00Z",
    ...overrides,
  };
}

const PASSING_SCORE: SampleScore = {
  schemaOk: true,
  schemaRationale: "response matches the expected structure",
  factuallyGrounded: true,
  factualRationale: "all claims are grounded in the userContent",
  hallucinationFree: true,
  hallucinationRationale: "no fabricated content detected",
};

const FAILING_SCORE: SampleScore = {
  schemaOk: false,
  schemaRationale: "response does not match expected shape",
  factuallyGrounded: false,
  factualRationale: "claims contradict userContent",
  hallucinationFree: false,
  hallucinationRationale: "fabricated URLs detected",
  worstOffender: "https://fake-url.example",
};

function sampleToNdjson(s: LlmCallSample): string {
  return JSON.stringify(s);
}

// ── test setup ────────────────────────────────────────────────────────────────

let tmpDir: string;
let outDir: string;
let callsNdjsonPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "judge-llm-batch-test-"));
  outDir = path.join(tmpDir, "judge-out");
  callsNdjsonPath = path.join(tmpDir, "calls.ndjson");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// ── parseSamples ──────────────────────────────────────────────────────────────

describe("parseSamples", () => {
  it("parses a single valid NDJSON line", () => {
    const sample = makeSample();
    const result = parseSamples(sampleToNdjson(sample));
    expect(result).toHaveLength(1);
    expect(result[0]!.callId).toBe("call-001");
  });

  it("parses multiple valid lines", () => {
    const lines = [makeSample({ callId: "a" }), makeSample({ callId: "b" })];
    const ndjson = lines.map(sampleToNdjson).join("\n");
    const result = parseSamples(ndjson);
    expect(result).toHaveLength(2);
    expect(result[0]!.callId).toBe("a");
    expect(result[1]!.callId).toBe("b");
  });

  it("skips blank lines without error", () => {
    const line = sampleToNdjson(makeSample());
    const result = parseSamples(`${line}\n\n`);
    expect(result).toHaveLength(1);
  });

  it("returns a sample with parsedOk=false for invalid JSON", () => {
    const result = parseSamples("this is not json");
    expect(result).toHaveLength(1);
    expect(result[0]!.parsedOk).toBe(false);
    expect(result[0]!.callType).toBe("unknown");
  });

  it("returns parsedOk=false for JSON that fails Zod validation", () => {
    const badJson = JSON.stringify({ unexpected: "shape" });
    const result = parseSamples(badJson);
    expect(result).toHaveLength(1);
    expect(result[0]!.parsedOk).toBe(false);
  });

  it("handles a mix of valid and invalid lines", () => {
    const good = sampleToNdjson(makeSample({ callId: "good" }));
    const bad = "not-json";
    const result = parseSamples(`${good}\n${bad}`);
    expect(result).toHaveLength(2);
    expect(result.some((s) => s.callId === "good")).toBe(true);
    expect(result.some((s) => s.parsedOk === false)).toBe(true);
  });

  it("returns an empty array for empty input", () => {
    const result = parseSamples("");
    expect(result).toHaveLength(0);
  });
});

// ── filterByCallType ──────────────────────────────────────────────────────────

describe("filterByCallType", () => {
  it("keeps only samples matching the requested callType", () => {
    const samples = [
      makeSample({ callId: "a", callType: "act" }),
      makeSample({ callId: "b", callType: "extract" }),
      makeSample({ callId: "c", callType: "act" }),
    ];
    const result = filterByCallType(samples, "act");
    expect(result).toHaveLength(2);
    expect(result.every((s) => s.callType === "act")).toBe(true);
  });

  it("returns an empty array when no samples match", () => {
    const samples = [makeSample({ callType: "act" })];
    const result = filterByCallType(samples, "observe");
    expect(result).toHaveLength(0);
  });

  it("returns all samples when all match", () => {
    const samples = [makeSample(), makeSample({ callId: "b" })];
    const result = filterByCallType(samples, "act");
    expect(result).toHaveLength(2);
  });
});

// ── computeVerdict ────────────────────────────────────────────────────────────

describe("computeVerdict", () => {
  it("pass=true when all three dimensions pass", () => {
    const sample = makeSample();
    const entry = computeVerdict(sample, PASSING_SCORE);
    expect(entry.pass).toBe(true);
    expect(entry.schemaOk).toBe(true);
    expect(entry.factuallyGrounded).toBe(true);
    expect(entry.hallucinationFree).toBe(true);
    expect(entry.callId).toBe("call-001");
  });

  it("pass=false when any dimension fails", () => {
    const sample = makeSample();
    const entry = computeVerdict(sample, FAILING_SCORE);
    expect(entry.pass).toBe(false);
    expect(entry.schemaOk).toBe(false);
    expect(entry.worstOffender).toBe("https://fake-url.example");
  });

  it("parsedOk=false forces schemaOk=false regardless of scorer", () => {
    const sample = makeSample({ parsedOk: false });
    const score = { ...PASSING_SCORE, schemaOk: true };
    const entry = computeVerdict(sample, score);
    expect(entry.schemaOk).toBe(false);
    expect(entry.schemaRationale).toContain("parsedOk=false");
  });

  it("parsedOk=false also causes pass=false", () => {
    const sample = makeSample({ parsedOk: false });
    const entry = computeVerdict(sample, PASSING_SCORE);
    expect(entry.pass).toBe(false);
  });

  it("preserves rationale fields from the scorer", () => {
    const sample = makeSample();
    const entry = computeVerdict(sample, PASSING_SCORE);
    expect(entry.schemaRationale).toBe(PASSING_SCORE.schemaRationale);
    expect(entry.factualRationale).toBe(PASSING_SCORE.factualRationale);
    expect(entry.hallucinationRationale).toBe(PASSING_SCORE.hallucinationRationale);
  });

  it("omits worstOffender when scorer does not return one", () => {
    const sample = makeSample();
    const entry = computeVerdict(sample, PASSING_SCORE);
    expect("worstOffender" in entry).toBe(false);
  });

  it("includes worstOffender when scorer returns one", () => {
    const sample = makeSample();
    const entry = computeVerdict(sample, FAILING_SCORE);
    expect(entry.worstOffender).toBe("https://fake-url.example");
  });
});

// ── aggregate ────────────────────────────────────────────────────────────────

describe("aggregate", () => {
  it("returns all zeros for empty verdicts", () => {
    const agg = aggregate([]);
    expect(agg).toEqual({
      n: 0,
      schemaPass: 0,
      factualPass: 0,
      hallucinationFreePass: 0,
      overallPass: 0,
    });
  });

  it("counts passes correctly for a mixed batch", () => {
    const passing = computeVerdict(makeSample({ callId: "a" }), PASSING_SCORE);
    const failing = computeVerdict(makeSample({ callId: "b" }), FAILING_SCORE);
    const partial = computeVerdict(makeSample({ callId: "c" }), {
      ...PASSING_SCORE,
      factuallyGrounded: false,
      factualRationale: "not grounded",
    });

    const agg = aggregate([passing, failing, partial]);

    expect(agg.n).toBe(3);
    // schemaOk: passing=true, failing=false, partial=true → 2
    expect(agg.schemaPass).toBe(2);
    // factuallyGrounded: passing=true, failing=false, partial=false → 1
    expect(agg.factualPass).toBe(1);
    // hallucinationFree: passing=true, failing=false, partial=true → 2
    expect(agg.hallucinationFreePass).toBe(2);
    // overall pass: only passing meets all three → 1
    expect(agg.overallPass).toBe(1);
  });

  it("all pass when every verdict passes", () => {
    const verdicts = [
      computeVerdict(makeSample({ callId: "a" }), PASSING_SCORE),
      computeVerdict(makeSample({ callId: "b" }), PASSING_SCORE),
    ];
    const agg = aggregate(verdicts);
    expect(agg.n).toBe(2);
    expect(agg.schemaPass).toBe(2);
    expect(agg.factualPass).toBe(2);
    expect(agg.hallucinationFreePass).toBe(2);
    expect(agg.overallPass).toBe(2);
  });
});

// ── writeVerdict ──────────────────────────────────────────────────────────────

describe("writeVerdict", () => {
  function makeVerdict(
    overrides: Partial<import("@/api/schemas/telemetry").JudgeVerdict> = {}
  ): import("@/api/schemas/telemetry").JudgeVerdict {
    return {
      callType: "act",
      batchIndex: 0,
      judgedAt: "2026-05-30T00:00:00Z",
      judgeModel: "claude-sonnet-4-6",
      verdicts: [],
      aggregate: { n: 0, schemaPass: 0, factualPass: 0, hallucinationFreePass: 0, overallPass: 0 },
      ...overrides,
    };
  }

  it("writes a JSON file to outDir", () => {
    const verdict = makeVerdict();
    const filePath = writeVerdict({ outDir, verdict });
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("names the file verdict-<callType>-<batchIndex>.json", () => {
    const verdict = makeVerdict({ callType: "extract", batchIndex: 2 });
    const filePath = writeVerdict({ outDir, verdict });
    expect(path.basename(filePath)).toBe("verdict-extract-2.json");
  });

  it("written file is valid JSON and passes judgeVerdictSchema", () => {
    const verdict = makeVerdict();
    const filePath = writeVerdict({ outDir, verdict });
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
    const result = judgeVerdictSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it("creates outDir if it does not exist", () => {
    const deepOut = path.join(tmpDir, "deep", "out");
    const verdict = makeVerdict();
    writeVerdict({ outDir: deepOut, verdict });
    expect(fs.existsSync(deepOut)).toBe(true);
  });

  it("throws if the verdict does not satisfy the schema", () => {
    const badVerdict = {
      callType: 42,
    } as unknown as import("@/api/schemas/telemetry").JudgeVerdict;
    expect(() => writeVerdict({ outDir, verdict: badVerdict })).toThrow();
  });
});

// ── makeDryRunScorer ──────────────────────────────────────────────────────────

describe("makeDryRunScorer", () => {
  it("returns all-true scores for any sample", async () => {
    const scorer = makeDryRunScorer();
    const score = await scorer(makeSample());
    expect(score.schemaOk).toBe(true);
    expect(score.factuallyGrounded).toBe(true);
    expect(score.hallucinationFree).toBe(true);
  });
});

// ── runJudge — integration over the pure core ─────────────────────────────────

describe("runJudge", () => {
  function writeSamples(samples: LlmCallSample[]): void {
    const ndjson = `${samples.map((s) => JSON.stringify(s)).join("\n")}\n`;
    fs.writeFileSync(callsNdjsonPath, ndjson, "utf-8");
  }

  it("filters by callType and produces the correct verdict file", async () => {
    const samples = [
      makeSample({ callId: "a", callType: "act" }),
      makeSample({ callId: "b", callType: "extract" }),
      makeSample({ callId: "c", callType: "act" }),
    ];
    writeSamples(samples);

    const scorer = vi.fn().mockResolvedValue(PASSING_SCORE);
    const { verdict, verdictPath } = await runJudge({
      callsNdjsonPath,
      callType: "act",
      outDir,
      scorerFn: scorer,
    });

    expect(scorer).toHaveBeenCalledTimes(2);
    expect(verdict.callType).toBe("act");
    expect(verdict.verdicts).toHaveLength(2);
    expect(verdict.aggregate.n).toBe(2);
    expect(verdict.aggregate.overallPass).toBe(2);
    expect(fs.existsSync(verdictPath)).toBe(true);
  });

  it("parsedOk=false auto-fails schema adherence without calling scorer differently", async () => {
    const sample = makeSample({ callId: "bad", parsedOk: false });
    writeSamples([sample]);

    const scorer = vi.fn().mockResolvedValue(PASSING_SCORE);
    const { verdict } = await runJudge({
      callsNdjsonPath,
      callType: "act",
      outDir,
      scorerFn: scorer,
    });

    expect(verdict.verdicts).toHaveLength(1);
    const entry = verdict.verdicts[0]!;
    expect(entry.schemaOk).toBe(false);
    expect(entry.pass).toBe(false);
    expect(entry.schemaRationale).toContain("parsedOk=false");
  });

  it("writes a schema-valid verdict JSON", async () => {
    const samples = [makeSample({ callId: "a" }), makeSample({ callId: "b" })];
    writeSamples(samples);

    const scorer = vi.fn().mockResolvedValue(PASSING_SCORE);
    const { verdictPath } = await runJudge({
      callsNdjsonPath,
      callType: "act",
      outDir,
      scorerFn: scorer,
    });

    const parsed = JSON.parse(fs.readFileSync(verdictPath, "utf-8")) as unknown;
    const result = judgeVerdictSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it("aggregate counts match hand-counted totals", async () => {
    const samples = [
      makeSample({ callId: "a" }),
      makeSample({ callId: "b" }),
      makeSample({ callId: "c" }),
    ];
    writeSamples(samples);

    let callIdx = 0;
    const scores = [PASSING_SCORE, FAILING_SCORE, PASSING_SCORE];
    const scorer = vi.fn().mockImplementation(async () => scores[callIdx++]!);

    const { verdict } = await runJudge({
      callsNdjsonPath,
      callType: "act",
      outDir,
      scorerFn: scorer,
    });

    // passing + failing + passing
    // schemaOk: 2 (a=true, b=false, c=true)
    // factuallyGrounded: 2 (a=true, b=false, c=true)
    // hallucinationFree: 2 (a=true, b=false, c=true)
    // overallPass: 2 (a=true, b=false, c=true)
    expect(verdict.aggregate.n).toBe(3);
    expect(verdict.aggregate.schemaPass).toBe(2);
    expect(verdict.aggregate.factualPass).toBe(2);
    expect(verdict.aggregate.hallucinationFreePass).toBe(2);
    expect(verdict.aggregate.overallPass).toBe(2);
  });

  it("uses batchIndex in the output file name", async () => {
    writeSamples([makeSample()]);
    const scorer = vi.fn().mockResolvedValue(PASSING_SCORE);

    const { verdictPath } = await runJudge({
      callsNdjsonPath,
      callType: "act",
      batchIndex: 3,
      outDir,
      scorerFn: scorer,
    });

    expect(path.basename(verdictPath)).toBe("verdict-act-3.json");
  });

  it("dry-run mode uses the dry-run scorer without any API call", async () => {
    writeSamples([makeSample()]);

    const { verdict } = await runJudge({
      callsNdjsonPath,
      callType: "act",
      outDir,
      dryRun: true,
    });

    expect(verdict.verdicts).toHaveLength(1);
    expect(verdict.verdicts[0]!.pass).toBe(true);
    expect(verdict.judgeModel).toBe("dry-run");
  });

  it("returns 0 verdicts for an empty callType match", async () => {
    writeSamples([makeSample({ callType: "observe" })]);
    const scorer = vi.fn().mockResolvedValue(PASSING_SCORE);

    const { verdict } = await runJudge({
      callsNdjsonPath,
      callType: "act",
      outDir,
      scorerFn: scorer,
    });

    expect(scorer).not.toHaveBeenCalled();
    expect(verdict.aggregate.n).toBe(0);
  });

  it("throws when the calls NDJSON file does not exist", async () => {
    await expect(
      runJudge({
        callsNdjsonPath: path.join(tmpDir, "nonexistent.ndjson"),
        callType: "act",
        outDir,
        dryRun: true,
      })
    ).rejects.toThrow();
  });
});
