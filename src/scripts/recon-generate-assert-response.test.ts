import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RECON_FLOW_STEP_SCHEMA } from "@/lib/llm/schemas";
import {
  assertResponseProblem,
  type FlowStepInput,
  main,
  splitAssertResponseSteps,
} from "@/scripts/recon-generate";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import { buildWizardCheckoutCaptures } from "@/scripts/recon-generate-multicall-fixture";

const ASSERT = {
  step: "read the order back",
  assertResponse: {
    request: { method: "GET", url: "/api/orders/{OrderId}" },
    equals: { "customer.email": "Email" },
    afterAction: 1,
  },
};
const STEPS = [
  { step: "open the checkout page" },
  { step: "enter the card number 4242" },
  { step: "confirm the order", submitStep: true },
];

describe("assertResponse schema and parsing", () => {
  it("accepts a well-formed step and existing steps unchanged", () => {
    expect(RECON_FLOW_STEP_SCHEMA.safeParse(ASSERT).success).toBe(true);
    expect(RECON_FLOW_STEP_SCHEMA.safeParse({ step: "click Go" }).success).toBe(true);
    expect(assertResponseProblem(ASSERT.assertResponse)).toBeNull();
  });

  it("rejects a missing request or an equality naming no payload field", () => {
    const { request: _r, ...noRequest } = ASSERT.assertResponse;
    expect(RECON_FLOW_STEP_SCHEMA.safeParse({ step: "x", assertResponse: noRequest }).success).toBe(
      false
    );
    expect(assertResponseProblem(noRequest)).toContain("request");
    const bad = { ...ASSERT.assertResponse, equals: { a: "" } };
    expect(RECON_FLOW_STEP_SCHEMA.safeParse({ step: "x", assertResponse: bad }).success).toBe(
      false
    );
    expect(assertResponseProblem(bad)).toContain("payload field");
    expect(assertResponseProblem({ ...ASSERT.assertResponse, equals: {} })).toContain("at least");
  });

  it("splits assertions off and remaps tailFromStep", () => {
    const steps = [STEPS[0]!, ASSERT, STEPS[1]!, STEPS[2]!] as FlowStepInput[];
    const out = splitAssertResponseSteps(steps, 2);
    expect(out.browserSteps).toHaveLength(3);
    expect(out.assertions).toHaveLength(1);
    expect(out.tailFromStep).toBe(1);
    expect(() =>
      splitAssertResponseSteps([{ step: "x", assertResponse: { equals: {} } } as never])
    ).toThrow(/Flow step 0 is invalid/);
  });
});

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

async function generate(steps: unknown[]): Promise<string> {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-assert-resp-"));
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
  const siteId = `assert-resp-test${process.pid}`;
  siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({ steps, submitEndpointPattern: "/place-order" })
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
    "ts",
    "--force",
  ]);
  await main();
  const files = readdirSync(siteOutDir).filter((f) => f.endsWith(".ts") && !f.includes("flow"));
  return files.map((f) => readFileSync(join(siteOutDir!, f), "utf8")).join("\n");
}

describe("assertResponse emission", () => {
  it("emits the read-back before the following action and names only fields on mismatch", async () => {
    const code = await generate([STEPS[0], ASSERT, STEPS[1], STEPS[2]]);
    const at = code.indexOf("assertResp1 = await httpClient");
    expect(at).toBeGreaterThan(-1);
    expect(code).toContain("/api/orders/${encodeURIComponent(String(payload.OrderId))}");
    expect(code).toContain('["customer","email"].reduce');
    expect(code).toContain("String(payload.Email)");
    expect(code).toContain("response field(s) differ from payload");
    expect(code).toContain('"customer.email (payload.Email)"');
    // Placed between action 1 and action 2, not at either end.
    const firstAction = code.indexOf("await httpClient(", 0);
    expect(at).toBeGreaterThan(firstAction);
    expect(code.indexOf("await httpClient(", at + 10)).toBeGreaterThan(at);
  }, 60_000);

  it("emits nothing for a flow without it", async () => {
    const code = await generate(STEPS);
    expect(code).not.toContain("assertDiff");
  }, 60_000);
});
