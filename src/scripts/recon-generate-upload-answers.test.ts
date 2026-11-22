import { describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";
import { bindMultipartSelectAnswers } from "./recon-generate";

const part = (n: string, v: string) =>
  `--B\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`;
const html = (body: string): Capture => ({ responseBody: body, requestHeaders: {} }) as never;

describe("bindMultipartSelectAnswers", () => {
  const cap = {
    requestHeaders: { "Content-Type": "multipart/form-data; boundary=B" },
  } as unknown as Capture;
  const prior = [
    {
      capture: html(
        '<select name="q1"><option value="">-</option><option value="42">A</option></select>'
      ),
    },
  ];
  it("maps select option ids to payload.Answers and leaves other parts", () => {
    const body = `${part("q1", "42")}${part("name", "42")}--B--`;
    const out = bindMultipartSelectAnswers(body, cap, prior);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder expanded from env by the code under test
    expect(out).toContain('name="q1"\r\n\r\n${payload.Answers["q1"]}\r\n');
    expect(out).toContain('name="name"\r\n\r\n42\r\n');
  });
  it("is a no-op for non-multipart requests", () => {
    const body = part("q1", "42");
    expect(
      bindMultipartSelectAnswers(body, { requestHeaders: {} } as unknown as Capture, prior)
    ).toBe(body);
  });
});

describe("urlencoded answers", () => {
  const cap = {
    requestHeaders: { "Content-Type": "application/x-www-form-urlencoded" },
  } as unknown as Capture;
  const prior = [
    {
      capture: html(
        '<select name="q 1"><option value="">-</option><option value="42">A</option></select>'
      ),
    },
  ];
  it("binds select fields and leaves others", () => {
    const out = bindMultipartSelectAnswers("q%201=42&name=42&x=1", cap, prior);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder
    expect(out).toBe('q%201=${payload.Answers["q 1"]}&name=42&x=1');
  });
  it("counts frozen urlencoded selects", async () => {
    const { detectContractGaps } = await import("./recon-generate");
    const step = {
      capture: {
        responseBody: prior[0]?.capture.responseBody,
        requestHeaders: cap.requestHeaders,
        requestPostData: "q%201=42&name=1",
      } as unknown as Capture,
      isMultipart: false,
    };
    expect(detectContractGaps([step], false, () => true, "body").frozenScreeningAnswers).toBe(1);
  });
});
