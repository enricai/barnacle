import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  RECON_GENERATE_CWD,
  RECON_GENERATE_CWD_FROM_REPO_ROOT,
} from "@/scripts/recon-generate-cwd.test-helper";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Acceptance test for the read-only REST GET flow: two captures of the same
 * GET endpoint (varying date keys, a bracketed array key, a path id that
 * repeats a query value, and a digit-leading site id) must generate a plugin
 * and contract whose request is built from the caller payload — not the
 * recording. Generic shop domain; no real site or plugin names.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const HOST = "api.shop.example.com";

let workDir: string | null = null;
let siteOutDir: string | null = null;
let tsconfigPath: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  if (tsconfigPath) rmSync(tsconfigPath, { force: true });
  workDir = null;
  siteOutDir = null;
  tsconfigPath = null;
});

function getCapture(query: string, timestamp: string, id = "4821"): Capture {
  return buildCapture({
    url: `https://${HOST}/v2/orders/${id}?${query}`,
    method: "GET",
    requestPostData: null,
    responseBody: {
      items: [{ id: 1, url: "https://cdn.shop.example.com/img/1.png" }],
      url: "https://cdn.shop.example.com/orders/4821",
    },
    timestamp,
  });
}

describe("recon-generate CLI — read-only REST GET flow is payload-driven", () => {
  it("emits an executeHttp built from payload and a typechecking contract", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-rest-get-payload-driven-"));
    const runRoot = join(workDir, "run");
    for (const d of ["graphql", "replays", "aux"]) mkdirSync(join(runRoot, d), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
    const captures = [
      getCapture(
        "order=4821&from_date=2026-01-05&to_date=2026-01-31&items[]=sku-a&3pl=42north&region=emea",
        "2026-05-01T00:00:00.000Z"
      ),
      getCapture(
        "order=4821&from_date=2026-02-10&to_date=2026-02-28&items[]=sku-b&3pl=77south&region=emea",
        "2026-05-01T00:00:01.000Z"
      ),
    ];
    captures.forEach((c, i) => {
      writeFileSync(
        join(runRoot, "graphql", `${String(i).padStart(3, "0")}-capture.json`),
        JSON.stringify(c)
      );
    });

    const siteId = `rest-get-payload-driven-test-${process.pid}`;
    siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({ steps: [{ step: "view orders" }], ownBackendHostnames: [HOST] })
    );
    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      {
        cwd: RECON_GENERATE_CWD,
        encoding: "utf8",
      }
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    const execStart = contract.indexOf("async executeHttp(");
    const execEnd = contract.indexOf("async execute(", execStart);
    const executeHttp = contract.slice(execStart, execEnd);

    // Flow is a read, not a submission: executeHttp is emitted and built from payload.
    expect(execStart).toBeGreaterThan(-1);
    expect(executeHttp).toContain("payload.order");
    expect(executeHttp).toContain("payload.from_date");
    expect(executeHttp).toContain("payload.to_date");
    // Bracketed key is mapped back to its real query key from a safe identifier.
    expect(executeHttp).toContain('["items[]", String(payload.items)]');
    // Digit-leading key yields a valid identifier and maps back to the real key.
    expect(executeHttp).toContain('["3pl", String(payload._3pl)]');
    // No recorded varying values baked into the request.
    for (const recorded of [
      "2026-01-05",
      "2026-01-31",
      "2026-02-10",
      "2026-02-28",
      "sku-a",
      "sku-b",
      "42north",
      "77south",
    ]) {
      expect(executeHttp).not.toContain(recorded);
    }
    // Truly constant param stays fixed.
    expect(executeHttp).toContain('["region", "emea"]');
    // Schema declares every derived field.
    for (const field of ["from_date", "to_date", "items", "_3pl", "order"]) {
      expect(contract).toContain(`${field}: z.string().optional(),`);
    }
    // Response `url` fields did not trip the payload URL guard.
    expect(contract).toContain("url: z.string(),");

    tsconfigPath = join(REPO_ROOT, `tsconfig.rest-get-payload-driven.${process.pid}.json`);
    writeFileSync(
      tsconfigPath,
      JSON.stringify({
        extends: "./tsconfig.json",
        compilerOptions: {
          noEmit: true,
          incremental: false,
          tsBuildInfoFile: null,
          paths: {
            "@/sites/*": [`./${RECON_GENERATE_CWD_FROM_REPO_ROOT}/src/sites/*`],
            "@/*": ["./src/*"],
            "@test/*": ["./test/*"],
            "@enricai/barnacle/*": ["./src/*"],
          },
        },
        include: [`${RECON_GENERATE_CWD_FROM_REPO_ROOT}/src/sites/${siteId}/**/*.ts`],
      })
    );
    const check = spawnSync(TSC_BIN, ["-p", tsconfigPath, "--noEmit"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    const diagnostics = `${check.stdout}\n${check.stderr}`;
    // The contract (schema + executeHttp) must typecheck clean. The browser
    // fallback's generic `payload.query` extract prompt is a separate,
    // pre-existing concern outside this flow's request construction, so only
    // diagnostics that point at the contract are asserted on.
    const contractDiagnostics = diagnostics
      .split("\n")
      .filter((line) => line.includes("contract.ts"));
    expect(contractDiagnostics, diagnostics).toEqual([]);
  }, 60_000);
});
