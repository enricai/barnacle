# `emailStep` flow hook — read the allocated testmail inbox, extract a link/code, and continue an email-gated flow

**Type:** engine capability
**Status:** shipped — schema, inbox threading, and the flow-runner hook (sections 1-3 below) are implemented and merged.
**Precedent mirrored:** the `captchaGated` solve hook (shipped 1.12.29–1.12.32). Same shape: one boolean flow-step flag → a guarded hook block at the top of `processStep` → an engine helper → fail-loud-or-advance.

---

## The gap

Some account flows gate progress on an **emailed step**: after submitting an email you must open a message (a set-password / verify / magic link, or a numeric OTP) and act on it before the flow continues. barnacle can read a testmail inbox — `pollTestmailInbox({inbox, subjectContains, timeoutMs, intervalMs})` in `src/testmail/client.ts` returns a `TestmailMessage {subject, text, html, …}` — but before this capability, that primitive was wired only into test/replay infrastructure. The live recon walk had no way to consume an emailed step: no cascade primitive knew to go read the inbox, extract the URL/code, and resume.

Two concrete consequences motivated the fix:

1. **The allocated inbox was thrown away.** The recon-browser entry point allocated a fresh inbox, bound `inbox.address` to the requested env var, and discarded the `TestmailInbox` object — so its `tag`/`timestampFrom` (needed to *poll* that exact inbox) never reached the flow-runner. Even if a hook wanted to poll, it had no handle.
2. **No flow-step type expressed "go read the email."** `RECON_FLOW_STEP_SCHEMA` had `optional`/`upload`/`submitStep`/`captchaGated` — nothing for an emailed continuation.

## Why it matters (a representative case)

Consider an enterprise SaaS signup flow that routes an unknown email straight to a **login-only** identity-provider page, with no self-service signup — the only new-account-adjacent path is "Reset your password," which emails a link. Account-creation flows that create an account inline with no email/OTP gate don't need this; but a genuinely email-gated account flow was uncovered by both the engine and every existing plugin. This is broadly applicable: many enterprise identity providers verify email on registration.

## Capability

Mirrors `captchaGated` exactly. One opt-in boolean plus a small config object; disabled and zero-cost for every existing flow.

### 1. Schema — `RECON_FLOW_STEP_SCHEMA` (`src/lib/llm/schemas.ts:60`)

```ts
/**
 * Opts a step into the emailed-verification hook: pause, poll the run's
 * allocated testmail inbox for a matching message, extract a link or code
 * from it, and act (navigate to the link, or fill the code into the field
 * the step's prose targets). Absent/false is a no-op for every existing flow.
 */
emailStep: z.boolean().default(false),
/** Config for an `emailStep`. Ignored unless `emailStep` is true. */
emailStepConfig: z
  .object({
    /** Case-insensitive subject substring to match (passed to pollTestmailInbox.subjectContains). */
    subjectContains: z.string().optional(),
    /** What to pull out of the matched message. */
    extract: z.enum(["link", "code"]).default("link"),
    /**
     * For extract:"link" — regex to pick the URL from message text/html
     * (first capture group, else full match). Defaults to the first http(s)
     * URL whose host matches the current page origin's registrable domain.
     */
    linkPattern: z.string().optional(),
    /** For extract:"code" — regex for the OTP/code (defaults to /\b\d{4,8}\b/). */
    codePattern: z.string().optional(),
    /** How to act. "navigate" = goto the link. "fill" = type the code into the step's target field. */
    action: z.enum(["navigate", "fill"]).default("navigate"),
    /** Poll budget ms (default 120_000 — real inbox delivery is slower than a captcha solve). */
    timeoutMs: z.number().optional(),
  })
  .optional(),
```

### 2. The allocated inbox is threaded to the flow-runner (`src/scripts/recon-browser.ts`)

`allocateTestmailInbox()` is called and the resulting `TestmailInbox` is retained (not discarded) at the point the requested env var is bound (`src/scripts/recon-browser.ts:2214-2221`), then passed down through `processStep` params alongside `captchaGated`-style fields (`src/scripts/recon-browser.ts:2523-2525`). If a flow marks `emailStep` but no inbox was allocated (`--allocate-email` absent), the hook fails loud — same philosophy as `CaptchaSolverUnavailableError` — never silent-skip.

### 3. Hook — guarded block in `processStep` (`src/scraper/flow-runner.ts:8396`), modeled on the `captchaGated` block

