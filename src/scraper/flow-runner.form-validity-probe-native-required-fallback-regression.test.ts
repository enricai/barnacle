import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { formValidityProbeExpr } from "@/scraper/flow-runner";

interface InvalidFormControlPayload {
  label: string;
  classSignature: string;
  emptyOrUnchecked: boolean;
  autoFilled: { action: string; value: string } | null;
}

/**
 * `formValidityProbeExpr`'s source runs the SAME native-validity fallback
 * the production pre-submit probe evaluates in the browser — executed here
 * via `new Function` against a genuine happy-dom document, mirroring
 * `flow-runner.field-values-at-failure-expr.test.ts`'s real-`evaluate`
 * pattern, so a required-but-pristine field with no framework invalid-
 * marker class is actually surfaced instead of just asserted against a
 * hand-rolled fixture.
 */
describe("flow-runner/formValidityProbeExpr native-validity fallback", () => {
  function runExpr(window: Window): InvalidFormControlPayload[] {
    const fn = new Function("document", "CSS", `return (${formValidityProbeExpr()});`) as (
      document: unknown,
      css: unknown
    ) => InvalidFormControlPayload[];
    return fn(window.document, window.CSS);
  }

  it("flags a pristine, empty required field with no ng-invalid/Mui-error/etc. marker class anywhere", () => {
    const window = new Window();
    const document = window.document;
    document.body.innerHTML = `
      <form>
        <label for="full_name">Full name</label>
        <input id="full_name" name="full_name" required />
      </form>
    `;

    const result = runExpr(window);

    expect(result).toContainEqual(
      expect.objectContaining({ label: "Full name", emptyOrUnchecked: true, classSignature: "" })
    );
  });

  it("does NOT report a non-required empty field, so the fallback introduces no false positives", () => {
    const window = new Window();
    const document = window.document;
    document.body.innerHTML = `
      <form>
        <label for="nickname">Nickname</label>
        <input id="nickname" name="nickname" />
      </form>
    `;

    const result = runExpr(window);

    expect(result).toEqual([]);
  });
});
