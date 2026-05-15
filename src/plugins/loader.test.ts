import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CaptchaEncounteredError, ScrapeFailureError } from "@/api/errors";
import { dispatch, SITE_PLUGINS } from "@/plugins/loader";
import { CaptchaError, SelectorFailureError } from "@/scraper/errors";
import type { SitePluginContext } from "@/site-plugin";

// vi.hoisted runs before vi.mock factories — required so these references
// are available when the factory closures execute.
const mockCreate = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "stub-id" }));
const mockFemaExecute = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    data: { confirmationNumber: "TEST-001" },
    auditPayload: { redacted: true },
  })
);

// Stub runWithSession to invoke the task synchronously with a null session so
// tests don't need a real Steel session or pool setup.
vi.mock("@/scraper/pool", () => ({
  runWithSession: vi.fn().mockImplementation((task: (s: null) => Promise<unknown>) => task(null)),
}));

// Stub prisma so tests don't need a live DB. siteSubmission.create must be
// a mock we can inspect to verify audit writes happened (and in the right order).
vi.mock("@/lib/db/client", () => ({
  prisma: {
    siteSubmission: { create: mockCreate },
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));

// Stub the fema plugin so SITE_PLUGINS is predictable in tests and execute()
// doesn't spin up a real browser session.
vi.mock("@/sites/fema/index", () => ({
  femaPlugin: {
    meta: {
      siteId: "fema",
      displayName: "FEMA Disaster Assistance",
      bodySchema: {},
      responseSchema: {},
      routeOverride: "/v1/fema/submit",
    },
    execute: mockFemaExecute,
  },
}));

const stubPlugin = SITE_PLUGINS[0] as NonNullable<(typeof SITE_PLUGINS)[0]>;

const stubContext: SitePluginContext = {
  baseUrl: "https://disasterassistance.gov",
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  } as unknown as SitePluginContext["logger"],
  config: {} as SitePluginContext["config"],
};

describe("dispatch", () => {
  beforeEach(() => {
    mockCreate.mockResolvedValue({ id: "stub-id" });
    mockFemaExecute.mockResolvedValue({
      data: { confirmationNumber: "TEST-001" },
      auditPayload: { redacted: true },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls plugin.execute() once with the passed payload and context", async () => {
    const payload = { field: "value" };
    await dispatch(stubPlugin, payload, stubContext);
    expect(mockFemaExecute).toHaveBeenCalledTimes(1);
    expect(mockFemaExecute).toHaveBeenCalledWith(payload, null, stubContext);
  });

  it("writes a SiteSubmission row with status=submitted and correct siteId on success", async () => {
    await dispatch(stubPlugin, {}, stubContext);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "submitted", siteId: "fema" }),
      })
    );
  });

  it("returns the SitePluginResult from execute() on success", async () => {
    const result = await dispatch(stubPlugin, {}, stubContext);
    expect(result.data).toEqual({ confirmationNumber: "TEST-001" });
  });

  it("throws CaptchaEncounteredError (not CaptchaError) when execute throws CaptchaError", async () => {
    const captchaErr = new CaptchaError("captcha hit");
    mockFemaExecute.mockRejectedValueOnce(captchaErr);

    await expect(dispatch(stubPlugin, {}, stubContext)).rejects.toBeInstanceOf(
      CaptchaEncounteredError
    );
  });

  it("throws ScrapeFailureError when execute throws a non-CaptchaError ScraperError subclass", async () => {
    const selectorErr = new SelectorFailureError("selector failed");
    mockFemaExecute.mockRejectedValueOnce(selectorErr);

    await expect(dispatch(stubPlugin, {}, stubContext)).rejects.toBeInstanceOf(ScrapeFailureError);
  });

  it("re-throws the original Error unchanged when execute throws a plain Error", async () => {
    const plainErr = new Error("unexpected");
    mockFemaExecute.mockRejectedValueOnce(plainErr);

    let caught: unknown;
    try {
      await dispatch(stubPlugin, {}, stubContext);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(plainErr);
  });

  it("writes the error SiteSubmission row BEFORE throwing", async () => {
    mockFemaExecute.mockRejectedValueOnce(new CaptchaError("captcha hit"));

    try {
      await dispatch(stubPlugin, {}, stubContext);
    } catch {
      // expected — we only care that create was called
    }

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "error", siteId: "fema" }),
      })
    );
  });
});

describe("SITE_PLUGINS", () => {
  it("contains exactly one entry with meta.siteId === 'fema'", () => {
    expect(SITE_PLUGINS).toHaveLength(1);
    expect(SITE_PLUGINS[0]?.meta.siteId).toBe("fema");
  });
});
