# Royal Caribbean site reconnaissance

> **TASKS.md Task 3** — live reconnaissance of `royalcaribbean.com/cruises`.
> Fill in each section during a manual walkthrough. The findings here drive
> prompt tuning for `src/scraper/flows/*.ts` and the Zod extract schemas.

**Last walked:** _(YYYY-MM-DD, your name)_
**Browser:** _(Chromium / Safari / …)_
**Market:** _(USA / CAN / UK / …)_

---

## (a) Filter widgets

One entry per filter widget on the search page. Note exactly what each widget
accepts, whether it's a single-select, multi-select, free-text, or date
picker, and what happens if the user leaves it empty.

| Widget | Type | Accepted values | Required? | Notes |
|--------|------|-----------------|-----------|-------|
| Destination | multi-select | ALASKA, BAHAMAS, CARIBBEAN, … | No | _Short list? Popular vs all?_ |
| Departure port | single-select | MIA, FLL, CIV, … | No | |
| Date range | date-picker (from, to) | YYYY-MM-DD | No | _Does RC round to month?_ |
| Cruise length | multi-select | 2-5n, 6-9n, 10n+ | No | _Exact buckets RC ships_ |
| Number of guests | number + age bucket | 1-8 | Yes (defaults to 2) | |
| Cabin type | multi-select | Inside / Oceanview / Balcony / Suite | No | |
| Ship | single-select | ship codes (RD, AL, …) | No | |

**Prompt hooks to fill in:** after recording exact widget labels, update the
`page.act()` prompts in `src/scraper/flows/sailing-package.ts` to reference
the actual DOM labels rather than the generic descriptions shipped today.

## (b) Results loading pattern

Select one:

- [ ] **Pagination** — a "next" button loads the next page.
- [ ] **Infinite scroll** — scrolling to the bottom auto-loads more.
- [ ] **Load more button** — a button below the list loads the next batch.
- [ ] **Batch** — all results render on initial load; no pagination.

Evidence:

- DOM element (selector, text, role): _(e.g. `button[data-test="load-more"]`)_
- Page count observed: _(e.g. ~20 per batch, up to 8 batches)_
- Loading latency: _(e.g. ~1.5 s to stabilize after trigger)_

The scraper flow in `src/scraper/flows/sailing-package.ts` already handles
both next-button and scroll variants via a pagination-probe extract; after
recon, narrow the prompt to the exact mechanism in use so Stagehand converges
faster.

## (c) Card vs detail data

Not every field is on the card. List every field you need, and whether it's
available on the **card** (results-page view) or requires a click into the
**detail** page.

| Field | On card? | Detail page only? | Notes |
|-------|----------|-------------------|-------|
| shipName | [ ] | [ ] | |
| shipCode | [ ] | [ ] | _Sometimes implicit in card URL_ |
| sailDate | [ ] | [ ] | |
| packageCode | [ ] | [ ] | _Usually in the detail URL_ |
| duration (nights) | [ ] | [ ] | |
| departurePort | [ ] | [ ] | |
| destinations[] | [ ] | [ ] | |
| itinerary stops | [ ] | [ ] | _Usually detail only_ |
| cabinOptions[] (pricing) | [ ] | [ ] | _Usually detail only_ |
| bookingUrl | [ ] | [ ] | |
| lead promotion short description | [ ] | [ ] | |

**Implication for the flow:** if any required field is detail-only, the
`enrichPricing` option on `scrapeSailingPackages()` (already implemented)
should be set to `true` in the services for that field. Adjust
`maxDetailEnrichments` to bound Steel session cost.

## Follow-up checklist

- [ ] Updated `src/scraper/flows/sailing-package.ts` prompts with exact DOM labels.
- [ ] Updated `scrapedSailingSchema` in the same file if card fields differ.
- [ ] Set `enrichPricing` + `maxDetailEnrichments` in the service layer based on
  what's detail-only.
- [ ] Ran `pnpm run smoke` against a real sailing to confirm the flow returns
  structured data matching the VPS response schema.
- [ ] Added an entry to this doc's "Last walked" header so the next person
  knows how stale the recon is.

## Known hazards

- **CAPTCHA**: Steel's `solveCaptcha: true` handles the common ones. If RC
  rolls a new challenge, the scraper surfaces a `CaptchaEncounteredError` →
  code 2004 in the VPS envelope. Check the scraper logs for rate.
- **Bot detection / IP bans**: residential proxies via Steel
  (`useProxy: true`). If RC still blocks, rotate the Steel session pool size
  down or add backoff.
- **UI drift**: Stagehand's built-in action cache expires silently when the
  cached action fails; the next attempt falls back to fresh AI resolution.
  The `smoke-test.ts` script detects drift by running a known query daily.
