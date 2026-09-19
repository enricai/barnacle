import { describe, expect, it } from "vitest";

import { submitCaptchaGatedForm } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { SubmitCandidate } from "@/scraper/submit-control";

/**
 * `isNavigatingEvaluateRejection` (flow-runner.ts) is a single classifier shared
 * by the callback-invoke path and this click-dispatch/form-submit fallback. This
 * proves the fix landed at that shared definition rather than only in the
 * callback-invoke consumer: the ranked-candidate click dispatch here must
 * tolerate a rejection whose full message is the literal content-free
 * `StagehandEvalError: Uncaught` exactly the same way it already tolerates the
 * known teardown substrings (`target closed`, etc.), falling through to the
 * form-level submit instead of rethrowing.
 */

function makeFakeTarget(evaluateCalls: ((expr: unknown) => unknown)[]): FrameTarget {
  let callIndex = 0;
  return {
    frame: {} as FrameTarget["frame"],
    frameSelector: null,
    evaluate: (async (expr: unknown) => {
      const handler = evaluateCalls[callIndex];
      callIndex += 1;
      if (!handler) throw new Error(`unexpected evaluate call #${callIndex}: ${String(expr)}`);
      return handler(expr);
    }) as FrameTarget["evaluate"],
    locator: () => ({ scope: "frame" as const }) as never,
    url: () => Promise.resolve("https://apply.example.com/application/abc-123"),
    title: () => Promise.resolve("application form"),
  };
}

describe("flow-runner/submitCaptchaGatedForm — click-dispatch tolerates the generic content-free eval rejection", () => {
  it("resolves true when the ranked-candidate click dispatch rejects with the literal StagehandEvalError: Uncaught message, falling through to a successful form-level submit", async () => {
    const candidate: SubmitCandidate = { deepIndex: 0, tier: 1 };
    const target = makeFakeTarget([
      () => true,
      () => [candidate],
      () => {
        throw new Error("StagehandEvalError: Uncaught");
      },
      () => undefined,
    ]);

    await expect(submitCaptchaGatedForm(target)).resolves.toBe(true);
  });
});
