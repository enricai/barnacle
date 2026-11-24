import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFileIdempotencyStore } from "@/cache/idempotency-guard";
import { resolveIdempotencyEntryPath } from "@/lib/telemetry/telemetry-paths";

const dirs: string[] = [];
const mk = () => {
  const d = mkdtempSync(join(tmpdir(), "idem-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("createFileIdempotencyStore", () => {
  it("persists across instances, deletes, and misses", () => {
    const dir = join(mk(), "nested");
    const a = createFileIdempotencyStore(dir);
    expect(a.get("k")).toBeUndefined();
    a.set("k", { state: "success", value: 1 }, 1000);
    expect(createFileIdempotencyStore(dir).get("k")).toEqual({ state: "success", value: 1 });
    expect(readdirSync(dir).every((f) => f.endsWith(".json"))).toBe(true);
    a.delete("k");
    expect(a.get("k")).toBeUndefined();
  });

  it("expires entries and removes the file", () => {
    vi.useFakeTimers();
    const dir = mk();
    const s = createFileIdempotencyStore(dir);
    s.set("k", { state: "unknown", message: "m" }, 10);
    vi.advanceTimersByTime(11);
    expect(s.get("k")).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("derives a stable filesystem-safe path", () => {
    const p = resolveIdempotencyEntryPath("/d", "a/../b");
    expect(p).toMatch(/^\/d\/[0-9a-f]{64}\.json$/);
    expect(resolveIdempotencyEntryPath("/d", "a/../b")).toBe(p);
  });
});
