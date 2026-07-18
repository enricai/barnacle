import { describe, expect, it } from "vitest";

import { COOKIES_DIR } from "@/scripts/recon-shared";
import type { CookieJarSnapshot } from "@/scripts/recon-shared";

describe("COOKIES_DIR", () => {
  it("points at the recon cookies directory", () => {
    expect(COOKIES_DIR).toBe("/tmp/recon/cookies");
  });
});

describe("CookieJarSnapshot shape", () => {
  it("typechecks a full jar snapshot literal", () => {
    const snapshot: CookieJarSnapshot = {
      label: "post-click",
      phase: "click",
      stepIndex: 0,
      timestamp: "2026-07-18T00:00:00.000Z",
      cookies: [
        {
          name: "appcast_session",
          value: "abc123",
          domain: ".appcast.io",
          path: "/",
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
          expires: -1,
          session: true,
          size: 17,
        },
      ],
    };

    expect(snapshot.cookies).toHaveLength(1);
    expect(snapshot.cookies[0].sameSite).toBe("Lax");
  });
});
