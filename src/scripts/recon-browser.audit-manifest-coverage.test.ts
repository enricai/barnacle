import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  auditFinalSubmitMatch,
  summarizeReplanFailureKinds,
  writeSubmitManifest,
} from "@/scripts/recon-browser";

const mkLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as never;
const tmp = () => mkdtempSync(join(tmpdir(), "rb-cov-"));
const put = (dir: string, name: string, obj: unknown) =>
  writeFileSync(join(dir, name), JSON.stringify(obj));

describe("auditFinalSubmitMatch", () => {
  it("fails with no hostnames and no pattern", () => {
    expect(auditFinalSubmitMatch({ capturesDir: tmp(), logger: mkLogger() })).toEqual({
      auditFailed: true,
      rejectionReason: null,
    });
  });
  it("fails and warns when the captures dir is unreadable", () => {
    const logger = mkLogger();
    const r = auditFinalSubmitMatch({
      capturesDir: join(tmp(), "missing"),
      submitEndpointPattern: "/apply",
      logger,
    });
    expect(r.auditFailed).toBe(true);
    expect((logger as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalled();
  });
  it("passes on a matching 2xx capture (endpoint + body patterns)", () => {
    const d = tmp();
    put(d, "001-a.json", {
      url: "https://x.test/apply",
      status: 200,
      method: "POST",
      requestPostData: "name=bob",
      responseBody: "{}",
    });
    put(d, "002-a.decoded.json", {});
    writeFileSync(join(d, "003-bad.json"), "{nope");
    expect(
      auditFinalSubmitMatch({
        capturesDir: d,
        submitEndpointPattern: "/apply",
        submitBodyPattern: "name=",
        logger: mkLogger(),
      })
    ).toEqual({ auditFailed: false, rejectionReason: null });
  });
  it("reports a rejection reason when the only match is a rejection", () => {
    const d = tmp();
    put(d, "001-a.json", {
      url: "https://x.test/apply",
      status: 200,
      method: "POST",
      responseBody: JSON.stringify({ rejected: true, reason: "dup" }),
    });
    const r = auditFinalSubmitMatch({
      capturesDir: d,
      submitEndpointPattern: "/apply",
      logger: mkLogger(),
    });
    expect(r.auditFailed).toBe(true);
    expect(r.rejectionReason).not.toBeNull();
  });
});

describe("writeSubmitManifest", () => {
  const run = (d: string, patt: string | null, body: string | null = null) => {
    const root = tmp();
    const logger = mkLogger();
    writeSubmitManifest({
      runRoot: root,
      capturesDir: d,
      submitEndpointPattern: patt,
      submitBodyPattern: body,
      logger,
    });
    return {
      root,
      logger: logger as unknown as {
        warn: ReturnType<typeof vi.fn>;
        info: ReturnType<typeof vi.fn>;
      },
    };
  };
  it("writes nothing without a pattern", () => {
    const { root } = run(tmp(), null);
    expect(() => readFileSync(join(root, "submit-manifest.json"))).toThrow();
  });
  it("warns on an unreadable dir", () => {
    const { logger } = run(join(tmp(), "nope"), "/apply");
    expect(logger.warn).toHaveBeenCalled();
  });
  it("records non-GET matches, skipping errors and non-matches", () => {
    const d = tmp();
    put(d, "001-a.json", {
      url: "https://x.test/apply",
      status: 200,
      method: "POST",
      requestPostData: "k=1",
    });
    put(d, "002-a.json", {
      url: "https://x.test/apply",
      status: 500,
      method: "POST",
      requestPostData: "k=1",
    });
    put(d, "003-a.json", {
      url: "https://x.test/other",
      status: 200,
      method: "POST",
      requestPostData: "k=1",
    });
    put(d, "004-a.json", { status: 200 });
    writeFileSync(join(d, "005-a.json"), "{bad");
    const { root } = run(d, "/apply", "k=");
    const m = JSON.parse(readFileSync(join(root, "submit-manifest.json"), "utf8"));
    expect(m.map((e: { index: number }) => e.index)).toEqual([0]);
  });
  it("falls back to 2xx GET captures (read flow)", () => {
    const d = tmp();
    put(d, "001-a.json", { url: "https://x.test/apply", status: 200, method: "GET" });
    const { root, logger } = run(d, "/apply");
    const m = JSON.parse(readFileSync(join(root, "submit-manifest.json"), "utf8"));
    expect(m).toHaveLength(1);
    expect(logger.info).toHaveBeenCalled();
  });
  it("writes an empty manifest and warns when nothing matches", () => {
    const { root, logger } = run(tmp(), "/apply", "k=");
    expect(JSON.parse(readFileSync(join(root, "submit-manifest.json"), "utf8"))).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("summarizeReplanFailureKinds", () => {
  const sample = (success: boolean, failureKind: string | null) =>
    JSON.stringify({
      callId: "c",
      callType: "act",
      model: "m",
      systemPrompt: "s",
      userContent: "u",
      responseContent: "r",
      parsedOk: true,
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
      success,
      errorMessage: null,
      failureKind,
      ts: "2026-05-30T00:00:00Z",
    });
  it("returns '' for a missing file", () => {
    expect(
      summarizeReplanFailureKinds({ callsNdjsonPath: join(tmp(), "x"), callType: "act" })
    ).toBe("");
  });
  it("returns '' when there are no failures", () => {
    const f = join(tmp(), "c.ndjson");
    writeFileSync(f, `${sample(true, null)}\n`);
    expect(summarizeReplanFailureKinds({ callsNdjsonPath: f, callType: "act" })).toBe("");
  });
  it("counts failure kinds, most frequent first", () => {
    const f = join(tmp(), "c.ndjson");
    writeFileSync(
      f,
      [sample(false, "response-empty"), sample(false, "response-empty"), sample(false, null)].join(
        "\n"
      )
    );
    expect(summarizeReplanFailureKinds({ callsNdjsonPath: f, callType: "act" })).toBe(
      "3 recent act failure(s): 2× response-empty, 1× unknown"
    );
  });
});
