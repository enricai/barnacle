/**
 * Unit tests for the telemetry-dir migration script. Each test builds a
 * fake `<tmp>/sites/<site>/telemetry/runs/<dir>/...` tree under mkdtemp
 * so the migrator can be exercised end-to-end without touching the real
 * src/sites/ tree.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  getScriptLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    errorWithStack: vi.fn(),
  }),
}));

import { urlDirName } from "@/lib/telemetry/telemetry-paths";

import { migrateTelemetryDirs, parseArgs } from "@/scripts/migrate-telemetry-dir-names";

let tmpRoot: string;
let sitesRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "migrate-telemetry-test-"));
  sitesRoot = join(tmpRoot, "sites");
  mkdirSync(sitesRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Build a partition dir with the given name, populated with url.txt + optional calls.ndjson. */
function makePartition(
  siteName: string,
  partitionName: string,
  url: string,
  opts?: { withCalls?: boolean; mtimeMs?: number }
): string {
  const partitionDir = join(sitesRoot, siteName, "telemetry", "runs", partitionName);
  mkdirSync(partitionDir, { recursive: true });
  writeFileSync(join(partitionDir, "url.txt"), `${url}\n`);
  if (opts?.withCalls !== false) {
    const callsPath = join(partitionDir, "calls.ndjson");
    writeFileSync(callsPath, '{"id":1}\n');
    if (opts?.mtimeMs !== undefined) {
      const seconds = opts.mtimeMs / 1000;
      utimesSync(callsPath, seconds, seconds);
    }
  }
  return partitionDir;
}

describe("migrateTelemetryDirs/dry-run by default", () => {
  it("does not rename anything when apply=false", () => {
    const url = "https://example.com/apply";
    const oldName = "aHR0cHM6Ly9leGFtcGxlLmNvbS9hcHBseQ"; // illustrative; doesn't have to be the real base64
    makePartition("foo", oldName, url, { mtimeMs: 1781140712843 });
    const outcome = migrateTelemetryDirs({ sitesRoot, siteFilter: null, apply: false });
    expect(outcome.migrated).toBe(1);
    expect(outcome.alreadyMigrated).toBe(0);
    expect(outcome.warnings).toBe(0);
    // Old dir still exists, new dir does not.
    expect(existsSync(join(sitesRoot, "foo", "telemetry", "runs", oldName))).toBe(true);
    expect(
      existsSync(join(sitesRoot, "foo", "telemetry", "runs", urlDirName(1781140712843, url)))
    ).toBe(false);
  });
});

describe("migrateTelemetryDirs/apply renames to ts+hash", () => {
  it("renames a base64-named partition to <ts>-<hash> derived from url.txt + mtime", () => {
    const url = "https://example.com/apply";
    const oldName = "aHR0cHM6Ly9leGFtcGxlLmNvbS9hcHBseQ";
    makePartition("foo", oldName, url, { mtimeMs: 1781140712843 });
    const outcome = migrateTelemetryDirs({ sitesRoot, siteFilter: null, apply: true });
    expect(outcome.migrated).toBe(1);
    const expectedNewName = urlDirName(1781140712843, url);
    expect(existsSync(join(sitesRoot, "foo", "telemetry", "runs", oldName))).toBe(false);
    expect(existsSync(join(sitesRoot, "foo", "telemetry", "runs", expectedNewName))).toBe(true);
  });
});

describe("migrateTelemetryDirs/idempotency", () => {
  it("skips dirs that already match <ts>-<hash> shape", () => {
    const url = "https://example.com/apply";
    const alreadyMigratedName = urlDirName(1781140712843, url);
    makePartition("foo", alreadyMigratedName, url, { mtimeMs: 1781140712843 });
    const outcome = migrateTelemetryDirs({ sitesRoot, siteFilter: null, apply: true });
    expect(outcome.migrated).toBe(0);
    expect(outcome.alreadyMigrated).toBe(1);
  });

  it("a second migration run is a no-op after the first apply", () => {
    const url = "https://example.com/apply";
    makePartition("foo", "aHR0cHM6Ly9leGFtcGxlLmNvbS9hcHBseQ", url, { mtimeMs: 1781140712843 });
    migrateTelemetryDirs({ sitesRoot, siteFilter: null, apply: true });
    const secondPass = migrateTelemetryDirs({ sitesRoot, siteFilter: null, apply: true });
    expect(secondPass.migrated).toBe(0);
    expect(secondPass.alreadyMigrated).toBe(1);
  });
});

