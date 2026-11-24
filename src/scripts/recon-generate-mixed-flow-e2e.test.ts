import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RECON_GENERATE_CWD,
  RECON_GENERATE_CWD_FROM_REPO_ROOT,
} from "@/scripts/recon-generate-cwd.test-helper";
import { buildWizardCheckoutCaptures } from "@/scripts/recon-generate-multicall-fixture";

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const STEPS = [
  { step: "open the checkout page" },
  { step: "enter the card number 4242" },
  { step: "confirm the order", submitStep: true },
];

let workDir: string | null = null;
let siteOutDir: string | null = null;
let tsconfigPath: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  if (tsconfigPath) rmSync(tsconfigPath, { force: true });
  workDir = siteOutDir = tsconfigPath = null;
});

function generate(
  flow: Record<string, unknown>,
  emit = "ts"
): { result: ReturnType<typeof spawnSync>; outDir: string; siteId: string } {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-mixed-flow-e2e-"));
  const runRoot = join(workDir, "run");
  const capturesDir = join(runRoot, "graphql");
  mkdirSync(capturesDir, { recursive: true });
  mkdirSync(join(runRoot, "replays"), { recursive: true });
  mkdirSync(join(runRoot, "aux"), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
  buildWizardCheckoutCaptures().forEach((capture, index) => {
    writeFileSync(
      join(capturesDir, `${String(index).padStart(3, "0")}-checkout-action.json`),
      JSON.stringify(capture)
    );
  });
  const siteId = `mixed-flow-e2e-test${process.pid}`;
  siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(join(siteOutDir, "recon-flow.json"), JSON.stringify(flow));
  const result = spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", emit, "--force"],
    { cwd: RECON_GENERATE_CWD, encoding: "utf8" }
  );
  return { result, outDir: siteOutDir, siteId };
}

describe("recon-generate CLI — mixed flow (httpSteps)", () => {
  it("emits an HTTP prefix, cookie hand-over with domcontentloaded and a browser tail that type-check", () => {
    const { result, outDir, siteId } = generate({
      steps: STEPS,
      submitEndpointPattern: "/place-order",
      httpSteps: {
        actions: 2,
        tailFromStep: 1,
        handoverUrl: "https://shop.example.com/checkout/edit",
      },
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("mixed flow, 2 HTTP-replayed");

    const contract = readFileSync(join(outDir, "contract.ts"), "utf8");
    expect(contract).toContain("async function runHttpPrefix(");
    expect(contract).not.toContain("async executeHttp(");
    expect(contract).toContain("await runHttpPrefix(payload, context)");

    const flow = readFileSync(join(outDir, "flows", "browser-flow.ts"), "utf8");
    expect(flow).toContain("addCookies(");
    expect(flow).toContain(
      'page.goto("https://shop.example.com/checkout/edit", { waitUntil: "domcontentloaded" })'
    );
    expect(flow).toContain("enter the card number 4242");
    expect(flow).not.toContain("open the checkout page");

    tsconfigPath = join(REPO_ROOT, `tsconfig.mixed-flow-e2e.${process.pid}.json`);
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
    expect(check.status, diagnostics).toBe(0);
  }, 90_000);

  it("fails loudly when the declared prefix exceeds the captured action steps", () => {
    const { result } = generate({
      steps: STEPS,
      submitEndpointPattern: "/place-order",
      httpSteps: { actions: 99, tailFromStep: 1 },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("httpSteps.actions (99) exceeds");
  }, 60_000);

  it("fails loudly for a config-manifest emit instead of silently dropping the prefix", () => {
    const { result } = generate(
      {
        steps: STEPS,
        submitEndpointPattern: "/place-order",
        httpSteps: { actions: 2, tailFromStep: 1 },
      },
      "config"
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("--emit ts");
  }, 60_000);
});
