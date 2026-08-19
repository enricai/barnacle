import { describe, expect, it } from "vitest";

import { CdpTransportClosedError } from "@/scraper/errors";
import type { StagehandLogLine } from "@/scraper/session-browserbase";
import { createSessionTeardownDetector, raceAgainstTeardown } from "@/scraper/session-teardown";

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
