import type { Page } from "@browserbasehq/stagehand";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureCookieJarSnapshot } from "@/scraper/cookie-jar";
import type { CookieRecord } from "@/scripts/recon-shared";

const HTTP_ONLY_COOKIE: CookieRecord = {
  name: "_acme_attr",
  value: "abc123",
  domain: ".acme.example",
  path: "/",
  expires: 1234567890,
  size: 20,
  httpOnly: true,
  secure: true,
  session: false,
  sameSite: "Lax",
};

const SESSION_COOKIE: CookieRecord = {
  name: "session_id",
  value: "xyz789",
  domain: "apply.acme.example",
  path: "/",
  expires: -1,
  size: 15,
  httpOnly: false,
  secure: true,
  session: true,
  sameSite: null,
};

function makePage(sendCDP: ReturnType<typeof vi.fn>): Page {
  return { sendCDP } as unknown as Page;
}

describe("scraper/cookie-jar captureCookieJarSnapshot", () => {
  it("returns a snapshot carrying both cookies with all attributes preserved", async () => {
    const sendCDP = vi.fn().mockResolvedValue({ cookies: [HTTP_ONLY_COOKIE, SESSION_COOKIE] });
    const page = makePage(sendCDP);

    const snapshot = await captureCookieJarSnapshot(page, "ats-c-apply", "post-click", 2);

    expect(sendCDP).toHaveBeenCalledWith("Network.getAllCookies");
    expect(snapshot.label).toBe("ats-c-apply");
    expect(snapshot.phase).toBe("post-click");
    expect(snapshot.stepIndex).toBe(2);
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.cookies).toEqual([HTTP_ONLY_COOKIE, SESSION_COOKIE]);
    expect(snapshot.cookies[0]?.httpOnly).toBe(true);
    expect(snapshot.cookies[0]?.secure).toBe(true);
    expect(snapshot.cookies[0]?.sameSite).toBe("Lax");
    expect(snapshot.cookies[0]?.expires).toBe(1234567890);
    expect(snapshot.cookies[0]?.domain).toBe(".acme.example");
    expect(snapshot.cookies[1]?.session).toBe(true);
    expect(snapshot.cookies[1]?.domain).toBe("apply.acme.example");
  });

  it("returns a snapshot with an error field instead of throwing when sendCDP rejects", async () => {
    const sendCDP = vi.fn().mockRejectedValue(new Error("CDP connection closed"));
    const page = makePage(sendCDP);

    const snapshot = await captureCookieJarSnapshot(page, "ats-c-apply", "post-apply", 5);

    expect(snapshot.error).toBe("CDP connection closed");
    expect(snapshot.cookies).toEqual([]);
    expect(snapshot.label).toBe("ats-c-apply");
    expect(snapshot.phase).toBe("post-apply");
    expect(snapshot.stepIndex).toBe(5);
  });

  describe("bounded against a wedged CDP session", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("resolves within the configured budget with an empty jar and a populated error when sendCDP never settles", async () => {
      const sendCDP = vi.fn().mockReturnValue(new Promise(() => {}));
      const page = makePage(sendCDP);

      const snapshotPromise = captureCookieJarSnapshot(page, "ats-c-apply", "pre-step", 3, {
        timeoutMs: 1_000,
      });
      const assertion = expect(snapshotPromise).resolves.toMatchObject({
        label: "ats-c-apply",
        phase: "pre-step",
        stepIndex: 3,
        cookies: [],
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;

      const snapshot = await snapshotPromise;
      expect(snapshot.error).toContain("timed out after 1000ms");
    });
  });
});
