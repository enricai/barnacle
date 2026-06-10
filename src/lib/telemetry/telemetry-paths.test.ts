/**
 * Unit coverage for the per-site / per-URL telemetry path helpers.
 *
 * The helpers wrap a couple of behaviours that are easy to get subtly wrong
 * (URL canonicalization, hash stability, partition walking on a missing
 * directory), so a small focused suite locks those in without standing up
 * the full recon harness.
 */

import { Buffer } from "node:buffer";
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
  it("collapses query-only variants to the same directory name", () => {
    expect(urlDirName("https://example.com/apply?a=1")).toBe(
      urlDirName("https://example.com/apply?b=2")
    );
  });

  it("returns different names for different paths", () => {
    expect(urlDirName("https://example.com/jobs/100")).not.toBe(
      urlDirName("https://example.com/jobs/101")
    );
  });

  it("produces filesystem-safe base64url output (no /, +, =)", () => {
    const name = urlDirName("https://example.com/jobs/abc?token=xyz");
    expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("round-trips back to the canonical URL", () => {
    const url = "https://example.com/jobs/12345";
    const name = urlDirName(url);
    const decoded = Buffer.from(name, "base64url").toString("utf8");
    expect(decoded).toBe(canonicalizeUrl(url));
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
  it("places calls.ndjson under runs/<urlDirName>/", () => {
    const dir = "/site/telemetry";
    const url = "https://example.com/apply";
    expect(resolveRunCallsPath(dir, url)).toBe(`${dir}/runs/${urlDirName(url)}/calls.ndjson`);
    expect(resolveRunUrlPath(dir, url)).toBe(`${dir}/runs/${urlDirName(url)}/url.txt`);
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
