import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const BASE = "https://shop.example/api/v2/products/search";

function generate(
  urls: string[],
  steps: unknown[],
  tag: string,
  withSensorPosts = false,
  flowExtra: Record<string, unknown> = {}
): string {
  const workDir = mkdtempSync(join(tmpdir(), "rest-get-emit-"));
  dirs.push(workDir);
  const runRoot = join(workDir, "run");
  const capturesDir = join(runRoot, "graphql");
  mkdirSync(capturesDir, { recursive: true });
  mkdirSync(join(runRoot, "replays"), { recursive: true });
  mkdirSync(join(runRoot, "aux"), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
  urls.forEach((url, i) => {
    writeFileSync(
      join(capturesDir, `00${i}-search.json`),
      JSON.stringify(
        buildCapture({
          url,
          requestPostData: null,
          responseBody: {
            total: 40,
            items: Array.from({ length: 12 }, (_, n) => ({ id: i * 12 + n + 1, name: `p${n}` })),
          },
          timestamp: `2024-02-01T00:00:0${i}Z`,
          method: "GET",
        })
      )
    );
  });
  if (withSensorPosts) {
    // A bot manager acknowledges every opaque sensor body with one fixed response.
    [1, 2, 3].forEach((n) => {
      writeFileSync(
        join(capturesDir, `01${n}-sensor.json`),
        JSON.stringify(
          buildCapture({
            url: "https://shop.example/assets/3f9a1c7e",
            method: "POST",
            requestPostData: JSON.stringify({ sensor_data: `blob-${n}-${"x".repeat(40 * n)}` }),
            responseBody: { success: true },
            timestamp: `2024-02-01T00:00:1${n}Z`,
          })
        )
      );
    });
  }
  const siteId = `rest-get-emit-${tag}-${process.pid}`;
  const siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  dirs.push(siteOutDir);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(join(siteOutDir, "recon-flow.json"), JSON.stringify({ steps, ...flowExtra }));
  const result = spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return readFileSync(join(siteOutDir, "contract.ts"), "utf8");
}

const URLS = [
  `${BASE}?limit=12&offset=0&sort=price`,
  `${BASE}?limit=12&offset=12&sort=price&category=shoes%20%26%20boots&brand=acme`,
  `${BASE}?limit=12&offset=24&sort=price&color=red`,
];
const STEPS = [
  { step: "open the page" },
  { step: "pick a category", payloadField: "category", optional: true },
  { step: "pick a color", payloadField: "color", optional: true },
];

describe("single-endpoint REST GET emit", () => {
  const contract = generate(URLS, STEPS, "paged");
  const http = contract.slice(
    contract.indexOf("async executeHttp("),
    contract.indexOf("async execute(")
  );
  const schema = contract.slice(
    contract.indexOf("PayloadSchema = z"),
    contract.indexOf("PayloadSchema = z") + 800
  );

  it("emits a GET with optional URL-encoded facet params and no required query field", () => {
    expect(http).toContain('method: "GET"');
    expect(http).toContain("new URLSearchParams(");
    expect(http).toContain(
      'payload.category !== undefined ? [["category", String(payload.category)]]'
    );
    expect(http).not.toContain("payload.query");
    expect(schema).not.toMatch(/\bquery:/);
  });

  it("keeps absent-means-no-filter facets optional in the schema", () => {
    expect(schema).toMatch(/category: z\.string\(\)\.optional\(\)/);
    expect(schema).toMatch(/color: z\.string\(\)\.optional\(\)/);
    expect(schema).not.toMatch(/\n {2}category: z\.string\(\),/);
  });

  it("wires facets seen only on non-richest captures in the paged emit", () => {
    expect(http).toContain("brand");
    expect(http).toContain("color");
    expect(http).toContain("category");
  });

  it("pages via limit/offset and stops on the reported total", () => {
    expect(http).toContain('["limit", String(PAGE_SIZE)]');
    expect(http).toContain('["offset", String(skip)]');
    expect(http).toContain("itemsById.size < total");
    expect(schema).not.toMatch(/\boffset:/);
    expect(schema).toContain("maxPages");
  });
});

describe("single-endpoint REST GET emit alongside recurring bot-manager POSTs", () => {
  const contract = generate(URLS, STEPS, "sensor", true);
  const http = contract.slice(
    contract.indexOf("async executeHttp("),
    contract.indexOf("async execute(")
  );

  it("issues the primary as a GET with the facet query params, not a POST body", () => {
    expect(http).toContain('method: "GET"');
    expect(http).not.toContain('method: "POST"');
    expect(http).toContain(
      'payload.category !== undefined ? [["category", String(payload.category)]]'
    );
  });
});

describe("array-form foldReturn through the generator CLI", () => {
  it("generates when several declared drills match no capture", () => {
    const contract = generate(URLS, STEPS, "foldarr", false, {
      foldReturn: [
        { endpointPattern: "/detail", resultsPath: "items", joinFields: ["id"] },
        {
          endpointPattern: "/other",
          joinFields: ["id"],
          attachAs: "extra",
          payloadFlag: "wantExtra",
        },
      ],
    });
    expect(contract).toContain('method: "GET"');
  });
});
