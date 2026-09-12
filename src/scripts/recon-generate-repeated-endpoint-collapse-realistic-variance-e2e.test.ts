import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * recon-generate-rest-repeated-endpoint-collapse-e2e.test.ts already pins two
 * variance shapes: a flat toggles poll with zero request variance, and a
 * paginated listing whose only varying field is pagination-shaped. Neither
 * covers two other realistic shapes the same collapse mechanism must handle:
 * a per-item drill re-fired with a byte-identical request (a genuine
 * duplicate/retry, not a distinct item, so its response has an object-array
 * field rather than the flat-toggle shape) and a polled endpoint fired at
 * report scale (6x) whose response VALUES differ (a boolean flips) while its
 * shape stays constant. This file exercises those two shapes in isolation
 * from the noise-exclusion and URL-templating concerns test-001/test-002
 * cover.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-repeated-endpoint-realistic-variance.example.com";
const POLL_URL = `https://${OWN_BACKEND_HOST}/feature-flags/catalog-availability`;
const DRILL_URL = `https://${OWN_BACKEND_HOST}/catalog/item-availability`;

const POLL_REFIRE_COUNT = 6;
const DRILL_RETRY_COUNT = 2;

function reportShapeCaptures(): Capture[] {
  const poll = Array.from({ length: POLL_REFIRE_COUNT }, (_, i) =>
    buildCapture({
      url: POLL_URL,
      requestPostData: "[]",
      // Every re-fire carries the identical request, but the boolean value
      // flips from poll to poll — the response VALUE varies while its shape
      // (and `responseShapeKey`) stays constant.
      responseBody: [{ name: "feature-a", enabled: i % 2 === 0 }],
      timestamp: `2024-01-01T00:00:${String(i).padStart(2, "0")}Z`,
    })
  );
  const drill = Array.from({ length: DRILL_RETRY_COUNT }, (_, i) =>
    buildCapture({
      url: DRILL_URL,
      // A genuine duplicate/retry: byte-identical request AND response, not
      // a second distinct item.
      requestPostData: JSON.stringify({ itemId: "item-1" }),
      responseBody: { units: [{ unitId: "unit-1" }], exchangeRate: 1.0 },
      timestamp: `2024-01-01T00:02:${String(i).padStart(2, "0")}Z`,
    })
  );
  return [...poll, ...drill];
}

function writeRunDir(root: string, captures: Capture[]): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));
  captures.forEach((capture, index) => {
    writeFileSync(
      join(root, "graphql", `${String(index).padStart(3, "0")}-capture.json`),
      JSON.stringify(capture)
    );
  });
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — repeated same-endpoint captures collapse for realistic variance shapes beyond the flat-poll/pagination pair", () => {
  it("collapses a duplicate/retried per-item drill and a value-varying poll fired at report scale, each to a single call", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-repeated-endpoint-realistic-variance-e2e-"));
    const runRoot = join(workDir, "run");
    const captures = reportShapeCaptures();
    writeRunDir(runRoot, captures);

    const siteId = `repeated-endpoint-realistic-variance-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "poll feature flags" },
          { step: "check catalog item availability", submitStep: true },
        ],
        submitEndpointPattern: "item-availability",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [OWN_BACKEND_HOST],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    const httpClientCallCount = (contract.match(/await httpClient\(/g) ?? []).length;

    // Two distinct real endpoint groups (poll, drill) — a small constant
    // bound above that, not one hard-coded call per raw capture (8 total).
    expect(httpClientCallCount).toBeLessThanOrEqual(2 + 2);

    // The value-varying poll survives exactly once, collapsed from 6 raw
    // re-fires whose only difference is the `enabled` boolean.
    expect(contract.match(/feature-flags\/catalog-availability/g)?.length).toBe(1);

    // The duplicate/retried drill survives exactly once, collapsed from 2
    // byte-identical raw captures — not two separate `httpClient` calls for
    // what is, at the request level, one occurrence retried.
    expect(contract.match(/catalog\/item-availability/g)?.length).toBe(1);
  }, 30_000);
});
