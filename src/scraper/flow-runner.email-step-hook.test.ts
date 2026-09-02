import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.RECON_RUN_ID = "flow-runner-email-step-hook-test";
process.env.RECON_OUT_DIR = mkdtempSync(join(tmpdir(), "recon-email-step-hook-"));

const { pollTestmailInboxMock } = vi.hoisted(() => ({ pollTestmailInboxMock: vi.fn() }));
vi.mock("@/testmail/client", async () => {
  const actual = await vi.importActual<typeof import("@/testmail/client")>("@/testmail/client");
  return { ...actual, pollTestmailInbox: pollTestmailInboxMock };
});

import { EmailStepExtractError, EmailStepInboxUnavailableError } from "@/scraper/errors";
import {
  executeStepWithHealing,
  extractCodeFromMessage,
  extractLinkFromMessage,
} from "@/scraper/flow-runner";
import type { TestmailInbox, TestmailMessage } from "@/testmail/client";
import type { Logger } from "@/types/logging";

/**
 * Exercises the `emailStep` hook wired into `executeStepWithHealing` — the
 * inbox-unavailable guard, the link/code extraction helpers, the
 * registrable-domain allowlist gate, and (critically) that the guard fires
 * BEFORE any other cascade primitive (upload/select/etc.) runs, since a
 * shape-matching step must never let an unrelated primitive silently claim
 * an `emailStep` step ahead of the inbox check.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const inbox: TestmailInbox = {
  address: "ns.tag@inbox.testmail.app",
  tag: "tag",
  timestampFrom: 0,
};

function makeMessage(overrides: Partial<TestmailMessage> = {}): TestmailMessage {
  return {
    id: "msg-1",
    from: "noreply@example.com",
    subject: "Verify your application",
    text: null,
    html: null,
    date: Date.now(),
    ...overrides,
  };
}

function baseParams(
  page: Page,
  stagehand: Stagehand,
  overrides: Partial<Parameters<typeof executeStepWithHealing>[0]>
): Parameters<typeof executeStepWithHealing>[0] {
  return {
    stagehand,
    page,
    step: "Fill in the verification code field with 'placeholder'",
    optional: false,
    upload: false,
    submitStep: false,
    flowHasSubmitSemantics: false,
    stepIndex: 0,
    phase: "apply",
    signalCounter: { n: 0 },
    recentCaptures: [] as string[],
    recentCaptureMeta: [] as { method: string; status: number; url: string }[],
    anthropic: null,
    rephraseModel: null,
    logger: testLogger,
    captureFn: vi.fn().mockResolvedValue(undefined),
    uploadFixture: null,
    isFinalStep: false,
    submitEndpointPattern: null,
    submittedStateSelectors: [] as string[],
    requireSubmitEndpointMatch: false,
    advanceTransitionBodyPattern: null,
    successUrlFragments: [] as string[],
    successPageTitleHints: [] as string[],
    ownBackendHostnames: [] as string[],
    knownErrorClassPrefixes: [] as string[],
    wizardExitButtonLabels: [] as string[],
    ...overrides,
  };
}

function makeFakePage(url = "https://apply.example.com/application/abc-123"): Page {
  return {
    evaluate: vi.fn().mockResolvedValue(null),
    url: () => url,
    title: vi.fn().mockResolvedValue(""),
    goto: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

describe("extractLinkFromMessage / extractCodeFromMessage (pure helpers)", () => {
  it("extracts the first URL sharing the current page's registrable domain by default", () => {
    const msg = makeMessage({
      text: "Click here: https://other.tld/x then https://apply.example.com/verify?t=abc",
    });
    expect(extractLinkFromMessage(msg, undefined, "https://apply.example.com/app")).toBe(
      "https://apply.example.com/verify?t=abc"
    );
  });

  it("returns null when no candidate URL matches the current page's domain", () => {
    const msg = makeMessage({ text: "Click here: https://totally-unrelated.tld/verify" });
    expect(extractLinkFromMessage(msg, undefined, "https://apply.example.com/app")).toBeNull();
  });

  it("honors a caller-supplied linkPattern over the domain-filtered default", () => {
    const msg = makeMessage({ text: "Confirm: https://apply.example.com/confirm/xyz-789 done" });
    expect(extractLinkFromMessage(msg, "confirm/([\\w-]+)", "https://apply.example.com/app")).toBe(
      "xyz-789"
    );
  });

  it("extracts a 4-8 digit code by default", () => {
    const msg = makeMessage({ text: "Your code is 482913, expires soon" });
    expect(extractCodeFromMessage(msg, undefined)).toBe("482913");
  });

  it("returns null when no code matches", () => {
    const msg = makeMessage({ text: "no digits here at all" });
    expect(extractCodeFromMessage(msg, undefined)).toBeNull();
  });
});

describe("flow-runner/executeStepWithHealing — emailStep hook", () => {
  beforeEach(() => {
    pollTestmailInboxMock.mockReset();
  });

  it("throws EmailStepInboxUnavailableError when emailStep is true and no inbox is allocated", async () => {
    const page = makeFakePage();
    const stagehand = {} as Stagehand;

    await expect(
      executeStepWithHealing(baseParams(page, stagehand, { emailStep: true, allocatedInbox: null }))
    ).rejects.toThrow(EmailStepInboxUnavailableError);

    expect(pollTestmailInboxMock).not.toHaveBeenCalled();
  });

  it("throws EmailStepInboxUnavailableError before any other cascade primitive runs, even when the step text matches a select-shaped instruction", async () => {
    const page = makeFakePage();
    const stagehand = {} as Stagehand;

    await expect(
      executeStepWithHealing(
        baseParams(page, stagehand, {
          emailStep: true,
          allocatedInbox: null,
          // Deliberately shaped to also match the select/fill primitives
          // below the emailStep hook in the cascade — proves the guard
          // fires first rather than letting an unrelated primitive claim
          // the step ahead of the inbox check.
          step: "Select 'Yes' from the verification dropdown",
        })
      )
    ).rejects.toThrow(EmailStepInboxUnavailableError);

    // No DOM read for any other primitive happened before the throw.
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it("throws EmailStepExtractError when extract:'link' finds no matching URL", async () => {
    pollTestmailInboxMock.mockResolvedValue(makeMessage({ text: "no links here" }));
    const page = makeFakePage();
    const stagehand = {} as Stagehand;

    await expect(
      executeStepWithHealing(
        baseParams(page, stagehand, { emailStep: true, allocatedInbox: inbox })
      )
    ).rejects.toThrow(EmailStepExtractError);
  });

  it("refuses to navigate to a link whose host is outside the current page's registrable domain", async () => {
    pollTestmailInboxMock.mockResolvedValue(
      makeMessage({ text: "Click https://attacker.tld/steal-session" })
    );
    const page = makeFakePage();
    const stagehand = {} as Stagehand;

    await expect(
      executeStepWithHealing(
        baseParams(page, stagehand, {
          emailStep: true,
          allocatedInbox: inbox,
          emailStepConfig: { extract: "link", linkPattern: "(https://\\S+)" },
        })
      )
    ).rejects.toThrow(EmailStepExtractError);

    expect(page.goto).not.toHaveBeenCalled();
  });

  it("navigates to an extracted same-domain link and reports completed, never logging the URL", async () => {
    pollTestmailInboxMock.mockResolvedValue(
      makeMessage({ text: "Confirm: https://apply.example.com/verify?t=super-secret-token" })
    );
    const page = makeFakePage();
    const stagehand = {} as Stagehand;

    const result = await executeStepWithHealing(
      baseParams(page, stagehand, { emailStep: true, allocatedInbox: inbox })
    );

    expect(result).toBe("completed");
    expect(page.goto).toHaveBeenCalledWith("https://apply.example.com/verify?t=super-secret-token");
    for (const mockFn of [testLogger.info, testLogger.warn, testLogger.error, testLogger.debug]) {
      for (const call of (mockFn as ReturnType<typeof vi.fn>).mock.calls) {
        expect(String(call[0])).not.toContain("super-secret-token");
      }
    }
  });

  it("splices an extracted link into the fill value instead of navigating when action:'fill' is set", async () => {
    pollTestmailInboxMock.mockResolvedValue(
      makeMessage({ text: "Confirm: https://apply.example.com/verify?t=super-secret-token" })
    );
    const page = makeFakePage();
    const stagehand = {} as Stagehand;

    await executeStepWithHealing(
      baseParams(page, stagehand, {
        emailStep: true,
        allocatedInbox: inbox,
        emailStepConfig: { extract: "link", action: "fill" },
        step: "Fill in the verification link field with 'placeholder'",
      })
    ).catch(() => {
      // Falling through into the full cascade on this bare fake page is
      // expected to eventually fail past the fill primitive; only the
      // pre-fallthrough splice + non-navigate is under test here.
    });

    expect(page.goto).not.toHaveBeenCalled();
    for (const mockFn of [testLogger.info, testLogger.warn, testLogger.error, testLogger.debug]) {
      for (const call of (mockFn as ReturnType<typeof vi.fn>).mock.calls) {
        expect(String(call[0])).not.toContain("super-secret-token");
      }
    }
  });

  it("splices an extracted code into the fill value and falls through to the cascade instead of returning early", async () => {
    pollTestmailInboxMock.mockResolvedValue(makeMessage({ text: "Your code is 837465" }));
    const page = makeFakePage();
    const stagehand = {} as Stagehand;

    await executeStepWithHealing(
      baseParams(page, stagehand, {
        emailStep: true,
        allocatedInbox: inbox,
        emailStepConfig: { extract: "code" },
        step: "Fill in the verification code field with 'placeholder'",
      })
    ).catch(() => {
      // Falling through into the full cascade on this bare fake page is
      // expected to eventually fail past the fill primitive; only the
      // pre-fallthrough splice + non-early-return is under test here.
    });

    expect(page.goto).not.toHaveBeenCalled();
    // The hook's own log line never interpolates the code (only its length).
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("emailStep: code extracted (len 6)")
    );
  });

  it("never logs the spliced code when it falls through into sibling select/checkbox/radio/prompt-selector primitives", async () => {
    pollTestmailInboxMock.mockResolvedValue(makeMessage({ text: "Your code is 837465" }));
    const page = makeFakePage();
    const stagehand = {} as Stagehand;

    await executeStepWithHealing(
      baseParams(page, stagehand, {
        emailStep: true,
        allocatedInbox: inbox,
        emailStepConfig: { extract: "code" },
        // No "select"/"check"/"radio" verb — matches parseFillStep only, so
        // the prompt-selector primitive's own re-parse picks the spliced
        // code up directly as its `option` (parsedFill.value).
        step: "Fill in the verification code field with 'placeholder'",
      })
    ).catch(() => {
      // Cascade fallthrough on this bare fake page eventually fails past
      // every primitive; only that none of them logged the code is under test.
    });

    for (const mockFn of [testLogger.info, testLogger.warn, testLogger.error, testLogger.debug]) {
      for (const call of (mockFn as ReturnType<typeof vi.fn>).mock.calls) {
        expect(String(call[0])).not.toContain("837465");
      }
    }
  });

  it("falls through untouched (no inbox poll) when emailStep is unset", async () => {
    const page = makeFakePage();
    const stagehand = {} as Stagehand;

    await executeStepWithHealing(
      baseParams(page, stagehand, { emailStep: false, allocatedInbox: null })
    ).catch(() => {
      // Same rationale as the captcha-hook precedent: cascade fallthrough on
      // this bare fake is expected to fail; only "the hook never ran" matters.
    });

    expect(pollTestmailInboxMock).not.toHaveBeenCalled();
  });
});
