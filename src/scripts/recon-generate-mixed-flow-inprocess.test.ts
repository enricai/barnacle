import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import { buildWizardCheckoutCaptures } from "@/scripts/recon-generate-multicall-fixture";
import { main } from "@/scripts/recon-generate";

const STEPS = [
  { step: "open the checkout page" },
  { step: "enter the card number 4242" },
  { step: "confirm the order", submitStep: true },
];

let workDir: string | null = null;
let siteOutDir: string | null = null;
const ORIGINAL_CWD = process.cwd();

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  vi.restoreAllMocks();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = siteOutDir = null;
});

async function run(
  httpSteps: Record<string, unknown>,
  emit = "ts",
): Promise<string> {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-mixed-inproc-"));
  const runRoot = join(workDir, "run");
  const capturesDir = join(runRoot, "graphql");
  mkdirSync(capturesDir, { recursive: true });
  mkdirSync(join(runRoot, "replays"), { recursive: true });
  mkdirSync(join(runRoot, "aux"), { recursive: true });
  writeFileSync(
    join(runRoot, "replays", "rate-limit.json"),
    JSON.stringify([]),
  );
  buildWizardCheckoutCaptures().forEach((capture, index) => {
    writeFileSync(
      join(
        capturesDir,
        `${String(index).padStart(3, "0")}-checkout-action.json`,
      ),
      JSON.stringify(capture),
    );
  });
  const siteId = `mixed-inproc-test${process.pid}`;
  siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: STEPS,
      submitEndpointPattern: "/place-order",
      httpSteps,
    }),
  );
  process.chdir(RECON_GENERATE_CWD);
  vi.spyOn(process, "argv", "get").mockReturnValue([
    "node",
    "recon-generate.ts",
    "--site-id",
    siteId,
    "--run-dir",
    runRoot,
    "--emit",
    emit,
    "--force",
  ]);
  try {
    await main();
  } catch (err) {
    return (err as Error).message;
  }
  return "";
}

describe("recon-generate main() — mixed flow validation (in-process)", () => {
  it("rejects a prefix exceeding the captured actions", async () => {
    expect(await run({ actions: 99, tailFromStep: 1 })).toContain(
      "httpSteps declared but the mixed flow cannot be generated",
    );
  }, 60_000);

  it("rejects a tailFromStep beyond the flow steps", async () => {
    expect(await run({ actions: 2, tailFromStep: 99 })).toContain(
      "httpSteps.tailFromStep (99) exceeds",
    );
  }, 60_000);

  it("rejects a config-manifest emit", async () => {
    expect(await run({ actions: 2, tailFromStep: 1 }, "config")).toContain(
      "--emit ts",
    );
  }, 60_000);
});
