/**
 * Regression test for the parent/child run-dir agreement bug: the parent
 * used to diff the legacy process-global `/tmp/recon/graphql` while the
 * child (spawned without RECON_RUN_ID) resolved its own run-scoped
 * `graphqlDir`, so the before/after capture diff always saw an empty
 * directory and every verdict reported false negatives. Pins that the
 * parent resolves one run dir, passes its runId to the child via
 * RECON_RUN_ID, and reads captures back from that same run's graphqlDir.
 */

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/config", () => ({
  config: {
    scraper: {
      useBedrock: false,
      anthropicApiKey: "test-key",
      model: "anthropic/claude-sonnet-4-6",
      proxyType: "residential",
      steelSessionTimeoutMs: 30000,
    },
    telemetry: {
      callsNdjsonPath: ".barnacle/calls.ndjson",
    },
  },
}));
vi.mock("@/lib/http", () => ({ configureHttpDispatcher: vi.fn() }));
vi.mock("@/scraper/session", () => ({ createBrowserSession: vi.fn() }));
vi.mock("@/scraper/errors", () => ({
  StepVerificationError: class StepVerificationError extends Error {},
}));
vi.mock("@/testmail/client", () => ({
  allocateTestmailInbox: vi.fn(),
  pollTestmailInbox: vi.fn(),
}));

const { loggerStub } = vi.hoisted(() => ({
  loggerStub: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    errorWithStack: vi.fn(),
  },
}));
vi.mock("@/lib/logging", () => ({
  getLogger: () => loggerStub,
  getScriptLogger: () => loggerStub,
}));

vi.mock("@/lib/telemetry/call-capture", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/telemetry/call-capture")>();
  return {
    ...actual,
    captureLlmCall: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

describe("recon-replay-jobs — run-scoped capture dir", () => {
  let outRoot: string;

  beforeEach(() => {
    outRoot = mkdtempSync(join(tmpdir(), "recon-replay-jobs-"));
    process.env.RECON_OUT_DIR = outRoot;
    process.env.RECON_RUN_ID = "20260719-100000-test";
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(outRoot, { recursive: true, force: true });
    delete process.env.RECON_OUT_DIR;
    delete process.env.RECON_RUN_ID;
    vi.restoreAllMocks();
  });

  it("readJobOutcome sees a capture written under <runDir>/graphql, not the legacy /tmp/recon/graphql", async () => {
    const { resolveReconRunDir } = await import("@/scripts/recon-shared.js");
    const { readJobOutcome } = await import("@/scripts/recon-replay-jobs.js");

    const runDir = resolveReconRunDir();
    expect(runDir.root).toBe(join(outRoot, "20260719-100000-test"));

    const capturesBefore = new Set<string>();
    mkdirSync(runDir.graphqlDir, { recursive: true });
    writeFileSync(
      join(runDir.graphqlDir, "000-apply-submit.json"),
      JSON.stringify({
        url: "https://example.com/api/jobs/123/integrated_apply",
        status: 200,
        responseBody: { ok: true },
      })
    );

    const outcome = readJobOutcome(capturesBefore, runDir.graphqlDir, []);
    expect(outcome.integratedApply200).toBe(true);
    expect(outcome.serverRejected).toBe(false);
  });

  describe("readJobOutcome — terminalUrl from flow-configured successUrlFragments", () => {
    const writeCapture = async (url: string): Promise<{ graphqlDir: string }> => {
      const { resolveReconRunDir } = await import("@/scripts/recon-shared.js");
      const runDir = resolveReconRunDir();
      mkdirSync(runDir.graphqlDir, { recursive: true });
      writeFileSync(
        join(runDir.graphqlDir, "001-terminal.json"),
        JSON.stringify({ url, status: 200, responseBody: { ok: true } })
      );
      return { graphqlDir: runDir.graphqlDir };
    };

    it("sets terminalUrl when a capture URL contains a configured fragment", async () => {
      const { readJobOutcome } = await import("@/scripts/recon-replay-jobs.js");
      const url = "https://apply.acme.example/jobs/1/apply-portal/applied";
      const { graphqlDir } = await writeCapture(url);

      const outcome = readJobOutcome(new Set<string>(), graphqlDir, [
        "/apply-portal/applied",
        "/apply/confirmation",
      ]);
      expect(outcome.terminalUrl).toBe(url);
    });

    it("leaves terminalUrl null when no fragment is configured", async () => {
      const { readJobOutcome } = await import("@/scripts/recon-replay-jobs.js");
      const { graphqlDir } = await writeCapture(
        "https://apply.acme.example/jobs/1/apply-portal/applied"
      );

      const outcome = readJobOutcome(new Set<string>(), graphqlDir, []);
      expect(outcome.terminalUrl).toBeNull();
    });

    it("leaves terminalUrl null when no capture matches any configured fragment", async () => {
      const { readJobOutcome } = await import("@/scripts/recon-replay-jobs.js");
      const { graphqlDir } = await writeCapture("https://apply.acme.example/jobs/1/still-editing");

      const outcome = readJobOutcome(new Set<string>(), graphqlDir, ["/apply-portal/applied"]);
      expect(outcome.terminalUrl).toBeNull();
    });

    it("treats fragments as literal substrings, not regexes", async () => {
      const { readJobOutcome } = await import("@/scripts/recon-replay-jobs.js");
      // `.` in a fragment must NOT match an arbitrary character the way a regex would.
      const { graphqlDir } = await writeCapture("https://apply.acme.example/jobs/1/aXapplied");

      const outcome = readJobOutcome(new Set<string>(), graphqlDir, ["a.applied"]);
      expect(outcome.terminalUrl).toBeNull();
    });
  });

  it("passes RECON_RUN_ID equal to the parent's resolved runId in the child's spawn env", async () => {
    const spawnMock = vi.mocked(spawn);
    const fakeChild = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => fakeChild.emit("exit", 0));
      return fakeChild as never;
    });

    const { resolveReconRunDir } = await import("@/scripts/recon-shared.js");
    const { runReconForJob } = await import("@/scripts/recon-replay-jobs.js");

    const runDir = resolveReconRunDir();
    // Deliberately distinct from process.env.RECON_RUN_ID (the ambient value
    // resolveReconRunDir() picked up) so the assertion below can only pass if
    // runReconForJob actually threads its `runId` param into the child's env
    // — not because it leaked in via `{ ...process.env }`.
    const explicitRunId = `${runDir.runId}-explicit`;
    await runReconForJob(
      "https://example.com/job/123",
      join(outRoot, "flow.json"),
      "someone@inbox.testmail.app",
      explicitRunId,
      runDir.graphqlDir
    );

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, , spawnOptions] = spawnMock.mock.calls[0]!;
    const env = (spawnOptions as { env?: Record<string, string | undefined> }).env;
    expect(env?.RECON_RUN_ID).toBe(explicitRunId);
    expect(env?.RECON_EMAIL).toBe("someone@inbox.testmail.app");
  });
});
