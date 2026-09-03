import { describe, expect, it } from "vitest";

import {
  CaptchaError,
  CaptchaSolverUnavailableError,
  CdpTransportClosedError,
  EmailStepExtractError,
  EmailStepInboxUnavailableError,
  BrowserbaseSessionCreateRateLimitError,
  HttpRateLimitError,
  HttpSchemaError,
  HttpUrlLockedError,
  isBrowserbaseSessionCreateRateLimitError,
  isCaptchaError,
  isCdpTransportClosedError,
  isEmailStepExtractError,
  isEmailStepInboxUnavailableError,
  isHttpSchemaError,
  isScraperError,
  MissingFormMapKeyError,
  type NeedsUserInfoResult,
  type RunHealingFlowResult,
  ScraperError,
  StepVerificationError,
  UnknownScraperError,
} from "@/scraper/errors";

describe("HttpUrlLockedError", () => {
  it("is non-retryable, instanceof ScraperError, and distinct from sibling Http errors", () => {
    const err = new HttpUrlLockedError();
    expect(err).toBeInstanceOf(ScraperError);
    expect(err.retryable).toBe(false);
    expect(err.name).toBe("HttpUrlLockedError");
    expect(err.message).toBe("requisition url locked");
    expect(err).not.toBeInstanceOf(HttpRateLimitError);
    expect(err).not.toBeInstanceOf(HttpSchemaError);
    expect(err).not.toBeInstanceOf(UnknownScraperError);
  });

  it("accepts a custom message", () => {
    const err = new HttpUrlLockedError("url locked on j-12345");
    expect(err.message).toBe("url locked on j-12345");
  });
});

describe("BrowserbaseSessionCreateRateLimitError", () => {
  it("is non-retryable, instanceof ScraperError, and recognized by isScraperError", () => {
    const err = new BrowserbaseSessionCreateRateLimitError();
    expect(err).toBeInstanceOf(ScraperError);
    expect(err.retryable).toBe(false);
    expect(err.name).toBe("BrowserbaseSessionCreateRateLimitError");
    expect(isScraperError(err)).toBe(true);
  });

  it("is recognized by isBrowserbaseSessionCreateRateLimitError, same-realm and cross-realm", () => {
    class FakeCrossModuleBrowserbaseSessionCreateRateLimitError extends Error {
      constructor(message = "browserbase session-create rate limit exceeded") {
        super(message);
        this.name = "BrowserbaseSessionCreateRateLimitError";
      }
    }

    const sameRealmErr = new BrowserbaseSessionCreateRateLimitError();
    expect(isBrowserbaseSessionCreateRateLimitError(sameRealmErr)).toBe(true);

    const crossRealmErr = new FakeCrossModuleBrowserbaseSessionCreateRateLimitError();
    expect(crossRealmErr).not.toBeInstanceOf(BrowserbaseSessionCreateRateLimitError);
    expect(isBrowserbaseSessionCreateRateLimitError(crossRealmErr)).toBe(true);
    expect(isScraperError(crossRealmErr)).toBe(true);
  });

  it("recognizes Stagehand's raw 'Unknown error: 429' throw by message, without instanceof", () => {
    const stagehandThrow = new Error("Unknown error: 429");
    expect(isBrowserbaseSessionCreateRateLimitError(stagehandThrow)).toBe(true);
  });

  it("does not match a 5xx 'Unknown error' or the ATS HttpRateLimitError", () => {
    expect(isBrowserbaseSessionCreateRateLimitError(new Error("Unknown error: 500"))).toBe(false);
    expect(isBrowserbaseSessionCreateRateLimitError(new HttpRateLimitError())).toBe(false);
  });

  it("returns false for a generic unrelated Error", () => {
    expect(isBrowserbaseSessionCreateRateLimitError(new Error("plain"))).toBe(false);
    expect(isBrowserbaseSessionCreateRateLimitError(null)).toBe(false);
    expect(isBrowserbaseSessionCreateRateLimitError(undefined)).toBe(false);
  });
});

