/**
 * Unit tests for the site-agnostic batch-report renderer.
 *
 * No network, no browser, no filesystem — just pure functions over
 * synthetic BatchJobVerdict arrays.
 */

import { describe, expect, it } from "vitest";

import { type BatchJobVerdict, renderBatchReport } from "@/testing/batch-report";

function makeVerdict(overrides: Partial<BatchJobVerdict> = {}): BatchJobVerdict {
  return {
    jobId: "job-001",
    submitStatus: "PASS",
    submitDurationMs: 1234,
    emailReceived: false,
    ...overrides,
  };
}

const ALL_PASS_WITH_EMAIL = makeVerdict({
  emailReceived: true,
  emailSubject: "Application Received",
});
const PASS_NO_EMAIL = makeVerdict({ jobId: "job-002", submitDurationMs: 2345 });
const FAIL_WITH_ERROR = makeVerdict({
  jobId: "job-003",
  submitStatus: "FAIL",
  submitDurationMs: 500,
  emailReceived: false,
  error: "verified=false",
});

describe("renderBatchReport", () => {
  it("returns a string starting with a newline and a markdown table header", () => {
    const out = renderBatchReport([ALL_PASS_WITH_EMAIL]);
    expect(out).toMatch(/^\n\|/);
    expect(out).toContain("| jobId | submit | dur (s) | email | subject / error |");
  });

  it("includes exactly one body row per verdict", () => {
    const verdicts = [ALL_PASS_WITH_EMAIL, PASS_NO_EMAIL, FAIL_WITH_ERROR];
    const out = renderBatchReport(verdicts);
    // header + separator + 3 body rows
    const lines = out
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("|"));
    expect(lines).toHaveLength(5);
  });

  it("each body row contains the jobId", () => {
    const verdicts = [makeVerdict({ jobId: "alpha" }), makeVerdict({ jobId: "beta" })];
    const out = renderBatchReport(verdicts);
    expect(out).toContain("| alpha |");
    expect(out).toContain("| beta |");
  });

  it("marks PASS and FAIL correctly in the submit column", () => {
    const out = renderBatchReport([ALL_PASS_WITH_EMAIL, FAIL_WITH_ERROR]);
    const rows = out
      .split("\n")
      .filter((l) => l.startsWith("|") && !l.startsWith("| jobId") && !l.startsWith("|---"));
    expect(rows[0]).toContain("| PASS |");
    expect(rows[1]).toContain("| FAIL |");
  });

  it("shows Y for email received and N for not received", () => {
    const out = renderBatchReport([ALL_PASS_WITH_EMAIL, PASS_NO_EMAIL]);
    const rows = out
      .split("\n")
      .filter((l) => l.startsWith("|") && !l.startsWith("| jobId") && !l.startsWith("|---"));
    expect(rows[0]).toContain("| Y |");
    expect(rows[1]).toContain("| N |");
  });

  it("renders duration in seconds (1 decimal place)", () => {
    const v = makeVerdict({ submitDurationMs: 3500 });
    const out = renderBatchReport([v]);
    expect(out).toContain("| 3.5 |");
  });

  it("renders '-' for null duration", () => {
    const v = makeVerdict({ submitDurationMs: null });
    const out = renderBatchReport([v]);
    expect(out).toContain("| - |");
  });

  it("renders emailSubject in the detail column when present", () => {
    const out = renderBatchReport([ALL_PASS_WITH_EMAIL]);
    expect(out).toContain("Application Received");
  });

  it("renders error in the detail column when email subject is absent", () => {
    const out = renderBatchReport([FAIL_WITH_ERROR]);
    expect(out).toContain("verified=false");
  });

  it("renders '—' in the detail column when neither subject nor error is present", () => {
    const v = makeVerdict({ emailReceived: false });
    const out = renderBatchReport([v]);
    expect(out).toContain("| — |");
  });

  it("includes the Net summary line with correct counts", () => {
    const verdicts = [ALL_PASS_WITH_EMAIL, PASS_NO_EMAIL, FAIL_WITH_ERROR];
    const out = renderBatchReport(verdicts);
    // 1 out of 3 received email
    expect(out).toContain("Net: 1/3 received confirmation email");
  });

  it("Net line is 0/N when no email received", () => {
    const verdicts = [PASS_NO_EMAIL, FAIL_WITH_ERROR];
    const out = renderBatchReport(verdicts);
    expect(out).toContain("Net: 0/2 received confirmation email");
  });

  it("Net line is N/N when all emails received", () => {
    const verdicts = [
      makeVerdict({ jobId: "a", emailReceived: true }),
      makeVerdict({ jobId: "b", emailReceived: true }),
    ];
    const out = renderBatchReport(verdicts);
    expect(out).toContain("Net: 2/2 received confirmation email");
  });

  it("handles an empty verdict array gracefully", () => {
    const out = renderBatchReport([]);
    expect(out).toContain("Net: 0/0 received confirmation email");
    // header + separator rows only
    const tableRows = out.split("\n").filter((l) => l.startsWith("|"));
    expect(tableRows).toHaveLength(2);
  });

  it("uses a custom jobIdLabel when supplied in options", () => {
    const out = renderBatchReport([makeVerdict()], { jobIdLabel: "reqNum" });
    expect(out).toContain("| reqNum | submit |");
  });

  it("truncates email subject to 60 chars", () => {
    const longSubject = "A".repeat(80);
    const v = makeVerdict({ emailReceived: true, emailSubject: longSubject });
    const out = renderBatchReport([v]);
    const truncated = "A".repeat(60);
    expect(out).toContain(truncated);
    expect(out).not.toContain("A".repeat(61));
  });

  it("pass count matches input (3 PASS, 1 FAIL)", () => {
    const verdicts = [
      makeVerdict({ jobId: "a", submitStatus: "PASS" }),
      makeVerdict({ jobId: "b", submitStatus: "PASS" }),
      makeVerdict({ jobId: "c", submitStatus: "PASS" }),
      makeVerdict({ jobId: "d", submitStatus: "FAIL" }),
    ];
    const out = renderBatchReport(verdicts);
    const passRows = out.split("\n").filter((l) => l.includes("| PASS |"));
    const failRows = out.split("\n").filter((l) => l.includes("| FAIL |"));
    expect(passRows).toHaveLength(3);
    expect(failRows).toHaveLength(1);
  });
});
