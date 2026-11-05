import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * A click-step facet whose literal matches no element of any captured body must
 * be demoted to optional and warned about on both the REST body and the GraphQL
 * variables transport, never emitted required with no payload reference.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.click-step-unread-facet-demoted-fixture.example.com";

const FIVE_ELEMENTS = [
  "2026-12;filterType=date",
  "GADGETS;filterType=category",
  "RED;filterType=color",
  "BETA;filterType=theme",
  "GAMMA;filterType=vendor",
];

const COLOR_STEP =
  "Open the colour filter dropdown in the sidebar and click the 'Red' colour option, keeping the other filters that are already applied";
const NIGHTS_STEP =
  "Open the number of nights filter dropdown in the sidebar and click the '4' nights option, keeping the other filters that are already applied";

const DECLARED_STEPS = [
  { step: "navigate", payloadField: "category" },
  { step: COLOR_STEP, payloadField: "color" },
  { step: NIGHTS_STEP, payloadField: "nights" },
];

type Transport = "rest" | "graphql";

function transportCapture(transport: Transport): unknown {
  if (transport === "rest") {
    return buildCapture({
      url: `https://${OWN_BACKEND_HOST}/quote/`,
      requestPostData: JSON.stringify({ category: "gadgets", filters: FIVE_ELEMENTS }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:01.000Z",
    });
  }
  const variables = { sort: "RELEVANCE", filters: FIVE_ELEMENTS };
  return {
    ...buildCapture({
      url: `https://${OWN_BACKEND_HOST}/graphql`,
      requestPostData: JSON.stringify({ variables }),
      responseBody: { trips: [{ id: "abc" }] },
      timestamp: "2026-01-01T00:00:01.000Z",
    }),
    operationName: "tripSearch",
    query:
      "query tripSearch($sort: String, $filters: [String!]) { trips(sort: $sort, filters: $filters) { id } }",
    variables,
  };
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

async function generate(transport: Transport): Promise<string> {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-click-unread-demoted-e2e-"));
  const runRoot = join(workDir, "run");
  for (const dir of ["graphql", "replays", "aux"])
    mkdirSync(join(runRoot, dir), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
  const captures = [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/browse/`,
      requestPostData: JSON.stringify({ sort: "recent" }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    transportCapture(transport),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/submit/`,
      requestPostData: JSON.stringify({ confirm: true }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:02.000Z",
    }),
  ];
  captures.forEach((capture, index) => {
    writeFileSync(
      join(runRoot, "graphql", `${String(index).padStart(3, "0")}-capture.json`),
      JSON.stringify(capture)
    );
  });

  const siteId = `click-step-unread-facet-demoted-test-${transport}-${process.pid}`;
  siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [
        {
          step: "navigate to the gadgets category page",
          navigateTo: `https://${OWN_BACKEND_HOST}/#/browse/gadgets`,
          payloadField: "category",
        },
        { step: COLOR_STEP, payloadField: "color" },
        { step: NIGHTS_STEP, payloadField: "nights" },
        { step: "submit the quote", submitStep: true },
      ],
      submitEndpointPattern: "submit",
      requireSubmitEndpointMatch: true,
      ownBackendHostnames: [OWN_BACKEND_HOST],
    })
  );

  const contractPath = join(siteOutDir, "contract.ts");
  const savedArgv = process.argv;
  process.argv = [
    savedArgv[0]!,
    GENERATE_SCRIPT,
    "--site-id",
    siteId,
    "--run-dir",
    runRoot,
    "--emit",
    "ts",
    "--force",
  ];
  vi.resetModules();
  try {
    // Importing the module runs main() (argv[1] ends with recon-generate.ts).
    await import("./recon-generate.js");
    for (let i = 0; i < 300 && !existsSync(contractPath); i++)
      await new Promise((r) => setTimeout(r, 100));
  } finally {
    process.argv = savedArgv;
  }
  return readFileSync(contractPath, "utf8");
}

describe("recon-generate main() in-process — unread declared field regenerates the contract optional", () => {
  for (const transport of ["rest", "graphql"] as const) {
    it(`emits nights optional on the ${transport} transport via the fallback re-emit`, async () => {
      const contract = await generate(transport);
      expect(contract).toMatch(/nights: z\.string\(\)\.optional\(\)/);
      expect(contract).not.toContain("payload.nights");
      expect(contract, contract).toMatch(/payload\.color[^`]*;filterType=color/);
    }, 60_000);
  }
});
