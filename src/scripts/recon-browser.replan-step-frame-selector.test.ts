import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

const { resolveFrameTargetSpy } = vi.hoisted(() => ({ resolveFrameTargetSpy: vi.fn() }));
vi.mock("@/scraper/frame-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/frame-target")>();
  return { ...actual, resolveFrameTarget: resolveFrameTargetSpy };
});

import { inheritStepFrameSelector, replanRemainingFlow } from "@/scripts/recon-browser";

describe("replan — step frameSelector", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    resolveFrameTargetSpy.mockReset();
  });

  it("probes the frame named by the selector it is given", async () => {
    dir = mkdtempSync(join(tmpdir(), "replan-frame-"));
    const dump = join(dir, "dump.json");
    writeFileSync(dump, JSON.stringify({ bodyOuterHtml: "<body></body>" }));
    const frameTarget = { evaluate: vi.fn().mockResolvedValue([]) };
    resolveFrameTargetSpy.mockResolvedValue(frameTarget);
    const client = {
      messages: {
        parse: vi.fn().mockResolvedValue({
          parsed_output: {
            outcome: "replan",
            steps: ["Click A", { step: "Click B", frameSelector: "#own" }],
          },
          content: [{ type: "text", text: "{}" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      },
    } as unknown as Anthropic;
    const steps = await replanRemainingFlow({
      client,
      originalFlow: ["x"],
      completedSteps: [],
      failedStep: "x",
      remainingSteps: [],
      failureDumpPath: dump,
      page: { url: () => "u", title: async () => "t" } as never,
      stagehand: { observe: vi.fn().mockResolvedValue([]) } as never,
      captureFn: async () => {},
      frameSelector: "#step_frame",
    });
    expect(resolveFrameTargetSpy.mock.calls.map((c) => c[1])).toContain("#step_frame");
    expect(steps?.[1]?.frameSelector).toBe("#own");
  });

  it("replanned steps inherit the failed step's frameSelector; flow-level unchanged", () => {
    const base = { optional: false, upload: false, origin: "replan" as const };
    const steps = [
      { instruction: "a", ...base },
      { instruction: "b", frameSelector: "#own", ...base },
    ];
    const out = inheritStepFrameSelector(steps, "#step");
    expect(out.map((s) => s.frameSelector)).toEqual(["#step", "#own"]);
    expect(inheritStepFrameSelector(steps, undefined)).toBe(steps);
  });
});
