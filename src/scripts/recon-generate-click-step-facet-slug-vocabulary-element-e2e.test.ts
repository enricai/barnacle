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

const OWN_BACKEND_HOST = "www.click-step-slug-vocabulary-fixture.example.com";

type Variant = {
  name: string;
  literal: string;
  slug: string;
  code: string;
  kind: string;
  field: string;
  casing: "toLowerCase" | "toUpperCase";
};

const clickStep = (kind: string, literal: string): string =>
  `Open the ${kind} filter dropdown in the search bar and select the '${literal}' option, keeping the other filters that are already applied`;

const VARIANTS: Variant[] = [
  {
    name: "destination literal against a lowercase slug element",
    literal: "Caribbean",
    slug: "caribbean",
    code: "CB",
    kind: "destination",
    field: "destination",
    casing: "toLowerCase",
  },
  {
    name: "category literal against an uppercase slug element on another kind",
    literal: "Hats",
    slug: "HATS",
    code: "HT",
    kind: "category",
    field: "category",
    casing: "toUpperCase",
  },
];

function buildCaptures(variant: Variant): Capture[] {
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/browse/`,
      requestPostData: JSON.stringify({
        ids: [`${variant.slug};filterId=urlFriendlyId`, "other;filterId=urlFriendlyId"],
      }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/quote/`,
      requestPostData: JSON.stringify({
        filters: ["2027-03;filterType=date", `${variant.code};filterType=${variant.kind}`],
      }),
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

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

function generate(variant: Variant): string {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-click-step-slug-"));
  const runRoot = join(workDir, "run");
  for (const dir of ["graphql", "replays", "aux"]) {
    mkdirSync(join(runRoot, dir), { recursive: true });
  }
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
  buildCaptures(variant).forEach((capture, index) => {
    writeFileSync(
      join(runRoot, "graphql", `${String(index).padStart(3, "0")}-capture.json`),
      JSON.stringify(capture)
    );
  });

  const siteId = `click-step-slug-vocabulary-test-${process.pid}`;
  siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [
        { step: clickStep(variant.kind, variant.literal), payloadField: variant.field },
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
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return readFileSync(join(siteOutDir, "contract.ts"), "utf8");
}

describe("recon-generate CLI — click-step facet threaded into a slug-vocabulary array element", () => {
  it.each(VARIANTS)(
    "$name",
    (variant) => {
      const contract = generate(variant);

      expect(contract, contract).toContain(
        `String(payload.${variant.field}).${variant.casing}()};filterId=urlFriendlyId`
      );
      expect(contract).not.toContain(`${variant.slug};filterId=urlFriendlyId`);
      expect(contract).toContain("other;filterId=urlFriendlyId");
      expect(contract, contract).toMatch(
        new RegExp(`payload\\.${variant.field}[^\`]*;filterType=${variant.kind}`)
      );
    },
    30_000
  );
});
