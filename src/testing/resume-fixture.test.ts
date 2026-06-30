/**
 * Verifies that loadTestResume() resolves the PDF from the site-agnostic
 * src/testing/fixtures/ path and returns the expected shape.
 */

import { describe, expect, it } from "vitest";

import { loadTestResume, resumePayloadFields } from "@/testing/resume-fixture";

describe("loadTestResume", () => {
  it("returns a non-empty Buffer", () => {
    const resume = loadTestResume();
    expect(Buffer.isBuffer(resume.buffer)).toBe(true);
    expect(resume.buffer.length).toBeGreaterThan(0);
  });

  it("sets contentType to application/pdf", () => {
    const resume = loadTestResume();
    expect(resume.contentType).toBe("application/pdf");
  });

  it("sets filename to reginald-reconaldo.pdf", () => {
    const resume = loadTestResume();
    expect(resume.filename).toBe("reginald-reconaldo.pdf");
  });

  it("sets base64 to the base64-encoded buffer contents", () => {
    const resume = loadTestResume();
    expect(resume.base64).toBe(resume.buffer.toString("base64"));
  });
});

describe("resumePayloadFields", () => {
  it("maps TestResume to the four payload field names used by every resume-accepting site", () => {
    const resume = loadTestResume();
    const fields = resumePayloadFields(resume);
    expect(fields).toStrictEqual({
      Resume: resume.buffer,
      ResumeContentType: "application/pdf",
      ResumeFilename: "reginald-reconaldo.pdf",
      ResumeBase64: resume.buffer.toString("base64"),
    });
  });
});
