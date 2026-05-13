# Royal Caribbean site reconnaissance

> Verified findings from live inspection of `royalcaribbean.com`, both via
> HTTP fetches (curl + sitemap) and a live headless browser session
> (Stagehand + Steel). All facts below were captured from the wire, not
> guessed.

**Method:** curl + `sitemap_index.xml` + `sitemap_itineraries.xml` walk
for static content, plus a Steel-hosted Chrome driven by Stagehand with
`claude-sonnet-4-6` for SPA + XHR capture.
**Market:** USA / `www.royalcaribbean.com` (root, no locale prefix).
**Last walked:** split recon pipeline —
`src/scripts/recon-browser.ts` (Steel + Stagehand capture),
`src/scripts/recon-http.ts` (HTTP probes + introspection),
`src/scripts/recon-summarize.ts` (rollup writer). Output archived to
`docs/rc-recon-live.md` (gitignored).

---

## robots.txt

Source: `https://www.royalcaribbean.com/robots.txt`.

- `/cruises` — NOT disallowed.
- `/itinerary/…` — NOT disallowed.
- `/graph`, `/cruises/graph`, `/bin/services/royal/*` — NOT disallowed (all
  are used by the public SPA).
- `/booking/`, `/room-selection/`, `/mycruises/`, `/favorites` — disallowed.
  Do NOT target these.
- DotBot is completely banned; generic user-agents are fine.

## Sitemaps

- `https://www.royalcaribbean.com/sitemap/sitemap_index.xml` — root index.
- `https://www.royalcaribbean.com/sitemap/sitemap_itineraries.xml` — every
  public cruise itinerary URL. Each ends in the exact `packageCode` VPS
  uses.

URL pattern:

```
/itinerary/{duration}-night-{destination-slug}-cruise-from-{port-slug}-on-{ship-slug}-{packageCode}
```

Examples: `JW3BH224` (Jewel), `OV03X039` (Ovation), `IC07E479` (Icon),
`WN4BH349` (Wonder). First two chars = ship code; suffix = package.

Regional variants exist for AUS / UK / DE / ES / FR / IT / BR / CN / LAC /
MX / NO / SG / SE.

---

## Direct GraphQL API (the big find)

The SPA calls **two GraphQL endpoints** — both public, both bulk-returning
JSON, both safe to call directly from Node without a browser. Confirmed
via `curl -X POST` with a plain desktop UA, no session token, no cookies:
returned **1018 total cruises** with `packageCode`, `sailDate`, pricing,
promotions.

| Endpoint | Operations |
|----------|------------|
| `POST https://www.royalcaribbean.com/graph` | `GetLocale`, `bestPromotionForMarket`, region/ship metadata |
| `POST https://www.royalcaribbean.com/cruises/graph` | `cruiseSearch_Cruises`, `cruiseSearch_FilterOptions`, `csearchWidget_FacetOptions` |

Required headers:

```http
content-type: application/json
accept: application/json
origin: https://www.royalcaribbean.com
referer: https://www.royalcaribbean.com/cruises
```

No auth header is sent by the site; no auth is required.

### `cruiseSearch_Cruises` — the catalog query

Minimal reproducer (returns cruises + total count):

```bash
curl -X POST https://www.royalcaribbean.com/cruises/graph \
  -H "content-type: application/json" \
  --data-raw '{
    "operationName":"cruiseSearch_Cruises",
    "query":"query cruiseSearch_Cruises($sort:CruiseSearchSort,$pagination:CruiseSearchPagination){cruiseSearch(sort:$sort,pagination:$pagination){results{cruises{id productViewLink lowestPriceSailing{id sailDate}}total}}}",
    "variables":{"sort":{"by":"RECOMMENDED"},"pagination":{"count":10,"skip":0}}
  }'
```

Sample response:

```json
{"data":{"cruiseSearch":{"results":{"cruises":[
  {"id":"WN04MIA-1040267344","productViewLink":"itinerary/4-night-bahamas-perfect-day-cruise-from-miami-on-wonder-WN4BH349?sailDate=2026-09-28&packageCode=WN4BH349&groupId=WN04MIA-1040267344&country=USA","lowestPriceSailing":{"id":"WN4BH351_2026-09-28","sailDate":"2026-09-28"}},
  …
], "total": 1018 }}}}
```