```ts
if (emailStep) {
  if (!allocatedInbox) {
    // No inbox to poll — fail loud, exactly like the captcha no-key path.
    throw new EmailStepInboxUnavailableError(
      "emailStep set but no testmail inbox allocated (pass --allocate-email)"
    );
  }
  const cfg = emailStepConfig ?? {};
  logger.info(`${formatStepPrefix(stepIndex, totalSteps)} emailStep: polling inbox ${allocatedInbox.address} (subjectContains=${cfg.subjectContains ?? "*"})`);
  const msg = await pollTestmailInbox({
    inbox: allocatedInbox,
    subjectContains: cfg.subjectContains,
    timeoutMs: cfg.timeoutMs ?? 120_000,
  }).catch((err) => {
    logger.error(`${formatStepPrefix(stepIndex, totalSteps)} emailStep: no matching email within budget (${toErrorMessage(err)}); failing the step`);
    throw err;
  });

  if ((cfg.extract ?? "link") === "link") {
    const url = extractLinkFromMessage(msg, cfg.linkPattern, await (frameTarget ?? mainFrameTarget(page)).url());
    if (!url) throw new EmailStepExtractError("no link matched in the verification email");
    logger.info(`${formatStepPrefix(stepIndex, totalSteps)} emailStep: navigating to extracted link`);
    const preIdx = latestCaptureIndex(recentCaptures);
    await page.goto(url); // NEVER log the URL body — it can be a single-use credential
    // Gate advance on the same transition poll the captcha hook reuses.
    if (advanceTransitionBodyPattern) {
      const confirmed = await waitForTransitionBody({ page, preIdx, advanceTransitionBodyPattern, timeoutMs: CAPTCHA_TRANSITION_POLL_MS, intervalMs: ADVANCE_TRANSITION_POLL_INTERVAL_MS });
      if (confirmed) { trajectory?.push({ stepIndex, verifiedBy: "network" }); return "completed"; }
    }
    return "completed";
  }

  // extract:"code" — hand the code to the normal fill cascade as the step's value.
  const code = extractCodeFromMessage(msg, cfg.codePattern);
  if (!code) throw new EmailStepExtractError("no code matched in the verification email");
  // Fall through to the normal fill primitive with `code` spliced as the value,
  // i.e. treat like a fill step whose value came from the inbox rather than the payload.
}
```

The errors thrown by this block, `EmailStepInboxUnavailableError` and `EmailStepExtractError`, live at `src/scraper/errors.ts:365-397`. Two pure helpers (`extractLinkFromMessage`, `extractCodeFromMessage`) do regex-over-`text`-then-`html`, defaulting link selection to "first URL whose host shares the current page's registrable domain" so a flow author usually needn't supply a pattern.

## Security / privacy requirements (non-negotiable, same bar as the captcha hook)

- **Never log the extracted link or code** — either can be a single-use credential. Log only "navigating to extracted link" / "code extracted (len N)".
- Restrict `navigate` to an **allowlist**: the link's host must share the registrable domain of the current page origin (or an explicit `ownBackendHostnames` entry). Refuse to navigate off-domain — a poisoned inbox message must not be able to redirect the session. This is the "never follow a link from untrusted content" rule applied at the engine.
- `pollTestmailInbox` already scopes reads to the run's own `tag` + `timestampFrom`, so it can't see other runs' mail.
- No key/token/URL in telemetry or capture files.

## For recon:generate (the emit side)

An `emailStep` marks a genuine external-dependency step. `emitBrowserFlowTs` in `src/scripts/recon-generate.ts` routes any step with `emailStep: true` around the ordinary payload-splice pipeline and instead emits the same inbox-poll + extract + act sequence the hook uses at runtime (`runHealingFlow`'s `allocatedInbox` path into `pollTestmailInbox`, `src/scraper/flow-runner.ts`). The mailbox is not hardcoded to testmail: the generated flow resolves it once per run from the caller-supplied payload via `testmailInboxFromAddress(payload.Email)` (imported from `@enricai/barnacle/testmail/client`), and that `allocatedInbox` constant is threaded into `runHealingFlow`'s options alongside the step's own `emailStepConfig`. The import, the `allocatedInbox` const, and the `allocatedInbox` option are all emitted only when at least one step declares `emailStep: true` — a flow with no email step is byte-identical to output from before this capability existed. `emitConfigManifest` in the same file rejects any `emailStep` step outright (throwing rather than silently dropping it), since a config-only manifest has no per-site TypeScript and thus no testmail inbox allocation path; `emailStep` requires a module plugin (`--emit module`).

## Scope / non-goals

- v1: testmail inbox for **recon** (unblocks the walk + generate). Production mailbox integration (reading the end user's actual inbox) is a **separate, larger** design — called out but not blocking v1.
- Not auto-detecting email-gated steps; it's **opt-in** per flow, exactly like `captchaGated`.

## What this unblocks

With `emailStep`, an email-gated account flow can be expressed: entry form → captcha (existing hook) → identifier email → "Reset/Set password" → **`emailStep` (poll inbox, extract set-password link, navigate)** → set password → authenticated wizard → submit. Before this capability, that class of flow was unwalkable and ungenerable.
