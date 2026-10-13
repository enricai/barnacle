import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  collectRequestBodyValuesByKey,
  findFrozenVaryingDrillParams,
  readComparableBodyLeaf,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins that arrays whose elements all share one identity suffix
 * (`;facetId=slug`) at differing lengths, and against a differently suffixed
 * array (`;facetType=...`), are never reported as a varying slot, while a
 * unique-key value that genuinely changes still is. Generic retail fixture.
 */

const SAME_SUFFIX = [
  "blue-shirt;facetId=slug",
  "spring-sale;facetId=slug",
  "promo;facetId=slug",
  "outlet;facetId=slug",
];
const OTHER_SAME_SUFFIX = [
  "red-hat;facetId=slug",
  "summer-sale;facetId=slug",
  "clearance;facetId=slug",
  "bundle;facetId=slug",
  "gift;facetId=slug",
  "new-in;facetId=slug",
];
const TYPE_SUFFIX = [
  "2026-12;facetType=date",
  "NORTH;facetType=region",
  "PROMO;facetType=theme",
  "4;facetType=size",
  "WW;facetType=brand",
  "GOC;facetType=store",
];

const cap = (body: unknown): Capture =>
  ({ url: "https://x/search", method: "POST", requestPostData: JSON.stringify(body) }) as Capture;

function indexesOf(array: string[]): string[] {
  return array.map((_, index) => String(index));
}

describe("readComparableBodyLeaf with same-suffix arrays of differing length", () => {
  for (const length of [3, 2, 1]) {
    it(`reports nothing varying for 4 vs ${length} same-suffix elements, both orderings`, () => {
      const longer = { filters: SAME_SUFFIX };
      const shorter = { filters: OTHER_SAME_SUFFIX.slice(0, length) };
      for (const index of indexesOf(SAME_SUFFIX)) {
        expect(readComparableBodyLeaf(longer, shorter, ["filters", index])).toBeUndefined();
      }
      for (const index of indexesOf(shorter.filters)) {
        expect(readComparableBodyLeaf(shorter, longer, ["filters", index])).toBeUndefined();
      }
    });
  }

  it("reports nothing varying for a middle length among shorter and longer arrays", () => {
    const middle = { filters: SAME_SUFFIX };
    for (const other of [OTHER_SAME_SUFFIX.slice(0, 2), OTHER_SAME_SUFFIX]) {
      for (const index of indexesOf(middle.filters)) {
        expect(
          readComparableBodyLeaf(middle, { filters: other }, ["filters", index])
        ).toBeUndefined();
      }
    }
  });

  it("returns an identical element's own value regardless of slot", () => {
    const shorter = { filters: [SAME_SUFFIX[3]!, SAME_SUFFIX[0]!] };
    expect(readComparableBodyLeaf({ filters: SAME_SUFFIX }, shorter, ["filters", "0"])).toBe(
      SAME_SUFFIX[0]
    );
  });
});

describe("readComparableBodyLeaf with same-suffix vs differently suffixed arrays", () => {
  for (const length of [5, 6]) {
    it(`reports nothing varying for 4 same-suffix vs ${length} differently suffixed elements`, () => {
      const same = { filters: SAME_SUFFIX };
      const typed = { filters: TYPE_SUFFIX.slice(0, length) };
      for (const index of indexesOf(SAME_SUFFIX)) {
        expect(readComparableBodyLeaf(same, typed, ["filters", index])).toBeUndefined();
      }
      for (const index of indexesOf(typed.filters)) {
        expect(readComparableBodyLeaf(typed, same, ["filters", index])).toBeUndefined();
      }
    });
  }
});

describe("frozen-varying consumers with same-suffix array shapes", () => {
  const shapes = [
    SAME_SUFFIX,
    OTHER_SAME_SUFFIX.slice(0, 3),
    OTHER_SAME_SUFFIX.slice(0, 2),
    OTHER_SAME_SUFFIX.slice(0, 1),
    TYPE_SUFFIX.slice(0, 5),
    TYPE_SUFFIX,
  ];

  it("collectRequestBodyValuesByKey reports no varying key across every shape", () => {
    const captures = shapes.map((filters) => cap({ filters }));
    for (const capture of captures) {
      expect(collectRequestBodyValuesByKey(capture, captures)!.has("filters")).toBe(false);
    }
  });

  it("findFrozenVaryingDrillParams returns [] across every shape", () => {
    const captures = shapes.map((filters) => cap({ filters }));
    const rendered = JSON.stringify({ filters: SAME_SUFFIX });
    expect(findFrozenVaryingDrillParams(captures[0]!, rendered, captures)).toEqual([]);
  });

  it("still reports a genuinely varying unique-key value", () => {
    const a = cap({ filters: ["blue-shirt;facetId=slug", "2026-12;facetType=date"] });
    const b = cap({ filters: ["green-shirt;facetId=slug", "2026-12;facetType=date"] });
    expect(collectRequestBodyValuesByKey(a, [a, b])!.has("filters")).toBe(true);
  });
});

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");
const OWN_BACKEND_HOST = "www.shared-suffix-array-shapes-fixture.example.com";
const DRILL_URL = `https://${OWN_BACKEND_HOST}/catalog/pricing/`;

