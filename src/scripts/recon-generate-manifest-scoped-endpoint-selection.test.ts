import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { main } from "@/scripts/recon-generate";

const REPO_ROOT = join(__dirname, "..", "..");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

const cap = (url: string, method: string, body: unknown, postData?: string) => ({
  url,
  method,
  status: 200,
  requestHeaders: { "content-type": "application/json" },
  ...(postData ? { requestPostData: postData } : {}),
  responseBody: JSON.stringify(body),
  responseHeaders: { "content-type": "application/json" },
});

async function generate(manifestIdx: number[]): Promise<string> {
  workDir = mkdtempSync(join(tmpdir(), "manifest-scoped-endpoint-"));
  const runRoot = join(workDir, "run");
  const dir = join(runRoot, "graphql");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(runRoot, "replays"), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), "[]");
  const captures = [
    cap("https://api.example-manifest.test/v1/jobs/alpha", "GET", {
      id: "a",
      title: "A",
    }),
    cap("https://api.example-manifest.test/v1/jobs/beta", "GET", {
      id: "b",
      title: "B",
    }),
    cap(
      "https://api.example-manifest.test/v1/collect-beacon",
      "POST",
      { ok: true },
      '{"event":"view"}'
    ),
  ];
  const names = captures.map((_, i) => `${String(i).padStart(3, "0")}-read.json`);
  for (const [i, c] of captures.entries()) {
    writeFileSync(join(dir, names[i] as string), JSON.stringify(c));
  }
  writeFileSync(
    join(runRoot, "submit-manifest.json"),
    JSON.stringify(
      manifestIdx.map((i) => ({
        index: i,
        filename: names[i],
        url: captures[i]?.url,
      }))
    )
  );
  const siteId = `manifest-scoped-endpoint-test-${process.pid}`;
  siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  const savedArgv = process.argv;
  process.argv = [
    savedArgv[0] ?? "node",
    GENERATE_SCRIPT,
    "--site-id",
    siteId,
    "--run-dir",
    runRoot,
    "--emit",
    "ts",
    "--force",
  ];
  try {
    await main();
  } finally {
    process.argv = savedArgv;
  }
  return readFileSync(join(siteOutDir, "contract.ts"), "utf8");
}

describe("recon-generate: endpoint is chosen from submit-manifest captures", () => {
  it("does not pick an unlisted one-off POST beacon on the same host", async () => {
    const contract = await generate([0, 1]);
    expect(contract).toContain("/v1/jobs/");
    expect(contract).not.toContain("collect-beacon");
  }, 120000);

  it("still generates when the manifest scopes to a single capture", async () => {
    const contract = await generate([2]);
    expect(contract).toContain("collect-beacon");
  }, 120000);
});
