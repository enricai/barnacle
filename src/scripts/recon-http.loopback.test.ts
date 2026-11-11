import { describe, expect, it } from "vitest";

import { isLoopbackOrLinkLocalHost } from "@/scripts/recon-http";

describe("isLoopbackOrLinkLocalHost", () => {
  it.each([
    "localhost",
    "localhost.",
    "app.localhost",
    "app.localhost.",
    "127.0.0.1",
    "169.254.10.20",
    "0.0.0.0",
    "[::1]",
    "[fe80::1]",
  ])("treats %s as loopback or link-local", (host) => {
    expect(isLoopbackOrLinkLocalHost(host)).toBe(true);
  });

  it.each(["example.com", "example.com.", "localhost.example.com", "notlocalhost"])(
    "treats %s as a real host",
    (host) => {
      expect(isLoopbackOrLinkLocalHost(host)).toBe(false);
    }
  );
});