describe("MissingFormMapKeyError", () => {
  it("carries the missing keys + context and is non-retryable", () => {
    const err = new MissingFormMapKeyError(["firstName", "applicantGender"], "buildFormMap");
    expect(err).toBeInstanceOf(ScraperError);
    expect(err.missingKeys).toEqual(["firstName", "applicantGender"]);
    expect(err.context).toBe("buildFormMap");
    expect(err.retryable).toBe(false);
    expect(err.message).toBe(
      "form-map missing required keys [firstName, applicantGender] in buildFormMap"
    );
    expect(err.name).toBe("MissingFormMapKeyError");
  });
});

describe("StepVerificationError", () => {
  it("defaults to kind cascade-exhausted, is non-retryable, and instanceof ScraperError", () => {
    const err = new StepVerificationError();
    expect(err).toBeInstanceOf(ScraperError);
    expect(err.retryable).toBe(false);
    expect(err.name).toBe("StepVerificationError");
    expect(err.kind).toBe("cascade-exhausted");
  });

  it("constructs with kind phantom-click-exhausted and round-trips consistently with cascade-exhausted", () => {
    const phantomClick = new StepVerificationError(
      "step failed verification after all heal attempts",
      "phantom-click-exhausted"
    );
    expect(phantomClick).toBeInstanceOf(StepVerificationError);
    expect(phantomClick).toBeInstanceOf(ScraperError);
    expect(phantomClick.kind).toBe("phantom-click-exhausted");
    expect(phantomClick.retryable).toBe(false);
    expect(phantomClick.name).toBe("StepVerificationError");

    const cascadeExhausted = new StepVerificationError(
      "step failed verification after all heal attempts",
      "cascade-exhausted"
    );
    expect(phantomClick.retryable).toBe(cascadeExhausted.retryable);
    expect(phantomClick.name).toBe(cascadeExhausted.name);
    expect(phantomClick.kind).not.toBe(cascadeExhausted.kind);
  });

  it("constructs with kind flow-timeout, non-retryable, kind round-trips", () => {
    const err = new StepVerificationError(
      "flow exceeded maxFlowMs budget at step 3",
      "flow-timeout"
    );
    expect(err).toBeInstanceOf(StepVerificationError);
    expect(err).toBeInstanceOf(ScraperError);
    expect(err.retryable).toBe(false);
    expect(err.name).toBe("StepVerificationError");
    expect(err.kind).toBe("flow-timeout");
  });

  it("constructs with kind submit-skipped, non-retryable, kind round-trips", () => {
    const err = new StepVerificationError("submitStep was skipped, not verified", "submit-skipped");
    expect(err).toBeInstanceOf(StepVerificationError);
    expect(err).toBeInstanceOf(ScraperError);
    expect(err.retryable).toBe(false);
    expect(err.name).toBe("StepVerificationError");
    expect(err.kind).toBe("submit-skipped");
  });
});

describe("CdpTransportClosedError", () => {
  it("is retryable, instanceof ScraperError, and named correctly", () => {
    const err = new CdpTransportClosedError("socket-close code=1006 reason=");
    expect(err).toBeInstanceOf(ScraperError);
    expect(err.retryable).toBe(true);
    expect(err.name).toBe("CdpTransportClosedError");
    expect(err.message).toBe("socket-close code=1006 reason=");
  });

  it("defaults to the standard message when constructed with no argument", () => {
    const err = new CdpTransportClosedError();
    expect(err.name).toBe("CdpTransportClosedError");
    expect(err.message).toBe("scraper session's CDP transport was closed by the SDK");
  });

  it("isCdpTransportClosedError recognizes a same-realm instance and a name-tagged plain Error", () => {
    const sameRealmErr = new CdpTransportClosedError();
    expect(isCdpTransportClosedError(sameRealmErr)).toBe(true);
    expect(isScraperError(sameRealmErr)).toBe(true);

    class FakeCrossModuleCdpTransportClosedError extends Error {
      constructor(message = "scraper session's CDP transport was closed by the SDK") {
        super(message);
        this.name = "CdpTransportClosedError";
      }
    }
    const crossRealmErr = new FakeCrossModuleCdpTransportClosedError();
    expect(crossRealmErr).not.toBeInstanceOf(CdpTransportClosedError);
    expect(isCdpTransportClosedError(crossRealmErr)).toBe(true);
    expect(isScraperError(crossRealmErr)).toBe(true);
  });

  it("isCdpTransportClosedError returns false for an unrelated Error", () => {
    expect(isCdpTransportClosedError(new Error("plain"))).toBe(false);
    expect(isCdpTransportClosedError(new TypeError("bad"))).toBe(false);
    expect(isCdpTransportClosedError(null)).toBe(false);
    expect(isCdpTransportClosedError(undefined)).toBe(false);
  });
});

