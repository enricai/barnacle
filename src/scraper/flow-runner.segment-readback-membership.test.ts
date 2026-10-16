// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { verifyFillReadback } from "@/scraper/flow-runner";

function readback(html: string, id: string): ReturnType<typeof verifyFillReadback> {
  const doc = (
    globalThis as unknown as {
      document: { body: { innerHTML: string } };
    }
  ).document;
  doc.body.innerHTML = html;
  const g = globalThis as unknown as Record<string, unknown>;
  g.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
  (doc as unknown as Record<string, unknown>).evaluate = (): { singleNodeValue: unknown } => ({
    singleNodeValue: (doc as unknown as { getElementById: (i: string) => unknown }).getElementById(
      id
    ),
  });
  const target = {
    evaluate: async (expr: string): Promise<unknown> => new Function(`return ${expr}`)(),
  };
  return verifyFillReadback(target as never, `//*[@id='${id}']`, "01");
}

const wrapped = (id: string): string =>
  `<div><input id="${id}" role="spinbutton" aria-valuemax="12" /></div>`;

describe("verifyFillReadback segment membership", () => {
  it("flags every segment of a wrapper-per-segment widget", async () => {
    const html = `<div><label>From</label><div>${wrapped("mm")}${wrapped("yyyy")}</div></div>`;
    expect((await readback(html, "mm"))?.outcome).toBe("segment");
    expect((await readback(html, "yyyy"))?.outcome).toBe("segment");
  });

  it("flags segments sharing one wrapper", async () => {
    const html = `<div><input id="mm" role="spinbutton" /><input id="dd" role="spinbutton" /></div>`;
    expect((await readback(html, "dd"))?.outcome).toBe("segment");
  });

  it("does not flag a standalone stepper", async () => {
    const html = `<div><label for="q">Qty</label><input id="q" role="spinbutton" value="01" /></div>`;
    expect((await readback(html, "q"))?.outcome).toBe("matched");
  });
});
