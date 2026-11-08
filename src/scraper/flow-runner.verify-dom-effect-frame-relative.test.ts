import { describe, expect, it } from "vitest";
import { verifyDomEffect } from "./flow-runner.js";
import type { FrameTarget } from "./frame-target.js";

const COMPOSITES = {
  nested: "/html[1]/body[1]/main[1]/div[1]/span[1]/iframe[1]/html[1]/body[1]/div[2]/form[1]/a[1]",
  shallow: "/html[1]/body[1]/iframe[1]/html[1]/body[1]/div[2]/a[1]",
} as const;
const RELATIVE = {
  nested: "/html[1]/body[1]/div[2]/form[1]/a[1]",
  shallow: "/html[1]/body[1]/div[2]/a[1]",
} as const;

function fakeFrameTarget() {
  const locators: string[] = [];
  const exprs: string[] = [];
  const locator = {
    first: () => locator,
    inputValue: async () => "v",
    isChecked: async () => true,
    fill: async () => undefined,
    type: async () => undefined,
  };
  const target = {
    frame: {},
    frameSelector: "iframe#f",
    locator: (s: string) => {
      locators.push(s);
      return locator;
    },
    evaluate: async (e: unknown) => {
      exprs.push(String(e));
      return null;
    },
  } as unknown as FrameTarget;
  return { target, locators, exprs };
}

describe("verifyDomEffect evaluates in the frame's coordinate system", () => {
  for (const hostDepth of ["nested", "shallow"] as const) {
    for (const method of ["click", "fill", "type", "selectOption", "check", "uncheck"] as const) {
      it(`${method} (${hostDepth} host path) locates by a frame-relative xpath`, async () => {
        const { target, locators, exprs } = fakeFrameTarget();
        await verifyDomEffect(target, {
          selector: `xpath=${COMPOSITES[hostDepth]}`,
          method,
          description: "",
          arguments: ["v"],
        });
        for (const s of locators) expect(s).toBe(`xpath=${RELATIVE[hostDepth]}`);
        for (const e of exprs) expect(e).not.toContain("iframe[1]");
        expect(locators.length + exprs.length).toBeGreaterThan(0);
      });
    }
  }
});
