import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";
import { main } from "@/scripts/recon-generate";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import type { Capture } from "@/scripts/recon-shared";

const GENERATE_SCRIPT = join(__dirname, "recon-generate.ts");
let workDir: string | null = null;
let siteOutDir: string | null = null;
afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
});

const slug = (s: string) =>
  s
    .replace(/[^a-z0-9]+/gi, "-")
    .toLowerCase()
    .slice(0, 24);

it("binds a declared navigateTo facet value to the array and scalar leaf that holds it", async () => {
  workDir = mkdtempSync(join(tmpdir(), "declared-facet-values-"));
  const runRoot = join(workDir, "run");
  for (const d of ["graphql", "replays", "aux"]) mkdirSync(join(runRoot, d), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), "[]");
  const stepA = "Pick the first widget kind";
  const stepB = "Pick the second gadget tag";
  const bodies: Array<[string, object]> = [
    ["open", { filters: {}, size: 10 }],
    [stepA, { filters: { kinds: ["k1"] }, size: 10 }],
    [stepB, { filters: { kinds: ["k1"], tag: "t1" }, size: 10 }],
  ];
  bodies.forEach(([step, body], i) => {
    const c: Capture = {
      timestamp: `2024-01-01T00:00:${10 + i}Z`,
      phase: i === 0 ? slug(step) : `zz-unmatched-${i}`,
      method: "POST",
      url: "https://api.example.com/v1/catalog/query",
      status: 200,
      requestHeaders: { "content-type": "application/json" },
      requestPostData: JSON.stringify(body),
      responseHeaders: { "content-type": "application/json" },
      responseBody: { items: [{ sku: `s${i}` }] },
      operationName: null,
      query: null,
      variables: null,
      decodedParams: null,
    };
    writeFileSync(join(runRoot, "graphql", `00${i}-capture.json`), JSON.stringify(c));
  });
  const siteId = `declared-facet-values-${process.pid}`;
  siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      submitEndpointPattern: "/v1/catalog/query",
      steps: [
        { step: "open catalog" },
        {
          step: stepA,
          navigateTo: "https://x.com/c?kind=k1",
          payloadField: "widgetKind",
          optional: true,
        },
        {
          step: "again",
          navigateTo: "https://x.com/c?kind=k1",
          payloadField: "widgetKind",
          optional: true,
        },
        {
          step: stepB,
          navigateTo: "https://x.com/c?kind=k1&tag=t1",
          payloadField: "gadgetTag",
          optional: true,
        },
      ],
    })
  );
  const savedArgv = process.argv;
  const savedCwd = process.cwd();
  const spies = [
    ...(["log", "info", "warn", "error"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation(() => {})
    ),
    ...[process.stdout, process.stderr].map((st) =>
      vi.spyOn(st, "write").mockImplementation((() => true) as never)
    ),
  ];
  try {
    process.chdir(RECON_GENERATE_CWD);
    process.argv = [
      "node",
      GENERATE_SCRIPT,
      "--site-id",
      siteId,
      "--run-dir",
      runRoot,
      "--emit",
      "ts",
      "--force",
    ];
    await main();
  } finally {
    process.argv = savedArgv;
    process.chdir(savedCwd);
    for (const sp of spies) sp.mockRestore();
  }
  const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
  expect(contract).toContain("payload.widgetKind");
  expect(contract).toContain("payload.gadgetTag");
  expect(contract).not.toContain("filtersKinds");
  expect(contract).not.toContain("filtersTags");
}, 60_000);
