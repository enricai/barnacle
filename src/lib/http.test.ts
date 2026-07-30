import Browserbase from "@browserbasehq/sdk";
import { describe, expect, it } from "vitest";

import { configureHttpDispatcher } from "@/lib/http";

describe("configureHttpDispatcher", () => {
  it("strips the explicit content-length header Browserbase's SDK would otherwise set", () => {
    configureHttpDispatcher();

    const apiClientPrototype = Object.getPrototypeOf(Browserbase.prototype) as {
      buildHeaders: (args: Record<string, unknown>) => Record<string, string>;
    };
    const fakeClient = {
      defaultHeaders: () => ({}),
      validateHeaders: () => {},
    };

    const headers = apiClientPrototype.buildHeaders.call(fakeClient, {
      options: {},
      headers: {},
      contentLength: "52",
      retryCount: 0,
    });

    expect(headers["content-length"]).toBeUndefined();
  });

  it("is idempotent across repeated calls", () => {
    configureHttpDispatcher();
    configureHttpDispatcher();

    const apiClientPrototype = Object.getPrototypeOf(Browserbase.prototype) as {
      buildHeaders: (args: Record<string, unknown>) => Record<string, string>;
    };
    const fakeClient = {
      defaultHeaders: () => ({}),
      validateHeaders: () => {},
    };

    const headers = apiClientPrototype.buildHeaders.call(fakeClient, {
      options: {},
      headers: {},
      contentLength: "52",
      retryCount: 0,
    });

    expect(headers["content-length"]).toBeUndefined();
  });
});