describe("CaptchaSolverUnavailableError", () => {
  it("is a CaptchaError subclass, non-retryable, and named correctly", () => {
    const err = new CaptchaSolverUnavailableError();
    expect(err).toBeInstanceOf(CaptchaError);
    expect(err).toBeInstanceOf(ScraperError);
    expect(err.retryable).toBe(false);
    expect(err.name).toBe("CaptchaSolverUnavailableError");
    expect(err.message).toBe("captcha solver unavailable: no provider configured");
  });

  it("is recognized by isCaptchaError and isScraperError, same-realm and cross-realm", () => {
    const sameRealmErr = new CaptchaSolverUnavailableError();
    expect(isCaptchaError(sameRealmErr)).toBe(true);
    expect(isScraperError(sameRealmErr)).toBe(true);

    class FakeCrossModuleCaptchaSolverUnavailableError extends Error {
      constructor(message = "captcha solver unavailable: no provider configured") {
        super(message);
        this.name = "CaptchaSolverUnavailableError";
      }
    }
    const crossRealmErr = new FakeCrossModuleCaptchaSolverUnavailableError();
    expect(crossRealmErr).not.toBeInstanceOf(CaptchaSolverUnavailableError);
    expect(isCaptchaError(crossRealmErr)).toBe(true);
    expect(isScraperError(crossRealmErr)).toBe(true);
  });
});

describe("EmailStepInboxUnavailableError", () => {
  it("is non-retryable, instanceof ScraperError, and named correctly", () => {
    const err = new EmailStepInboxUnavailableError();
    expect(err).toBeInstanceOf(ScraperError);
    expect(err.retryable).toBe(false);
    expect(err.name).toBe("EmailStepInboxUnavailableError");
    expect(err.message).toBe(
      "emailStep set but no testmail inbox allocated (pass --allocate-email)"
    );
  });

  it("isEmailStepInboxUnavailableError recognizes a same-realm instance and a name-tagged plain Error", () => {
    const sameRealmErr = new EmailStepInboxUnavailableError();
    expect(isEmailStepInboxUnavailableError(sameRealmErr)).toBe(true);
    expect(isScraperError(sameRealmErr)).toBe(true);

    class FakeCrossModuleEmailStepInboxUnavailableError extends Error {
      constructor(
        message = "emailStep set but no testmail inbox allocated (pass --allocate-email)"
      ) {
        super(message);
        this.name = "EmailStepInboxUnavailableError";
      }
    }
    const crossRealmErr = new FakeCrossModuleEmailStepInboxUnavailableError();
    expect(crossRealmErr).not.toBeInstanceOf(EmailStepInboxUnavailableError);
    expect(isEmailStepInboxUnavailableError(crossRealmErr)).toBe(true);
    expect(isScraperError(crossRealmErr)).toBe(true);
  });

  it("isEmailStepInboxUnavailableError returns false for an unrelated Error", () => {
    expect(isEmailStepInboxUnavailableError(new Error("plain"))).toBe(false);
    expect(isEmailStepInboxUnavailableError(null)).toBe(false);
    expect(isEmailStepInboxUnavailableError(undefined)).toBe(false);
  });
});

