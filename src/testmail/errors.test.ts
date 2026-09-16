import { describe, expect, it } from "vitest";

import { TestmailApiError, TestmailTimeoutError } from "@/testmail/errors";

describe("TestmailTimeoutError", () => {
  it("is instanceof Error, named correctly, and carries the message", () => {
    const err = new TestmailTimeoutError("no message matched the inbox filter within 30000ms");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("TestmailTimeoutError");
    expect(err.message).toBe("no message matched the inbox filter within 30000ms");
  });
});

describe("TestmailApiError", () => {
  it("is instanceof Error, named correctly, and carries the message", () => {
    const err = new TestmailApiError("testmail graphql api returned result: error");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("TestmailApiError");
    expect(err.message).toBe("testmail graphql api returned result: error");
  });
});
