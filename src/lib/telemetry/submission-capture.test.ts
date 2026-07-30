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

vi.mock("@/lib/telemetry/s3-sink", () => ({
  bufferSubmissionLine: vi.fn(),
}));

import { bufferSubmissionLine } from "@/lib/telemetry/s3-sink";
import {
  captureSubmissionEnvelope,
  type SubmissionEnvelopeSample,
  submissionEnvelopeSampleSchema,
} from "@/lib/telemetry/submission-capture";

function makeSuccessInput(): Parameters<typeof captureSubmissionEnvelope>[0] {
  return {
    siteId: "ats-c",
    requestId: "req-abc-123",
    joinKeys: null,
    session: null,
    inboundPayload: { jobId: "56793094457", ClickUrl: "https://example.com/apply" },
    status: "submitted",
    auditPayload: { verified: true, applicationId: "app-xyz" },
    errorMessage: null,
    durationMs: 4321,
  };
}

function makeSuccessInputWithJoinKeys(): Parameters<typeof captureSubmissionEnvelope>[0] {
  return {
    ...makeSuccessInput(),
    joinKeys: { clickId: "v-9981", refId: "56793094457_jid-1" },
  };
}

function makeSuccessInputWithSession(): Parameters<typeof captureSubmissionEnvelope>[0] {
  return {
    ...makeSuccessInput(),
    session: {
      id: "sess-abc",
      provider: "browserbase",
      ip: "203.0.113.42",
      ipCapturedAt: "2026-07-26T10:00:01.000Z",
    },
  };
}

