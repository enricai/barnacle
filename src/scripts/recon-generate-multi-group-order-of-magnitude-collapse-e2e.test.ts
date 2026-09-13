import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Operationalizes required_item 1 verbatim (an 8x-repeated listing endpoint
 * must collapse to one paging loop) plus a 6x-repeated per-item drill and a
 * 6x-repeated zero-variance poll endpoint, at the report's own reference
 * multiplicities. Unlike recon-generate-partial-fix-verification-hooks-
 * combined-e2e.test.ts (which already passes and therefore proves nothing
 * about the still-open defect), every field-name/value shape here is
 * deliberately chosen to avoid the generator's own already-handled shapes:
 * the listing's varying key is named outside PAGINATION_FIELD_NAME_PATTERN
 * (recon-generate.ts:2106-2107), and the drill carries a per-item join field
 * so it must fold rather than merely dedupe.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-multi-group-order-of-magnitude-fixture.example.com";
const STATUS_URL = `https://${OWN_BACKEND_HOST}/job-board/queue-status`;
const LISTING_URL = `https://${OWN_BACKEND_HOST}/job-board/open-roles/`;
const DRILL_URL = `https://${OWN_BACKEND_HOST}/job-board/role-detail/`;

const STATUS_POLL_COUNT = 6;
const LISTING_PAGE_COUNT = 8;
const DRILL_ITEM_COUNT = 6;

// Same rationale as the combined-e2e fixture: a minimal toy fixture can't
// reach the report's own order-of-magnitude bound without a realistic-sized
// field vocabulary.
function extraResponseFields(prefix: string): Record<string, string> {
  return Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`${prefix}Field${i}`, "x"]));
}

function fixtureCaptures(): Capture[] {
  // Zero-variance poll: identical request body and shape on every call, no
  // varying field at all.
  const statusPolls = Array.from({ length: STATUS_POLL_COUNT }, (_, i) =>
    buildCapture({
      url: STATUS_URL,
      requestPostData: "{}",
      responseBody: { queueOpen: true, ...extraResponseFields("status") },
      timestamp: `2024-01-01T00:00:${String(i).padStart(2, "0")}Z`,
    })
  );

  // Paged listing whose varying request field is named `pageMarker` --
  // deliberately outside PAGINATION_FIELD_NAME_PATTERN's allowlist (page,
  // pagenum, pagenumber, pageindex, pageno, offset, skip, start, cursor) --
  // so the collapse can't rely on that pattern matching the key by name.
  const listing = Array.from({ length: LISTING_PAGE_COUNT }, (_, i) =>
    buildCapture({
      url: `${LISTING_URL}?_=${1800000000 + i}`,
      requestPostData: JSON.stringify({ pageMarker: i + 1 }),
      responseBody: {
        totalPageMarkers: LISTING_PAGE_COUNT,
        roles: [{ roleId: `r${i + 1}`, ...extraResponseFields("listing") }],
      },
      timestamp: `2024-01-01T00:01:${String(i).padStart(2, "0")}Z`,
    })
  );

  // Per-item drill: each call is keyed by its own item's join field
  // (`roleId`), so the generator must fold by join key rather than merely
  // deduping identical calls.
  const drills = Array.from({ length: DRILL_ITEM_COUNT }, (_, i) =>
    buildCapture({
      url: DRILL_URL,
      requestPostData: JSON.stringify({ roleId: `r${i + 1}` }),
      responseBody: {
        teams: [{ teamId: `t${i + 1}`, ...extraResponseFields("drill") }],
        headcountRatio: 1.0,
      },
      timestamp: `2024-01-01T00:02:${String(i).padStart(2, "0")}Z`,
    })
  );

  return [...statusPolls, ...listing, ...drills];
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

describe("recon-generate CLI — 8x/6x/6x same-endpoint groups collapse to the report's own order of magnitude", () => {
  it("emits a contract.ts with the shipped baseline's call-count and line-count order of magnitude", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-multi-group-order-of-magnitude-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `multi-group-order-of-magnitude-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "accept cookie banner" },
          { step: "dismiss newsletter prompt" },
          { step: "poll queue status" },
          { step: "expand facet filters" },
          { step: "browse paged role listing" },
          { step: "sort listing by relevance" },
          { step: "select first listed role" },
          { step: "open role detail panel" },
          { step: "drill into role detail", submitStep: true },
          { step: "confirm role detail summary" },
        ],
        submitEndpointPattern: "role-detail",
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

    // Raw capture count is 20 (6 status polls + 8 listing pages + 6 drills).
    // The report's own required_item 1: an 8x-repeated listing must collapse
    // to one paging loop, a 6x-repeated per-item drill must fold, and a
    // 6x-repeated zero-variance poll must dedupe to one call -- the
    // report's own httpClient-count order of magnitude (~4, not 38).
    expect(httpClientCallCount).toBeLessThanOrEqual(6);

    // The report's own line-count verification hook, order-of-magnitude:
    // nowhere near the reported 7880 (shipped baseline ~569).
    const lineCount = contract.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(1200);
  }, 30_000);
});
