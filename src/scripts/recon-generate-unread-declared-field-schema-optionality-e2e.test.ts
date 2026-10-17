import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * A declared payloadField no emitted request reads must not be left required in
 * the payload schema, and the unread warning must still fire when only the
 * browser flow mentions payload.<field>. A sibling field that is threaded into
 * the request body stays required.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.unread-declared-schema-fixture.example.com";

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

function generate(transport: Transport): { contract: string; browserFlow: string; output: string } {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-unread-declared-schema-e2e-"));
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

  const siteId = `unread-declared-schema-test-${transport}-${process.pid}`;
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

  const result = spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  const output = `${result.stdout}\n${result.stderr}`;
  expect(result.status, output).toBe(0);
  return {
    contract: readFileSync(join(siteOutDir, "contract.ts"), "utf8"),
    browserFlow: readFileSync(join(siteOutDir, "flows", "browser-flow.ts"), "utf8"),
    output,
  };
}

describe("recon-generate CLI — unread declared nights field stays optional in the schema", () => {
  for (const transport of ["rest", "graphql"] as const) {
    it(`never emits nights required and still warns when the browser flow mentions it (${transport})`, () => {
      const { contract, browserFlow, output } = generate(transport);

      expect(output).toContain("declared payloadField nights is read by no emitted request");
      expect(output).not.toContain("declared payloadField color");
      expect(contract).not.toMatch(/nights: z\.string\(\)(?!\.optional)/);
      expect(contract).toMatch(/nights: z\.string\(\)\.optional\(\)/);
      expect(contract).not.toContain("payload.nights");
      expect(contract).not.toMatch(/color: z\.string\(\)\.optional\(\)/);
      expect(contract).toMatch(/payload\.color[^`]*;filterType=color/);
      expect(browserFlow).toContain("payload.nights");
    }, 30_000);
  }
});
