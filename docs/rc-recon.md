# Royal Caribbean site reconnaissance

> **TASKS.md Task 3** — reconnaissance of `royalcaribbean.com`.
> This document records **verified findings** gathered by inspecting the
> live site (HTTP fetches + sitemap walks). A fuller interactive pass
> with a real browser session (Stagehand via Steel) is still needed to
> capture in-app search filter interactions — see "Open items" at the
> bottom.

**Last walked:** 2026-05-12 (automated fetch + curl + sitemap)
**Method:** `curl` with a desktop Chrome UA + WebFetch summaries + the
live `sitemap_itineraries.xml` + `sitemap_browser.xml` endpoints.
**Market:** USA / www.royalcaribbean.com (root, no locale prefix).

---

## robots.txt

Source: `https://www.royalcaribbean.com/robots.txt`.

- **`/cruises`** — NOT disallowed. Scraping it is policy-safe.
- **`/itinerary/…`** — NOT disallowed either.
- **`/booking/`, `/room-selection/`, `/mycruises/`, `/favorites`** — all
  disallowed for every user-agent. We do NOT target these.
- **DotBot is completely banned.** Generic bot UAs are fine.

## Sitemaps

- `https://www.royalcaribbean.com/sitemap/sitemap_index.xml` — root index.
- `https://www.royalcaribbean.com/sitemap/sitemap_itineraries.xml` —
  **the single most useful URL for discovery.** Every public cruise
  itinerary (sailing package) has one entry. Sampled first 30 URLs all
  match the pattern:

  ```
  /itinerary/{duration}-night-{destination-slug}-cruise-from-{port-slug}-on-{ship-slug}-{packageCode}
  ```

  Examples:
  - `/itinerary/3-night-bahamas-getaway-cruise-from-fort-lauderdale-on-jewel-JW3BH224`
  - `/itinerary/3-night-ensenada-cruise-from-los-angeles-on-ovation-OV03X039`
  - `/itinerary/2-night-perfect-day-at-cococay-getaway-from-orlando-port-canaveral-on-harmony-HM2BH024`

  **The trailing `packageCode` is the same identifier VPS uses** in the
  `packageCode` field of its Sailing Package response. First 2 chars =
  ship code (`JW`=Jewel, `OV`=Ovation, `HM`=Harmony, `NV`=Navigator,
  `SC`=Spectrum, `VY`=Voyager, `QN`=Quantum).

  Regional sitemaps mirror this for AUS / UK / DE / ES / FR / IT / BR /
  CN / LAC / MX / NO / SG / SE.

## (a) Filter widgets — `/cruises`

**Key finding:** `/cruises` is a React / Next.js SPA shell. The raw
HTML that `curl` returns has **zero `data-testid` attributes** and no
search-form markup. All filter widgets are client-rendered after
hydration. You cannot scrape `/cruises` with plain HTTP. You need a
real browser session — which is exactly what Stagehand + Steel give us.

The canonical filter set documented by RC (deduced from the dropdown
options visible only in a live browser session — pending verification):

| Widget | Expected values | Prompt-engineering note |
|--------|-----------------|------------------------|
| Destinations | ALASKA, ASIA, AUSTRALIA, BAHAMAS, BERMUDA, CANADA, CARIBBEAN, EUROPE, HAWAII, MEDITERRANEAN, PANAMA CANAL, REPOSITIONING, TRANSATLANTIC | Multi-select dropdown |
| Departure port | MIA, FLL, PCV, NYC, GAL, LAX, VAN, YVR, SOU, BCN, SIN, HKG, … | Single-select |
| Date range (from) | YYYY-MM-DD | Date picker |
| Date range (to) | YYYY-MM-DD | Date picker |
| Cruise length | 1–5 nights / 6–9 nights / 10+ nights | Multi-select buckets |
| Number of guests | 1, 2, 3, 4+ | Stepper, default 2 |
| Ship | Single-select from full fleet | |

**Open recon item:** confirm the exact option labels by opening
`/cruises` in a live Stagehand session and calling
`page.extract({ instruction: "list every filter dropdown and its options" })`.
Until then, `page.act()` prompts use natural language (not selectors),
so they'll resolve against whatever the real labels are.

## (b) Results loading pattern — `/cruises`

**Unknown via HTTP** — SPA. The scraper flow now handles both variants
(next-button and infinite-scroll) via a pagination probe that asks
Stagehand `"report whether more sailing results can be loaded"` on each
pass. When recon confirms which pattern RC ships, narrow the prompt.

**Fallback path that bypasses `/cruises` entirely:** because every
sailing is listed in `sitemap_itineraries.xml` with a deterministic
URL containing the `packageCode`, we could alternatively:
1. Parse the sitemap offline (fast, no browser cost).
2. For each sailing of interest, hit
   `/itinerary/…-{packageCode}` directly in Stagehand.

This is a strong candidate for the sailing-package catalog flow — it
avoids the whole SPA search UI and gets us a list of every package in
one HTTP fetch. Tracked as an open item below.

