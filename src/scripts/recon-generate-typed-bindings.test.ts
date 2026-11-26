import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * A flow-file payload binding may declare a wire type (`number`) and a
 * transform (`utc-instant`) that the emitted accessor applies while the public
 * input stays a string; a structured input whose every occurrence is rebound
 * is no longer registered. Generic made-up venue-booking fixture.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");
const HOST = "www.typed-bindings-fixture.example.test";

const BODY = {
  order: { items_attributes: [{ roomId: 9, reservedTo: "2026-12-15T19:30:00Z", count: 2 }] },
};

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

function generate(steps: unknown[], tag: string): string {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-typed-bindings-"));
  const runRoot = join(workDir, "run");
  for (const dir of ["graphql", "replays", "aux"])
    mkdirSync(join(runRoot, dir), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
  const captures = [
    buildCapture({
      url: `https://${HOST}/cart.json`,
      requestPostData: JSON.stringify({ cartId: "cart-seed-1" }),
      responseBody: { cartId: "cart-1" },
      timestamp: "2026-06-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${HOST}/order.json`,
      requestPostData: JSON.stringify(BODY),
      responseBody: { ok: true },
      timestamp: "2026-06-01T00:00:01.000Z",
    }),
  ];
  captures.forEach((capture, index) => {
    writeFileSync(
      join(runRoot, "graphql", `${String(index).padStart(3, "0")}-capture.json`),
      JSON.stringify(capture)
    );
  });
  const siteId = `typed-bindings-${tag}-${process.pid}`;
  siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps,
      submitEndpointPattern: "/order.json",
      httpSteps: {
        actions: 2,
        tailFromStep: steps.length,
        handoverUrl: `https://${HOST}/order/edit`,
      },
      requireSubmitEndpointMatch: true,
    })
  );
  const result = spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: RECON_GENERATE_CWD, encoding: "utf8" }
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return readFileSync(join(siteOutDir, "contract.ts"), "utf8");
}

const declared = (extra: Record<string, unknown> = {}) => [
  { step: "choose room '9'", payloadField: "roomId", ...(extra.room as object) },
  {
    step: "choose time '2026-12-15T19:30:00Z'",
    payloadField: "reservedTo",
    ...(extra.time as object),
  },
  { step: "choose party size '2'", payloadField: "count", ...(extra.count as object) },
  { step: "open the cart page" },
  { step: "submit order", submitStep: true },
];

describe("typed payload bindings", () => {
  it("applies declared wire type and transform; schema stays string; rebound input dropped", () => {
    const contract = generate(
      declared({
        room: { payloadWire: "number" },
        time: { payloadTransform: "utc-instant" },
        count: { payloadWire: "number" },
      }),
      "typed"
    );
    expect(contract).toMatch(/"roomId":\$\{JSON\.stringify\(Number\(payload\.roomId\)\)\}/);
    expect(contract).toMatch(/"count":\$\{JSON\.stringify\(Number\(payload\.count\)\)\}/);
    expect(contract).toContain("new Date(String(payload.reservedTo)).toISOString().replace(");
    expect(contract).toMatch(/roomId: z\.string\(\)/);
    expect(contract).not.toMatch(/\border: z\./);
    expect(contract).not.toContain("payload.order");
  });

  it("keeps the structured input registered when an occurrence is not rebound", () => {
    const contract = generate(
      [
        { step: "choose room '9'", payloadField: "roomId", payloadWire: "number" },
        { step: "open the cart page" },
        { step: "submit order", submitStep: true },
      ],
      "partial"
    );
    expect(contract).toMatch(/\border: z\./);
  });

  it("leaves output unchanged without declarations", () => {
    const contract = generate(declared(), "plain");
    expect(contract).not.toContain("Number(payload.");
    expect(contract).not.toContain("toISOString");
  });
});
