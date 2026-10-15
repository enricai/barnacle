import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.unread-declared-facet-optional-fixture.example.com";

const COLOR_STEP = "Open the colour dropdown in the catalogue and select the 'Teal' colour option";
const SIZE_STEP = "Open the size dropdown in the catalogue and select the 'Large' size option";

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

function buildCaptures(): Capture[] {
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalogue/`,
      requestPostData: JSON.stringify({ colour: "Teal", sort: "recent" }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/basket/`,
      requestPostData: JSON.stringify({ quantity: 2 }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:01.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/submit/`,
      requestPostData: JSON.stringify({ confirm: true }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:02.000Z",
    }),
  ];
}

function generate(): { contract: string; output: string } {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-unread-declared-facet-"));
  const runRoot = join(workDir, "run");
  for (const dir of ["graphql", "replays", "aux"])
    mkdirSync(join(runRoot, dir), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
  buildCaptures().forEach((capture, index) => {
    writeFileSync(
      join(runRoot, "graphql", `${String(index).padStart(3, "0")}-capture.json`),
      JSON.stringify(capture)
    );
  });

  const siteId = `unread-declared-facet-optional-test-${process.pid}`;
  siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [
        { step: COLOR_STEP, payloadField: "colour" },
        { step: SIZE_STEP, payloadField: "size" },
        { step: "submit the order", submitStep: true },
      ],
      submitEndpointPattern: "submit",
      requireSubmitEndpointMatch: true,
      ownBackendHostnames: [OWN_BACKEND_HOST],
    })
  );

  const result = spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  const output = `${result.stdout}\n${result.stderr}`;
  expect(result.status, output).toBe(0);
  return { contract: readFileSync(join(siteOutDir, "contract.ts"), "utf8"), output };
}

describe("recon-generate CLI — declared click-step payloadField no request reads", () => {
  it("emits the unread field optional, never reads it, and warns naming it", () => {
    const { contract, output } = generate();

    expect(output).toContain("declared payloadField size is read by no emitted request");
    expect(output).not.toContain("declared payloadField colour is read by no emitted request");
    expect(contract, contract).toMatch(/size: z\.string\(\)\.optional\(\)/);
    expect(contract, contract).not.toMatch(/size: z\.string\(\)(?!\.optional)/);
    expect(contract).not.toContain("payload.size");
    expect(contract, "multi-step REST path").toContain("httpClient(");
  }, 30_000);
});