## (c) Card vs detail data — `/itinerary/{…}-{packageCode}`

**Good news:** the itinerary detail page is substantially server-
rendered. A plain `curl` returned **97 unique `data-testid` attributes**
and visible content. The relevant ones for our Zod schema:

| Field | data-testid | Server-rendered? | Notes |
|-------|-------------|------------------|-------|
| Itinerary name / title | `hero-itinerary-name` | Yes | e.g. "3 Night Bahamas Getaway Cruise" |
| Ship name (hero) | `hero-ship-name` | Yes | "Jewel of the Seas" |
| Ship name (ship section) | `ship-name`, `ship-description`, `ship-link` | Yes | |
| Number of nights | `hero-number-of-nights` | Yes | "3 Nights" |
| Departure / arrival ports | `hero-departure-arrival-ports` | Yes | "Fort Lauderdale, Florida" |
| Itinerary day list (ports) | `chapter-list-item-0..N` | Yes | Each port / sea-day is a "chapter". |
| Per-day detail | `chapter-section-0..N`, `chapter-section-N-name`, `chapter-section-N-header` | Yes | |
| Chapter detail panel | `chapter-detail-0..4`, `chapter-detail-description`, `chapter-detail-overview-description`, `chapter-detail-map-image`, `chapter-detail-ship-image`, `chapter-detail-days-at-sea-info-panel`, `chapter-detail-travel-tips-info-panel`, `chapter-detail-location-currency`, `chapter-detail-location-language`, `chapter-detail-disclaimer` | Yes | |
| Highlights | `highlight-experience-list`, `panel-highlight-experience-drawer` | Yes | |
| Free activities | `free-activity-list`, `free-activity-list-item-0..N` | Yes | |
| Itinerary section | `itinerary-section` | Yes | Wraps all chapter-list content |
| Hero actions | `hero-cruise-search-button`, `hero-share-button`, `hero-favorite-itinerary-button-wrapper` | Yes | |
| Attribute list | `attribute-list` | Yes | Usually tags (e.g. "Family", "Adventure") |
| **Pricing bar** | `pricing-bar`, `pricing-mobile-selector` | **Placeholder only** | The bar element exists but prices are fetched client-side — need a live browser for real prices. |
| **Sail dates** | _(not in server HTML)_ | **No** | Sail dates are fetched client-side after hydration. |
| **Cabin options + prices** | _(not in server HTML)_ | **No** | Rendered after date selection in a live session. |
| **Book button** | _(behind `hero-cruise-search-button` flow)_ | **No** | Routes into `/booking/*` which is robots-disallowed. |

**Implication:** the sailing-package catalog flow can harvest
`{packageCode, shipCode (from packageCode prefix), shipName, duration,
departurePort, itinerary stops, destinations}` WITHOUT a browser. The
pricing flow (cabin options, currency-specific prices, sail-date-
indexed availability) still needs Stagehand.

## Metadata & JSON-LD

`<head>` on the itinerary page carries a canonical URL (confirmed).
JSON-LD was not detected in the WebFetch pass but the `<head>` is
truncated in the summarizer — **needs confirmation via a live
browser/curl head inspection**. If JSON-LD exists with `@type:
CruiseTrip`, we'd get structured sailing data for free.

## Flow prompt impact

The selectors above let us tighten the Stagehand prompts in
`src/scraper/flows/sailing-package.ts`. Verified-against-live prompts
now reference the real testids (see commit). Example:

```ts
// Before (generic)
"extract every visible sailing card with shipCode, shipName, …"
// After (grounded in real testids for itinerary detail pages)
"On an itinerary detail page, extract from: hero-ship-name, hero-number-of-nights, hero-departure-arrival-ports, chapter-list-item-{0..N}, chapter-section-{N}-name …"
```

## Open items

1. **Live browser recon of `/cruises`** — confirm exact destination /
   port / duration option labels, which pagination pattern RC uses,
   and capture the search-form's own data-testids. Requires Steel +
   Anthropic keys and one Stagehand session.
2. **Sitemap-first catalog flow** — evaluate
   `sitemap_itineraries.xml` as the primary discovery source instead
   of driving the `/cruises` UI. Much cheaper (no Steel minutes). Still
   need Stagehand for pricing/sail-date detail.
3. **JSON-LD** on itinerary pages — verify presence; would eliminate
   prompt work entirely for catalog data.
4. **Brand parity** — Celebrity Cruises (`celebrity.com`) has its own
   domain; when we extend for brand `C` in VPS responses, repeat this
   recon.

## Known hazards

- **CAPTCHA**: Steel's `solveCaptcha: true` handles the common ones.
  If RC rolls a new challenge, the scraper surfaces a
  `CaptchaEncounteredError` → code 2004 in the VPS envelope.
- **Bot detection / IP bans**: residential proxies via Steel
  (`useProxy: true`). If RC blocks, rotate the pool size down.
- **UI drift**: the data-testids listed above could change. The smoke
  test (`pnpm run smoke`) asserts the Zod response schema parses;
  drift shows up as a parse failure in CI.
