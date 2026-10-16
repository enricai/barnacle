import { describe, expect, it } from "vitest";

import {
  matchesUploadAffordanceVocabulary,
  UPLOAD_AFFORDANCE_MATCHER_EXPR,
} from "@/scraper/upload-affordance-expr";

const POSITIVE = [
  "Select files",
  "Choose Files",
  "Select file",
  "Upload",
  "Browse",
  "Attach",
  "Add a resume",
  "Add files",
  "Select   Files",
  "Choose file",
  "Add a file",
  "Add a CV",
  "Upload files",
  "Uploads",
  "Add resumes",
  "Add CVs",
  "Upload your Resumes/CVs",
];
const NEGATIVE = [
  "Cancel",
  "Remove file",
  "Remove files",
  "No file",
  "No files",
  "Decline to upload files",
  "Upload later",
  "Submit",
  "Skip",
  "Select files later",
  "Cancel upload files",
  "",
];

describe("upload affordance vocabulary", () => {
  const browser = new Function(`return (${UPLOAD_AFFORDANCE_MATCHER_EXPR});`)() as (
    s: string
  ) => boolean;

  it.each(POSITIVE)("accepts %s in Node and browser", (label) => {
    expect(matchesUploadAffordanceVocabulary(label)).toBe(true);
    expect(browser(label)).toBe(true);
  });

  it.each(NEGATIVE)("rejects %j in Node and browser", (label) => {
    expect(matchesUploadAffordanceVocabulary(label)).toBe(false);
    expect(browser(label)).toBe(false);
  });
});
