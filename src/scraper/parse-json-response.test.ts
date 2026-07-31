import { describe, expect, it } from "vitest";
import { z } from "zod/v4";

import { HttpSchemaError, HttpUrlLockedError } from "@/scraper/errors";
import { parseJsonResponse } from "@/scraper/parse-json-response";

const LABEL = "test/endpoint";

const SimpleSchema = z.object({
  id: z.string(),
  count: z.number(),
});

describe("parseJsonResponse", () => {
  describe("valid JSON + matching schema", () => {
    it("returns the narrowed data on a well-formed body", () => {
      const raw = JSON.stringify({ id: "abc", count: 3 });
      const result = parseJsonResponse(raw, SimpleSchema, LABEL);
      expect(result).toEqual({ id: "abc", count: 3 });
    });

    it("strips unknown fields via Zod passthrough default", () => {
      const raw = JSON.stringify({ id: "x", count: 1, extra: "ignored" });
      const result = parseJsonResponse(raw, SimpleSchema, LABEL);
      expect(result).toEqual({ id: "x", count: 1 });
    });
  });

  describe("plugin-supplied classifyBody on a non-JSON body", () => {
    // Stands in for a vendor sentinel a plugin recognizes; the engine itself
    // knows no vendor wire format.
    const classify = (raw: string): HttpUrlLockedError | undefined =>
      raw.trim() === "SENTINEL_LOCKED" ? new HttpUrlLockedError() : undefined;

    it("throws the classifier's error when it recognizes the body", () => {
      expect(() => parseJsonResponse("SENTINEL_LOCKED", SimpleSchema, LABEL, classify)).toThrow(
        HttpUrlLockedError
      );
    });

    it("receives the raw (untrimmed) body so the plugin owns trimming", () => {
      expect(() => parseJsonResponse("  SENTINEL_LOCKED\n", SimpleSchema, LABEL, classify)).toThrow(
        HttpUrlLockedError
      );
    });

    it("does NOT throw HttpSchemaError when the classifier handles the body", () => {
      expect(() => parseJsonResponse("SENTINEL_LOCKED", SimpleSchema, LABEL, classify)).not.toThrow(
        HttpSchemaError
      );
    });

    it("falls through to HttpSchemaError when the classifier returns undefined", () => {
      expect(() => parseJsonResponse("SENTINEL_OTHER", SimpleSchema, LABEL, classify)).toThrow(
        HttpSchemaError
      );
    });

    it("with no classifier, a non-JSON body is a plain HttpSchemaError", () => {
      expect(() => parseJsonResponse("SENTINEL_LOCKED", SimpleSchema, LABEL)).toThrow(
        HttpSchemaError
      );
    });
  });

  describe("non-JSON body", () => {
    it("throws HttpSchemaError", () => {
      expect(() => parseJsonResponse("not json", SimpleSchema, LABEL)).toThrow(HttpSchemaError);
    });

    it("includes contextLabel in the message", () => {
      expect(() => parseJsonResponse("not json", SimpleSchema, LABEL)).toThrow(
        `${LABEL} non-JSON body:`
      );
    });

    it("includes first 200B of body in the message", () => {
      const body = "x".repeat(300);
      expect(() => parseJsonResponse(body, SimpleSchema, LABEL)).toThrow(
        `first 200B: ${"x".repeat(200)}`
      );
    });

    it("body prefix is capped at 200 characters even for longer bodies", () => {
      const body = "!".repeat(500);
      let message = "";
      try {
        parseJsonResponse(body, SimpleSchema, LABEL);
      } catch (err) {
        message = err instanceof Error ? err.message : "";
      }
      const prefix200Idx = message.indexOf("first 200B: ");
      expect(prefix200Idx).toBeGreaterThan(-1);
      // message ends with `<200-char slice>)` — strip the closing paren
      const captured = message.slice(prefix200Idx + "first 200B: ".length, -1);
      expect(captured.length).toBe(200);
    });
  });

  describe("JSON body failing schema validation", () => {
    it("throws HttpSchemaError", () => {
      const raw = JSON.stringify({ id: 123, count: "wrong" });
      expect(() => parseJsonResponse(raw, SimpleSchema, LABEL)).toThrow(HttpSchemaError);
    });

    it("includes contextLabel in the message", () => {
      const raw = JSON.stringify({ id: 123 });
      expect(() => parseJsonResponse(raw, SimpleSchema, LABEL)).toThrow(
        `${LABEL} body failed Zod parse:`
      );
    });

    it("includes a slice of the Zod error message", () => {
      const raw = JSON.stringify({ wrong: true });
      let message = "";
      try {
        parseJsonResponse(raw, SimpleSchema, LABEL);
      } catch (err) {
        message = err instanceof Error ? err.message : "";
      }
      expect(message).toMatch(/body failed Zod parse:/);
      expect(message.length).toBeGreaterThan(`${LABEL} body failed Zod parse: `.length);
    });

    it("Zod error is capped at 300 characters", () => {
      // Schema that produces a long error message by requiring many fields
      const BigSchema = z.object(
        Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`field${i}`, z.string()]))
      );
      let message = "";
      try {
        parseJsonResponse("{}", BigSchema, LABEL);
      } catch (err) {
        message = err instanceof Error ? err.message : "";
      }
      const prefix = `${LABEL} body failed Zod parse: `;
      const zodPart = message.slice(prefix.length);
      expect(zodPart.length).toBeLessThanOrEqual(300);
    });
  });
});