The query supports: `filters` (string-encoded), `qualifiers`, `sort`,
`pagination` (`count` + `skip`), and `nlSearch`. The full query shape
recorded in `docs/rc-recon-live.md` includes `highlights`, cabin prices,
promo text, itinerary map URLs, and more.

### `cruises_FilterOptions` / `csearchWidget_FacetOptions` — facet discovery

Returns the full filter taxonomy + counts per facet code. Observed values:

**destination** — `CARIB` (1621), `BAHAM` (781), `ALCAN` (401 = Alaska /
Canada), `MEXCO` (334), `EUROP` (316), `FAR.E` (191 = Far East),
`BERMU` (56), `SOPAC` (55 = South Pacific), `AUSTL` (45),
`ATLCO` (24), `T.ATL` (18 = Transatlantic), `TPACI` (9), `ISLAN` (7),
`HAWAI` (3), `PACIF` (3), `T.PAN` (1).

**nights** — integer buckets (7 has the most at 14xx, plus 3/4/5/6/8/9/10+).

Other filter keys the probe reveals: `accessible` (boolean), `departureDate`
(date range), `departurePort`, `cruiseLength`, `guest`, `ship`,
`stateroomClass`, `sort` (RECOMMENDED | PRICE | SAIL_DATE).

---

## Result cards — live Stagehand extract

From a real search (Caribbean, 2026, 2 guests):

| shipName | sailDate | nights | departurePort | startingPrice |
|----------|----------|--------|----------------|---------------|
| Wonder of the Seas | Sep 28, 2026 | 4 | Miami, FL | $497 |
| Wonder of the Seas | Oct 2, 2026 | 3 | Miami, FL | $461 |
| Icon of the Seas | May 30, 2026 | 7 | Miami, FL | $1,273 |
| Freedom of the Seas | Oct 17, 2026 | 5 | Miami, FL | $423 |
| Freedom of the Seas | Aug 22, 2026 | 5 | Miami, FL | $581 |

Card HTML uses `class="cruise-card"` (no stable data-testid on the card
itself). Badges visible: "Last Minute Cruise Deals", "Early Booking Bonus".

## Pagination

**Mechanism:** `load-more` button (explicit "Load More" text). Observed
in the live DOM after scrolling past the first batch. The GraphQL
endpoint also supports `pagination: { count, skip }` for direct API
paging.

## `/itinerary/{…}-{packageCode}` — detail page

Substantially server-rendered. A plain `curl` returned **97 unique
`data-testid` attributes**. Key ones for our Zod schema:

| Field | data-testid | Rendered where |
|-------|-------------|----------------|
| Itinerary name | `hero-itinerary-name` | SSR |
| Ship name | `hero-ship-name`, `ship-name` | SSR |
| Nights | `hero-number-of-nights` | SSR |
| Departure/arrival ports | `hero-departure-arrival-ports` | SSR |
| Itinerary day list | `chapter-list-item-0..N`, `chapter-section-N-name` | SSR |
| Attribute tags | `attribute-list` | SSR |
| Pricing bar | `pricing-bar`, `pricing-mobile-selector` | CSR (placeholder + client fetch) |

**Sail dates + cabin pricing are CSR.** The hydration calls the same
`/cruises/graph` endpoint for per-sailing pricing — same direct path as
catalog discovery.

---

## Implementation consequences

Given the GraphQL endpoint is public and callable without a browser:

1. **Primary catalog path → direct HTTP.** `src/services/sailing-catalog.ts`
   should issue `cruiseSearch_Cruises` against `/cruises/graph` with the
   right filters, paginating via `count/skip`. No Steel minutes used.
   Implementation is a thin `fetch()` wrapper.

