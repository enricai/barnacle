import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emitContractTs } from "@/scripts/recon-generate";
import { buildWizardCheckoutCaptures } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Regression coverage for the browser-flow-only fallback (see
 * docs/recon-generate-emits-bogus-http-stub-for-multicall-flow.md): a
 * multi-action flow whose captured sequence can't be faithfully replayed as a
 * bare-`fetch` HTTP sequence must not ship a fabricated single-call
 * `executeHttp` (or any `executeHttp` at all) — it ships browser-only with
 * the standard candidate payload schema instead.
 */
describe("emitContractTs — omitExecuteHttp (browser-flow-only) branch", () => {
  const inputBody = { FirstName: "Reginald" };

  it("emits no executeHttp method, no {query} field, no hardcoded endpoint, and the standard ApplicantContactSchema bodySchema", () => {
    const source = emitContractTs({
      siteId: "test-site",
      pascal: "TestSite",
      baseUrl: "https://api.example.com",
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: { saved: true },
      gql: false,
      gqlQuery: null,
      endpointPath: "/apply/create",
      auxFiles: [],
      multiStepBody: undefined,
      omitExecuteHttp: true,
      inputBody,
    });

    expect(source).not.toContain("async executeHttp(");
    expect(source).not.toContain("query: payload.query");
    expect(source).not.toContain("z.object({\n  query:");
    expect(source).not.toContain("/apply/create");
    expect(source).toContain(
      "ApplicantContactSchema.extend({\n  Email: z.email(),\n  ClickUrl: z.string().min(1),\n  Answers: multipartJsonObject(z.record(z.string(), z.unknown())),\n})"
    );
    expect(source).toContain("import { ApplicantContactSchema }");
    expect(source).not.toContain("createHttpClient");
    expect(source).not.toContain("Bottleneck");
    expect(source).not.toContain("BASE_HEADERS");
  });

  it("a genuinely single-action query flow is unaffected — no omitExecuteHttp, single-endpoint {query} branch unchanged", () => {
    const source = emitContractTs({
      siteId: "test-site",
      pascal: "TestSite",
      baseUrl: "https://api.example.com",
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: { id: "abc" },
      gql: false,
      gqlQuery: null,
      endpointPath: "/search",
      auxFiles: [],
    });

    expect(source).toContain("async executeHttp(");
    expect(source).toContain("query: payload.query");
    expect(source).toContain("z.object({\n  query: z.string().min(1),\n})");
  });

  it("a synthesizable multi-step flow (no omitExecuteHttp) is unaffected — keeps its executeHttp", () => {
    const source = emitContractTs({
      siteId: "test-site",
      pascal: "TestSite",
      baseUrl: "https://api.example.com",
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: { products: [] },
      gql: false,
      gqlQuery: null,
      endpointPath: "/search",
      auxFiles: [],
      multiStepBody: `    return { data: {} as unknown };`,
      omitExecuteHttp: false,
      inputBody,
    });

    expect(source).toContain("async executeHttp(");
    expect(source).not.toContain("query: payload.query");
  });
});

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

describe("recon-generate CLI — cross-domain multi-action flow falls back to browser-flow-only", () => {
  let workDir: string | null = null;
  let siteOutDir: string | null = null;

  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
    workDir = null;
    siteOutDir = null;
  });

  it("omits executeHttp entirely when the captured sequence crosses hosts mid-flow, instead of fabricating a single-call HTTP stub", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-recon-cross-domain-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    const replaysDir = join(runRoot, "replays");
    const auxDir = join(runRoot, "aux");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(replaysDir, { recursive: true });
    mkdirSync(auxDir, { recursive: true });
    writeFileSync(join(replaysDir, "rate-limit.json"), JSON.stringify([]));

    // Reuse the wizard-checkout fixture (a real same-host 10-call submission
    // sequence, bugfix-002's own precedent for "preserve the real captured
    // sequence") but redirect the final call to a DIFFERENT host — the shape
    // of a mid-flow auth bounce or vendor-hosted submission step a bare
    // fetch-based executeHttp can't faithfully replay.
    const captures = buildWizardCheckoutCaptures();
    const last = captures[captures.length - 1]!;
    captures[captures.length - 1] = {
      ...last,
      url: last.url.replace("https://api.example.com", "https://payments.example.net"),
    };
    const filenames = captures.map(
      (_, index) => `${String(index).padStart(3, "0")}-checkout-action.json`
    );
    captures.forEach((capture, index) => {
      writeFileSync(join(capturesDir, filenames[index]!), JSON.stringify(capture));
    });

    // extractActionSequence's own heuristic drops any capture off the run's
    // baseUrl host outright — a submit-manifest.json is the one path
    // (resolveManifestActionSequence, recon-generate.ts:768) that carries a
    // cross-host entry through to compileActionSteps at all, matching how a
    // real ATS-style CXS recon actually narrates its own submission
    // sequence (see bugfix-002's own precedent fixture/test for this same
    // manifest-driven path).
    writeFileSync(
      join(runRoot, "submit-manifest.json"),
      JSON.stringify(
        captures.map((capture, index) => ({ index, filename: filenames[index]!, url: capture.url }))
      )
    );

    const siteId = `recon-cross-domain-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    expect(contract).not.toContain("async executeHttp(");
    expect(contract).not.toContain("query: z.string().min(1)");
    expect(contract).not.toContain("payload.query");
    expect(contract).toContain(
      "ApplicantContactSchema.extend({\n  Email: z.email(),\n  ClickUrl: z.string().min(1),\n  Answers: multipartJsonObject(z.record(z.string(), z.unknown())),\n})"
    );
  }, 30_000);
});
