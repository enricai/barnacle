/**
 * Unit coverage for the per-site / per-URL telemetry path helpers.
 *
 * The helpers wrap a couple of behaviours that are easy to get subtly wrong
 * (URL canonicalization, directory-name uniqueness, partition walking on a
 * missing directory), so a small focused suite locks those in without
 * standing up the full recon harness.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  canonicalizeUrl,
  readSiteCallsNdjson,
  resolveRunCallsPath,
  resolveRunUrlPath,
  resolveSiteTelemetryDir,
  urlDirName,
} from "@/lib/telemetry/telemetry-paths";

describe("telemetry-paths/canonicalizeUrl", () => {
  it("strips query parameters", () => {
    expect(canonicalizeUrl("https://example.com/apply?utm_source=foo&jobId=123")).toBe(
      "https://example.com/apply"
    );
  });

  it("strips hash fragments", () => {
    expect(canonicalizeUrl("https://example.com/apply#step2")).toBe("https://example.com/apply");
  });

  it("treats www and non-www as different identities", () => {
    expect(canonicalizeUrl("https://www.example.com/apply")).not.toBe(
      canonicalizeUrl("https://example.com/apply")
    );
  });

  it("normalises trailing slash + scheme case to a canonical form", () => {
    expect(canonicalizeUrl("HTTPS://Example.com/apply/")).toBe(
      canonicalizeUrl("https://example.com/apply")
    );
  });
});

describe("telemetry-paths/urlDirName", () => {
  it("collapses query-only variants to the same directory name (same ts)", () => {
    const ts = 1781140712843;
    expect(urlDirName(ts, "https://example.com/apply?a=1")).toBe(
      urlDirName(ts, "https://example.com/apply?b=2")
    );
  });

  it("returns different names for different paths (same ts)", () => {
    const ts = 1781140712843;
    expect(urlDirName(ts, "https://example.com/jobs/100")).not.toBe(
      urlDirName(ts, "https://example.com/jobs/101")
    );
  });

  it("returns different names for the same URL at different timestamps", () => {
    const url = "https://example.com/jobs/100";
    expect(urlDirName(1781140712843, url)).not.toBe(urlDirName(1781140712844, url));
  });

  it("produces filesystem-safe output: only digits, hyphen, and hex chars", () => {
    const name = urlDirName(1781140712843, "https://example.com/jobs/abc?token=xyz");
    expect(name).toMatch(/^\d+-[0-9a-f]+$/);
  });

  it("keeps total length well under filesystem NAME_MAX (255)", () => {
    // Pathologically long URL — same as the data:URL shape that crashed
    // Bethesda. The output must still be safe.
    const huge = `data:image/svg+xml;base64,${"P".repeat(5000)}`;
    expect(urlDirName(1781140712843, huge).length).toBeLessThanOrEqual(64);
  });

  it("is deterministic: same (ts, url) yields the same name on every call", () => {
    const ts = 1781140712843;
    const url = "https://example.com/jobs/12345";
    expect(urlDirName(ts, url)).toBe(urlDirName(ts, url));
  });

  it("sorts chronologically by the timestamp prefix", () => {
    const url = "https://example.com/apply";
    const earlier = urlDirName(1781140712843, url);
    const later = urlDirName(1781140712844, url);
    expect([later, earlier].sort()).toEqual([earlier, later]);
  });
});

describe("telemetry-paths/resolveSiteTelemetryDir", () => {
  it("returns null when no flow file is provided", () => {
    expect(resolveSiteTelemetryDir(null)).toBeNull();
  });

  it("returns <flowDir>/telemetry for a flow file path", () => {
    expect(resolveSiteTelemetryDir("/path/to/site/recon-flow.json")).toBe(
      "/path/to/site/telemetry"
    );
  });
});

describe("telemetry-paths/resolveRunCallsPath + resolveRunUrlPath", () => {
  it("places calls.ndjson and url.txt under runs/<ts-hash>/ with matching ts", () => {
    const dir = "/site/telemetry";
    const ts = 1781140712843;
    const url = "https://example.com/apply";
    expect(resolveRunCallsPath(dir, ts, url)).toBe(
      `${dir}/runs/${urlDirName(ts, url)}/calls.ndjson`
    );
    expect(resolveRunUrlPath(dir, ts, url)).toBe(`${dir}/runs/${urlDirName(ts, url)}/url.txt`);
  });

  it("calls.ndjson and url.txt sit in the same dir when called with the same (ts, url)", () => {
    const dir = "/site/telemetry";
    const ts = 1781140712843;
    const url = "https://example.com/apply";
    const callsPath = resolveRunCallsPath(dir, ts, url);
    const urlPath = resolveRunUrlPath(dir, ts, url);
    // Drop the filename, compare parent directories.
    expect(callsPath.replace(/\/[^/]+$/, "")).toBe(urlPath.replace(/\/[^/]+$/, ""));
  });
});

describe("telemetry-paths/readSiteCallsNdjson", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "telemetry-paths-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty string when runs/ does not exist", () => {
    expect(readSiteCallsNdjson(tmpDir)).toBe("");
  });

  it("concatenates calls.ndjson across partitions", () => {
    const runsDir = join(tmpDir, "runs");
    mkdirSync(join(runsDir, "aaa"), { recursive: true });
    mkdirSync(join(runsDir, "bbb"), { recursive: true });
    writeFileSync(join(runsDir, "aaa", "calls.ndjson"), '{"id":1}\n');
    writeFileSync(join(runsDir, "bbb", "calls.ndjson"), '{"id":2}\n');
    const merged = readSiteCallsNdjson(tmpDir);
    expect(merged).toContain('{"id":1}');
    expect(merged).toContain('{"id":2}');
  });

  it("ignores partition directories without a calls.ndjson", () => {
    const runsDir = join(tmpDir, "runs");
    mkdirSync(join(runsDir, "aaa"), { recursive: true });
    mkdirSync(join(runsDir, "empty"), { recursive: true });
    writeFileSync(join(runsDir, "aaa", "calls.ndjson"), '{"id":1}\n');
    const merged = readSiteCallsNdjson(tmpDir);
    expect(merged).toBe('{"id":1}\n');
  });
});
