import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  | { state: "unknown"; message: string }
  | { state: "pending"; owner?: string }
  | { state: "failed"; message: string };

/** Poll view of an async operation. */
export type OperationStatus =
  | { status: "pending" }
  | { status: "succeeded"; value: unknown }
  | { status: "failed"; message: string }
  | { status: "unknown-outcome"; message: string };

/** Minimal store contract; swap in a durable implementation as needed. */
export interface IdempotencyStore {
  get(key: string): IdempotencyRecord | undefined | Promise<IdempotencyRecord | undefined>;
  set(key: string, record: IdempotencyRecord, ttlMs: number): void | Promise<void>;
  delete(key: string): void | Promise<void>;
  /**
   * Optional cross-process lease: atomically writes a `pending` record only if
   * no live record exists. Returns false when another holder owns the key.
   */
  claim?(key: string, ttlMs: number, owner?: string): boolean | Promise<boolean>;
  /**
   * Optional: extends the live `pending` claim held by `owner`. Returns false
   * when the record is missing, expired, settled, or owned by someone else.
   */
  renew?(key: string, owner: string, ttlMs: number): boolean | Promise<boolean>;
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
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        // Unreadable or corrupt entry: it exists, so it is not "never ran".
        return {
          state: "unknown",
          message: `idempotency entry could not be read: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
    set(key, record, ttlMs) {
      const path = resolveIdempotencyEntryPath(dir, key);
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(tmp, JSON.stringify({ record, expiresAt: Date.now() + ttlMs }));
      renameSync(tmp, path);
    },
    delete(key) {
      rmSync(resolveIdempotencyEntryPath(dir, key), { force: true });
    },
    renew(key, owner, ttlMs) {
      const path = resolveIdempotencyEntryPath(dir, key);
      let e: { record: IdempotencyRecord; expiresAt: number };
      try {
        e = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        return false;
      }
      if (e.record.state !== "pending" || e.record.owner !== owner) return false;
      if (e.expiresAt <= Date.now()) return false;
      const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(tmp, JSON.stringify({ record: e.record, expiresAt: Date.now() + ttlMs }));
      renameSync(tmp, path);
      return true;
    },
    claim(key, ttlMs, owner) {
      const path = resolveIdempotencyEntryPath(dir, key);
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.claim`;
      writeFileSync(
        tmp,
        JSON.stringify({
          record: owner === undefined ? { state: "pending" } : { state: "pending", owner },
          expiresAt: Date.now() + ttlMs,
        })
      );
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            linkSync(tmp, path); // atomic: fails if the entry exists
            return true;
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
            // get() evicts an expired entry; a live one means we lost the claim.
            if (this.get(key) !== undefined) return false;
          }
        }
        return false;
      } finally {
        rmSync(tmp, { force: true });
      }
    },
  };
}

/** Durable store when telemetry persistence is configured, else in-memory. */
export function createConfiguredIdempotencyStore(): IdempotencyStore {
  const dir = config.telemetry.idempotencyDir;
  return dir ? createFileIdempotencyStore(dir) : createInMemoryIdempotencyStore();
}

/** Lease on an in-progress run held in a shared store; a crashed holder frees it after this. */
const LEASE_MS = 5 * 60 * 1000;
const LEASE_POLL_MS = 25;

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
  /**
   * Starts the guarded run in the background and returns an operation id
   * derived from the idempotency key (retries get the same id), or `null`
   * when no key can be derived (caller should run synchronously).
   */
  start<T>(
    siteId: string,
    config: PluginIdempotency | undefined,
    body: unknown,
    execute: () => Promise<T>
  ): Promise<string | null>;
  /** Current state of an operation; `undefined` when unknown to the store. */
  status(siteId: string, operationId: string): Promise<OperationStatus | undefined>;
}

