import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

const mockReadFileSync = vi.hoisted(() => vi.fn());

vi.mock("node:fs", () => ({ readFileSync: mockReadFileSync }));

import { loadFixture } from "@/scraper/fixtures";

afterEach(() => {
  vi.clearAllMocks();
});

const TestSchema = z.object({ id: z.string(), value: z.number() });

describe("scraper/fixtures loadFixture", () => {
  it("returns parsed, validated data on a valid fixture file", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ id: "abc", value: 42 }));
    const result = loadFixture("test-site", "data.json", TestSchema);
    expect(result).toEqual({ id: "abc", value: 42 });
  });

  it("throws a helpful error when the fixture file does not exist", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    expect(() => loadFixture("test-site", "missing.json", TestSchema)).toThrow(
      /run recon-http\.ts/
    );
  });

  it("throws a helpful error when the fixture file contains invalid JSON", () => {
    mockReadFileSync.mockReturnValue("not { valid json");
    expect(() => loadFixture("test-site", "bad.json", TestSchema)).toThrow(/not valid JSON/);
  });

  it("throws a helpful error when the fixture does not match the schema", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ id: 123, value: "wrong type" }));
    expect(() => loadFixture("test-site", "drift.json", TestSchema)).toThrow(/schema mismatch/);
  });
});