describe("EmailStepExtractError", () => {
  it("is non-retryable, instanceof ScraperError, and named correctly", () => {
    const err = new EmailStepExtractError();
    expect(err).toBeInstanceOf(ScraperError);
    expect(err.retryable).toBe(false);
    expect(err.name).toBe("EmailStepExtractError");
    expect(err.message).toBe("no link/code matched in the verification email");
  });

  it("isEmailStepExtractError recognizes a same-realm instance and a name-tagged plain Error", () => {
    const sameRealmErr = new EmailStepExtractError();
    expect(isEmailStepExtractError(sameRealmErr)).toBe(true);
    expect(isScraperError(sameRealmErr)).toBe(true);

    class FakeCrossModuleEmailStepExtractError extends Error {
      constructor(message = "no link/code matched in the verification email") {
        super(message);
        this.name = "EmailStepExtractError";
      }
    }
    const crossRealmErr = new FakeCrossModuleEmailStepExtractError();
    expect(crossRealmErr).not.toBeInstanceOf(EmailStepExtractError);
    expect(isEmailStepExtractError(crossRealmErr)).toBe(true);
    expect(isScraperError(crossRealmErr)).toBe(true);
  });

  it("isEmailStepExtractError returns false for an unrelated Error", () => {
    expect(isEmailStepExtractError(new Error("plain"))).toBe(false);
    expect(isEmailStepExtractError(null)).toBe(false);
    expect(isEmailStepExtractError(undefined)).toBe(false);
  });
});

describe("cross-realm type guards", () => {
  // Matches what an out-of-tree plugin's independently-resolved copy of this
  // package produces: a nominally distinct class (different constructor
  // identity than this module's HttpSchemaError) whose base constructor still
  // stamps `name` from `new.target.name`, exactly like the real class does.
  class FakeCrossModuleHttpSchemaError extends Error {
    constructor(message = "http response schema mismatch") {
      super(message);
      this.name = "HttpSchemaError";
    }
  }

  class FakeCrossModuleCaptchaError extends Error {
    constructor(message = "captcha challenge encountered") {
      super(message);
      this.name = "CaptchaError";
    }
  }

  it("recognizes a cross-realm error via name when instanceof misses", () => {
    const crossRealmErr = new FakeCrossModuleHttpSchemaError();
    expect(crossRealmErr).not.toBeInstanceOf(HttpSchemaError);
    expect(isHttpSchemaError(crossRealmErr)).toBe(true);
    expect(isScraperError(crossRealmErr)).toBe(true);
  });

  it("still recognizes same-realm errors via instanceof (no regression)", () => {
    const sameRealmErr = new HttpSchemaError();
    expect(isHttpSchemaError(sameRealmErr)).toBe(true);
    expect(isScraperError(sameRealmErr)).toBe(true);
  });

  it("does not cross-match a different error's cross-realm name", () => {
    const crossRealmCaptcha = new FakeCrossModuleCaptchaError();
    expect(isHttpSchemaError(crossRealmCaptcha)).toBe(false);
    expect(isCaptchaError(crossRealmCaptcha)).toBe(true);
    expect(isScraperError(crossRealmCaptcha)).toBe(true);
  });

  it("returns false for unrelated values", () => {
    expect(isHttpSchemaError(new Error("plain"))).toBe(false);
    expect(isHttpSchemaError(new TypeError("bad"))).toBe(false);
    expect(isHttpSchemaError("not even an error")).toBe(false);
    expect(isHttpSchemaError(null)).toBe(false);
    expect(isHttpSchemaError(undefined)).toBe(false);
    expect(isScraperError(new Error("plain"))).toBe(false);
  });
});

describe("NeedsUserInfoResult", () => {
  it("type-checks as a structured hot-path payload and reads back at runtime", () => {
    // Compile-time shape guard: the assignment below fails tsc if the type drifts.
    const result: NeedsUserInfoResult = {
      verified: false,
      needsUserInfo: true,
      missingFields: [
        { field: "educationLevel", question: "What is your highest level of education?" },
      ],
      requiresOtp: true,
    };

    expect(result.verified).toBe(false);
    expect(result.needsUserInfo).toBe(true);
    expect(result.missingFields).toEqual([
      { field: "educationLevel", question: "What is your highest level of education?" },
    ]);
    expect(result.requiresOtp).toBe(true);
  });
});

describe("RunHealingFlowResult", () => {
  it("type-checks as a runHealingFlow outcome and reads back at runtime", () => {
    // Compile-time shape guard: the assignment below fails tsc if the type drifts.
    const result: RunHealingFlowResult = {
      submitVerified: true,
      submitStepSkipped: false,
      lastStepIndex: 4,
    };

    expect(result.submitVerified).toBe(true);
    expect(result.submitStepSkipped).toBe(false);
    expect(result.lastStepIndex).toBe(4);
  });
});
