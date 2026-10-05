import { describe, expect, it } from "vitest";

import {
  applyStructuredValuePayloadSubstitutions,
  type StateVarBinding,
} from "@/scripts/recon-generate";

/**
 * `applyStructuredValuePayloadSubstitutionsForEnvelope`'s `carriesThreadedValue`
 * check (recon-generate.ts) now carries THREE independent exclusion sources
 * that all funnel into the same array-wide exclude-vs-swallow decision: a
 * state-threaded prior-step value (`priorStepStateBindings`, unrestricted),
 * a fold join-field value (`joinFieldValues`), and a registered payload-
 * accessor literal (`payloadAccessorExcludeValues`, added alongside the
 * other two to fix the reported facet-swallow gap). Each was proven correct
 * in isolation by its own precedent regression test. This proves they still
 * compose correctly when all three coexist as separate elements of the SAME
 * array: the array must stay excluded from the wholesale
 * `${JSON.stringify(payload.<key>)}` swallow, and every one of the three
 * raw literals must survive untouched in the output text (which is exactly
 * what makes each one still available for its own downstream splice pass to
 * thread).
 */
describe("applyStructuredValuePayloadSubstitutions — multiple exclusion sources coexisting in one array", () => {
  it("excludes the whole array when a state-threaded value, a fold join-field value, and a payload-accessor literal are each a separate element", () => {
    const parsedBody = {
      // Three distinct exclusion reasons, one per element, plus one
      // unrelated control element that matches nothing.
      tags: ["region-us-east", "batch-42", "dept-engineering", "unrelated"],
    };
    const template = JSON.stringify(parsedBody);
    const outStructuredKeys = new Map<string, string>();

    // (a) state-threaded: an unrestricted prior-step binding, same shape as
    // the existing "still excludes unconditionally on an unrestricted
    // (name-free) prior-step value match" precedent.
    const priorStepStateBindings = new Map<string, StateVarBinding>([
      [
        "region-us-east",
        {
          varName: "chainValue0",
          sourceName: "0",
          restricted: false,
          unconditional: true,
        },
      ],
    ]);

    // (b) fold join-field value: same shape as the existing "still excludes
    // unconditionally on a join-field value match" precedent.
    const joinFieldValues = new Set<string>(["batch-42"]);

    // (c) registered payload-accessor literal: same shape as the existing
    // payloadAccessorExcludeValues precedent.
    const payloadAccessorExcludeValues = new Map<string, string>([
      ["dept-engineering", "state.departmentCode"],
    ]);

    const result = applyStructuredValuePayloadSubstitutions(
      template,
      parsedBody,
      outStructuredKeys,
      priorStepStateBindings,
      joinFieldValues,
      payloadAccessorExcludeValues
    );

    // The whole array must stay untouched — none of the three exclusion
    // sources may be dropped by the others' presence, and the control
    // element proves the array wasn't swallowed for some unrelated reason.
    expect(result).toBe(template);
    // The schema key is registered independently of the swallow, so the declared type stays in sync with the payload accessor.
    expect(outStructuredKeys.has("tags")).toBe(true);

    // Every one of the three raw literals must survive frozen in the text —
    // each still available for its own downstream splice pass to thread.
    expect(result).toContain('"region-us-east"');
    expect(result).toContain('"batch-42"');
    expect(result).toContain('"dept-engineering"');
  });

  it("control: swallows the same array shape when none of the three exclusion sources match", () => {
    const parsedBody = {
      tags: ["region-us-east", "batch-42", "dept-engineering", "unrelated"],
    };
    const template = JSON.stringify(parsedBody);
    const outStructuredKeys = new Map<string, string>();

    const result = applyStructuredValuePayloadSubstitutions(
      template,
      parsedBody,
      outStructuredKeys
    );

    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    const expectedTagsSub = "${JSON.stringify(payload.tags)}";
    expect(result).toContain(`"tags":${expectedTagsSub}`);
    expect(outStructuredKeys.has("tags")).toBe(true);
  });
});
