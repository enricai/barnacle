import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import type { Page } from "@browserbasehq/stagehand";

import { clickDeepLocatorCandidate } from "@/scraper/deep-locator-candidates";

function pageWith(locator: object): Page {
  return { deepLocator: () => ({ nth: () => locator }) } as unknown as Page;
}

describe("clickDeepLocatorCandidate trusted click centring", () => {
  it("centres and hit-tests before click()", async () => {
    const order: string[] = [];
    const send = vi.fn(async (method: string) => {
      order.push(method);
      return { result: { value: { state: "hit" } } };
    });
    const locator = {
      frame: { session: { send } },
      resolveNode: async () => ({ objectId: "o1" }),
      click: async () => {
        order.push("click");
      },
    };
    await clickDeepLocatorCandidate(pageWith(locator), null, "button", 0, {
      preferTrustedClick: true,
    });
    expect(order).toEqual(["Runtime.callFunctionOn", "Runtime.releaseObject", "click"]);
  });

  it("never clicks an occluded target", async () => {
    const click = vi.fn();
    const locator = {
      frame: {
        session: {
          send: async () => ({ result: { value: { state: "occluded", occluder: "div#ov" } } }),
        },
      },
      resolveNode: async () => ({ objectId: "o1" }),
      click,
    };
    await expect(
      clickDeepLocatorCandidate(pageWith(locator), null, "button", 0, { preferTrustedClick: true })
    ).rejects.toThrow(/occluded by div#ov/);
    expect(click).not.toHaveBeenCalled();
  });

  it("degrades to plain click() for a click-only locator", async () => {
    const click = vi.fn(async () => undefined);
    await clickDeepLocatorCandidate(pageWith({ click }), null, "button", 0, {
      preferTrustedClick: true,
    });
    expect(click).toHaveBeenCalledTimes(1);
  });
});
