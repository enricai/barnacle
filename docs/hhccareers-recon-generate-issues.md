# hhccareers recon/generate — reporter context

> Environment context supporting
> [barnacle-report-recon-generate-phenom.md](./barnacle-report-recon-generate-phenom.md)
> (the failure report) and
> [hhccareers-apply-flow.md](./hhccareers-apply-flow.md) (the captured ground
> truth). Records only the surrounding facts observed during the run — no
> additional defects beyond those in the report.

Supporting context for the failure report and the captured ground truth. This
file records only the surrounding environment facts observed during the run — it
lists no additional defects beyond those in the report.

**Engine:** `@enricai/barnacle@1.7.3`. **Target:** `www.hhccareers.org` — Phenom
People front-end → Oracle Taleo backend (tenant `refNum=HHKHHEUS`), employer
Hartford HealthCare. First Phenom-fronted target.

## Environment facts observed

- **Stale live targets.** The consumer's resolved-URL cache freshest hhccareers
  URL was ~2 months old; of the 20 freshest cached URLs, 15 returned HTTP 410 Gone
  and only 5 were live (200). Recon had to be pointed at a currently-live posting.
  Live one used: `…/job/HHKHHEUS26158515EXTERNALENUS/…-Post-Anesthesia-Care-Unit`.
- **Phenom jobs search API is tenant-gated.** `/api/apply/v2/jobs` returned
  `"Tenant not identified"` without a tenant id; the tenant `HHKHHEUS` is visible
  only in the apply-config path `content-us.phenompeople.com/api/HHKHHEUS/…`.

## State of the generated artifacts

The recon-generated files (`contract.ts`, `flows/browser-flow.ts`, `index.ts`)
were produced in the consumer repo and left in place for inspection. Per the
failure report, `contract.ts`/`browser-flow.ts` are non-functional (FAILUREs 3-4);
`index.ts` (the `hhccareersPlugin as plugin` barrel) is the one correct artifact.
At the time of this run the generated plugin did **not** load in the consumer's
runtime: its generated `contract.ts` imports `bottleneck` (a barnacle dependency the
generated header calls for via `pnpm add bottleneck zod`), which the consumer repo
(`nursefly/autoapply`) did not declare in its own dependencies — a consumer-side dep
gap, not an engine defect (see the report's "Not engine defects" section). It has
since been added (nursefly/autoapply#107), so the plugin now loads.

The real apply flow was captured manually (Playwright), stopping before final
submit — see
[hhccareers-apply-flow.md](./hhccareers-apply-flow.md).
