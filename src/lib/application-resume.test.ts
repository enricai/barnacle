import { describe, expect, it } from "vitest";

import { ApplicantResumeSchema } from "@/lib/application-resume";
import { loadTestResume } from "@/testing/resume-fixture";

describe("ApplicantResumeSchema", () => {
  it("parses a Buffer-backed resume block from the shared test fixture", () => {
    const resume = loadTestResume();
    const result = ApplicantResumeSchema.safeParse({
      Resume: resume.buffer,
      ResumeContentType: resume.contentType,
      ResumeFilename: resume.filename,
      ResumeBase64: resume.base64,
    });
    expect(result.success).toBe(true);
  });

  it("parses a minimal Buffer value for Resume", () => {
    const result = ApplicantResumeSchema.safeParse({
      Resume: Buffer.from("x"),
      ResumeContentType: "application/pdf",
      ResumeFilename: "resume.pdf",
      ResumeBase64: Buffer.from("x").toString("base64"),
    });
    expect(result.success).toBe(true);
  });

  it("rejects a string Resume — multipart builders require a real Buffer instance", () => {
    const resume = loadTestResume();
    const result = ApplicantResumeSchema.safeParse({
      Resume: "not-a-buffer",
      ResumeContentType: resume.contentType,
      ResumeFilename: resume.filename,
      ResumeBase64: resume.base64,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a base64-string Resume — even though it looks like bytes, it is not a Buffer", () => {
    const resume = loadTestResume();
    const result = ApplicantResumeSchema.safeParse({
      Resume: resume.base64,
      ResumeContentType: resume.contentType,
      ResumeFilename: resume.filename,
      ResumeBase64: resume.base64,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing ResumeBase64 field", () => {
    const resume = loadTestResume();
    const { base64: _removed, ...rest } = resume;
    const result = ApplicantResumeSchema.safeParse({
      Resume: rest.buffer,
      ResumeContentType: rest.contentType,
      ResumeFilename: rest.filename,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing Resume field", () => {
    const resume = loadTestResume();
    const result = ApplicantResumeSchema.safeParse({
      ResumeContentType: resume.contentType,
      ResumeFilename: resume.filename,
      ResumeBase64: resume.base64,
    });
    expect(result.success).toBe(false);
  });
});
