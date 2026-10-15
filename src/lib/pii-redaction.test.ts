import { Writable } from "node:stream";

import Fastify from "fastify";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { extendLogger, PII_REDACTING_LOG_HOOKS } from "@/lib/logging";
import {
  redactionPolicyFor,
  redactPii,
  redactPiiDeep,
  registerRedactionPolicy,
  registerSecretValue,
  registerSensitiveValues,
  releaseSensitiveValues,
  resetSensitiveValuesForTests,
} from "@/lib/pii-redaction";
import { generateThrowawayPassword } from "@/lib/random";
import type { RedactionPolicy } from "@/types/pii-redaction";

const POLICY: RedactionPolicy = {
  persistKeys: ["orderId", "trackingUrl"],
  publicKeys: ["searchTerm"],
  skipKeys: ["attachment"],
  wordKeys: ["fullName", "contactEmail", "street"],
  digitKeys: ["phone", "nationalId"],
};

const PAYLOAD = {
  orderId: "ORD-778899",
  trackingUrl: "https://shop.example.com/o/778899?ref=abc",
  searchTerm: "blue widgets",
  fullName: "Ann Sentinelson",
  contactEmail: "ann.sentinel@example.com",
  phone: "+15551234567",
  nationalId: "123-45-6789",
  street: "42 Wallaby Way",
  choices: { size: "Large", note: "Leave at the side door" },
  attachment: Buffer.from("attachment"),
  attachmentName: "Ann_Sentinelson_Invoice.pdf",
};

afterEach(() => {
  resetSensitiveValuesForTests();
});

describe("redactPii", () => {
  it("is a no-op when nothing is registered", () => {
    expect(redactPii("Fill in the Email field with 'ann.sentinel@example.com'")).toBe(
      "Fill in the Email field with 'ann.sentinel@example.com'"
    );
  });

  it("matches wordKeys case-insensitively on word boundaries", () => {
    registerSensitiveValues("run-1", PAYLOAD, POLICY);
    expect(
      redactPii("Fill in Name with 'ANN SENTINELSON' and email 'Ann.Sentinel@example.com'")
    ).toBe("Fill in Name with '<fullName>' and email '<contactEmail>'");
    expect(redactPii("Ann Sentinelsonville")).toBe("Ann Sentinelsonville");
  });

  it("matches digitKeys in any formatting, including national and international forms", () => {
    registerSensitiveValues("run-1", PAYLOAD, POLICY);
    for (const formatted of [
      "+15551234567",
      "(555) 123-4567",
      "555.123.4567",
      "5551234567",
      "+1 555 123 4567",
      "1 (555) 123-4567",
    ]) {
      expect(redactPii(`phone=${formatted};`)).toBe("phone=<phone>;");
    }
    for (const formatted of ["123456789", "123 45 6789", "123-45-6789"]) {
      expect(redactPii(`id=${formatted};`)).toBe("id=<nationalId>;");
    }
    expect(redactPii("call 1-800-555-0000 or 1555123456789")).toBe(
      "call 1-800-555-0000 or 1555123456789"
    );
  });

  it("matches an international digit value in its national format", () => {
    registerSensitiveValues("run-1", { tel: "+442079460958" }, { digitKeys: ["tel"] });
    for (const formatted of ["020 7946 0958", "+44 20 7946 0958", "+44 (0)20 7946 0958"]) {
      expect(redactPii(`tel ${formatted}.`)).toBe("tel <tel>.");
    }
    expect(redactPii("tel 4420794609581")).toBe("tel 4420794609581");
  });

  it("matches unlisted keys as literals, including nested values", () => {
    registerSensitiveValues("run-1", PAYLOAD, POLICY);
    const out = redactPii(
      "radio: selected 'Leave at the side door'; uploading Ann_Sentinelson_Invoice.pdf for ORD-778899"
    );
    expect(out).toContain("<choices>");
    expect(out).toContain("<attachmentName>");
    expect(out).not.toMatch(/side door|Invoice\.pdf/);
  });

  it("never matches persisted, public or skipped keys", () => {
    registerSensitiveValues("run-1", PAYLOAD, POLICY);
    const text = "order ORD-778899 via https://shop.example.com/o/778899?ref=abc for blue widgets";
    expect(redactPii(text)).toBe(text);
  });

  it("is fail-closed without a policy: every string is matched as a literal", () => {
    registerSensitiveValues("run-1", { searchTerm: "blue widgets", orderId: "ORD-1234" });
    expect(redactPii("searching blue widgets for ORD-1234")).toBe(
      "searching <searchTerm> for <orderId>"
    );
  });

  it("keeps values scrubbed through the release grace period, then forgets them", () => {
    registerSensitiveValues("run-1", PAYLOAD, POLICY);
    releaseSensitiveValues("run-1", 60_000);
    expect(redactPii("ann.sentinel@example.com")).toBe("<contactEmail>");
    releaseSensitiveValues("run-1", 0);
    expect(redactPii("ann.sentinel@example.com")).toBe("ann.sentinel@example.com");
  });

  it("scrubs a generated throwaway password with no payload registered", () => {
    const password = generateThrowawayPassword();
    expect(redactPii(`Fill in the Password field with '${password}'`)).toBe(
      "Fill in the Password field with '<Secret>'"
    );
  });

  it("ignores secrets too short to match safely", () => {
    registerSecretValue("ab");
    expect(redactPii("ab")).toBe("ab");
  });
});

