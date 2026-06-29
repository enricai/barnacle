/**
 * Site-agnostic batch-test verdict type and markdown report renderer. Any
 * plugin batch script can populate `BatchJobVerdict[]` and call
 * `renderBatchReport` to get a consistent table + summary without reimplementing
 * the formatting logic. Site-specific fields (employer, reqNum, hospitalState, etc.)
 * stay in the per-site script; only the cross-cutting outcome fields live here.
 */

/** Per-job outcome produced after the submit + email-poll phases. */
export interface BatchJobVerdict {
  /** Stable job identifier shown in the report row (e.g. reqNum, auditJobId). */
  jobId: string;
  /** Whether the HTTP submit phase succeeded. */
  submitStatus: "PASS" | "FAIL";
  /** Round-trip duration of the submit phase, milliseconds. */
  submitDurationMs: number | null;
  /** Whether a confirmation email arrived during the poll window. */
  emailReceived: boolean;
  /** Subject line of the confirmation email, if one arrived. */
  emailSubject?: string;
  /** Error message from whichever phase failed first. */
  error?: string;
}

export interface RenderBatchReportOptions {
  /** Label for the first column header. Defaults to `"jobId"`. */
  jobIdLabel?: string;
}

/**
 * Renders a markdown table plus a `Net: N/M received confirmation email` summary
 * line for a batch run. Returns the formatted string — callers decide how to emit
 * it (process.stdout.write, logger, file, etc.).
 */
export function renderBatchReport(
  verdicts: BatchJobVerdict[],
  opts: RenderBatchReportOptions = {}
): string {
  const jobIdLabel = opts.jobIdLabel ?? "jobId";
  const rows = [
    `| ${jobIdLabel} | submit | dur (s) | email | subject / error |`,
    `|---|---|---|---|---|`,
    ...verdicts.map((v) => {
      const dur = v.submitDurationMs != null ? (v.submitDurationMs / 1000).toFixed(1) : "-";
      const detail = v.emailSubject ? v.emailSubject.slice(0, 60) : (v.error ?? "—");
      return `| ${v.jobId} | ${v.submitStatus} | ${dur} | ${v.emailReceived ? "Y" : "N"} | ${detail} |`;
    }),
  ];
  const emailCount = verdicts.filter((v) => v.emailReceived).length;
  return `\n${rows.join("\n")}\n\nNet: ${emailCount}/${verdicts.length} received confirmation email\n`;
}
