import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getBoolEnv, getEnv, getNodeEnv, getNumericEnv } from "@/lib/env";

/**
 * The env readers feed every field of the config singleton. A silent
 * parsing regression here would affect every consumer downstream, so
 * the boolean + numeric truth tables warrant direct coverage even
 * though the code is small.
 */

describe("lib/env getNodeEnv", () => {
  const preserved = process.env.NODE_ENV;
  afterEach(() => {
    if (preserved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = preserved;
  });

  it.each([
    ["production", "production"],
    ["test", "test"],
  ] as const)("returns %s when NODE_ENV=%s", (value, expected) => {
    process.env.NODE_ENV = value;
    expect(getNodeEnv()).toBe(expected);
  });

  it.each([
    "development",
    "staging",
    "",
    "random",
  ] as const)("defaults to development when NODE_ENV=%s", (value) => {
    process.env.NODE_ENV = value;
    expect(getNodeEnv()).toBe("development");
  });

  it("defaults to development when NODE_ENV is unset", () => {
    delete process.env.NODE_ENV;
    expect(getNodeEnv()).toBe("development");
  });
});

describe("lib/env getEnv", () => {
  const KEY = "BARNACLE_TEST_STR";
  const preserved = process.env[KEY];
  afterEach(() => {
    if (preserved === undefined) delete process.env[KEY];
    else process.env[KEY] = preserved;
  });

  it("returns the env value when set", () => {
    process.env[KEY] = "real-value";
    expect(getEnv(KEY, "default")).toBe("real-value");
  });

  it("returns the default when unset", () => {
    delete process.env[KEY];
    expect(getEnv(KEY, "default")).toBe("default");
  });

  it("returns the default when set to an empty string", () => {
    process.env[KEY] = "";
    expect(getEnv(KEY, "default")).toBe("default");
  });
});

describe("lib/env getBoolEnv", () => {
  const KEY = "BARNACLE_TEST_BOOL";
  const preserved = process.env[KEY];
  beforeEach(() => {
    delete process.env[KEY];
  });
  afterEach(() => {
    if (preserved === undefined) delete process.env[KEY];
    else process.env[KEY] = preserved;
  });

  it.each(["true", "TRUE", "True", "1", "yes", "YES"] as const)("treats %s as true", (value) => {
    process.env[KEY] = value;
    expect(getBoolEnv(KEY)).toBe(true);
  });

  it.each(["false", "0", "no", "off", "nope"] as const)("treats %s as false", (value) => {
    process.env[KEY] = value;
    expect(getBoolEnv(KEY)).toBe(false);
  });

  it("returns defaultValue when unset", () => {
    expect(getBoolEnv(KEY, true)).toBe(true);
    expect(getBoolEnv(KEY, false)).toBe(false);
  });
});

describe("lib/env getNumericEnv", () => {
  const KEY = "BARNACLE_TEST_NUM";
  const preserved = process.env[KEY];
  beforeEach(() => {
    delete process.env[KEY];
  });
  afterEach(() => {
    if (preserved === undefined) delete process.env[KEY];
    else process.env[KEY] = preserved;
  });

  it("parses a valid integer", () => {
    process.env[KEY] = "42";
    expect(getNumericEnv(KEY, 0)).toBe(42);
  });

  it("parses a negative integer", () => {
    process.env[KEY] = "-7";
    expect(getNumericEnv(KEY, 0)).toBe(-7);
  });

  it("takes the leading integer of a mixed string (parseInt semantics)", () => {
    process.env[KEY] = "42abc";
    expect(getNumericEnv(KEY, 0)).toBe(42);
  });

  it("falls back when the value is not numeric", () => {
    process.env[KEY] = "not-a-number";
    expect(getNumericEnv(KEY, 99)).toBe(99);
  });

  it("falls back when unset", () => {
    expect(getNumericEnv(KEY, 99)).toBe(99);
  });
});
