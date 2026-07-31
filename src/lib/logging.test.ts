import type pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getLogger, splitLargeMessage } from "@/lib/logging";

const pinoOptionsCalls: pino.LoggerOptions[] = [];

// Spies on the options pino is constructed with, so tests can assert on
// `transport` directly instead of relying on pino-pretty being absent from
// node_modules (it's a devDependency and is installed in this repo's test
// environment either way).
vi.mock("pino", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("pino") & { default: typeof pino };
  const spied = (options: pino.LoggerOptions) => {
    pinoOptionsCalls.push(options);
    return actual.default(options);
  };
  return { ...actual, default: spied };
});

/** Re-imports the module fresh under the given NODE_ENV — isDevelopment
 * and the pino transport are computed once at module load. */
async function loadLoggingWithNodeEnv(nodeEnv: string) {
  const preserved = process.env.NODE_ENV;
  process.env.NODE_ENV = nodeEnv;
  vi.resetModules();
  const mod = await import("@/lib/logging.js");
  process.env.NODE_ENV = preserved;
  return mod;
}

/**
 * CloudWatch caps log events at 256KB. splitLargeMessage is the one
 * piece of logic in this module that does real work — the pino wiring
 * is battle-tested library code, but the splitter is ours.
 *
 * Tests cover the three split strategies (newline / space / byte-safe
 * character boundary) plus the happy path where no splitting is
 * needed. Also pins the chunk-prefix format so downstream log
 * aggregators that rely on the "[i/n]" markers don't break silently.
 */

describe("lib/logging splitLargeMessage", () => {
  it("returns the message unchanged when under the size limit", () => {
    expect(splitLargeMessage("hello world", 1000)).toEqual(["hello world"]);
  });

  it("splits on a newline boundary when one exists past halfMax", () => {
    // Newline sits at position 60; maxSize 100 means halfMax=50.
    // The split should cut right after the newline (position 61).
    const first = `${"a".repeat(60)}\n`;
    const rest = "b".repeat(80);
    const chunks = splitLargeMessage(first + rest, 100);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(first);
    expect(chunks[1]).toBe(rest);
  });

  it("splits on a space boundary when no newline is available", () => {
    // Space at position 60, no newline. maxSize=100, halfMax=50.
    const first = `${"a".repeat(60)} `;
    const rest = "b".repeat(80);
    const chunks = splitLargeMessage(first + rest, 100);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(first);
    expect(chunks[1]).toBe(rest);
  });

  it("falls back to a character-boundary cut when no natural boundary exists", () => {
    // No whitespace anywhere. Splitter must still produce ≤ maxSize
    // chunks by walking character boundaries.
    const payload = "x".repeat(250);
    const chunks = splitLargeMessage(payload, 100);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
    expect(chunks.join("")).toBe(payload);
  });

  it("preserves multi-byte UTF-8 characters instead of splitting mid-codepoint", () => {
    // Each 🚢 is 4 bytes in UTF-8. A naive split would risk cutting
    // one in half; findCharacterBoundary must prevent that.
    const payload = "🚢".repeat(40); // 160 bytes, no whitespace
    const chunks = splitLargeMessage(payload, 50);
    for (const chunk of chunks) {
      // Every chunk must re-encode to ≤ maxSize without a replacement
      // character (U+FFFD), which is what appears when a codepoint
      // gets split.
      expect(chunk).not.toContain("�");
    }
    expect(chunks.join("")).toBe(payload);
  });

  it("never splits a surrogate pair between chunks (emoji stay intact)", () => {
    // Each 🎉 is one codepoint but two UTF-16 code units (high +
    // low surrogate). Older findCharacterBoundary walked by code
    // units and would count the high surrogate alone as 3 bytes,
    // then if that byte budget exceeded maxSize it broke before
    // consuming the low surrogate — chunk ended on an unpaired
    // high surrogate, which re-encodes to U+FFFD in UTF-8 and
    // silently corrupts the emoji in the downstream log.
    //
    // maxSize=5 forces the issue: 🎉🎉🎉 = 12 bytes in UTF-8, split
    // at 5 bytes the split lands mid-emoji. Pin by asserting every
    // chunk's first and last code unit are not lone surrogates.
    const payload = "🎉🎉🎉🎉";
    const chunks = splitLargeMessage(payload, 5);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // A lone high surrogate is in [0xD800, 0xDBFF]; a lone low
      // surrogate is in [0xDC00, 0xDFFF]. Both must be paired.
      const firstCode = chunk.charCodeAt(0);
      if (firstCode >= 0xdc00 && firstCode <= 0xdfff) {
        throw new Error(`chunk begins with orphan low surrogate: 0x${firstCode.toString(16)}`);
      }
      const lastCode = chunk.charCodeAt(chunk.length - 1);
      if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
        throw new Error(`chunk ends with orphan high surrogate: 0x${lastCode.toString(16)}`);
      }
    }
    // Round-trip: joining the chunks must exactly reconstruct the input.
    expect(chunks.join("")).toBe(payload);
  });
});

