import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins the report's literal defect-2 shape: ONE deeply-nested, short,
 * unrelated response scalar whose value coincidentally equals TWO later,
 * differently-named submit-body fields at once (mirroring the report's
 * `page`/`exploreMorePage` both matching the same `displayOrder105`), rather
 * than two distinct source fields each colliding with one target (the
 * sibling multi-toggle guard test) or one target colliding across steps.
 * Neither target may be spliced from the shared source local's own derived
 * name; a genuinely name-correlated third field must still resolve.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.shared-source-dual-target-splice-guard-fixture.example.com";
const LIST_URL = `https://${OWN_BACKEND_HOST}/catalog/search/`;
const DETAIL_URL = `https://${OWN_BACKEND_HOST}/catalog/detail/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/catalog/submit/`;

// The genuinely-threaded value: same field name on both sides.
const TOKEN_VALUE = "tok7";

// The single deeply-nested, short, unrelated scalar whose value coincidentally
// equals two later, differently-named submit-body fields at once.
const SHARED_SCALAR_VALUE = 105;

function fixtureCaptures(): Capture[] {
  const list = buildCapture({
    url: LIST_URL,
    requestPostData: '{"page":1}',
    // Deeply-nested, short, unrelated scalar — nothing to do with either
    // "cursorPosition" or "queueSlot" names it later coincidentally matches.
    responseBody: {
      results: [{ itemId: "item-a" }],
      meta: { pagination: { layout: { displayOrder: SHARED_SCALAR_VALUE } } },
    },
    timestamp: "2026-01-01T00:00:00Z",
  });
  const detail = buildCapture({
    url: DETAIL_URL,
    requestPostData: '{"itemId":"item-a"}',
    responseBody: { token: TOKEN_VALUE },
    timestamp: "2026-01-01T00:00:01Z",
  });
  // The submit body re-references `token` under its own genuine name, plus
  // two differently-named fields whose values both coincidentally equal the
  // single shared, unrelated nested scalar above.
  const submit = buildCapture({
    url: SUBMIT_URL,
    requestPostData: JSON.stringify({
      itemId: "item-a",
      token: TOKEN_VALUE,
      cursorPosition: SHARED_SCALAR_VALUE,
      queueSlot: SHARED_SCALAR_VALUE,
    }),
    responseBody: { ok: true },
    timestamp: "2026-01-01T00:00:02Z",
  });
  return [list, detail, submit];
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

describe("recon-generate CLI — one shared unrelated scalar never simultaneously sources two differently-named body fields", () => {
  it("sources each coincidentally-matching body field only from its own name-correlated accessor, never the shared unrelated scalar's local", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-shared-source-dual-target-splice-guard-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `shared-source-dual-target-splice-guard-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "browse catalog search" },
          { step: "open item detail panel" },
          { step: "submit item selection", submitStep: true },
        ],
        submitEndpointPattern: "catalog/submit",
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

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    const bodyLineMatch = contract.match(/catalog\/submit\/[\s\S]*?body:\s*`([^`]*)`/);
    expect(bodyLineMatch, contract).not.toBeNull();
    const bodyTemplate = bodyLineMatch![1]!;

    // The genuinely-threaded field must still resolve from its own
    // name-correlated accessor/local — the fix must not over-correct into
    // blocking legitimate same-name threading.
    const tokenLine = bodyTemplate.match(/"token"\s*:\s*"?\$\{([^}]*)\}"?/);
    expect(tokenLine, bodyTemplate).not.toBeNull();
    expect(tokenLine![1]).toMatch(/token/i);

    // Neither differently-named field may be spliced from the shared
    // unrelated scalar's own derived name ("displayOrder"), even though
    // both were planted from the SAME single unrelated response value.
    const cursorPositionLine = bodyTemplate.match(/"cursorPosition"\s*:\s*"?([^,\n}]*)"?/);
    if (cursorPositionLine && cursorPositionLine[1]!.includes("${")) {
      expect(cursorPositionLine[1]).not.toMatch(/displayorder/i);
    }

    const queueSlotLine = bodyTemplate.match(/"queueSlot"\s*:\s*"?([^,\n}]*)"?/);
    if (queueSlotLine && queueSlotLine[1]!.includes("${")) {
      expect(queueSlotLine[1]).not.toMatch(/displayorder/i);
    }

    // No invalidly-nested placeholder anywhere in the emitted body.
    expect(bodyTemplate).not.toMatch(/\$\{[^}]*\$\{/);
  }, 30_000);
});