describe("registerRedactionPolicy", () => {
  it("serves a plugin's policy by siteId until it is cleared", () => {
    registerRedactionPolicy("shop", POLICY);
    expect(redactionPolicyFor("shop")).toBe(POLICY);
    registerRedactionPolicy("shop", undefined);
    expect(redactionPolicyFor("shop")).toBeUndefined();
  });
});

describe("redactPiiDeep", () => {
  it("scrubs strings inside objects, arrays and errors", () => {
    registerSensitiveValues("run-1", PAYLOAD, POLICY);
    const err = new Error(
      "step 3 (Fill in the Email field with 'ann.sentinel@example.com') failed"
    );
    const out = JSON.stringify(
      redactPiiDeep({ msg: "ok", steps: [{ error: err.message }], err, n: 3 })
    );
    expect(out).not.toContain("ann.sentinel@example.com");
    expect(out).toContain("<contactEmail>");
    expect(out).toContain('"n":3');
  });

  it("scrubs an error's cause chain", () => {
    registerSensitiveValues("run-1", PAYLOAD, POLICY);
    const err = new Error("submit failed", {
      cause: new Error(`rejected ${PAYLOAD.contactEmail}`),
    });
    const out = JSON.stringify(redactPiiDeep({ err }));
    expect(out).not.toContain(PAYLOAD.contactEmail);
    expect(out).toContain("<contactEmail>");
  });

  it("returns class instances untouched so their serializers still see prototype getters", () => {
    registerSensitiveValues("run-1", PAYLOAD, POLICY);
    class RequestLike {
      get method(): string {
        return "POST";
      }
    }
    const req = new RequestLike();
    const out = redactPiiDeep({ req, when: new URL("https://example.com/x") }) as {
      req: RequestLike;
      when: URL;
    };
    expect(out.req).toBe(req);
    expect(out.req.method).toBe("POST");
    expect(out.when.href).toBe("https://example.com/x");
  });
});

describe("PII_REDACTING_LOG_HOOKS", () => {
  it("scrubs interpolated messages and logged error objects before they are written", () => {
    registerSensitiveValues("run-1", PAYLOAD, POLICY);
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb): void {
        lines.push(String(chunk));
        cb();
      },
    });
    const logger = pino({ hooks: PII_REDACTING_LOG_HOOKS }, sink);

    logger.info(`deepLocator filled "Email" with "${PAYLOAD.contactEmail}"`);
    logger
      .child({ reqId: "r1" })
      .error({ err: new Error(`bad phone ${PAYLOAD.phone}`) }, "unhandled");

    const output = lines.join("");
    expect(output).not.toContain(PAYLOAD.contactEmail);
    expect(output).not.toContain("5551234567");
    expect(output).toContain("<contactEmail>");
    expect(output).toContain("<phone>");
  });

  it("scrubs a value that a CloudWatch-size split would cut in half", () => {
    registerSensitiveValues("run-1", PAYLOAD, POLICY);
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb): void {
        lines.push(String(chunk));
        cb();
      },
    });
    const logger = extendLogger(pino({ hooks: PII_REDACTING_LOG_HOOKS }, sink));
    // Space-free and densely packed (~300 KB of "/email"), so the splitter
    // hard-cuts and the cut lands inside an email copy.
    const message = `/${PAYLOAD.contactEmail}`.repeat(12_000);

    logger.info(message);

    const output = lines.join("");
    expect(output).not.toMatch(/sentinel|example\.com/);
    expect(output).toContain("<contactEmail>");
  });

  it("keeps Fastify's request/response log fields while a run is registered", async () => {
    registerSensitiveValues("run-1", PAYLOAD, POLICY);
    const lines: Array<Record<string, unknown>> = [];
    const sink = new Writable({
      write(chunk, _enc, cb): void {
        lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
        cb();
      },
    });
    const app = Fastify({ loggerInstance: pino({ hooks: PII_REDACTING_LOG_HOOKS }, sink) });
    app.get("/health", async () => ({ ok: true }));
    await app.inject({ method: "GET", url: "/health" });
    await app.close();

    const incoming = lines.find((l) => l.msg === "incoming request");
    const completed = lines.find((l) => l.msg === "request completed");
    expect(incoming?.req).toMatchObject({ method: "GET", url: "/health" });
    expect(completed?.res).toMatchObject({ statusCode: 200 });
  });
});
