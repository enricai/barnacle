import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { UnknownOutcomeError } from "@/api/errors";

import { config } from "@/config";
import { resolveIdempotencyEntryPath } from "@/lib/telemetry/telemetry-paths";
import type { PluginIdempotency } from "@/site-plugin";

/**
 * Duplicate-submission guard for write plugins.
 *
 * A key derived from siteId + the plugin's declared `keyFields` identifies one
 * logical operation. Concurrent duplicates join the in-flight run, a recent
 * success is replayed, a failed run is not recorded (a genuine retry runs),
 * and a failure classified `unknown` leaves an unknown-outcome entry so a
 * duplicate gets a typed conflict instead of re-running a possibly-completed
 * irreversible step.
 */

export type IdempotencyRecord =
  | { state: "success"; value: unknown }
  | { state: "unknown"; message: string };

/** Minimal store contract; swap in a durable implementation as needed. */
export interface IdempotencyStore {
  get(key: string): IdempotencyRecord | undefined | Promise<IdempotencyRecord | undefined>;
  set(key: string, record: IdempotencyRecord, ttlMs: number): void | Promise<void>;
  delete(key: string): void | Promise<void>;
}

export function createInMemoryIdempotencyStore(): IdempotencyStore {
  const entries = new Map<string, { record: IdempotencyRecord; expiresAt: number }>();
  return {
    get(key) {
      const e = entries.get(key);
      if (!e) return undefined;
      if (e.expiresAt <= Date.now()) {
        entries.delete(key);
        return undefined;
      }
      return e.record;
    },
    set(key, record, ttlMs) {
      entries.set(key, { record, expiresAt: Date.now() + ttlMs });
    },
    delete(key) {
      entries.delete(key);
    },
  };
}

/** Durable store: one JSON file per key under `dir`; survives restarts. */
export function createFileIdempotencyStore(dir: string): IdempotencyStore {
  return {
    get(key) {
      const path = resolveIdempotencyEntryPath(dir, key);
      try {
        const e = JSON.parse(readFileSync(path, "utf8")) as {
          record: IdempotencyRecord;
          expiresAt: number;
        };
        if (e.expiresAt <= Date.now()) {
          rmSync(path, { force: true });
          return undefined;
        }
        return e.record;
      } catch {
        return undefined;
      }
    },
    set(key, record, ttlMs) {
      const path = resolveIdempotencyEntryPath(dir, key);
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ record, expiresAt: Date.now() + ttlMs }));
      renameSync(tmp, path);
    },
    delete(key) {
      rmSync(resolveIdempotencyEntryPath(dir, key), { force: true });
    },
  };
}

/** Durable store when telemetry persistence is configured, else in-memory. */
export function createConfiguredIdempotencyStore(): IdempotencyStore {
  const dir = config.telemetry.idempotencyDir;
  return dir ? createFileIdempotencyStore(dir) : createInMemoryIdempotencyStore();
}

export const DEFAULT_IDEMPOTENCY_TTL_MS = 6 * 60 * 60 * 1000;

/** Default success predicate: the run completed and did not ask for more user info. */
export function defaultIsSuccess(data: unknown): boolean {
  if (data !== null && typeof data === "object") {
    return (data as { needsUserInfo?: unknown }).needsUserInfo !== true;
  }
  return true;
}

/**
 * Derives the dedupe key, or `null` (no dedupe) when there are no key fields
 * or any declared field is missing/blank in the body.
 */
export function deriveIdempotencyKey(
  siteId: string,
  keyFields: readonly string[],
  body: unknown
): string | null {
  if (keyFields.length === 0 || body === null || typeof body !== "object") return null;
  const parts: string[] = [];
  for (const field of keyFields) {
    const v = (body as Record<string, unknown>)[field];
    if (typeof v === "string") {
      const t = v.trim();
      if (!t) return null;
      parts.push(t);
    } else if (typeof v === "number" || typeof v === "boolean") {
      parts.push(String(v));
    } else {
      return null;
    }
  }
  return JSON.stringify([siteId, ...parts]);
}

export interface IdempotencyGuardOptions {
  store?: IdempotencyStore;
  ttlMs?: number;
}

export interface IdempotencyGuard {
  run<T>(
    siteId: string,
    config: PluginIdempotency | undefined,
    body: unknown,
    execute: () => Promise<T>
  ): Promise<T>;
}

export function createIdempotencyGuard(options: IdempotencyGuardOptions = {}): IdempotencyGuard {
  const store = options.store ?? createConfiguredIdempotencyStore();
  const ttlMs = options.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
  const inFlight = new Map<string, Promise<unknown>>();

  function replay(record: IdempotencyRecord): unknown {
    if (record.state === "unknown") throw new UnknownOutcomeError(record.message);
    return record.value;
  }

  async function execAndRecord<T>(
    key: string,
    config: PluginIdempotency,
    execute: () => Promise<T>
  ): Promise<T> {
    const isSuccess = config.isSuccess ?? defaultIsSuccess;
    try {
      const value = await execute();
      if (isSuccess(value)) await store.set(key, { state: "success", value }, ttlMs);
      return value;
    } catch (err) {
      if (config.classifyFailure?.(err) === "unknown") {
        await store.set(
          key,
          {
            state: "unknown",
            message: `previous run ended with an unknown outcome: ${err instanceof Error ? err.message : String(err)}`,
          },
          ttlMs
        );
      }
      throw err;
    }
  }

  function run<T>(
    siteId: string,
    config: PluginIdempotency | undefined,
    body: unknown,
    execute: () => Promise<T>
  ): Promise<T> {
    if (!config) return execute();
    const key = deriveIdempotencyKey(siteId, config.keyFields, body);
    if (key === null) return execute();

    const existing = inFlight.get(key);
    if (existing) return existing as Promise<T>;

    // Registered synchronously (no await before inFlight.set) so concurrent
    // duplicates always find it; the store lookup happens inside the promise.
    const promise = (async () => {
      const recorded = await store.get(key);
      if (recorded) return replay(recorded) as T;
      return execAndRecord(key, config, execute);
    })().finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  }

  return { run };
}
