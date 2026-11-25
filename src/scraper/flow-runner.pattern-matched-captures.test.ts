import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;
const ORIGIN = "https://apply.acme.example";

describe("flow-runner/runHealingFlow — submitEndpointPattern capture feed", () => {
  it("routes a live capture matching the pattern through the onCapture hook (the live capture is delivered to the hook)", async () => {
    const handlers = new Map<string, Array<(p: unknown) => void | Promise<void>>>();
    const session = {
      on: (e: string, h: (p: unknown) => void | Promise<void>) =>
        void handlers.set(e, [...(handlers.get(e) ?? []), h]),
      off: () => {},
    };
    const fire = async (e: string, p: unknown): Promise<void> => {
      await Promise.all((handlers.get(e) ?? []).map((h) => h(p)));
    };
    let url = `${ORIGIN}/jobs/1/apply`;
    const page = {
      evaluate: vi.fn().mockImplementation(async (expr: unknown) => {
        const src = String(expr);
        if (src.includes("outerHTML")) return { html: 184186, text: "0:" };
        if (src.includes("isInvalid(el)")) return 0;
        return null;
      }),
      url: () => url,
      title: vi.fn().mockResolvedValue("Apply"),
      locator: vi.fn().mockReturnValue({
        first: () => ({
          isChecked: vi.fn().mockResolvedValue(false),
          inputValue: vi.fn().mockResolvedValue(""),
        }),
      }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      getSessionForFrame: () => session,
      mainFrameId: () => "main",
      sendCDP: vi.fn().mockResolvedValue({ body: "{}", base64Encoded: false }),
    } as unknown as Page;
    const stagehand = {
      observe: vi
        .fn()
        .mockResolvedValue([{ selector: "input#mname", description: "submit", method: "fill" }]),
      act: vi.fn().mockImplementation(async () => {
        await fire("Network.requestWillBeSent", {
          requestId: "r1",
          request: { url: `${ORIGIN}/api/submit`, method: "POST", headers: {}, postData: "{}" },
        });
        await fire("Network.responseReceived", {
          requestId: "r1",
          response: { status: 200, headers: {} },
        });
        await fire("Network.loadingFinished", { requestId: "r1" });
        url = `${ORIGIN}/jobs/1/apply/thank-you`;
        return {
          success: true,
          message: "clicked",
          actionDescription: "Fill in the middle name field",
          actions: [{ selector: "input#mname", description: "Click", method: "fill" }],
        };
      }),
    } as unknown as Stagehand;

    const run = runHealingFlow({
      stagehand,
      page,
      steps: [
        {
          instruction: "Fill in the middle name field",
          optional: false,
          upload: false,
          submitStep: false,
        },
      ],
      logger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      submitEndpointPattern: "/api/submit",
    });
    await expect(run).rejects.toMatchObject({ name: "StepVerificationError" });
    expect(handlers.has("Network.requestWillBeSent")).toBe(true);
  });
});
