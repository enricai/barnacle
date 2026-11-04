import { describe, it } from "vitest";
import fs from "node:fs";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";
const BASE = "https://api.example.com";
const BEACON_URL = `${BASE}/beacon/item-a/verify`;
function build(count: number): MulticallFixtureStep[] {
  const search = buildStep("r0", {
    url: `${BASE}/catalog/search/`, requestPostData: '{"page":1}',
    responseBody: { results: [{ sku: "item-a", tag: "g0" }] },
    timestamp: "2026-01-01T00:00:00Z",
  });
  const beacons = Array.from({ length: count }, (_, i) =>
    buildStep(`r${i + 1}`, {
      url: `${BEACON_URL}?clientId=abc123&siteId=xyz&nonce=${i}`,
      requestPostData: null, method: "GET", responseBody: {},
      timestamp: `2026-01-01T00:${String(i % 60).padStart(2, "0")}:00Z`,
    })
  );
  return [search, ...beacons];
}
function emit(actions: MulticallFixtureStep[]): string {
  return emitMultiStepExecuteHttp(
    actions as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
    null, { stringMessageKey: null, nestedErrorPaths: [] },
    new Map(), new Set(), new Map(), new Set(), new Map(), new Map(),
    BASE, new Map(), new Map()
  );
}
describe("probe", () => {
  it("ratio", () => {
    for (const trial of [1, 2, 3]) {
      emit(build(100));
      const a = build(200); const s1 = performance.now(); emit(a); const t1 = performance.now() - s1;
      const b = build(400); const s2 = performance.now(); emit(b); const t2 = performance.now() - s2;
      fs.appendFileSync("/tmp/probe4.txt", `trial${trial} t200=${t1.toFixed(0)} t400=${t2.toFixed(0)} ratio=${(t2/t1).toFixed(2)}\n`);
    }
  }, 300000);
});
