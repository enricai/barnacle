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