function fixtureCaptures(): Capture[] {
  const primary = buildCapture({
    url: `https://${OWN_BACKEND_HOST}/catalog/search/`,
    requestPostData: JSON.stringify({ page: 1 }),
    responseBody: { results: [{ sku: "sku-a" }, { sku: "sku-b" }, { sku: "sku-c" }] },
    timestamp: "2026-06-01T00:00:00.000Z",
  });
  const drill = (sku: string, filters: string[], timestamp: string): Capture =>
    buildCapture({
      url: `${DRILL_URL}?sku=${sku}&mark-${filters[filters.length - 1]}=ok`,
      requestPostData: JSON.stringify({ filters }),
      responseBody: { results: [{ sku, amount: 19.99 }] },
      timestamp,
    });
  return [
    primary,
    drill("sku-a", SAME_SUFFIX, "2026-06-01T00:00:01.000Z"),
    drill("sku-b", OTHER_SAME_SUFFIX.slice(0, 2), "2026-06-01T00:00:02.000Z"),
    drill("sku-c", TYPE_SUFFIX, "2026-06-01T00:00:03.000Z"),
  ];
}

function writeRunDir(root: string, captures: Capture[]): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));
  captures.forEach((capture, index) => {
    writeFileSync(
      join(root, "graphql", `${String(index).padStart(3, "0")}-capture.json`),
      JSON.stringify(capture)
    );
  });
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — same-suffix array shapes across three drill captures", () => {
  it("generates contract.ts without a frozen-varying error", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-shared-suffix-shapes-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `shared-suffix-shapes-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "search catalog" }, { step: "drill into pricing", submitStep: true }],
        submitEndpointPattern: "catalog/pricing",
        ownBackendHostnames: [OWN_BACKEND_HOST],
        foldReturn: {
          endpointPattern: "catalog/pricing",
          resultsPath: "results",
          joinFields: ["sku"],
        },
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).not.toContain("would freeze a value that varied");
    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).toContain("/catalog/pricing/");
  }, 60_000);
});

const EXCLUSIVE_ID_TAGGED = [
  "red;filterId=colorTag",
  "xl;filterId=colorTag",
  "cotton;filterId=colorTag",
  "sale;filterId=colorTag",
];
const EXCLUSIVE_TYPE_TAGGED = [
  "2026-12;filterType=date",
  "GARDEN;filterType=theme",
  "4;filterType=night",
  "WW;filterType=ship",
  "SALE;filterType=promo",
  "XL;filterType=size",
];

function exclusiveFilterCaptures(): Capture[] {
  const primary = buildCapture({
    url: `https://${OWN_BACKEND_HOST}/catalog/search/`,
    requestPostData: JSON.stringify({ page: 1 }),
    responseBody: { results: [{ sku: "sku-a" }, { sku: "sku-b" }, { sku: "sku-c" }] },
    timestamp: "2026-06-01T00:00:00.000Z",
  });
  const drill = (sku: string, filters: string[], region: string, timestamp: string): Capture =>
    buildCapture({
      url: `${DRILL_URL}?sku=${sku}`,
      requestPostData: JSON.stringify({
        currency: "USD",
        filters,
        region: "EU",
        sorts: [{ criteria: "RECOMMENDED", region }],
      }),
      responseBody: { results: [{ sku, amount: 19.99 }] },
      timestamp,
    });
  return [
    primary,
    drill("sku-a", EXCLUSIVE_ID_TAGGED, "NJ", "2026-06-01T00:00:01.000Z"),
    drill("sku-b", EXCLUSIVE_ID_TAGGED.slice(0, 2), "NJ", "2026-06-01T00:00:02.000Z"),
    drill("sku-c", EXCLUSIVE_TYPE_TAGGED, "FL", "2026-06-01T00:00:03.000Z"),
  ];
}

