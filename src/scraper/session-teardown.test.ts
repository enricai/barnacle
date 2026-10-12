import { describe, expect, it } from "vitest";

import { CdpTransportClosedError, SessionLifetimeExceededError } from "@/scraper/errors";
import type { StagehandLogLine } from "@/scraper/session-browserbase";
import {
  classifySessionTeardown,
  createDeathClassifier,
  createSessionTeardownDetector,
  raceAgainstTeardown,
  resolveSessionDeathError,
} from "@/scraper/session-teardown";

/** Flushes pending microtasks without relying on a timer. */
const flushMicrotasks = (): Promise<void> => Promise.resolve().then(() => undefined);

describe("session-teardown/createSessionTeardownDetector", () => {
  it("rejects the death signal synchronously (microtask, not timer) on Stagehand's verbatim teardown pair", async () => {
    const { watchLogLine, deathSignal } = createSessionTeardownDetector();
    let rejection: unknown;
    deathSignal.catch((err) => {
      rejection = err;
    });

    watchLogLine({
      level: 0,
      category: "stagehand:v3",
      message: "initiating shutdown → CDP transport closed: socket-close code=1006 reason=",
    } as StagehandLogLine);

    await flushMicrotasks();

    expect(rejection).toBeInstanceOf(CdpTransportClosedError);
  });

  it("rejects on the second message of the pair too", async () => {
    const { watchLogLine, deathSignal } = createSessionTeardownDetector();
    let rejection: unknown;
    deathSignal.catch((err) => {
      rejection = err;
    });

    watchLogLine({
      level: 0,
      category: "stagehand:v3",
      message: "closing resources → CDP transport closed: socket-close code=1006 reason=",
    } as StagehandLogLine);

    await flushMicrotasks();

    expect(rejection).toBeInstanceOf(CdpTransportClosedError);
  });

  it("never rejects on ordinary info/debug log lines", async () => {
    const { watchLogLine, deathSignal } = createSessionTeardownDetector();
    let rejected = false;
    deathSignal.catch(() => {
      rejected = true;
    });

    watchLogLine({
      level: 1,
      category: "stagehand:v3",
      message: "navigating to page",
    } as StagehandLogLine);
    watchLogLine({
      level: 2,
      category: "stagehand:v3",
      message: "observing candidates",
    } as StagehandLogLine);
    watchLogLine({
      level: 0,
      category: "stagehand:v3",
      message: "Browserbase session status: COMPLETED",
    } as StagehandLogLine);

    await flushMicrotasks();

    expect(rejected).toBe(false);
  });

  it("never rejects on a normal end-of-flow close with no teardown log line at all", async () => {
    const { deathSignal } = createSessionTeardownDetector();
    let rejected = false;
    deathSignal.catch(() => {
      rejected = true;
    });

    await flushMicrotasks();

    expect(rejected).toBe(false);
  });
});

describe("session-teardown/classifySessionTeardown", () => {
  it("classifies a teardown near the configured timeout as a timeout hit, with seconds and step count in the message", () => {
    const result = classifySessionTeardown({
      configuredTimeoutSeconds: 300,
      elapsedSeconds: 290,
      completedStepCount: 7,
    });

    expect(result.isTimeoutHit).toBe(true);
    expect(result.message).toContain("hit its timeout");
    expect(result.message).toContain("300s");
    expect(result.message).toContain("7 step(s)");
  });

  it("does not classify an early teardown as a timeout hit, and uses the generic mid-flow message instead", () => {
    const result = classifySessionTeardown({
      configuredTimeoutSeconds: 300,
      elapsedSeconds: 30,
      completedStepCount: 2,
    });

    expect(result.isTimeoutHit).toBe(false);
    expect(result.message).not.toContain("hit its timeout");
    expect(result.message).toContain("stagehand-initiated teardown mid-flow");
    expect(result.message).toContain("2 step(s)");
  });

  it("produces text that is observably distinct between the two classifications for the same step count", () => {
    const timeoutHit = classifySessionTeardown({
      configuredTimeoutSeconds: 300,
      elapsedSeconds: 295,
      completedStepCount: 5,
    });
    const generic = classifySessionTeardown({
      configuredTimeoutSeconds: 300,
      elapsedSeconds: 10,
      completedStepCount: 5,
    });

    expect(timeoutHit.message).not.toBe(generic.message);
  });

  it("treats an elapsed time exactly at the tolerance boundary as a timeout hit (inclusive lower bound)", () => {
    const result = classifySessionTeardown({
      configuredTimeoutSeconds: 300,
      elapsedSeconds: 285,
      completedStepCount: 0,
      toleranceSeconds: 15,
    });

    expect(result.isTimeoutHit).toBe(true);
  });

  it("respects a custom tolerance instead of the default", () => {
    const result = classifySessionTeardown({
      configuredTimeoutSeconds: 300,
      elapsedSeconds: 250,
      completedStepCount: 0,
      toleranceSeconds: 60,
    });

    expect(result.isTimeoutHit).toBe(true);
  });
});

