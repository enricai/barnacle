import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Reproduces the reported "value-coincidence-threading" defect in
 * `interpolateStateValues`: naive `result.split(value).join(replacement)`,
 * unanchored and re-scanning the progressively-mutated result, lets a
 * coincidentally-matching short state value get spliced into an unrelated
 * opaque path segment (e.g. `warehouse42` for a `pageSize` value of `42`),
 * and lets a later, shorter value's search text match inside an earlier
 * substitution's own freshly-inserted `${...}` text (e.g. a `record.Id`
 * accessor containing `Id` gets its own `Id` suffix re-matched by a separate
 * `Id`-valued binding), producing an invalid nested placeholder.
 */
function emitConsumerUrl(): string {
  const producer = {
    capture: buildCapture({
      url: "https://api.example.com/session/start",
      requestPostData: null,
      responseBody: { id: "LONGVALUEID12", short: "Id", count: "42" },
      timestamp: "2026-01-01T00:00:00Z",
    }),
    varName: "r0",
    produces: [
      { kind: "body" as const, name: "record.Id", path: ["id"] },
      { kind: "body" as const, name: "shortIdVar", path: ["short"] },
      { kind: "body" as const, name: "pageSize", path: ["count"] },
    ],
    isMultipart: false,
    isCrossDomain: false,
  };
  const consumer = {
    capture: buildCapture({
      url: "https://api.example.com/report/LONGVALUEID12/entity/Id/warehouse42/items/42/summary",
      requestPostData: null,
      responseBody: {},
      timestamp: "2026-01-01T00:00:01Z",
    }),
    varName: "r1",
    produces: [],
    isMultipart: false,
    isCrossDomain: false,
  };

  const body = emitMultiStepExecuteHttp(
    [producer, consumer] as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
    null,
    { stringMessageKey: null, nestedErrorPaths: [] },
    new Map(),
    new Set(),
    new Map(),
    new Set(),
    new Map(),
    new Map(),
    "https://api.example.com",
    new Map(),
    new Map()
  );

  const match = /httpClient\(`([^`]*report[^`]*)`/.exec(body);
  if (!match) throw new Error("consumer url not found in emitted code");
  return match[1]!;
}

describe("interpolateStateValues — anchored, single-pass substitution", () => {
  it("never splices a coincidentally-matching value into an unrelated literal segment", () => {
    const url = emitConsumerUrl();

    expect(url).toContain("warehouse42");
    expect(url).not.toMatch(/warehouse\$\{pageSize\}/);
  });

  it("never produces a nested placeholder from a later shorter value matching inside an earlier substitution", () => {
    const url = emitConsumerUrl();

    expect(url).not.toMatch(/\$\{[^}]*\$\{/);
  });

  it("still correctly interpolates a legitimate, boundary-safe standalone occurrence", () => {
    const url = emitConsumerUrl();

    expect(url).toContain("${record.Id}");
    expect(url).toContain("${shortIdVar}");
    expect(url).toContain("${pageSize}");
  });
});
