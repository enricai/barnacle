import * as fs from "node:fs";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

describe("file store owner/renew/read safety", () => {
  it("surfaces a truncated entry as unknown and claim followers terminate", () => {
    const dir = mk();
    const s = createFileIdempotencyStore(dir);
    s.set("k", { state: "success", value: 1 }, 1000);
    writeFileSync(resolveIdempotencyEntryPath(dir, "k"), '{"record":');
    expect(s.get("k")?.state).toBe("unknown");
    expect(s.claim?.("k", 1000, "a")).toBe(false);
  });

  it("renew extends only the owner's live pending claim", () => {
    vi.useFakeTimers();
    const s = createFileIdempotencyStore(mk());
    expect(s.claim?.("k", 100, "a")).toBe(true);
    expect(s.renew?.("k", "b", 1000)).toBe(false);
    vi.advanceTimersByTime(90);
    expect(s.renew?.("k", "a", 1000)).toBe(true);
    vi.advanceTimersByTime(500);
    expect(s.get("k")).toEqual({ state: "pending", owner: "a" });
    s.set("k", { state: "success", value: 1 }, 1000);
    expect(s.renew?.("k", "a", 1000)).toBe(false);
  });

  it("uses distinct temp files for concurrent sets", () => {
    const dir = mk();
    const s = createFileIdempotencyStore(dir);
    const names: string[] = [];
    const orig = fs.renameSync;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((a, b) => {
      names.push(String(a));
      return orig(a, b);
    });
    s.set("k", { state: "pending" }, 1000);
    s.set("k", { state: "pending" }, 1000);
    spy.mockRestore();
    expect(new Set(names).size).toBe(2);
  });
});
