import { describe, expect, it } from "vitest";
import { REQUEST_BODY_UNAVAILABLE } from "@/scraper/request-body-marker";
import type { Capture } from "@/scripts/recon-shared";
import {
  buildContractChecklist,
  contractGapChecklistLines,
  detectContractGaps,
} from "./recon-generate";

const cap = (method: string, body: string | null, headers: Record<string, string> = {}) =>
  ({
    method,
    requestPostData: body,
    requestHeaders: headers,
    responseBody: "",
  }) as unknown as Capture;
const step = (c: Capture, isMultipart = false) => ({ capture: c, isMultipart });
const all = () => true;

describe("detectContractGaps", () => {
  it("flags a sequence with no submit write as truncated", () => {
    const g = detectContractGaps([step(cap("GET", null)), step(cap("GET", null))], true, all);
    expect(g.truncatedSequence).toBe(true);
  });
  it("leaves a complete flow clean", () => {
    const g = detectContractGaps([step(cap("GET", null)), step(cap("POST", "{}"))], true, all);
    expect(g).toEqual({
      captchaGatedSteps: 0,
      truncatedSequence: false,
      bodylessUploadSteps: 0,
      frozenScreeningAnswers: 0,
    });
    expect(contractGapChecklistLines(g)).toEqual([]);
  });
  it("flags a bodyless upload and a captcha-gated step", () => {
    const g = detectContractGaps(
      [
        step(
          cap("POST", REQUEST_BODY_UNAVAILABLE, { "content-type": "multipart/form-data" }),
          true
        ),
        step(cap("POST", '{"g-recaptcha-response":"tok"}')),
      ],
      true,
      all
    );
    expect(g.bodylessUploadSteps).toBe(1);
    expect(g.captchaGatedSteps).toBe(1);
  });
});

describe("detectContractGaps frozen screening answers", () => {
  const sel = (body: string) =>
    ({
      method: "GET",
      requestPostData: null,
      requestHeaders: {},
      responseBody: body,
    }) as unknown as Capture;
  const html = '<select name="q1"><option value="a">A</option></select>';
  const steps = [step(sel(html)), step(cap("POST", 'x name="q1" y'))];
  it("counts posted selects when the emitted body has no payload.Answers binding", () => {
    expect(detectContractGaps(steps, false, all, "const x = 1;").frozenScreeningAnswers).toBe(1);
  });
  it("counts nothing when answers are bound", () => {
    expect(detectContractGaps(steps, false, all, "payload.Answers[0]").frozenScreeningAnswers).toBe(
      0
    );
  });
});

describe("buildContractChecklist gap lines", () => {
  const base = { pascal: "X", gql: false, gqlQuery: null };
  it("is unchanged without gaps", () => {
    const g = detectContractGaps([step(cap("POST", "{}"))], true, all);
    expect(buildContractChecklist({ ...base, gaps: g })).toEqual(buildContractChecklist(base));
  });
  it("lists each condition", () => {
    const lines = buildContractChecklist({
      ...base,
      gaps: {
        captchaGatedSteps: 1,
        truncatedSequence: true,
        bodylessUploadSteps: 1,
        frozenScreeningAnswers: 2,
      },
    });
    for (const re of [
      /captcha-gated/,
      /stops short of the flow's submit/,
      /upload step/,
      /screening answer/,
    ])
      expect(lines.some((l) => re.test(l))).toBe(true);
  });
});
