import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  readDeclaredEndpointPatterns,
  readFlowReadOnly,
  readOwnBackendHostnames,
  readSubmitBodyPattern,
  readSubmitEndpointPattern,
  readSuccessUrlFragments,
} from "@/scripts/recon-shared";

const DIR = mkdtempSync(join(tmpdir(), "flow-readers-"));
const flow = (name: string, body: string): string => {
  const path = join(DIR, name);
  writeFileSync(path, body);
  return path;
};

describe.each([
  ["readSuccessUrlFragments", readSuccessUrlFragments, "successUrlFragments"],
  ["readOwnBackendHostnames", readOwnBackendHostnames, "ownBackendHostnames"],
] as const)("%s", (_n, fn, key) => {
  it("returns only non-empty strings", () => {
    expect(fn(flow(`${key}1.json`, JSON.stringify({ [key]: ["a", "", 3, "b"] })))).toEqual([
      "a",
      "b",
    ]);
  });
  it("returns [] for bare-array flow, missing key, non-array value", () => {
    expect(fn(flow(`${key}2.json`, "[]"))).toEqual([]);
    expect(fn(flow(`${key}3.json`, "{}"))).toEqual([]);
    expect(fn(flow(`${key}4.json`, JSON.stringify({ [key]: "x" })))).toEqual([]);
  });
  it("returns [] for malformed or missing files", () => {
    expect(fn(flow(`${key}5.json`, "nope"))).toEqual([]);
    expect(fn(join(DIR, "missing.json"))).toEqual([]);
  });
});

describe("readDeclaredEndpointPatterns", () => {
  it("returns submit pattern first, then foldReturn object", () => {
    const f = flow(
      "dep1.json",
      JSON.stringify({
        submitEndpointPattern: "/s",
        foldReturn: { endpointPattern: "/f" },
      })
    );
    expect(readDeclaredEndpointPatterns(f)).toEqual(["/s", "/f"]);
  });
  it("returns all foldReturn array patterns", () => {
    const f = flow(
      "dep2.json",
      JSON.stringify({
        submitEndpointPattern: "/s",
        foldReturn: [{ endpointPattern: "/a" }, {}, { endpointPattern: "/b" }],
      })
    );
    expect(readDeclaredEndpointPatterns(f)).toEqual(["/s", "/a", "/b"]);
  });
  it("returns [] for bare array, neither field, malformed, missing", () => {
    expect(readDeclaredEndpointPatterns(flow("dep3.json", "[]"))).toEqual([]);
    expect(readDeclaredEndpointPatterns(flow("dep4.json", "{}"))).toEqual([]);
    expect(readDeclaredEndpointPatterns(flow("dep5.json", "nope"))).toEqual([]);
    expect(readDeclaredEndpointPatterns(join(DIR, "missing.json"))).toEqual([]);
  });
});

describe("readSubmitEndpointPattern", () => {
  it("returns the pattern, and undefined for absent/array/unreadable", () => {
    expect(readSubmitEndpointPattern(flow("s1.json", '{"submitEndpointPattern":"/x"}'))).toBe("/x");
    expect(readSubmitEndpointPattern(flow("s2.json", "{}"))).toBeUndefined();
    expect(readSubmitEndpointPattern(flow("s3.json", "[]"))).toBeUndefined();
    expect(readSubmitEndpointPattern(flow("s4.json", "{bad"))).toBeUndefined();
    expect(readSubmitEndpointPattern(join(DIR, "missing.json"))).toBeUndefined();
  });
});

describe("readSubmitBodyPattern", () => {
  it("returns the pattern, and undefined for absent/array/unreadable", () => {
    expect(readSubmitBodyPattern(flow("b1.json", '{"submitBodyPattern":"Foo"}'))).toBe("Foo");
    expect(readSubmitBodyPattern(flow("b2.json", "{}"))).toBeUndefined();
    expect(readSubmitBodyPattern(flow("b3.json", "[]"))).toBeUndefined();
    expect(readSubmitBodyPattern(flow("b4.json", "{bad"))).toBeUndefined();
  });
});

describe("readFlowReadOnly", () => {
  it("is true only for a literal true", () => {
    expect(readFlowReadOnly(flow("ro1.json", '{"readOnly":true}'))).toBe(true);
    expect(readFlowReadOnly(flow("ro2.json", '{"readOnly":"true"}'))).toBe(false);
    expect(readFlowReadOnly(flow("ro3.json", "{}"))).toBe(false);
    expect(readFlowReadOnly(flow("ro4.json", "[]"))).toBe(false);
  });
});