describe("recon-generate CLI — mutually exclusive filter arrays with a differing sibling", () => {
  it("generates contract.ts without a frozen-varying error when siblings are constant", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-exclusive-constant-"));
    const runRoot = join(workDir, "run");
    writeRunDir(
      runRoot,
      exclusiveFilterCaptures().map((capture) => ({
        ...capture,
        requestPostData: capture.requestPostData?.replace('"region":"FL"', '"region":"NJ"') ?? null,
      }))
    );

    const siteId = `exclusive-constant-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "search catalog" }, { step: "drill into pricing", submitStep: true }],
        submitEndpointPattern: "catalog/pricing",
        ownBackendHostnames: [OWN_BACKEND_HOST],
        foldReturn: {
          endpointPattern: "catalog/pricing",
          resultsPath: "results",
          joinFields: ["sku"],
        },
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).not.toContain("would freeze a value that varied");
    expect(readFileSync(join(siteOutDir, "contract.ts"), "utf8")).toContain("/catalog/pricing/");
  }, 60_000);

  it("flags only the genuinely varying sibling, never a filters.N slot", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-exclusive-filters-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, exclusiveFilterCaptures());

    const siteId = `exclusive-filters-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "search catalog" }, { step: "drill into pricing", submitStep: true }],
        submitEndpointPattern: "catalog/pricing",
        ownBackendHostnames: [OWN_BACKEND_HOST],
        foldReturn: {
          endpointPattern: "catalog/pricing",
          resultsPath: "results",
          joinFields: ["sku"],
        },
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status, output).toBe(1);
    expect(output).toContain("sorts.0.region");
    expect(output).not.toMatch(/body field \\?"filters\./);
  }, 60_000);
});

describe("findFrozenVaryingDrillParams with mutually exclusive filter arrays and a differing sibling", () => {
  const ID_TAGGED = [
    "red;filterId=colorTag",
    "xl;filterId=colorTag",
    "cotton;filterId=colorTag",
    "sale;filterId=colorTag",
  ];
  const TYPE_TAGGED = [
    "2026-12;filterType=date",
    "GARDEN;filterType=theme",
    "4;filterType=night",
    "WW;filterType=ship",
    "SALE;filterType=promo",
    "XL;filterType=size",
  ];
  const body = (filters: string[], region: string): Record<string, unknown> => ({
    currency: "USD",
    filters,
    region: "EU",
    sorts: [{ criteria: "RECOMMENDED", region }],
  });
  const variants = [
    body(ID_TAGGED, "NJ"),
    body(ID_TAGGED.slice(0, 3), "NJ"),
    body(ID_TAGGED.slice(0, 2), "NJ"),
    body(ID_TAGGED.slice(0, 1), "NJ"),
    body(TYPE_TAGGED, "FL"),
    body(TYPE_TAGGED.slice(0, 5), "FL"),
  ];

  it("never reports a filters.N entry for any ordered pair of shapes", () => {
    const captures = variants.map((variant) => cap(variant));
    for (const [capIndex, capture] of captures.entries()) {
      const rendered = JSON.stringify(variants[capIndex]);
      const frozen = findFrozenVaryingDrillParams(capture, rendered, captures);
      expect(
        frozen.filter((entry) => JSON.stringify(entry).includes("filters")),
        `capture ${capIndex}`
      ).toEqual([]);
    }
  });

  it("pairs filters leaves of every shape pair only with an identical element", () => {
    for (const [a, first] of variants.entries()) {
      for (const [b, second] of variants.entries()) {
        if (a === b) continue;
        for (const index of indexesOf(first.filters as string[])) {
          const leaf = (first.filters as string[])[Number(index)]!;
          const expected = (second.filters as string[]).includes(leaf) ? leaf : undefined;
          expect(
            readComparableBodyLeaf(first, second, ["filters", index]),
            `${a}->${b}[${index}]`
          ).toBe(expected);
        }
      }
    }
  });
});

describe("readComparableBodyLeaf with positional identity tags on arrays of differing length", () => {
  const tagged = (values: string[], name: string): string[] =>
    values.map((value, index) => `${value};${name}=t${index}`);

  for (const [ownLength, otherLength] of [
    [4, 2],
    [3, 1],
    [1, 3],
    [4, 6],
  ] as const) {
    it(`pairs disjoint ${ownLength} vs ${otherLength} elements with nothing`, () => {
      const own = { filters: tagged(["a", "b", "c", "d"].slice(0, ownLength), "tagId") };
      const other = {
        filters: tagged(["w", "x", "y", "z", "u", "v"].slice(0, otherLength), "tagId"),
      };
      for (const index of indexesOf(own.filters)) {
        expect(readComparableBodyLeaf(own, other, ["filters", index])).toBeUndefined();
      }
      for (const index of indexesOf(other.filters)) {
        expect(readComparableBodyLeaf(other, own, ["filters", index])).toBeUndefined();
      }
    });
  }

  it("still pairs a changed value of the same-shaped array by identity", () => {
    const own = { filters: tagged(["a", "b"], "tagId") };
    const other = { filters: tagged(["z", "b"], "tagId") };
    expect(readComparableBodyLeaf(own, other, ["filters", "0"])).toBe("z;tagId=t0");
  });
});
