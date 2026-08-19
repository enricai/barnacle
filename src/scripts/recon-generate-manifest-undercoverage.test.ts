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
import { buildWizardCheckoutCaptures } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Reproduces the reported defect: `resolveManifestActionSequence`
 * (recon-generate.ts:761-780) is unconditionally authoritative once
 * submit-manifest.json parses ("the manifest ... wins when present",
 * recon-generate.ts:766-769) — its result is never checked for plausibility
 * against the richer heuristic `extractActionSequence` would find. A flow
 * whose recon-flow.json marks only one step `submitStep: true` (the natural
 * model for a single-button checkout) but whose real site auto-saves every
 * wizard section server-side produces a short (here length-1) manifest,
 * which then unconditionally overrides the correct multi-endpoint captured
 * sequence. `recon-generate.ts:4838` sets `isSubmissionFlow = actionSteps.length
 * > 1`, so a length-1 manifest collapses the plugin to the generic
 * single-call `{ query }` fallback (recon-generate.ts:3800/4033) instead of
 * the real 10-call checkout sequence that was actually captured.
 *
 * Exercises the real CLI (matches recon-generate-run-input.test.ts's
 * spawnSync harness pattern) rather than importing internals directly, since
 * `resolveManifestActionSequence`'s effect on the emitted `contract.ts` is
 * only observable through the full generation pipeline.
 *
 * Regression pin: bugfix-002 made the generator compare the manifest against
 * the heuristic sequence instead of trusting it unconditionally. Beyond
 * string-matching the emitted source, this also eval-and-runs the emitted
 * `executeHttp` body against a mocked fetch (the
 * recon-generate-multistep-e2e.test.ts harness pattern), proving the 10-call
 * sequence executes correctly end to end and threads a freshly-minted
 * `orderId` through every URL rather than hardcoding the captured one.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

let workDir: string | null = null;
let siteOutDir: string | null = null;
let flowFile: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  if (flowFile) rmSync(flowFile, { force: true });
  workDir = null;
  siteOutDir = null;
  flowFile = null;
});

describe("recon-generate: submit-manifest.json under-coverage collapses a real multi-call flow", () => {
  it("emits the fabricated single {query} POST instead of the captured 10-call checkout sequence", async () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-recon-manifest-undercoverage-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    const replaysDir = join(runRoot, "replays");
    const auxDir = join(runRoot, "aux");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(replaysDir, { recursive: true });
    mkdirSync(auxDir, { recursive: true });
    writeFileSync(join(replaysDir, "rate-limit.json"), JSON.stringify([]));

    const captures = buildWizardCheckoutCaptures();
    captures.forEach((capture, index) => {
      const filename = `${String(index).padStart(3, "0")}-checkout-action.json`;
      writeFileSync(join(capturesDir, filename), JSON.stringify(capture));
    });

    // Under-covering submit-manifest.json: recon-browser only matched the
    // final "place order" click against the flow's declared submit pattern,
    // so it authoritatively narrates the whole flow as that one capture —
    // even though 9 other genuine section-save POSTs were captured.
    const placeOrderIndex = captures.length - 1;
    const placeOrderCapture = captures[placeOrderIndex];
    if (!placeOrderCapture) throw new Error("unreachable");
    writeFileSync(
      join(runRoot, "submit-manifest.json"),
      JSON.stringify([
        {
          index: placeOrderIndex,
          filename: `${String(placeOrderIndex).padStart(3, "0")}-checkout-action.json`,
          url: placeOrderCapture.url,
        },
      ])
    );

    const siteId = `recon-manifest-undercoverage-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);

    // A single submitStep:true step is the natural (and, per the report, wrong)
    // way to declare a one-button checkout flow — the flow itself never claims
    // the wizard sections aren't part of the submission.
    mkdirSync(siteOutDir, { recursive: true });
    flowFile = join(siteOutDir, "recon-flow.json");
    writeFileSync(
      flowFile,
      JSON.stringify({
        steps: [
          { step: "fill out the shipping, billing, payment, and review sections" },
          { step: "click place order", submitStep: true },
        ],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // What SHOULD happen: the real 10-call checkout sequence that was
    // actually captured drives executeHttp, not a fabricated single-call
    // stub. This is the acceptance bar bugfix-002 must clear — it is
    // expected to fail against the current, unfixed generator.
    //
    // The order id itself is correctly state-threaded (`${orderId}`, sourced
    // from the create-order response) rather than left as the literal
    // "order-42" — a real checkout mints a different order id per session,
    // so hardcoding the captured one would be wrong for production use. The
    // section path segments below stay literal on the endpoint's first
    // occurrence, which is enough to prove every genuine section call
    // survived instead of collapsing to a single fabricated stub.
    expect(contract).not.toContain("query: z.string().min(1)");
    expect(contract).not.toContain("payload.query");
    expect(contract).toContain("/checkout/create-order");
    expect(contract).toContain("/shipping");
    expect(contract).toContain("/billing");
    expect(contract).toContain("/payment");
    expect(contract).toContain("/review");
    expect(contract).toContain("/place-order");

    // Stronger than the string checks above: eval-and-run the emitter's OWN
    // executeHttp body (recon-generate-multistep-e2e.test.ts's harness
    // pattern) against a mocked fetch, proving the 10-call sequence actually
    // EXECUTES end to end rather than merely containing the right substrings.
    // The mocked create-order response mints an orderId that DIFFERS from
    // the captured "order-42" — if the generator had hardcoded the captured
    // literal instead of threading `orderId` from the real response, every
    // subsequent call's URL would still show "order-42" and this would fail.
    const mintedOrderId = "sess-live-501";
    const responseBodies = [
      { orderId: mintedOrderId },
      { section: "shipping", orderId: mintedOrderId, saved: true },
      { section: "billing", orderId: mintedOrderId, saved: true },
      { section: "payment", orderId: mintedOrderId, saved: true },
      { section: "review", orderId: mintedOrderId, saved: true },
      { section: "shipping", orderId: mintedOrderId, saved: true },
      { section: "billing", orderId: mintedOrderId, saved: true },
      { section: "payment", orderId: mintedOrderId, saved: true },
      { section: "review", orderId: mintedOrderId, saved: true },
      { orderId: mintedOrderId, status: "placed" },
    ];
    const fetchMock = vi.fn();
    for (const body of responseBodies) {
      fetchMock.mockResolvedValueOnce({
        status: 200,
        ok: true,
        text: vi.fn().mockResolvedValue(JSON.stringify(body)),
        headers: new Headers(),
      });
    }
    vi.stubGlobal("fetch", fetchMock);

    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);
    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });
    const executeHttp = evalExecuteHttpBody(executeHttpBody, httpClient, z);

    const result2 = await executeHttp({
      BaseUrl: "https://api.example.com",
      line1: "1 Main St",
      city: "Springfield",
      cardLast4: "4242",
      method: "card",
      accepted: true,
      confirmed: true,
      saveCard: true,
      confirm: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(10);
    const requestedUrls = fetchMock.mock.calls.map((call) => call[0] as string);
    expect(requestedUrls[0]).toBe("https://api.example.com/checkout/create-order");
    for (const url of requestedUrls.slice(1)) {
      expect(url).toContain(`/checkout/${mintedOrderId}/`);
      expect(url).not.toContain("order-42");
    }
    expect(requestedUrls[requestedUrls.length - 1]).toBe(
      `https://api.example.com/checkout/${mintedOrderId}/place-order`
    );
    expect(result2.data).toEqual({ section: "review", orderId: mintedOrderId, saved: true });

    vi.unstubAllGlobals();
  }, 30_000);
});
