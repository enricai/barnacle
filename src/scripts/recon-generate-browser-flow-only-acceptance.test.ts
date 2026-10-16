import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { ApplicantContactSchema } from "@/lib/applicant-payload";
import { JobTrackingSchema } from "@/lib/job-tracking";
import { buildWizardCheckoutCaptures } from "@/scripts/recon-generate-multicall-fixture";

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

/** Concatenation trick so Biome's noTemplateCurlyInString rule doesn't flag the literal. */
const RECON_PASSWORD_TOKEN = `$${"{RECON_PASSWORD}"}`;

const VOCABULARY_SOURCE = `export default {
  subject: /./,
  exclusions: [],
  table: [
    [/\\b(mobile phone|phone number)\\b/i, "MobilePhone"],
    [/\\blast name\\b/i, "LastName"],
    [/\\b(street address|address line 1)\\b/i, "AddressLine1"],
  ],
};
`;

const FLOW = {
  browserFlowOnly: true,
  steps: [
    { step: "open the application page" },
    { step: "Fill in the Mobile Phone field with '555-0100'" },
    { step: "Fill in the Street Address field with '1 Main St'" },
    { step: "Fill in the Last name field with 'O'Brien'" },
    { step: `Fill in the Password field with '${RECON_PASSWORD_TOKEN}'` },
    { step: "confirm the application", submitStep: true },
  ],
  submitEndpointPattern: "/checkout",
};

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

interface Generation {
  status: number | null;
  output: string;
  files: Record<string, string>;
  browserFlow: string;
}

/** Runs the real generator CLI over the wizard-checkout captures, returning the
 * exit status and every emitted .ts file. */
function generate(
  flow: Record<string, unknown>,
  options: { emptyCaptures?: boolean } = {}
): Generation {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-bfo-acceptance-"));
  const runRoot = join(workDir, "run");
  const capturesDir = join(runRoot, "graphql");
  mkdirSync(capturesDir, { recursive: true });
  mkdirSync(join(runRoot, "replays"), { recursive: true });
  mkdirSync(join(runRoot, "aux"), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
  const captures = options.emptyCaptures ? [] : buildWizardCheckoutCaptures();
  captures.forEach((capture, index) => {
    writeFileSync(
      join(capturesDir, `${String(index).padStart(3, "0")}-checkout-action.json`),
      JSON.stringify(capture)
    );
  });
  const vocabularyFile = join(workDir, "vocabulary.mjs");
  writeFileSync(vocabularyFile, VOCABULARY_SOURCE);
  const siteId = `bfo-acceptance-test-${process.pid}`;
  siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(join(siteOutDir, "recon-flow.json"), JSON.stringify(flow));
  const result = spawnSync(
    TSX_BIN,
    [
      GENERATE_SCRIPT,
      "--site-id",
      siteId,
      "--run-dir",
      runRoot,
      "--emit",
      "ts",
      "--force",
      "--vocabulary",
      vocabularyFile,
    ],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  const outDir = siteOutDir;
  const flowFile = join(outDir, "flows", "browser-flow.ts");
  return {
    status: result.status,
    output: `${result.stdout}\n${result.stderr}`,
    files: Object.fromEntries(
      readdirSync(outDir)
        .filter((name) => name.endsWith(".ts"))
        .map((name) => [name, readFileSync(join(outDir, name), "utf8")])
    ),
    browserFlow: existsSync(flowFile) ? readFileSync(flowFile, "utf8") : "",
  };
}

function evalPayloadSchema(contract: string): z.ZodObject {
  const block = /const \w+PayloadSchema = ([\s\S]*?\.merge\(JobTrackingSchema\));/.exec(contract);
  if (!block) throw new Error("payload schema block not found in emitted contract");
  return new Function(
    "z",
    "ApplicantContactSchema",
    "JobTrackingSchema",
    "multipartJsonObject",
    `return ${block[1]};`
  )(z, ApplicantContactSchema, JobTrackingSchema, (s: z.ZodType) => s) as z.ZodObject;
}

describe("browser-flow-only job-application contract — all mechanisms together", () => {
  it("accepts the caller's payload, keeps TrackingUrl, retries once, and enters on ClickUrl", () => {
    const { status, output, files, browserFlow } = generate(FLOW);
    expect(status, output).toBe(0);
    const contract = files["contract.ts"] ?? "";

    expect(contract).toContain("ApplicantContactSchema.extend(");
    expect(contract).toMatch(/BrowserFlow\(session\.stagehand, payload\.ClickUrl,/);
    expect(contract).not.toContain("async executeHttp(");
    expect(contract).toMatch(/maxAttempts: 1,/);
    expect(contract).not.toContain("context: SitePluginContext");
    expect(contract).not.toContain("invoked only when hot path fails");
    expect(contract).not.toMatch(/\b(MobilePhone|AddressLine1)\b/);
    expect(browserFlow).toContain("payload.LastName");
    expect(browserFlow).toContain("payload.Phone");
    expect(browserFlow).toContain("payload.AddressLine");
    expect(browserFlow).not.toContain("O'Brien");
    expect(browserFlow).not.toMatch(/payload\.(MobilePhone|AddressLine1)\b/);

    const schema = evalPayloadSchema(contract);
    const parsed = schema.safeParse({
      FirstName: "Ada",
      LastName: "O'Brien",
      Email: "ada@example.com",
      Phone: "555-0100",
      AddressLine: "1 Main St",
      City: "Springfield",
      State: "IL",
      PostalCode: "62701",
      Country: "US",
      County: "Sangamon",
      Resume: Buffer.from("resume"),
      ResumeContentType: "application/pdf",
      ResumeFilename: "resume.pdf",
      ResumeBase64: "cmVzdW1l",
      Answers: {},
      ClickUrl: "https://jobs.example.com/apply/1",
      TrackingUrl: "https://track.example.com/c/1",
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect((parsed.data as Record<string, unknown>).TrackingUrl).toBe(
      "https://track.example.com/c/1"
    );
  }, 60_000);

  it("fails generation with no placeholder origin when ownBackendHostnames matches no capture", () => {
    const { status, output, files } = generate({
      ...FLOW,
      ownBackendHostnames: ["api.unmatched-example.test"],
    });
    expect(status).not.toBe(0);
    expect(output).toMatch(/ownBackendHostnames matched no capture/);
    expect(files["contract.ts"]).toBeUndefined();
    expect(output).not.toMatch(/placeholder/i);
  }, 60_000);

  it("fails generation without emitting any file when the capture pool is empty", () => {
    const { status, files, output } = generate(FLOW, { emptyCaptures: true });
    expect(status).not.toBe(0);
    expect(files["contract.ts"]).toBeUndefined();
    expect(Object.values(files).join("\n")).not.toContain("https://example.com");
    expect(output).not.toContain("defaultBaseUrl");
  }, 60_000);
});
