/**
 * One-off diagnostic: drive a single HCA job to the COMPENSATION worklet and dump
 * the raw server state — the comp field's full label/type/required/value, the
 * EditQuestionItem persistence echo, and the TransitionWorklet response
 * (session_error / errors / advanced-or-not). Answers definitively WHY the two
 * manager-role comp jobs stall after we send "45": value rejected, value not
 * persisted, or a second required field. Files a real app only if it advances
 * past comp — run only on an operator-authorized job.
 *
 * Usage: pnpm tsx --env-file=.env src/scripts/hca-comp-probe.ts <jobUrl>
 */

import { getScriptLogger } from "@/lib/logging";
import type { HcaPayload } from "@/sites/hca/contract";
import {
  destroyFieldSetGroup,
  editQuestionItem,
  loadSession,
  submitFieldSetPayload,
  transitionNext,
  uploadResume,
} from "@/sites/hca/flows/gq-client";
import { parseWorkletState } from "@/sites/hca/flows/http-flow";
import { resolveFieldValue } from "@/sites/hca/flows/question-mapper";
import { bootstrapHcaSession } from "@/sites/hca/tokens/bootstrap";
import { TEST_PERSONA } from "@/testing/persona-fixture";
import { loadTestResume } from "@/testing/resume-fixture";
import { allocateTestmailInbox } from "@/testmail/client";

const logger = getScriptLogger("hca-comp-probe");

/** Pull the `session` object out of whatever /gq operation wrapper the response uses. */
function extractSession(resp: unknown): Record<string, unknown> {
  const r = resp as Record<string, unknown>;
  const data = (r?.data ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(data)) {
    const v = data[k] as Record<string, unknown> | undefined;
    if (v && typeof v === "object" && "session" in v) {
      return (v.session ?? {}) as Record<string, unknown>;
    }
  }
  return (data.session ?? {}) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url) throw new Error("usage: hca-comp-probe <jobUrl>");
  const inbox = allocateTestmailInbox();
  const resume = loadTestResume();
  const payload: HcaPayload = {
    FirstName: TEST_PERSONA.FirstName,
    LastName: TEST_PERSONA.LastName,
    Email: inbox.address,
    MobilePhone: TEST_PERSONA.Phone,
    AddressLine1: TEST_PERSONA.Address.Line1,
    City: TEST_PERSONA.Address.City,
    State: TEST_PERSONA.Address.StateName,
    PostalCode: TEST_PERSONA.Address.PostalCode,
    Country: TEST_PERSONA.Address.CountryName,
    Resume: resume.buffer,
    ResumeFilename: resume.filename,
    ResumeContentType: resume.contentType,
  };

  logger.info(`comp-probe: bootstrapping ${url}`);
  const session = await bootstrapHcaSession(url);
  logger.info(`comp-probe: session ${session.applicationUuid}`);

  for (let i = 0; i < 25; i++) {
    const state = parseWorkletState(extractSession(await loadSession(session)));
    logger.info(
      `comp-probe: on "${state.title}" (${state.progressPercentage}%) fields=${state.fills.length} social=${state.hasSocialSet} nextAllowed=${state.isNextAllowed}`
    );

    if (state.title.toUpperCase().includes("COMPENSATION")) {
      logger.info("comp-probe: ===== COMPENSATION DUMP =====");
      for (const f of state.fills) {
        logger.info(
          `comp-probe:   field kind=${f.kind} req=${f.fillable.required} type=${f.fillable.type} ` +
            `opts=${f.fillable.options.length} label="${f.fillable.label}"`
        );
        const v = resolveFieldValue(f.fillable, payload);
        logger.info(`comp-probe:     mapper→ ${v === null ? "SKIP" : JSON.stringify(v)}`);
        if (v !== null && f.kind === "question") {
          const editResp = await editQuestionItem(session, f.id, v);
          logger.info(
            `comp-probe:     editQuestionItem RESP: ${JSON.stringify(editResp).slice(0, 800)}`
          );
        }
      }
      const after = parseWorkletState(extractSession(await loadSession(session)));
      logger.info(
        `comp-probe: after edits — nextAllowed=${after.isNextAllowed} fields=${after.fills.length}`
      );
      for (const f of after.fills) {
        logger.info(
          `comp-probe:   POST-EDIT field req=${f.fillable.required} type=${f.fillable.type} label="${f.fillable.label.slice(0, 45)}"`
        );
      }
      const resp = await transitionNext(session, state.workletId);
      logger.info(`comp-probe: TRANSITION RESP: ${JSON.stringify(resp).slice(0, 1800)}`);
      const rs = extractSession(resp);
      logger.info(
        `comp-probe: transition → session_error=${JSON.stringify(rs.session_error)} ` +
          `completed=${JSON.stringify(rs.completed)} progress=${JSON.stringify(rs.progress_percentage)}`
      );
      logger.info("comp-probe: DONE (diagnostic stops at COMPENSATION).");
      return;
    }

    // Advance toward COMPENSATION with the same ops the real flow uses.
    for (const entry of state.repeatableEntries) {
      await destroyFieldSetGroup(session, entry.fieldSetId, entry.fieldGroupId);
    }
    if (state.hasSocialSet) {
      await uploadResume(
        session,
        payload.Resume,
        payload.ResumeFilename,
        payload.ResumeContentType
      );
    }
    const fieldIds: string[] = [];
    const fieldValues: string[] = [];
    for (const fill of state.fills) {
      const value = resolveFieldValue(fill.fillable, payload);
      if (value === null) continue;
      if (fill.kind === "field") {
        fieldIds.push(fill.id);
        fieldValues.push(value);
      } else {
        await editQuestionItem(session, fill.id, value);
      }
    }
    if (fieldIds.length > 0) {
      await submitFieldSetPayload(session, state.workletId, fieldIds, fieldValues);
    }
    const resp = await transitionNext(session, state.workletId);
    const rs = extractSession(resp);
    if (/no longer available/i.test(String(rs.session_error ?? ""))) {
      logger.info(`comp-probe: job_expired — ${rs.session_error}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  logger.info("comp-probe: never reached COMPENSATION in 25 transitions");
}

void main().catch((err) => {
  logger.error(`comp-probe crashed: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
