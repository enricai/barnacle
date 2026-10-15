import { readFileSync } from "node:fs";
import { type Document, type HTMLInputElement, Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import {
  parseCheckStateStep,
  parseCheckStep,
  tryCheckboxStatePrimitive,
} from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";

const LOGGER = { info: () => undefined, warn: () => undefined } as never;

function setup(
  html: string,
  flipOnClick = true
): { target: FrameTarget; clicks: string[]; page: never; doc: Document } {
  const window = new Window({ url: "https://example.com/" });
  window.document.body.innerHTML = html;
  const doc = window.document as unknown as Document;
  const clicks: string[] = [];
  const evaluate = async (expr: string): Promise<unknown> =>
    new window.Function("document", "window", "getComputedStyle", `return (${expr});`)(
      window.document,
      window,
      window.getComputedStyle.bind(window)
    );
  const target = {
    evaluate,
    locator: (sel: string) => ({
      click: async (): Promise<void> => {
        clicks.push(sel);
        const el = window.document.querySelector(sel) as unknown as import("happy-dom").HTMLElement;
        const box =
          el.tagName === "INPUT" ? el : (el.querySelector("input") as HTMLInputElement | null);
        if (flipOnClick && box)
          (box as HTMLInputElement).checked = !(box as HTMLInputElement).checked;
      },
    }),
  } as unknown as FrameTarget;
  const page = { waitForTimeout: async (): Promise<void> => undefined } as never;
  return { target, clicks, page, doc };
}

const patchHit = (doc: Document): void => {
  (doc as unknown as { elementFromPoint: (x: number, y: number) => unknown }).elementFromPoint =
    () => doc.querySelector("[data-barnacle-cbstate]");
};

const run = (s: ReturnType<typeof setup>, instruction: string): Promise<string | null> => {
  patchHit(s.doc);
  (s.doc as unknown as { elementFromPoint: () => unknown }).elementFromPoint = () => {
    const el = s.doc.querySelector("[data-barnacle-cbstate]");
    return el;
  };
  return tryCheckboxStatePrimitive({ page: s.page, target: s.target, instruction, logger: LOGGER });
};

describe("parseCheckStateStep", () => {
  it("parses check and uncheck, not click", () => {
    expect(parseCheckStateStep("Check the 'I agree to the terms' checkbox")?.desired).toBe(true);
    expect(parseCheckStateStep("Uncheck the 'I agree to the terms' checkbox")?.desired).toBe(false);
    expect(parseCheckStateStep("Click the 'I agree to the terms' checkbox")).toBeNull();
  });
});

describe("tryCheckboxStatePrimitive", () => {
  const one = `<input type="checkbox" id="a" checked><label for="a">I agree to the terms</label>`;

  it("is a no-op for a pre-ticked box on Check", async () => {
    const s = setup(one);
    expect(await run(s, "Check the 'I agree to the terms' checkbox")).toBe("a");
    expect(s.clicks).toEqual([]);
    expect((s.doc.getElementById("a") as HTMLInputElement).checked).toBe(true);
  });

  it("ticks an unticked box with exactly one click", async () => {
    const s = setup(one.replace(" checked", ""));
    expect(await run(s, "Check the 'I agree to the terms' checkbox")).toBe("a");
    expect(s.clicks).toHaveLength(1);
    expect((s.doc.getElementById("a") as HTMLInputElement).checked).toBe(true);
  });

  it("unchecks only the matching section's box", async () => {
    const s = setup(`
      <section aria-labelledby="h1"><h3 id="h1">Billing</h3>
        <input type="checkbox" id="b" checked><label for="b">I agree to the terms</label></section>
      <section aria-labelledby="h2"><h3 id="h2">Shipping</h3>
        <input type="checkbox" id="c" checked><label for="c">I agree to the terms</label></section>`);
    expect(
      await run(s, "Uncheck the 'I agree to the terms' checkbox in the Shipping section")
    ).toBe("c");
    expect((s.doc.getElementById("b") as HTMLInputElement).checked).toBe(true);
    expect((s.doc.getElementById("c") as HTMLInputElement).checked).toBe(false);
  });

  it("falls through when ambiguous or missing", async () => {
    const two = `<input type="checkbox" id="b"><label for="b">Terms</label><input type="checkbox" id="c"><label for="c">Terms</label>`;
    expect(await run(setup(two), "Check the 'Terms' checkbox")).toBeNull();
    expect(await run(setup(one), "Check the 'Nope' checkbox")).toBeNull();
  });

  it("unchecks a pre-ticked box with exactly one click", async () => {
    const s = setup(one);
    expect(await run(s, "Uncheck the 'I agree to the terms' checkbox")).toBe("a");
    expect(s.clicks).toHaveLength(1);
    expect((s.doc.getElementById("a") as HTMLInputElement).checked).toBe(false);
  });

  it("is a no-op for an unticked box on Uncheck", async () => {
    const s = setup(one.replace(" checked", ""));
    expect(await run(s, "Uncheck the 'I agree to the terms' checkbox")).toBe("a");
    expect(s.clicks).toEqual([]);
  });

  it("matches the label exactly, not as a substring", async () => {
    const s = setup(
      `<input type="checkbox" id="a"><label for="a">I agree to the terms and conditions</label>`
    );
    expect(await run(s, "Check the 'I agree to the terms' checkbox")).toBeNull();
    expect(s.clicks).toEqual([]);
  });

  it("prefers aria-checked over the checked property", async () => {
    const on = setup(
      `<div role="checkbox" id="r" aria-checked="true" aria-label="Subscribe"></div>`
    );
    expect(await run(on, "Check the 'Subscribe' checkbox")).toBe("r");
    expect(on.clicks).toEqual([]);
    const off = setup(
      `<div role="checkbox" id="r" aria-checked="false" aria-label="Subscribe"></div>`,
      false
    );
    expect(await run(off, "Uncheck the 'Subscribe' checkbox")).toBe("r");
    expect(off.clicks).toEqual([]);
  });

  it("falls through when the click never flips the box", async () => {
    const s = setup(one.replace(" checked", ""), false);
    expect(await run(s, "Check the 'I agree to the terms' checkbox")).toBeNull();
    expect(s.clicks.length).toBeGreaterThan(0);
  });

  it("falls back to the box when the label click point is obscured", async () => {
    const s = setup(one.replace(" checked", ""));
    (s.doc as unknown as { elementFromPoint: () => unknown }).elementFromPoint = () =>
      s.doc.querySelector("[data-barnacle-cbstate=box]");
    const id = await tryCheckboxStatePrimitive({
      page: s.page,
      target: s.target,
      instruction: "Check the 'I agree to the terms' checkbox",
      logger: LOGGER,
    });
    expect(id).toBe("a");
    expect(s.clicks).toEqual(['[data-barnacle-cbstate="box"]']);
  });

  it("falls through without clicking when every click point is obscured", async () => {
    const s = setup(one.replace(" checked", ""));
    (s.doc as unknown as { elementFromPoint: () => unknown }).elementFromPoint = () => s.doc.body;
    const id = await tryCheckboxStatePrimitive({
      page: s.page,
      target: s.target,
      instruction: "Check the 'I agree to the terms' checkbox",
      logger: LOGGER,
    });
    expect(id).toBeNull();
    expect(s.clicks).toEqual([]);
  });

  it("clears its marker attributes afterwards", async () => {
    const s = setup(one.replace(" checked", ""));
    await run(s, "Check the 'I agree to the terms' checkbox");
    expect(s.doc.querySelector("[data-barnacle-cbstate]")).toBeNull();
  });

  it("ignores click phrasing, leaving toggles to the cascade", async () => {
    const s = setup(one);
    expect(await run(s, "Click the 'I agree to the terms' checkbox")).toBeNull();
    expect(s.clicks).toEqual([]);
  });
});

describe("parseCheckStep uncheck form", () => {
  it("extracts the label from an Uncheck step", () => {
    expect(parseCheckStep("Uncheck the 'Newsletter' checkbox")).toEqual({ label: "Newsletter" });
  });
});

describe("step ordering", () => {
  it("runs the checkbox state primitive before the prompt-selector and date primitives", () => {
    const src = readFileSync(`${__dirname}/flow-runner.ts`, "utf8");
    const at = (needle: string): number => src.indexOf(`await ${needle}({`);
    const state = at("tryCheckboxStatePrimitive");
    expect(state).toBeGreaterThan(0);
    expect(state).toBeLessThan(at("tryPromptSelectorPrimitive"));
    expect(state).toBeLessThan(at("trySegmentedDateSpinbuttonPrimitive"));
  });
});
