import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Bottleneck from "bottleneck";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import { createHttpClient } from "@/scraper/http-client";
import {
  evalExecuteHttpBody,
  extractExecuteHttpBodyFromContract,
} from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Closes the one remaining gap in the facet-payload-threading test cluster:
 * every sibling test (recon-generate-scalar-facet-payload-threading-e2e,
 * recon-generate-array-facet-payload-threading-e2e, and the regression files
 * they were written against) only proves the CLI emits
 * `${payload.<Field>}` / `${JSON.stringify(payload.<Field>)}` as SOURCE
 * TEXT in contract.ts. None of them actually run the emitted executeHttp
 * function. This test does: it evals the real emitted body (via this repo's
 * own eval-harness helper) against a mocked fetch and calls it with payload
 * values DIFFERENT from what was captured, proving the splice resolves to
 * the caller-supplied value at runtime — not merely that the right template
 * text made it into the file.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.facet-payload-runtime-execution-fixture.example.com";
const SEARCH_URL = `https://${OWN_BACKEND_HOST}/api/trip-search`;
const PLAN_URL = `https://${OWN_BACKEND_HOST}/api/trip-plan`;
const CONFIRM_URL = `https://${OWN_BACKEND_HOST}/api/trip-confirm`;

// Kept under 8 characters (recon-generate.ts's MIN_STATE_VALUE_LENGTH), same
// discipline as recon-generate-scalar-facet-payload-threading-e2e.test.ts:
// isolates the exact-key/facet-splice path from the unrelated generic
// same-value STATE threading pass.
const CAPTURED_REGION = "Pacific";
const CAPTURED_THEME = "Alpine";

// Array-of-objects payload field, structurally identical to the reported
// attendeeMix shape, recurring verbatim across all three request bodies.
const CAPTURED_GROUP_MIX = [{ adultCount: 2, childCount: 0, subAges: [], mixId: "0" }];

function captureBody(extra: Record<string, unknown>): string {
  return JSON.stringify({
    region: CAPTURED_REGION,
    theme: CAPTURED_THEME,
    groupMix: CAPTURED_GROUP_MIX,
    ...extra,
  });
}

function reportShapeCaptures(): Capture[] {
  const search = buildCapture({
    url: SEARCH_URL,
    requestPostData: captureBody({ step: "search" }),
    responseBody: { results: [{ id: "trip-1" }] },
    timestamp: "2024-01-01T00:00:00Z",
  });
  const plan = buildCapture({
    url: PLAN_URL,
    requestPostData: captureBody({ step: "plan" }),
    responseBody: { plan: { id: "plan-1" } },
    timestamp: "2024-01-01T00:01:00Z",
  });
  const confirm = buildCapture({
    url: CONFIRM_URL,
    requestPostData: captureBody({ step: "confirm" }),
    responseBody: { confirmation: { id: "conf-1" } },
    timestamp: "2024-01-01T00:02:00Z",
  });
  return [search, plan, confirm];
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

function writeVocabularyModule(dir: string): string {
  const vocabPath = join(dir, "vocabulary.mjs");
  writeFileSync(
    vocabPath,
    `export const vocabulary = {
  subject: /(?!)/,
  exclusions: [],
  table: [
    [/region/i, "Region"],
    [/theme/i, "Theme"],
  ],
};
`
  );
  return vocabPath;
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate emitted executeHttp — typed facet payload fields resolve at runtime, not just in source text", () => {
  it("splices caller-supplied scalar and array-of-objects payload values into every request body when the generated executeHttp actually runs", async () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-facet-payload-runtime-execution-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, reportShapeCaptures());

    const siteId = `facet-payload-runtime-execution-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });

    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: `Fill in the Region field with '${CAPTURED_REGION}'` },
          { step: `Fill in the Theme field with '${CAPTURED_THEME}'` },
          { step: "review trip plan" },
          { step: "confirm trip booking", submitStep: true },
        ],
        submitEndpointPattern: "trip-confirm",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [OWN_BACKEND_HOST],
      })
    );

    const vocabularyPath = writeVocabularyModule(workDir);

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
        vocabularyPath,
      ],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // Confirm both fields were spliced as source text before proceeding to
    // the runtime proof — this is the same assertion the sibling e2e tests
    // make, kept here only as a precondition sanity check.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    expect(contract).toContain("${payload.Region}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    expect(contract).toContain("${payload.Theme}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    expect(contract).toContain("${JSON.stringify(payload.groupMix)}");

    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);
    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    // Each request in the flow is validated against ITS OWN inferred
    // response schema (search -> { results }, plan -> { plan }, confirm ->
    // { confirmation }), so the mock must answer with the right shape per
    // endpoint rather than one generic body.
    const responseForUrl = (url: string): unknown => {
      if (url.includes("trip-search")) return { results: [{ id: "trip-1" }] };
      if (url.includes("trip-plan")) return { plan: { id: "plan-1" } };
      return { confirmation: { id: "conf-1" } };
    };

    const requestBodies: string[] = [];
    const fetchMock = vi.fn().mockImplementation((url: string, init?: { body?: string }) => {
      if (init?.body) requestBodies.push(init.body);
      return Promise.resolve({
        status: 200,
        ok: true,
        text: vi.fn().mockResolvedValue(JSON.stringify(responseForUrl(url))),
        headers: new Headers(),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const executeHttp = evalExecuteHttpBody(executeHttpBody, httpClient, z);

    // Deliberately different from every captured literal above — the only
    // way this can show up in a request body is if the emitted
    // `${payload.Region}` / `${payload.Theme}` / `${JSON.stringify(payload.groupMix)}`
    // template splices actually evaluate against the payload argument at
    // call time, not against whatever was frozen in at generation time.
    const NEW_REGION = "Atlantic";
    const NEW_THEME = "Desert";
    const NEW_GROUP_MIX = [
      { adultCount: 5, childCount: 2, subAges: [9, 4], mixId: "new-1" },
      { adultCount: 1, childCount: 0, subAges: [], mixId: "new-2" },
    ];

    await executeHttp({
      BaseUrl: `https://${OWN_BACKEND_HOST}`,
      Region: NEW_REGION,
      Theme: NEW_THEME,
      groupMix: NEW_GROUP_MIX,
      step: "confirm",
    });

    expect(requestBodies.length).toBeGreaterThanOrEqual(3);
    for (const rawBody of requestBodies) {
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      expect(parsed.region).toBe(NEW_REGION);
      expect(parsed.theme).toBe(NEW_THEME);
      expect(parsed.groupMix).toEqual(NEW_GROUP_MIX);

      expect(rawBody).not.toContain(CAPTURED_REGION);
      expect(rawBody).not.toContain(CAPTURED_THEME);
      expect(JSON.stringify(parsed.groupMix)).not.toBe(JSON.stringify(CAPTURED_GROUP_MIX));
    }
  }, 30_000);
});
