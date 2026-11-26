/**
 * Fixed, model-free typing of a payment-card value into the payment provider's
 * frame. The value goes straight to the field via per-character key events: it
 * is never part of an instruction, so no act/observe/heal/judge/rephrase prompt
 * can contain it. Before returning, the frame origin, field focus and the
 * provider's completeness marker are all verified.
 */

import type { Page } from "@browserbasehq/stagehand";

import { type FrameTarget, readCurrentFrameUrl } from "@/scraper/frame-target";

export interface CardStepSpec {
  /** Runtime value; absent/empty fails closed. Never logged. */
  value: string | undefined;
  /** Origin of the payment provider frame the field must live in. */
  frameOrigin: string;
  /** Selector the provider sets when the field is valid. */
  completeSelector?: string;
  /** Field inside the frame; defaults to the first enabled visible input. */
  fieldSelector?: string;
}

export class CardStepError extends Error {
  constructor(
    readonly reason: "no-value" | "wrong-frame" | "not-focused" | "incomplete" | "type-failed",
    message: string
  ) {
    super(message);
    this.name = "CardStepError";
  }
}

const DEFAULT_FIELD = "input:not([type=hidden]):not([disabled])";
const KEY_DELAY_MS = 40;

export async function executeCardStep(params: {
  page: Page;
  target: FrameTarget;
  spec: CardStepSpec;
}): Promise<void> {
  const { page, target, spec } = params;
  if (spec.value === undefined || spec.value === "") {
    throw new CardStepError("no-value", "card step has no payload value to type");
  }
  let origin = "";
  try {
    origin = new URL(await readCurrentFrameUrl(page, target)).origin;
  } catch {
    origin = "";
  }
  // The origin of the frame itself, so a main-frame fallback can never match.
  if (target.frame === null || origin !== spec.frameOrigin) {
    throw new CardStepError(
      "wrong-frame",
      `card field is not in the declared payment frame (expected ${spec.frameOrigin}, got ${origin || "none"})`
    );
  }
  const field = target.locator(spec.fieldSelector ?? DEFAULT_FIELD).first();
  try {
    await field.click();
    await field.type(spec.value, { delay: KEY_DELAY_MS });
  } catch {
    throw new CardStepError("type-failed", "typing into the payment frame failed");
  }
  const fieldSel = JSON.stringify(spec.fieldSelector ?? DEFAULT_FIELD);
  const focused = await target
    .evaluate<boolean>(
      `(() => { const el = document.activeElement; return !!el && el !== document.body && el.matches(${fieldSel}); })()`
    )
    .catch(() => false);
  if (!focused) throw new CardStepError("not-focused", "payment field does not hold focus");
  if (spec.completeSelector !== undefined) {
    const completeSel = JSON.stringify(spec.completeSelector);
    const complete = await target
      .evaluate<boolean>(`document.querySelector(${completeSel}) !== null`)
      .catch(() => false);
    if (!complete) {
      throw new CardStepError("incomplete", "payment provider did not mark the card complete");
    }
  }
}