function makeErrorInput(): Parameters<typeof captureSubmissionEnvelope>[0] {
  return {
    siteId: "ats-c",
    requestId: "req-def-456",
    joinKeys: null,
    session: null,
    inboundPayload: { jobId: "99999999999" },
    status: "error",
    auditPayload: null,
    errorMessage: "HttpServerError: 503 from ats-c",
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

  it("forwards the exact serialized line to the S3 submission buffer", async () => {
    await captureSubmissionEnvelope(makeSuccessInput(), { sinkPath });

    const line = fs.readFileSync(sinkPath, "utf-8");
    expect(bufferSubmissionLine).toHaveBeenCalledTimes(1);
    expect(bufferSubmissionLine).toHaveBeenCalledWith(line);
  });

  it("writes joinKeys and kind:submit as top-level fields", async () => {
    const input = makeSuccessInputWithJoinKeys();
    await captureSubmissionEnvelope(input, { sinkPath });

    const line = fs.readFileSync(sinkPath, "utf-8").trim();
    const parsed = JSON.parse(line) as SubmissionEnvelopeSample;
    expect(parsed.joinKeys).toEqual(input.joinKeys);
    expect(parsed.siteId).toBe(input.siteId);
    expect(parsed.kind).toBe("submit");

    const result = submissionEnvelopeSampleSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it("writes a null joinKeys as an explicit top-level null, not omitted", async () => {
    await captureSubmissionEnvelope(makeSuccessInput(), { sinkPath });

    const line = fs.readFileSync(sinkPath, "utf-8").trim();
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect("joinKeys" in parsed).toBe(true);
    expect(parsed.joinKeys).toBeNull();
  });

  it("writes session as a top-level field", async () => {
    const input = makeSuccessInputWithSession();
    await captureSubmissionEnvelope(input, { sinkPath });

    const line = fs.readFileSync(sinkPath, "utf-8").trim();
    const parsed = JSON.parse(line) as SubmissionEnvelopeSample;
    expect(parsed.session).toEqual(input.session);

    const result = submissionEnvelopeSampleSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it("writes a null session as an explicit top-level null, not omitted", async () => {
    await captureSubmissionEnvelope(makeSuccessInput(), { sinkPath });

    const line = fs.readFileSync(sinkPath, "utf-8").trim();
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect("session" in parsed).toBe(true);
    expect(parsed.session).toBeNull();
  });

  it("submissionEnvelopeSampleSchema accepts a null session", () => {
    const line = {
      kind: "submit",
      siteId: "ats-c",
      requestId: "req-789",
      joinKeys: null,
      session: null,
      inboundPayload: { jobId: "11111111111" },
      status: "submitted",
      auditPayload: null,
      errorMessage: null,
      durationMs: 1500,
      ts: "2026-01-01T00:00:00.000Z",
    };

    const result = submissionEnvelopeSampleSchema.safeParse(line);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.session).toBeNull();
    }
  });

  it("submissionEnvelopeSampleSchema rejects a kind value other than submit", () => {
    const invalid = { ...makeBaseParsedLine(), kind: "beacon" };
    const result = submissionEnvelopeSampleSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("submissionEnvelopeSampleSchema rejects a line with no kind field", () => {
    const line = {
      siteId: "ats-c",
      requestId: "req-789",
      joinKeys: null,
      session: null,
      inboundPayload: { jobId: "11111111111" },
      status: "submitted",
      auditPayload: null,
      errorMessage: null,
      durationMs: 1500,
      ts: "2026-01-01T00:00:00.000Z",
    };

    const result = submissionEnvelopeSampleSchema.safeParse(line);
    expect(result.success).toBe(false);
  });

  it("forwards a serialized line containing joinKeys to the S3 buffer", async () => {
    const input = makeSuccessInputWithJoinKeys();
    await captureSubmissionEnvelope(input, { sinkPath });

    expect(bufferSubmissionLine).toHaveBeenCalledTimes(1);
    const forwardedLine = vi.mocked(bufferSubmissionLine).mock.calls[0]?.[0] ?? "";
    expect(forwardedLine).toContain(`"clickId":"${input.joinKeys?.clickId}"`);
    expect(forwardedLine).toContain(`"kind":"submit"`);
  });

  it("drops the entire submit line (never rejects) when a plugin-attached joinKeys bag contains a circular reference", async () => {
    const circular: Record<string, unknown> = { token: "abc" };
    circular.self = circular;
    const input = { ...makeSuccessInput(), joinKeys: circular };

    await expect(captureSubmissionEnvelope(input, { sinkPath })).resolves.toBeUndefined();

    expect(fs.existsSync(sinkPath)).toBe(false);
    expect(bufferSubmissionLine).not.toHaveBeenCalled();
  });

  it("drops the entire submit line (never rejects) when a plugin-attached joinKeys bag contains a BigInt", async () => {
    const input = { ...makeSuccessInput(), joinKeys: { minted: 9007199254740993n } };

    await expect(captureSubmissionEnvelope(input, { sinkPath })).resolves.toBeUndefined();

    expect(fs.existsSync(sinkPath)).toBe(false);
    expect(bufferSubmissionLine).not.toHaveBeenCalled();
  });

  it("writes a line that parses under submissionEnvelopeSampleSchema with an undefined-valued joinKeys key absent", async () => {
    const input = { ...makeSuccessInput(), joinKeys: { clickId: "v-9981", jid: undefined } };
    await captureSubmissionEnvelope(input, { sinkPath });

    const line = fs.readFileSync(sinkPath, "utf-8").trim();
    const parsed = JSON.parse(line) as SubmissionEnvelopeSample;
    const result = submissionEnvelopeSampleSchema.safeParse(parsed);
    expect(result.success).toBe(true);
    expect(parsed.joinKeys).toEqual({ clickId: "v-9981" });
    expect(parsed.joinKeys && "jid" in parsed.joinKeys).toBe(false);
  });
});

function makeBaseParsedLine(): Record<string, unknown> {
  return {
    kind: "submit",
    siteId: "ats-c",
    requestId: "req-abc-123",
    joinKeys: { clickId: "v-9981", refId: "56793094457_jid-1" },
    session: null,
    inboundPayload: { jobId: "56793094457" },
    status: "submitted",
    auditPayload: null,
    errorMessage: null,
    durationMs: 4321,
    ts: "2026-07-26T10:00:00.000Z",
  };
}
