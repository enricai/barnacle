/**
 * Unit tests for the submission-envelope NDJSON sink. All tests write to a
 * temp directory so no real `.barnacle/` directory is touched.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/config", () => ({
  config: {
    telemetry: {
      submissionsNdjsonPath: ".barnacle/submissions.ndjson",
      s3: {
        bucket: undefined,
      },
    },
  },
}));

vi.mock("@/lib/logging", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    errorWithStack: vi.fn(),
  }),
}));

import {
  captureSubmissionEnvelope,
  type SubmissionEnvelopeSample,
  submissionEnvelopeSampleSchema,
} from "@/lib/telemetry/submission-capture";

function makeSuccessInput(): Parameters<typeof captureSubmissionEnvelope>[0] {
  return {
    siteId: "appcast",
    requestId: "req-abc-123",
    inboundPayload: { jobId: "56793094457", ClickUrl: "https://example.com/apply" },
    status: "submitted",
    auditPayload: { verified: true, applicationId: "app-xyz" },
    errorMessage: null,
    durationMs: 4321,
  };
}

function makeErrorInput(): Parameters<typeof captureSubmissionEnvelope>[0] {
  return {
    siteId: "appcast",
    requestId: "req-def-456",
    inboundPayload: { jobId: "99999999999" },
    status: "error",
    auditPayload: null,
    errorMessage: "HttpServerError: 503 from appcast",
    durationMs: 1234,
  };
}

let tmpDir: string;
let sinkPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "submission-capture-test-"));
  sinkPath = path.join(tmpDir, "submissions.ndjson");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("captureSubmissionEnvelope", () => {
  it("appends exactly one line per envelope", async () => {
    await captureSubmissionEnvelope(makeSuccessInput(), { sinkPath });

    const content = fs.readFileSync(sinkPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
  });

  it("appends two lines for two envelopes (success + error)", async () => {
    await captureSubmissionEnvelope(makeSuccessInput(), { sinkPath });
    await captureSubmissionEnvelope(makeErrorInput(), { sinkPath });

    const content = fs.readFileSync(sinkPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
  });

  it("each line is valid JSON that passes the Zod schema", async () => {
    await captureSubmissionEnvelope(makeSuccessInput(), { sinkPath });

    const line = fs.readFileSync(sinkPath, "utf-8").trim();
    const parsed = JSON.parse(line) as SubmissionEnvelopeSample;
    const result = submissionEnvelopeSampleSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it("preserves siteId, requestId, status, durationMs, and ts on success", async () => {
    const input = makeSuccessInput();
    await captureSubmissionEnvelope(input, { sinkPath });

    const line = fs.readFileSync(sinkPath, "utf-8").trim();
    const parsed = JSON.parse(line) as SubmissionEnvelopeSample;
    expect(parsed.siteId).toBe(input.siteId);
    expect(parsed.requestId).toBe(input.requestId);
    expect(parsed.status).toBe("submitted");
    expect(parsed.durationMs).toBe(input.durationMs);
    expect(parsed.errorMessage).toBeNull();
    expect(typeof parsed.ts).toBe("string");
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("preserves errorMessage and null auditPayload on error", async () => {
    const input = makeErrorInput();
    await captureSubmissionEnvelope(input, { sinkPath });

    const line = fs.readFileSync(sinkPath, "utf-8").trim();
    const parsed = JSON.parse(line) as SubmissionEnvelopeSample;
    expect(parsed.status).toBe("error");
    expect(parsed.errorMessage).toBe(input.errorMessage);
    expect(parsed.auditPayload).toBeNull();
  });

  it("preserves the inbound and audit payloads verbatim", async () => {
    const input = makeSuccessInput();
    await captureSubmissionEnvelope(input, { sinkPath });

    const line = fs.readFileSync(sinkPath, "utf-8").trim();
    const parsed = JSON.parse(line) as SubmissionEnvelopeSample;
    expect(parsed.inboundPayload).toEqual(input.inboundPayload);
    expect(parsed.auditPayload).toEqual(input.auditPayload);
  });

  it("line is terminated by a newline character", async () => {
    await captureSubmissionEnvelope(makeSuccessInput(), { sinkPath });

    const content = fs.readFileSync(sinkPath, "utf-8");
    expect(content.endsWith("\n")).toBe(true);
  });

  it("creates the sink directory if it does not exist", async () => {
    const nestedSink = path.join(tmpDir, "deep", "nested", "submissions.ndjson");
    await captureSubmissionEnvelope(makeSuccessInput(), { sinkPath: nestedSink });

    expect(fs.existsSync(nestedSink)).toBe(true);
  });
});
