# Royal Caribbean site reconnaissance

> Verified findings from live inspection of `royalcaribbean.com`, both via
> HTTP fetches (curl + sitemap) and a live headless browser session
> (Stagehand + Steel). All facts below were captured from the wire, not
> guessed.

**Method:** curl + `sitemap_index.xml` + `sitemap_itineraries.xml` walk
for static content, plus a Steel-hosted Chrome driven by Stagehand with
`claude-sonnet-4-6` for SPA + XHR capture.
**Market:** USA / `www.royalcaribbean.com` (root, no locale prefix).
**Last walked:** automated recon script (`pnpm exec tsx src/scripts/recon.ts`);
output archived to `docs/rc-recon-live.md` (gitignored).

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

## Remaining open items

1. **Multi-key AND composition in `filters`** — if we ever want to push
   predicates server-side rather than filter client-side, the encoding
   is still unknown. The SPA in observed captures always sent
   `filters: ""` and let the backend session infer them, so this may
   not have a pure-HTTP answer.
2. **Detail-page per-cabin pricing queries** — next recon pass should
   hold the `/itinerary/…` page longer so hydration GraphQL fires before
   close.
3. **Production rate-limit ceiling** — probed 5 rps × 60, no throttling.
   Higher thresholds unexplored on purpose (don't burn the egress IP).