describe("migrateTelemetryDirs/safety guards", () => {
  it("skips and warns when url.txt is missing", () => {
    const partitionDir = join(sitesRoot, "foo", "telemetry", "runs", "no-url-txt");
    mkdirSync(partitionDir, { recursive: true });
    // No url.txt written.
    const outcome = migrateTelemetryDirs({ sitesRoot, siteFilter: null, apply: true });
    expect(outcome.migrated).toBe(0);
    expect(outcome.warnings).toBe(1);
    expect(existsSync(partitionDir)).toBe(true);
  });

  it("skips and warns when url.txt is empty", () => {
    const partitionDir = join(sitesRoot, "foo", "telemetry", "runs", "empty-url-txt");
    mkdirSync(partitionDir, { recursive: true });
    writeFileSync(join(partitionDir, "url.txt"), "");
    const outcome = migrateTelemetryDirs({ sitesRoot, siteFilter: null, apply: true });
    expect(outcome.warnings).toBe(1);
    expect(existsSync(partitionDir)).toBe(true);
  });

  it("skips and warns when target dir already exists (collision)", () => {
    const url = "https://example.com/apply";
    const oldName = "aHR0cHM6Ly9leGFtcGxlLmNvbS9hcHBseQ";
    makePartition("foo", oldName, url, { mtimeMs: 1781140712843 });
    // Pre-create the target dir to force a collision.
    const targetName = urlDirName(1781140712843, url);
    mkdirSync(join(sitesRoot, "foo", "telemetry", "runs", targetName), { recursive: true });
    const outcome = migrateTelemetryDirs({ sitesRoot, siteFilter: null, apply: true });
    expect(outcome.warnings).toBe(1);
    expect(existsSync(join(sitesRoot, "foo", "telemetry", "runs", oldName))).toBe(true);
  });
});

describe("migrateTelemetryDirs/site filter", () => {
  it("only touches the named site when siteFilter is set", () => {
    const url = "https://example.com/apply";
    makePartition("foo", "aHR0cHM6Ly9leGFtcGxlLmNvbS9hcHBseQ", url, { mtimeMs: 1781140712843 });
    makePartition("bar", "aHR0cHM6Ly9leGFtcGxlLmNvbS9hcHBseQ", url, { mtimeMs: 1781140712844 });
    const outcome = migrateTelemetryDirs({ sitesRoot, siteFilter: "foo", apply: true });
    expect(outcome.migrated).toBe(1);
    // bar's partition is untouched.
    expect(
      readdirSync(join(sitesRoot, "bar", "telemetry", "runs")).some((n) => n.startsWith("aHR0cHM6"))
    ).toBe(true);
  });
});

describe("migrateTelemetryDirs/no telemetry dir", () => {
  it("skips a site that has no telemetry/runs subtree", () => {
    mkdirSync(join(sitesRoot, "empty-site"), { recursive: true });
    const outcome = migrateTelemetryDirs({ sitesRoot, siteFilter: null, apply: true });
    expect(outcome.migrated).toBe(0);
    expect(outcome.warnings).toBe(0);
  });
});

describe("parseArgs", () => {
  it("defaults to dry-run", () => {
    expect(parseArgs(["node", "script.ts"])).toEqual({ apply: false, siteFilter: null });
  });

  it("flips apply when --apply is present", () => {
    expect(parseArgs(["node", "script.ts", "--apply"])).toEqual({
      apply: true,
      siteFilter: null,
    });
  });

  it("captures --site <name>", () => {
    expect(parseArgs(["node", "script.ts", "--site", "ats-c", "--apply"])).toEqual({
      apply: true,
      siteFilter: "ats-c",
    });
  });
});
