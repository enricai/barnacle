import { describe, expect, it } from "vitest";

import { makeMockFetchResponse } from "@/testing/mock-fetch-response";

describe("makeMockFetchResponse", () => {
  it("sets status to the given argument", () => {
    const res = makeMockFetchResponse(200, "{}");
    expect(res.status).toBe(200);
  });

  it("text() resolves to the body string", async () => {
    const res = makeMockFetchResponse(200, "hello");
    await expect(res.text()).resolves.toBe("hello");
  });

  it("json() resolves to the parsed body", async () => {
    const res = makeMockFetchResponse(200, '{"ok":true}');
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("headers reflect the passed header map", () => {
    const res = makeMockFetchResponse(200, "{}", { "x-session-token": "tok123" });
    expect(res.headers.get("x-session-token")).toBe("tok123");
  });

  it("defaults to empty Headers when no header map is passed", () => {
    const res = makeMockFetchResponse(200, "{}");
    expect(res.headers.get("x-session-token")).toBeNull();
  });

  it("works with non-200 status codes", async () => {
    const res = makeMockFetchResponse(401, "Unauthorized");
    expect(res.status).toBe(401);
    await expect(res.text()).resolves.toBe("Unauthorized");
  });

  it("headers support multiple keys simultaneously", () => {
    const res = makeMockFetchResponse(200, "{}", {
      "hosted-applies-session": "new-session",
      "x-xsrf-token": "new-xsrf",
    });
    expect(res.headers.get("hosted-applies-session")).toBe("new-session");
    expect(res.headers.get("x-xsrf-token")).toBe("new-xsrf");
  });
});
