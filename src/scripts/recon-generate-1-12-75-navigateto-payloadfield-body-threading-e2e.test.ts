import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Closes the core gap left open by
 * recon-generate.navigateto-explicit-payloadfield-facet-regression.test.ts,
 * which only proves a navigateTo step's explicit `payloadField` reaches a
 * tracking HEADER template and the PayloadSchema declaration — exactly the
 * shape the report says does not count. This drives the real `recon:generate`
 * CLI over a flow whose navigateTo-declared facet value is carried ONLY in a
 * downstream request BODY (never a header), so the emitted contract.ts's
 * `body:` template literal must itself contain the `${payload.<field>}`
 * splice, not merely the schema or a header string.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.navigateto-payloadfield-body-threading-fixture.example.com";
const EVENT_SLUG = "autumn-showcase";

function fixtureCaptures(): Capture[] {
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/events/browse/`,
      requestPostData: JSON.stringify({ sort: "date" }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/events/reserve/`,
      requestPostData: JSON.stringify({ eventSlug: EVENT_SLUG, confirm: true }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:01.000Z",
    }),
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

describe("recon-generate CLI — navigateTo step's explicit payloadField reaches the emitted request BODY template", () => {
  it("splices the body-carried event slug into the payload.EventSlug accessor inside the body template, not only headers/schema", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-navigateto-payloadfield-body-threading-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `navigateto-payloadfield-body-threading-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate to the autumn showcase event page",
            navigateTo: `https://${OWN_BACKEND_HOST}/#/events/${EVENT_SLUG}`,
            payloadField: "EventSlug",
          },
          { step: "browse events" },
          { step: "reserve event", submitStep: true },
        ],
        submitEndpointPattern: "events/reserve",
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

    const contractPath = join(siteOutDir, "contract.ts");
    const contract = readFileSync(contractPath, "utf8");

    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    const expectedSplice = "${payload.EventSlug}";

    // The splice must appear specifically inside a `body:`-shaped template
    // literal — this is the exact distinction the report draws between a real
    // fix and the "tracking-header-only" false positive.
    const bodyBlocks = [...contract.matchAll(/body:\s*`([^`]*)`,/g)].map((m) => m[1] ?? "");
    expect(bodyBlocks.length, contract).toBeGreaterThan(0);
    expect(bodyBlocks.some((b) => b.includes(expectedSplice))).toBe(true);

    // The recon's captured literal must never survive frozen inside any body
    // template — every occurrence must have been rewritten to the accessor.
    for (const body of bodyBlocks) {
      expect(body).not.toContain(EVENT_SLUG);
    }

    // The payload schema still declares the field (coverage for the schema
    // side continues to hold alongside the body-threading fix).
    const schemaMatch = contract.match(
      /PayloadSchema = z\.object\(\{[\s\S]*?\n\}\)(?:\.extend\(\{[\s\S]*?\n\}\))?;/
    );
    expect(schemaMatch, contract).not.toBeNull();
    const schema = schemaMatch?.[0] ?? "";
    expect(schema).toMatch(/ {2}EventSlug:/);
  }, 30_000);
});