describe("lib/logging getLogger", () => {
  it("returns a Logger that exposes the pino surface + errorWithStack", () => {
    const logger = getLogger({ name: "test-scope" });
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.errorWithStack).toBe("function");
  });

  it("errorWithStack handles Error instances without throwing", () => {
    const logger = getLogger({ name: "test-scope" });
    expect(() => logger.errorWithStack(new Error("boom"), "context")).not.toThrow();
  });

  it("errorWithStack handles non-Error throws without crashing", () => {
    const logger = getLogger({ name: "test-scope" });
    expect(() => logger.errorWithStack("string thrown")).not.toThrow();
    expect(() => logger.errorWithStack({ custom: "shape" })).not.toThrow();
  });

  it("info/warn/error/debug handle a non-string first arg (object payload) without throwing", () => {
    // Non-string payloads take the else branch of logWithSplitting —
    // pino's own serializer handles them, we just pass through.
    const logger = getLogger({ name: "test-scope" });
    expect(() => logger.info({ user: 42 }, "payload msg")).not.toThrow();
    expect(() => logger.warn({ retry: 3 })).not.toThrow();
    expect(() => logger.error({ err: "x" })).not.toThrow();
    expect(() => logger.debug({ op: "probe" })).not.toThrow();
  });

  it("info/warn/error/debug handle string first arg (split path) without throwing", () => {
    const logger = getLogger({ name: "test-scope" });
    expect(() => logger.info("simple string")).not.toThrow();
    expect(() => logger.warn("simple warn")).not.toThrow();
    expect(() => logger.error("simple error")).not.toThrow();
    expect(() => logger.debug("simple debug")).not.toThrow();
  });
});

/**
 * Pins the pino-pretty prod-crash fix: getScriptLogger must gate its
 * transport behind the same isDevelopment check getLogger uses, so it can
 * never drag a devDependency-only transport into a production module-load
 * path (see the crash report for src/lib/llm/judge.ts).
 */
describe("lib/logging getScriptLogger", () => {
  afterEach(() => {
    pinoOptionsCalls.length = 0;
  });

  it("configures no transport (raw JSON) under NODE_ENV=production", async () => {
    const { getScriptLogger } = await loadLoggingWithNodeEnv("production");
    pinoOptionsCalls.length = 0;
    getScriptLogger("test-script");
    expect(pinoOptionsCalls.at(-1)?.transport).toBeUndefined();
  });

  it("configures no transport (raw JSON) under NODE_ENV=test", async () => {
    const { getScriptLogger } = await loadLoggingWithNodeEnv("test");
    pinoOptionsCalls.length = 0;
    getScriptLogger("test-script");
    expect(pinoOptionsCalls.at(-1)?.transport).toBeUndefined();
  });

  it("still configures the pino-pretty transport under NODE_ENV=development", async () => {
    const { getScriptLogger } = await loadLoggingWithNodeEnv("development");
    pinoOptionsCalls.length = 0;
    getScriptLogger("test-script");
    expect(pinoOptionsCalls.at(-1)?.transport).toEqual({
      target: "pino-pretty",
      options: { colorize: true, translateTime: "SYS:standard", ignore: "pid,hostname" },
    });
  });
});
