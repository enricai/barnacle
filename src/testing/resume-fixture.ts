import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Resolved resume bytes + the metadata downstream plugins need to attach
 * the file to a multipart request or a JSON resume blob. Plugins that
 * accept resume uploads can destructure this shape directly into their
 * payload fields.
 */
export interface TestResume {
  buffer: Buffer;
  contentType: "application/pdf";
  filename: string;
  base64: string;
}

/**
 * The payload-side field names that every resume-accepting site uses
 * identically. Extracted so tests can spread this instead of repeating
 * the four-field mapping verbatim.
 */
export interface ResumePayloadFields {
  Resume: Buffer;
  ResumeContentType: string;
  ResumeFilename: string;
  ResumeBase64: string;
}

const RESUME_PATH = resolve(__dirname, "./fixtures/resume.pdf");

/**
 * Read the shared persona PDF once and return its bytes + the per-call
 * metadata fields the plugins expect. Centralised so the integration tests
 * never disagree about which resume the test persona is submitting, and so
 * a future swap to a different PDF is a one-file change instead of a fan-out
 * across every test.
 */
export function loadTestResume(): TestResume {
  const buffer = readFileSync(RESUME_PATH);
  return {
    buffer,
    contentType: "application/pdf",
    filename: "reginald-reconaldo.pdf",
    base64: buffer.toString("base64"),
  };
}

/**
 * Maps a `TestResume` to the four payload field names every resume-accepting
 * site shares (Resume, ResumeContentType, ResumeFilename, ResumeBase64).
 * Extracted here so tests can spread `resumePayloadFields(resume)` instead
 * of repeating the same literal mapping at every call site.
 */
export function resumePayloadFields(resume: TestResume): ResumePayloadFields {
  return {
    Resume: resume.buffer,
    ResumeContentType: resume.contentType,
    ResumeFilename: resume.filename,
    ResumeBase64: resume.base64,
  };
}