describe("session-teardown/raceAgainstTeardown", () => {
  it("resolves with the step's value when the step settles before teardown fires", async () => {
    const { deathSignal } = createSessionTeardownDetector();

    const result = await raceAgainstTeardown(Promise.resolve("step-result"), deathSignal);

    expect(result).toBe("step-result");
  });

  it("rejects with CdpTransportClosedError when teardown fires before the step settles", async () => {
    const { watchLogLine, deathSignal } = createSessionTeardownDetector();
    const stepPromise = new Promise<string>(() => undefined);

    const racePromise = raceAgainstTeardown(stepPromise, deathSignal);
    racePromise.catch(() => undefined);

    watchLogLine({
      level: 0,
      category: "stagehand:v3",
      message: "initiating shutdown → CDP transport closed: socket-close code=1006 reason=",
    } as StagehandLogLine);

    await expect(racePromise).rejects.toBeInstanceOf(CdpTransportClosedError);
  });

  it("stays resolved with the step's value when teardown fires only after the flow already settled", async () => {
    const { watchLogLine, deathSignal } = createSessionTeardownDetector();

    const result = await raceAgainstTeardown(Promise.resolve("step-result"), deathSignal);
    expect(result).toBe("step-result");

    watchLogLine({
      level: 0,
      category: "stagehand:v3",
      message: "initiating shutdown → CDP transport closed: socket-close code=1006 reason=",
    } as StagehandLogLine);
    await flushMicrotasks();

    expect(result).toBe("step-result");
  });
});

describe("session-teardown/classified death", () => {
  const line = {
    level: 0,
    category: "stagehand:v3",
    message: "initiating shutdown → CDP transport closed: socket-close code=1006 reason=",
  } as StagehandLogLine;

  it("rejects and aborts with SessionLifetimeExceededError when the classifier reports a hit", async () => {
    const { watchLogLine, deathSignal, deathAbortSignal } = createSessionTeardownDetector({
      classifyDeath: () => ({ configuredTimeoutSeconds: 300, elapsedSeconds: 301.5 }),
    });
    watchLogLine(line);
    const err = await deathSignal.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionLifetimeExceededError);
    expect((err as Error).message).toContain("301.5s");
    expect((err as Error).message).toContain("300s");
    expect(deathAbortSignal.aborted).toBe(true);
    expect(deathAbortSignal.reason).toBe(err);
  });

  it("keeps CdpTransportClosedError when the classifier reports no hit", async () => {
    const { watchLogLine, deathSignal, deathAbortSignal } = createSessionTeardownDetector({
      classifyDeath: () => undefined,
    });
    watchLogLine(line);
    const err = await deathSignal.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CdpTransportClosedError);
    expect(deathAbortSignal.reason).toBe(err);
  });
});

describe("session-teardown/resolveSessionDeathError", () => {
  const original = new CdpTransportClosedError("x");

  it("returns SessionLifetimeExceededError when the session recorded a hit", () => {
    const out = resolveSessionDeathError(
      { getSessionTimeoutHit: () => ({ configuredTimeoutSeconds: 300, elapsedSeconds: 302 }) },
      original
    );
    expect(out).toBeInstanceOf(SessionLifetimeExceededError);
  });

  it("returns the same error when no hit", () => {
    expect(resolveSessionDeathError({ getSessionTimeoutHit: () => undefined }, original)).toBe(
      original
    );
  });

  it("is undefined-safe for Steel-shaped sessions", () => {
    expect(resolveSessionDeathError({}, original)).toBe(original);
    expect(resolveSessionDeathError(undefined, original)).toBe(original);
  });
});

describe("session-teardown/createDeathClassifier", () => {
  const base = {
    configuredTimeoutSeconds: 300,
    toleranceSeconds: 5,
    getCompletedStepCount: () => 2,
  };

  it("classifies a log-line death as lifetime with no transport-closed event", async () => {
    const classifyDeath = createDeathClassifier({
      ...base,
      isOwnClose: () => false,
      getElapsedSeconds: () => 299,
    });
    const { watchLogLine, deathSignal } = createSessionTeardownDetector({ classifyDeath });
    watchLogLine({
      level: 0,
      category: "stagehand:v3",
      message: "initiating shutdown → CDP transport closed: socket-close code=1006 reason=",
    } as StagehandLogLine);
    expect(await deathSignal.catch((e: unknown) => e)).toBeInstanceOf(SessionLifetimeExceededError);
  });

  it("never classifies our own close", () => {
    const classifyDeath = createDeathClassifier({
      ...base,
      isOwnClose: () => true,
      getElapsedSeconds: () => 400,
    });
    expect(classifyDeath()).toBeUndefined();
  });

  it("does not classify an early teardown", () => {
    const classifyDeath = createDeathClassifier({
      ...base,
      isOwnClose: () => false,
      getElapsedSeconds: () => 30,
    });
    expect(classifyDeath()).toBeUndefined();
  });
});
