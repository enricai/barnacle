import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Same-endpoint captures whose body arrays differ in length and carry
 * mutually exclusive element identities ("<value>;facetId=slug" vs
 * "<VALUE>;facetType=name") share slot indices holding unrelated identities.
 * Generation must complete through both emitters rather than abort or report
 * the arrays as one varying frozen field.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

function searchCapture(filters: string[], timestamp: string): Capture {
  return {
    timestamp,
    phase: "browse",
    method: "POST",
    url: "https://api.example.com/catalog/search/",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ filters, page: 1 }),
    responseHeaders: {},
    responseBody: { results: [{ sku: "sku-a" }, { sku: "sku-b" }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

const SHORT_SHAPE = [
  "red;facetId=color",
  "wool;facetId=material",
  "m;facetId=size",
  "a;facetId=brand",
];
const LONG_SHAPE = [
  "XL;facetType=size",
  "BLUE;facetType=color",
  "COTTON;facetType=fabric",
  "NIKE;facetType=brand",
  "NEW;facetType=condition",
  "US;facetType=region",
];

function writeRunDir(root: string): void {
  const capturesDir = join(root, "graphql");
  mkdirSync(capturesDir, { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  const captures = [
    searchCapture(SHORT_SHAPE.slice(0, 1), "2024-04-01T00:00:00Z"),
    searchCapture(SHORT_SHAPE, "2024-04-01T00:00:01Z"),
    searchCapture(LONG_SHAPE.slice(0, 5), "2024-04-01T00:00:02Z"),
    searchCapture(LONG_SHAPE, "2024-04-01T00:00:03Z"),
  ];
  captures.forEach((c, i) => {
    writeFileSync(join(capturesDir, `00${i}-browse-search.json`), JSON.stringify(c));
  });
}

function writeFlowFile(siteOutDir: string): void {
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({ steps: [{ step: "search the catalog" }] })
  );
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

function run(runRoot: string, siteId: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
}

describe("recon-generate CLI — mutually exclusive facet array shapes", () => {
  it("completes and emits a contract without flagging the arrays as a varying frozen field", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-exclusive-facet-shapes-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `exclusive-facet-shapes-run${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowFile(siteOutDir);

    const result = run(runRoot, siteId);
    const out = `${result.stdout}\n${result.stderr}`;
    const contractPath = join(siteOutDir, "contract.ts");

    expect(result.status, out).toBe(0);
    expect(out).not.toMatch(/frozen/i);
    expect(existsSync(contractPath)).toBe(true);
    expect(readFileSync(contractPath, "utf8").length).toBeGreaterThan(0);
  }, 60_000);
});