export function deriveOperationId(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

export function createIdempotencyGuard(options: IdempotencyGuardOptions = {}): IdempotencyGuard {
  const store = options.store ?? createConfiguredIdempotencyStore();
  const ttlMs = options.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
  const inFlight = new Map<string, Promise<unknown>>();

  const activeOps = new Set<string>();
  const opKey = (siteId: string, id: string) => `op:${siteId}:${id}`;

  // dispatch() rewrites plugin errors via toApiError and keeps the original
  // on `originalError`; the plugin's classifier must see what it threw.
  function classifyUnknown(config: PluginIdempotency, err: unknown): boolean {
    const original = (err as { originalError?: unknown } | null)?.originalError;
    if (original !== undefined && config.classifyFailure?.(original) === "unknown") return true;
    return config.classifyFailure?.(err) === "unknown";
  }

  function replay(record: IdempotencyRecord): unknown {
    if (record.state === "unknown") throw new UnknownOutcomeError(record.message);
    if (record.state === "success") return record.value;
    throw new Error("unexpected idempotency record state");
  }

  async function execAndRecord<T>(
    key: string,
    config: PluginIdempotency,
    execute: () => Promise<T>,
    leased = false
  ): Promise<T> {
    const isSuccess = config.isSuccess ?? defaultIsSuccess;
    try {
      const value = await execute();
      if (isSuccess(value)) await store.set(key, { state: "success", value }, ttlMs);
      else if (leased) await store.delete(key);
      return value;
    } catch (err) {
      if (classifyUnknown(config, err)) {
        await store.set(
          key,
          {
            state: "unknown",
            message: `previous run ended with an unknown outcome: ${err instanceof Error ? err.message : String(err)}`,
          },
          ttlMs
        );
      } else if (leased) {
        await Promise.resolve(store.delete(key)).catch(() => undefined);
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
      for (;;) {
        const recorded = await store.get(key);
        if (recorded && recorded.state !== "pending") return replay(recorded) as T;
        if (!store.claim) {
          if (recorded) throw new Error("unexpected idempotency record state");
          return execAndRecord(key, config, execute);
        }
        if (!recorded && (await store.claim(key, LEASE_MS))) {
          return execAndRecord(key, config, execute, true);
        }
        // Another process holds the lease: wait for its outcome.
        await new Promise((r) => setTimeout(r, LEASE_POLL_MS));
      }
    })().finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  }

  async function start<T>(
    siteId: string,
    config: PluginIdempotency | undefined,
    body: unknown,
    execute: () => Promise<T>
  ): Promise<string | null> {
    if (!config) return null;
    const key = deriveIdempotencyKey(siteId, config.keyFields, body);
    if (key === null) return null;
    const id = deriveOperationId(key);
    const k = opKey(siteId, id);
    // Registered synchronously so concurrent retries rediscover the operation.
    if (activeOps.has(k)) return id;
    activeOps.add(k);
    try {
      const existing = await store.get(k);
      // Success, unknown and interrupted-pending outcomes are never blindly
      // re-run; only a recorded plain failure ("safe to retry") may run again.
      if (existing && existing.state !== "failed") {
        activeOps.delete(k);
        return id;
      }
      await store.set(k, { state: "pending" }, ttlMs);
    } catch (err) {
      activeOps.delete(k);
      throw err;
    }
    void run(siteId, config, body, execute)
      .then(
        (value) =>
          (config.isSuccess ?? defaultIsSuccess)(value)
            ? store.set(k, { state: "success", value }, ttlMs)
            : store.set(k, { state: "failed", message: "operation did not succeed" }, ttlMs),
        (err) =>
          store.set(
            k,
            err instanceof UnknownOutcomeError || classifyUnknown(config, err)
              ? {
                  state: "unknown",
                  message: err instanceof Error ? err.message : String(err),
                }
              : {
                  state: "failed",
                  message: err instanceof Error ? err.message : String(err),
                },
            ttlMs
          )
      )
      .catch(() => undefined)
      .finally(() => activeOps.delete(k));
    return id;
  }

  async function status(siteId: string, id: string): Promise<OperationStatus | undefined> {
    const k = opKey(siteId, id);
    const rec = await store.get(k);
    if (!rec) return undefined;
    switch (rec.state) {
      case "pending":
        // Pending with no live run in this process means a restart cut it off.
        return activeOps.has(k)
          ? { status: "pending" }
          : {
              status: "unknown-outcome",
              message: "operation was interrupted by a restart",
            };
      case "success":
        return { status: "succeeded", value: rec.value };
      case "failed":
        return { status: "failed", message: rec.message };
      case "unknown":
        return { status: "unknown-outcome", message: rec.message };
    }
  }

  return { run, start, status };
}
