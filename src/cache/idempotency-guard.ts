import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { UnknownOutcomeError } from "@/api/errors";

import { config } from "@/config";
import { redactPii } from "@/lib/pii-redaction";
import { resolveIdempotencyEntryPath } from "@/lib/telemetry/telemetry-paths";
import { isTaskDeadlineError } from "@/scraper/errors";
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
          message: `idempotency entry could not be read: ${redactPii(err instanceof Error ? err.message : String(err))}`,
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

/** One chain per key for the whole process: stores wrapping one backing dir are distinct objects. */
const writeChains = new Map<string, Promise<void>>();

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
    // The engine's deadline error means the task may still be running: always unknown.
    if (isTaskDeadlineError(err) || isTaskDeadlineError(original)) return true;
    if (original !== undefined && config.classifyFailure?.(original) === "unknown") return true;
    return config.classifyFailure?.(err) === "unknown";
  }

  // A plugin that refuses must see errors the guard raises (e.g. store
  // failures) so they cannot read as retry-safe.
  async function refuse(config: PluginIdempotency, err: unknown): Promise<unknown> {
    return config.refusalFor ? await config.refusalFor(err) : err;
  }

  function replay(record: IdempotencyRecord): unknown {
    if (record.state === "unknown") throw new UnknownOutcomeError(record.message);
    if (record.state === "success") return record.value;
    throw new Error("unexpected idempotency record state");
  }

  const msgOf = (err: unknown) => redactPii(err instanceof Error ? err.message : String(err));
  const warn = (state: string, err: unknown) =>
    process.stderr.write(`idempotency: failed to record ${state} outcome: ${msgOf(err)}\n`);

  /**
   * Settled writes to one key are serialized per key across every guard and store in
   * this process, so an `unknown` write can neither be issued from a stale read
   * nor land after a success. Across processes the store contract has no
   * compare-and-set, so only the leased claim protects that case.
   */
  function serialized(key: string, fn: () => Promise<void>): Promise<void> {
    const chains = writeChains;
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    chains.set(key, next);
    const cleanup = () => {
      if (chains.get(key) === next) chains.delete(key);
    };
    void next.then(cleanup, cleanup);
    return next;
  }

  /** Writes a settled record unless the key already holds a success. */
  function setUnlessSuccess(key: string, record: IdempotencyRecord): Promise<void> {
    return serialized(key, async () => {
      if ((await store.get(key))?.state === "success") return;
      await store.set(key, record, ttlMs);
    });
  }

  function setSuccess(key: string, record: IdempotencyRecord): Promise<void> {
    return serialized(key, () => Promise.resolve(store.set(key, record, ttlMs)));
  }
  async function execAndRecord<T>(
    key: string,
    config: PluginIdempotency,
    execute: () => Promise<T>,
    owner?: string
  ): Promise<T> {
    const isSuccess = config.isSuccess ?? defaultIsSuccess;
    const leased = owner !== undefined;
    const leaseTtl = Math.min(LEASE_MS, ttlMs);
    const renewUntil = Date.now() + ttlMs;
    let timer: ReturnType<typeof setInterval> | undefined;
    if (leased && store.renew) {
      const renew = store.renew.bind(store);
      timer = setInterval(
        () => {
          if (Date.now() >= renewUntil) {
            if (timer) clearInterval(timer);
            timer = undefined;
            return;
          }
          Promise.resolve()
            .then(() => renew(key, owner, leaseTtl))
            .catch(() => undefined);
        },
        Math.max(1, Math.floor(leaseTtl / 3))
      );
      timer.unref?.();
    }
    // Releases only this run's own pending claim, never a new owner's.
    const release = async () => {
      try {
        const cur = await store.get(key);
        if (cur?.state === "pending" && (cur.owner === undefined || cur.owner === owner)) {
          await store.delete(key);
        }
      } catch {
        // ignore
      }
    };
    try {
      const value = await execute();
      if (timer) clearInterval(timer);
      timer = undefined;
      if (isSuccess(value)) {
        try {
          const rec: IdempotencyRecord = { state: "success", value };
          await setSuccess(key, rec);
        } catch (e) {
          warn("success", e);
        }
      } else if (leased) await release();
      return value;
    } catch (err) {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (classifyUnknown(config, err)) {
        try {
          await setUnlessSuccess(key, {
            state: "unknown",
            message: `previous run ended with an unknown outcome: ${msgOf(err)}`,
          });
        } catch (e) {
          warn("unknown", e);
        }
      } else if (leased) await release();
      throw err;
    } finally {
      if (timer) clearInterval(timer);
    }
  }

  /** Settles an async operation record; an existing success is never overwritten. */
  async function settleOp(
    k: string,
    config: PluginIdempotency,
    outcome: { ok: true; value: unknown } | { ok: false; err: unknown }
  ): Promise<void> {
    if (outcome.ok) {
      await setUnlessSuccess(
        k,
        (config.isSuccess ?? defaultIsSuccess)(outcome.value)
          ? { state: "success", value: outcome.value }
          : { state: "failed", message: "operation did not succeed" }
      );
      return;
    }
    const err = outcome.err;
    await setUnlessSuccess(
      k,
      err instanceof UnknownOutcomeError || classifyUnknown(config, err)
        ? { state: "unknown", message: msgOf(err) }
        : { state: "failed", message: msgOf(err) }
    );
  }

  /** Runs execute; a failed async operation is reopened as pending for the duration. */
  async function execReopening<T>(
    siteId: string,
    key: string,
    config: PluginIdempotency,
    exec: () => Promise<T>,
    mapError: (err: unknown) => Promise<unknown>
  ): Promise<T> {
    const k = opKey(siteId, deriveOperationId(key));
    let reopened = false;
    try {
      if (!activeOps.has(k)) {
        const op = await store.get(k);
        if (op?.state === "failed") {
          await store.set(k, { state: "pending" }, ttlMs);
          activeOps.add(k);
          reopened = true;
        }
      }
    } catch {
      // best effort
    }
    if (!reopened) return exec();
    try {
      const value = await exec();
      await settleOp(k, config, { ok: true, value }).catch((e) => warn("operation", e));
      return value;
    } catch (err) {
      let mapped: unknown;
      try {
        mapped = await mapError(err);
      } catch (refusalError) {
        mapped = refusalError;
      }
      await settleOp(k, config, { ok: false, err: mapped }).catch((e) => warn("operation", e));
      throw mapped;
    } finally {
      activeOps.delete(k);
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
    const lockKey: string = key;
    const lockConfig: PluginIdempotency = config;
    let refusalApplied = false;
    async function mapError(err: unknown): Promise<unknown> {
      refusalApplied = true;
      return refuse(lockConfig, err);
    }
    const promise = (async () => {
      try {
        return await runLocked();
      } catch (err) {
        throw refusalApplied ? err : await mapError(err);
      }
    })().finally(() => {
      inFlight.delete(key);
    });
    async function runLocked(): Promise<T> {
      for (;;) {
        const recorded = await store.get(lockKey);
        if (recorded && recorded.state !== "pending") return replay(recorded) as T;
        if (!store.claim) {
          if (recorded) throw new Error("unexpected idempotency record state");
          return execReopening(
            siteId,
            lockKey,
            lockConfig,
            () => execAndRecord(lockKey, lockConfig, execute),
            mapError
          );
        }
        const owner = randomUUID();
        if (!recorded && (await store.claim(lockKey, Math.min(LEASE_MS, ttlMs), owner))) {
          return execReopening(
            siteId,
            lockKey,
            lockConfig,
            () => execAndRecord(lockKey, lockConfig, execute, owner),
            mapError
          );
        }
        // Another process holds the lease: wait for its outcome.
        await new Promise((r) => setTimeout(r, LEASE_POLL_MS));
      }
    }
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
      throw await refuse(config, err);
    }
    void run(siteId, config, body, execute)
      .then(
        (value) => settleOp(k, config, { ok: true, value }),
        (err) => settleOp(k, config, { ok: false, err })
      )
      .catch((e) => warn("operation", e))
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
