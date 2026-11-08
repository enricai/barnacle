import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * A later drill's request value minted by an earlier isolated drill's answer
 * (a fare id from a quote answer, used by a seat-availability POST) must be
 * read off the item's attached quote result, not from the quote drill's
 * block-scoped local nor a captured literal.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");
const HOST = "www.minted-value-attached-drill-fixture.example.com";
const FARE = "fare-zz-7788";

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — minted value threads from the attached drill result", () => {
  it("reads the fare id off the item for the seat drill, never a literal or the out-of-scope local", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-minted-attached-"));
    const root = join(workDir, "run");
    for (const d of ["graphql", "replays", "aux"]) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, "replays", "rate-limit.json"), "[]");
    const caps = [
      buildCapture({
        url: `https://${HOST}/flights/search/`,
        requestPostData: '{"q":"x"}',
        responseBody: {
          results: [{ flightId: "fl-100" }, { flightId: "fl-200" }],
        },
        timestamp: "2026-01-01T00:00:00Z",
      }),
      buildCapture({
        url: `https://${HOST}/flights/quote/`,
        requestPostData: '{"flightId":"fl-100"}',
        responseBody: { flightId: "fl-100", fareId: FARE, price: 120 },
        timestamp: "2026-01-01T00:00:01Z",
      }),
      buildCapture({
        url: `https://${HOST}/flights/seats/`,
        requestPostData: JSON.stringify({ flightId: "fl-100", fareId: FARE }),
        responseBody: {
          flightId: "fl-100",
          seats: [{ row: "12A", free: true }],
        },
        timestamp: "2026-01-01T00:00:02Z",
      }),
      buildCapture({
        url: `https://${HOST}/flights/book/`,
        requestPostData: '{"flightId":"fl-100"}',
        responseBody: { ok: true },
        timestamp: "2026-01-01T00:00:03Z",
      }),
    ];
    for (const [i, c] of caps.entries()) {
      writeFileSync(join(root, "graphql", `00${i}-capture.json`), JSON.stringify(c));
    }
    const siteId = `minted-attached-drill-e2e-${process.pid}`;
    siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "search flights" },
          { step: "quote" },
          { step: "seats" },
          { step: "book", submitStep: true },
        ],
        submitEndpointPattern: "flights/book",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [HOST],
        foldReturn: [
          {
            endpointPattern: "flights/book",
            resultsPath: "results",
            joinFields: ["flightId"],
          },
          {
            endpointPattern: "flights/quote",
            resultsPath: "results",
            joinFields: ["flightId"],
            attachAs: "quote",
          },
          {
            endpointPattern: "flights/seats",
            resultsPath: "results",
            joinFields: ["flightId"],
            attachAs: "seats",
          },
        ],
      })
    );
    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", root, "--emit", "ts", "--force"],
      { cwd: RECON_GENERATE_CWD, encoding: "utf8" }
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    const seats = contract.match(/flights\/seats\/[\s\S]*?body:\s*`([^`]*)`/);
    expect(seats, contract).not.toBeNull();
    expect(seats![1]).toContain(`"fareId":"\${item.fareId}"`);
    expect(seats![1]).not.toContain(FARE);
    expect(contract).not.toContain(`"fareId":"\${fareId}"`);
    // The quote drill still fails in isolation, dropping only its own key.
    expect(contract).toContain("fold drill quote failed");
  }, 60_000);
});

describe("recon-generate in-process — minted value threads from the attached drill result", () => {
  it("(in-process) reads the fare id off the item for the seat drill, never a literal or the out-of-scope local", async () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-minted-attached-"));
    const root = join(workDir, "run");
    for (const d of ["graphql", "replays", "aux"]) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, "replays", "rate-limit.json"), "[]");
    const caps = [
      buildCapture({
        url: `https://${HOST}/flights/search/`,
        requestPostData: '{"q":"x"}',
        responseBody: {
          results: [{ flightId: "fl-100" }, { flightId: "fl-200" }],
        },
        timestamp: "2026-01-01T00:00:00Z",
      }),
      buildCapture({
        url: `https://${HOST}/flights/quote/`,
        requestPostData: '{"flightId":"fl-100"}',
        responseBody: { flightId: "fl-100", fareId: FARE, price: 120 },
        timestamp: "2026-01-01T00:00:01Z",
      }),
      buildCapture({
        url: `https://${HOST}/flights/seats/`,
        requestPostData: JSON.stringify({ flightId: "fl-100", fareId: FARE }),
        responseBody: {
          flightId: "fl-100",
          seats: [{ row: "12A", free: true }],
        },
        timestamp: "2026-01-01T00:00:02Z",
      }),
      buildCapture({
        url: `https://${HOST}/flights/book/`,
        requestPostData: '{"flightId":"fl-100"}',
        responseBody: { ok: true },
        timestamp: "2026-01-01T00:00:03Z",
      }),
    ];
    for (const [i, c] of caps.entries()) {
      writeFileSync(join(root, "graphql", `00${i}-capture.json`), JSON.stringify(c));
    }
    const siteId = `minted-attached-drill-e2e-${process.pid}`;
    siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "search flights" },
          { step: "quote" },
          { step: "seats" },
          { step: "book", submitStep: true },
        ],
        submitEndpointPattern: "flights/book",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [HOST],
        foldReturn: [
          {
            endpointPattern: "flights/book",
            resultsPath: "results",
            joinFields: ["flightId"],
          },
          {
            endpointPattern: "flights/quote",
            resultsPath: "results",
            joinFields: ["flightId"],
            attachAs: "quote",
          },
          {
            endpointPattern: "flights/seats",
            resultsPath: "results",
            joinFields: ["flightId"],
            attachAs: "seats",
          },
        ],
      })
    );
    const origArgv = process.argv;
    const origCwd = process.cwd();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const contractPath = join(siteOutDir, "contract.ts");
    try {
      process.chdir(RECON_GENERATE_CWD);
      process.argv = [
        "node",
        GENERATE_SCRIPT,
        "--site-id",
        siteId,
        "--run-dir",
        root,
        "--emit",
        "ts",
        "--force",
      ];
      vi.resetModules();
      await import("./recon-generate.js");
      await vi.waitFor(() => expect(existsSync(contractPath)).toBe(true), {
        timeout: 30_000,
      });
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      process.argv = origArgv;
      process.chdir(origCwd);
      exitSpy.mockRestore();
    }
    expect(exitSpy).not.toHaveBeenCalled();
    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    const seats = contract.match(/flights\/seats\/[\s\S]*?body:\s*`([^`]*)`/);
    expect(seats, contract).not.toBeNull();
    expect(seats![1]).toContain(`"fareId":"\${item.fareId}"`);
    expect(seats![1]).not.toContain(FARE);
    expect(contract).not.toContain(`"fareId":"\${fareId}"`);
    // The quote drill still fails in isolation, dropping only its own key.
    expect(contract).toContain("fold drill quote failed");
  }, 60_000);
});
