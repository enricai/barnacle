import { Writable } from "node:stream";

import Fastify from "fastify";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { extendLogger, PII_REDACTING_LOG_HOOKS } from "@/lib/logging";
import {
  redactPii,
  redactPiiDeep,
  registerSecretValue,
  registerSensitiveValues,
  releaseSensitiveValues,
  resetSensitiveValuesForTests,
} from "@/lib/pii-redaction";
import { generateThrowawayPassword } from "@/lib/random";

const PAYLOAD = {
  JobId: "JOB-778899",
  ClickUrl: "https://careers.example.com/job/778899?vivclid=abc",
  FirstName: "Ann",
  LastName: "Sentinelson",
  Email: "ann.sentinel@example.com",
  Phone: "+15551234567",
  AddressLine: "42 Wallaby Way",
  City: "Springfield",
  PostalCode: "62704",
  Answers: { gender: "Female", veteran: "I am not a protected veteran", over18: "Yes" },
  Resume: Buffer.from("resume"),
  ResumeBase64: "cmVzdW1l",
  ResumeFilename: "Ann_Sentinelson_Resume.pdf",
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

  it("scrubs identity fields case-insensitively on word boundaries", () => {
    registerSensitiveValues("run-1", PAYLOAD);
    expect(redactPii("Fill in First Name with 'ann' and Last Name with 'SENTINELSON'")).toBe(
      "Fill in First Name with '<FirstName>' and Last Name with '<LastName>'"
    );
    // "Ann" inside another word is not the applicant's name.
    expect(redactPii("Annual review planned")).toBe("Annual review planned");
  });

  it("scrubs phone numbers in any common US formatting", () => {
    registerSensitiveValues("run-1", PAYLOAD);
    for (const formatted of ["+15551234567", "(555) 123-4567", "555.123.4567", "5551234567"]) {
      expect(redactPii(`phone=${formatted};`)).toBe("phone=<Phone>;");
    }
    expect(redactPii("call 1-800-555-0000")).toBe("call 1-800-555-0000");
  });

  it("scrubs nested answer values and the résumé filename but not job identifiers", () => {
    registerSensitiveValues("run-1", PAYLOAD);
    const out = redactPii(
      "radio: selected 'I am not a protected veteran'; uploading Ann_Sentinelson_Resume.pdf for JOB-778899"
    );
    expect(out).toContain("<Answers>");
    expect(out).toContain("<ResumeFilename>");
    expect(out).toContain("JOB-778899");
    expect(out).not.toMatch(/protected veteran|Sentinelson/);
  });

  it("keeps values scrubbed through the release grace period, then forgets them", () => {
    registerSensitiveValues("run-1", PAYLOAD);
    releaseSensitiveValues("run-1", 60_000);
    expect(redactPii("ann.sentinel@example.com")).toBe("<Email>");
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

describe("redactPiiDeep", () => {
  it("scrubs strings inside objects, arrays and errors", () => {
    registerSensitiveValues("run-1", PAYLOAD);
    const err = new Error(
      "step 3 (Fill in the Email field with 'ann.sentinel@example.com') failed"
    );
    const out = JSON.stringify(
      redactPiiDeep({ msg: "ok", steps: [{ error: err.message }], err, n: 3 })
    );
    expect(out).not.toContain("ann.sentinel@example.com");
    expect(out).toContain("<Email>");
    expect(out).toContain('"n":3');
  });

  it("scrubs an error's cause chain", () => {
    registerSensitiveValues("run-1", PAYLOAD);
    const err = new Error("submit failed", { cause: new Error(`rejected ${PAYLOAD.Email}`) });
    const out = JSON.stringify(redactPiiDeep({ err }));
    expect(out).not.toContain(PAYLOAD.Email);
    expect(out).toContain("<Email>");
  });

  it("returns class instances untouched so their serializers still see prototype getters", () => {
    registerSensitiveValues("run-1", PAYLOAD);
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
    registerSensitiveValues("run-1", PAYLOAD);
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb): void {
        lines.push(String(chunk));
        cb();
      },
    });
    const logger = pino({ hooks: PII_REDACTING_LOG_HOOKS }, sink);

    logger.info(`deepLocator filled "Email" with "${PAYLOAD.Email}"`);
    logger
      .child({ reqId: "r1" })
      .error({ err: new Error(`bad phone ${PAYLOAD.Phone}`) }, "unhandled");

    const output = lines.join("");
    expect(output).not.toContain(PAYLOAD.Email);
    expect(output).not.toContain("5551234567");
    expect(output).toContain("<Email>");
    expect(output).toContain("<Phone>");
  });

  it("scrubs a value that a CloudWatch-size split would cut in half", () => {
    registerSensitiveValues("run-1", PAYLOAD);
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
    const message = `/${PAYLOAD.Email}`.repeat(12_000);

    logger.info(message);

    const output = lines.join("");
    expect(output).not.toMatch(/sentinel|example\.com/);
    expect(output).toContain("<Email>");
  });

  it("keeps Fastify's request/response log fields while a run is registered", async () => {
    registerSensitiveValues("run-1", PAYLOAD);
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
