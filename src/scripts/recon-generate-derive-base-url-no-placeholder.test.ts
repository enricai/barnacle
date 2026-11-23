import { describe, expect, it } from "vitest";
import { deriveBaseUrl } from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

const cap = (url: string): Capture => ({ url }) as Capture;

describe("deriveBaseUrl without a placeholder origin", () => {
  it("throws naming the captured hosts when ownBackendHostnames matches no capture", () => {
    expect(() => deriveBaseUrl([cap("https://other.test/a")], ["api.shop-example.test"])).toThrow(
      /ownBackendHostnames matched no capture.*other\.test/
    );
  });

  it("returns the declared host's origin when it matches", () => {
    expect(
      deriveBaseUrl(
        [cap("https://other.test/a"), cap("https://api.shop-example.test/x")],
        ["api.shop-example.test"]
      )
    ).toBe("https://api.shop-example.test");
  });

  it("prefers the host of captures matching the declared submit pattern over raw host count", () => {
    const c = (url: string, method = "POST"): Capture => ({ url, method }) as Capture;
    const caps = [
      c("https://www.shop-example.test/a", "GET"),
      c("https://www.shop-example.test/b", "GET"),
      c("https://www.shop-example.test/c", "GET"),
      c("https://api.shop-example.test/search/preflight", "OPTIONS"),
      c("https://api.shop-example.test/search"),
    ];
    expect(
      deriveBaseUrl(caps, ["www.shop-example.test", "api.shop-example.test"], {
        endpoint: "/search",
        body: null,
      } as never)
    ).toBe("https://api.shop-example.test");
  });
});
