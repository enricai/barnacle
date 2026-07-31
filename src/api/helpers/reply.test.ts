import type { FastifyReply } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { replyWithError } from "@/api/helpers/reply";
import { ERROR_CODES, statusSchema } from "@/api/schemas/common";

/**
 * Builds a minimal FastifyReply double with chainable status() and a send()
 * spy. The real reply is large; for replyWithError we only need the two
 * methods it touches.
 */
function makeReply(): {
  reply: FastifyReply;
  status: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn();
  const status = vi.fn(() => ({ send }));
  const reply = { status, send } as unknown as FastifyReply;
  return { reply, status, send };
}

describe("api/helpers/reply replyWithError", () => {
  it("uses httpStatusForCode when no statusOverride is provided", () => {
    const { reply, status, send } = makeReply();
    replyWithError(reply, ERROR_CODES.FIELD_VIOLATION, "bad field");
    expect(status).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith(400);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("maps AUTHORIZATION_ERROR to 401 via httpStatusForCode", () => {
    const { reply, status } = makeReply();
    replyWithError(reply, ERROR_CODES.AUTHORIZATION_ERROR, "nope");
    expect(status).toHaveBeenCalledWith(401);
  });

  it("uses statusOverride instead of httpStatusForCode when provided", () => {
    const { reply, status } = makeReply();
    replyWithError(reply, ERROR_CODES.GENERIC_ERROR, "weird", undefined, 418);
    expect(status).toHaveBeenCalledWith(418);
  });

  it("falls back to httpStatusForCode when statusOverride is undefined", () => {
    const { reply, status } = makeReply();
    replyWithError(reply, ERROR_CODES.THROTTLED_REQUEST, "slow down", undefined, undefined);
    expect(status).toHaveBeenCalledWith(429);
  });

  it("sends an envelope shaped like the standard status block", () => {
    const { reply, send } = makeReply();
    replyWithError(reply, ERROR_CODES.SCRAPE_FAILURE, "boom");
    const envelope = send.mock.calls[0]?.[0] as { status: unknown };
    expect(envelope).toBeDefined();
    expect(statusSchema.safeParse(envelope.status).success).toBe(true);
  });

  it("propagates the message and code into the envelope details", () => {
    const { reply, send } = makeReply();
    replyWithError(reply, ERROR_CODES.CAPTCHA_ENCOUNTERED, "captcha hit", "WARN");
    const envelope = send.mock.calls[0]?.[0] as {
      status: { details: Array<{ code: number; detailType: string; message: string }> };
    };
    const detail = envelope.status.details[0];
    expect(detail?.code).toBe(ERROR_CODES.CAPTCHA_ENCOUNTERED);
    expect(detail?.message).toBe("captcha hit");
    expect(detail?.detailType).toBe("WARN");
  });
});