2. **Stagehand becomes a fallback.** Use it only when:
   - GraphQL shape drifts in a breaking way (Stagehand's AI adapts, static
     code breaks).
   - RC adds a bot challenge to the GraphQL endpoint (hasn't yet — it's
     the SPA's own backend).
   - An unusual query that doesn't map cleanly to the GraphQL variables.

3. **Sitemap stays useful for cold-start enumeration.**
   `src/scraper/sitemap.ts` already parses it; combine with the GraphQL
   search for full catalog coverage.

4. **Promotions** → `bestPromotionForMarket` query on `/graph`.

## Known hazards

- **Akamai bot detection** — RC posts to `/0k5EPrqOSRkyqDEVcg/…` (Akamai
  Bot Manager beacon) on every page load. Plain curl to `/cruises/graph`
  still works, but high-rate requests could trip it. Rate-limit via our
  existing `bottleneck` wrapper and use the sitemap for cold discovery.
- **UI drift** — GraphQL schemas change; keep `scripts/recon-browser.ts` +
  `scripts/recon-http.ts` runnable in CI so drift surfaces as a schema-parse
  failure.
- **Regional pricing** — the `locale` query (`GetLocale(localeCountry:"USA")`)
  returns `office=MIA, currency=USD`; other markets would pass a
  different country and receive different offices/currencies. Mapping
  stays aligned with VPS's market/office/currency triplet.

## Resolved open items (from 2026-05-12 recon)

Captures on disk under `/tmp/recon/` (gitignored); see `docs/rc-recon-live.md`
for the regenerated summary. Script entry points: `recon-browser.ts`,
`recon-http.ts`, `recon-summarize.ts`.

### 1. GraphQL introspection — DISABLED

Both `POST /graph` and `POST /cruises/graph` return `200` for a
`{__schema{types{name}}}` probe but with no `data.__schema` payload —
introspection is disabled in production. No typed-client codegen path;
we have to hand-write type definitions from captured queries.

### 2. Rate-limit behaviour — NO THROTTLING UP TO 5 rps × 60

Probed via 60 sequential `cruiseSearch_Cruises` calls @ 5 rps from a
plain Node egress IP (no residential proxy). 60/60 returned 200, zero
429/403. `retry-after` / `x-ratelimit-*` headers never set. Direct-HTTP
catalog strategy is viable. Still wrap in `bottleneck` for politeness
and to stay under whatever threshold we haven't probed yet.

### 3. `filters` string encoding — PARTIALLY RESOLVED, use "no filter" path

- **Single predicate:** `key:value` (e.g. `destination:CARIB`) — confirmed.
- **Multi-value OR within a key:** `key:v1,v2` (e.g. `destination:CARIB,BAHAM`)
  — confirmed.
- **Multi-key AND:** UNRESOLVED. Every separator tried (`;`, `,`, `&`,
  `|`, `+`, space, `AND`, `&&`) either collapsed to the first predicate
  or returned zero matches.
- **Response non-determinism:** identical requests return different
  `total` counts on repeat (observed 259 / 340 / 822 / 1006 for the
  same literal), implying RC's backend partitions cache by qualifiers
  / session state the SPA sets up.

**Implementation consequence:** the simplest, most robust path is to
**paginate `cruiseSearch_Cruises` without `filters`** (empty string) and
apply VPS-parity predicates (`brandCode`, `fromSailDate`..`toSailDate`,
`shipCodes`, `includeTourPackages`) **client-side** on the response's
`productViewLink` (contains `packageCode`, `sailDate`, `groupId`,
`country`) and `lowestPriceSailing.sailDate`. Full pagination via
`pagination: {count, skip}` until `cruises.length < count` OR
`skip >= total`. Sidesteps both the encoding uncertainty and the
non-determinism.

### 4. Detail-page CSR GraphQL ops — NOT CAPTURED THIS RUN

The browser recon's `/itinerary/…` navigation timed out before hydration
fired the per-sailing pricing queries (the captures all landed in the
`home` phase). Not a blocker: we already know from the `cruiseSearch_Cruises`
response that `lowestPriceSailing` + `lowestStateroomClassPrice` + currency
are returned at the list level. For per-cabin breakdowns, next recon pass
should keep the session alive longer on the detail page.

### 5. `markets-all` aux endpoint — VPS market triplet available for free

`GET /bin/services/royal/markets/all` returns the **exact**
market/office/country/currency/agencyId tuples VPS's requests require.
Sample rows (out of ~16):

| market | office | country | language | agencyId |
|--------|--------|---------|----------|----------|
| usa | MIA | USA | en | 156393 |
| esp | SPA | ESP | es | 192679 |
| gbr | LON | gbr | en | 156473 |
| deu | FRA | deu | de | 204185 |
| fra | PAR | fra | fr | 386322 |
| ita | GEN | ita | it | 310559 |
| mex | MEX | mex | es | 279277 |
| bra | IBR | bra | pt | 386526 |
| nor | OSL | nor | no | 157197 |

This removes any guesswork from VPS's `officeCode` / `countryCode` /
`currencyCode` fields on pricing requests. `GetLocale(localeCountry:"USA")`
on `/graph` returns the same info for single-market queries.

### 6. Filter taxonomy — FULLY CAPTURED

`cruises_FilterOptions` on `/cruises/graph` returns 17 filter keys:
`accessible`, `destination` (16 facets), `nights` (19 facets), `port`
(223 facets), `ship` (31 facets), `startDate` (24 facets), `voyageType`,
`visiting` (576 facets — POI-level), `departurePort` (31 facets),
`coupon`, `crownAndAnchorNumber`, `military`, `police`, `senior`,
`resident`, `custom` (13 facets — seasonal promos), `sort`.

Full JSON at `/tmp/recon/graphql/006-home-anon.json`.

### 7. Multi-key AND in `filters` — ACCEPTED BUT ONLY FIRST PREDICATE APPLIED

Ran a probe matrix of 55 encodings × 3 repeats, then a v2 validation
matrix of 24 encodings × 5 repeats (see `/tmp/recon/filter-probe-matrix.json`
and `/tmp/recon/filter-probe-matrix-v2.json`). Findings:

- **Single predicate, list type:** `key:value`. Stable 5/5 for
  `destination:ALCAN` (296), `ship:WN` (4), `ship:IC` (10),
  `departurePort:FLL` (97).
- **Within-key OR:** `key:v1,v2` (e.g. `destination:CARIB,BAHAM`).
  Confirmed via recon-filter-probe.
- **Range filter syntax:** `key:min~max` (tilde). Narrows but with
  1-8 count jitter (`nights:7~7`→~282, `nights:3~5`→~187,
  `startDate:2026-06-01~2026-06-30`→~62). Tilde is correct; jitter
  is the same cache-layer effect that drifts baseline totals.
- **Multi-key AND:** `::` separator is parsed (request returns stable
  results) but **only the first predicate is actually applied**:
  `destination:CARIB::ship:WN` → 340 (same as `destination:CARIB`
  alone), `destination:BAHAM::departurePort:MIA` → 67 (same as
  `destination:BAHAM` alone). `destination:BAHAM::nights:3~5` → 67
  (same as Bahamas-only). No separator tested achieved true
  intersection.

**Implementation consequence:** the direct-HTTP client sends ONE
most-selective predicate (shipCodes > destination > date range)
and applies the rest client-side on `productViewLink` +
`lowestPriceSailing.sailDate`. Even with just the destination
predicate, 1006 → 259 cruises = 4× reduction for free.

### 8. Detail-page per-cabin pricing — RESOLVED

The `/itinerary/...` detail page **does not fire any per-sailing
pricing call against `/cruises/graph`** on load — every captured
run (three attempts) shows zero detail-phase GraphQL activity even
when `[data-testid="pricing-bar"]` is visible and clicked.

**BUT:** the RSC (React Server Components) hydration payload
embedded in the SSR HTML **does** contain a `lowestPrice` struct
for the package:

```json
"lowestPrice": { "amount": 460.51, "total": 921.02 },
"totalSailings": 92,
"resolvedSearchParams": { "sailDate": "2026-10-02", "packageCode": "WN3BH177" }
```

Captured by plain `curl` — no browser, no Steel.

**Per-super-category pricing** (Interior / Outside / Balcony / Deluxe
= VPS codes I/O/B/D) IS reachable for free at the list level via
`cruiseSearch_Cruises.cruises[].sailings[].stateroomClassPricing`.
Live capture against `/cruises/graph` (no browser, no Steel,
default desktop UA) returns one entry per super-category per
sailing with the full price breakdown VPS expects:

```json
{
  "price": {
    "value": 915.43,
    "originalAmount": 1356.43,
    "netAmount": 915.43,
    "discountAmount": 441,
    "taxesAndFeesAmount": 137.43,
    "areTaxesAndFeesIncluded": true,
    "currency": { "code": "USD" }
  },
  "stateroomClass": { "id": "INTERIOR", "content": { "code": "I" } }
}
```

Mapping to VPS:

| RC GraphQL `stateroomClass.content.code` | RC `stateroomClass.id` | VPS `superCategoryCode` | VPS `superCategoryName` |
|------------------------------------------|------------------------|-------------------------|-------------------------|
| `I` | `INTERIOR` | `I` | `INSIDE` |
| `O` | `OUTSIDE` | `O` | `OUTSIDE` |
| `B` | `BALCONY` | `B` | `BALCONY` |
| `D` | `DELUXE`  | `D` | `DELUXE` |

Codes line up 1:1 with the four super-categories used by VPS's
`super-category-pricing` sample response. (`Sample Super Category
Pricing Request and Response.json` shows the same I/O/B/D set;
no separate Aqua/Concierge super-category is exposed in the VPS
contract — those are *fine* categories beneath D.)

**Per-FINE-category pricing** (specific stateroom codes like J3, 4N,
4V — what VPS's `category-pricing` endpoint exposes) is NOT in the
SSR and NOT fired on `/cruises/graph` page load by the SPA.
Probably fires when a user selects a specific sail-date in the
pricing-bar widget; the free-tier (datacenter-IP) browser sessions
can't reliably drive that hydration through Akamai.

**Decision:** stick with the **extrapolation path** for now —
no Steel-tier upgrade.

  - `super-category-pricing` parity: **fully satisfied for free**
    via `stateroomClassPricing[]` on each sailing. The existing
    `mapStateroomClassPricing()` in `src/scraper/flows/graphql-catalog.ts`
    already pipes this into `ScrapedSailing.cabinOptions` and the
    `services/pricing.ts` super-category service consumes it.
  - `category-pricing` parity: **best-effort** — the initial
    release surfaces only super-category granularity. The
    Stagehand fallback flow (`src/scraper/flows/pricing.ts`)
    remains the path for per-fine-category requests, but free-tier
    datacenter IPs hit intermittent Akamai challenges, so callers
    that demand category-level precision will see degraded
    coverage until a residential-proxy upgrade.

A residential-proxy upgrade (Steel Starter, ~$29/mo) is the path
forward if a downstream client needs full `category-pricing`
parity. Track that as a paid-action prerequisite — do NOT auto-
upgrade. When/if upgraded, re-run `pnpm run recon:browser` with
session keep-alive on `/itinerary/{packageCode}` after a sailDate
selection and capture the per-fine-category XHR(s); document the
new GraphQL operation here before wiring into the service layer.

## Remaining open items

1. **Per-FINE-category pricing hydration flow** — only relevant for
   the VPS `category-pricing` endpoint (specific stateroom codes
   like J3, 4N, 4V), not for `super-category-pricing`. Super-
   category parity is already met for free via §8. Free-tier
   datacenter IPs cannot reliably trigger the per-fine-category
   hydration on `/itinerary/{packageCode}` — Akamai serves stripped
   pages. Cleared as a launch blocker only if a downstream client
   demands fine-category precision; otherwise the Stagehand fallback
   in `src/scraper/flows/pricing.ts` covers ad-hoc requests at
   degraded reliability. Resolution path when needed: upgrade Steel
   to a residential-proxy tier and re-run `recon-browser` with a
   long-lived session that selects a sailDate before XHR capture.
2. **Production rate-limit ceiling** — probed 5 rps × 60, no throttling.
   Higher thresholds unexplored on purpose (don't burn the egress IP).
