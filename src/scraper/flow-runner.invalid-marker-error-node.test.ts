import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { countNgInvalidContainers } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";

function countFor(html: string): Promise<number> {
  const win = new Window();
  win.document.body.innerHTML = html;
  const target = {
    evaluate: async (expr: string) => new win.Function("document", `return ${expr};`)(win.document),
  } as unknown as FrameTarget;
  return countNgInvalidContainers(target);
}

describe("countNgInvalidContainers non-class error markers", () => {
  it("counts a data-automation-id error-message node", async () => {
    expect(await countFor(`<div data-automation-id="errorMessage">Required</div>`)).toBe(1);
  });
  it("counts a role=alert error banner", async () => {
    expect(await countFor(`<div role="alert" class="error-banner">Fix errors</div>`)).toBe(1);
  });
  it("ignores empty error templates, plain alerts and clean pages", async () => {
    expect(await countFor(`<div data-automation-id="errorMessage"></div>`)).toBe(0);
    expect(await countFor(`<div role="alert">Saved</div><input data-automation-id="email">`)).toBe(
      0
    );
  });
  it("still counts aria-invalid and ng-invalid", async () => {
    expect(await countFor(`<input aria-invalid="true"><div class="ng-invalid"></div>`)).toBe(2);
  });
});
