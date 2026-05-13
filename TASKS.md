RC Cruise Scraper API — Task Breakdown
Phase 1 — Environment & Infrastructure Setup
Task 1: Initialize the project repo
Create a Node.js/TypeScript project. Install @browserbasehq/stagehand, steel-sdk, zod, express (or Fastify), and dotenv. Set up .env for Steel API key, Browserbase API key, and LLM key (Claude Sonnet or GPT-4o — Stagehand needs one). Configure tsconfig.json for modern TS.
Task 2: Spin up Steel browser session
Write a session factory that creates a Steel cloud browser session per request, connects Stagehand to it via the Steel CDP endpoint, and tears it down after extraction completes. Steel handles proxy rotation and CAPTCHA — configure it to use residential proxies from the start, RC will block datacenter IPs.

Phase 2 — RC Site Exploration & Schema Design
Task 3: Manual reconnaissance of the RC search flow
A developer manually walks through royalcaribbean.com/cruises and documents: (a) every filter widget and its behavior — destination, departure port, date range, cruise length, number of guests, cabin type; (b) how results load (pagination, infinite scroll, or batch); (c) what data is present on the results cards vs. what requires clicking into a sailing detail page. This is the spec input for Tasks 4 and 5.
Task 4: Define the output Zod schema
Before writing any automation, lock the data contract. Minimum viable schema should include: sailingId, shipName, departurePort, departureDate, returnDate, durationNights, destinations (array), cabinOptions (array of {type, pricePerPerson, currency}), bookingUrl. This schema drives Stagehand's extract() calls and is what your API returns.

Phase 3 — Automation Script
Task 5: Build the search filter interaction script
Using Stagehand's act() primitive, write a script that accepts search parameters and drives the RC search form: navigate to /cruises, apply each filter (departure port, destination, date range, duration, guest count), wait for results to render. Use act() for each discrete interaction — don't use agent() here, you want deterministic control on the critical path.
Task 6: Build the results extraction script
Using Stagehand's extract() with the Zod schema from Task 4, pull all visible sailing cards from the results page. Handle pagination or scroll-to-load. For each result, decide whether pricing detail requires navigating into the sailing page — if yes, write a secondary extract() that opens each sailing and pulls cabin-level pricing, then returns to results.
Task 7: Implement Stagehand caching
Stagehand has built-in action caching — enable it. This means after the first run on a given page structure, subsequent runs skip LLM inference and replay cached actions. This cuts latency and LLM cost dramatically. Also implement cache invalidation logic: if RC updates their UI and an action fails, the cache busts and falls back to AI resolution automatically.

Phase 4 — API Wrapper
Task 8: Build the HTTP API layer
Wrap the automation in an Express/Fastify API with a single endpoint: POST /search. Request body accepts the search parameters matching RC's filters. The handler instantiates a Steel session, runs Tasks 5+6 scripts, returns structured JSON matching the Zod schema, then closes the session. Add request validation on input.
Task 9: Add concurrency and session pooling
Single-session execution will be slow (~20-40 seconds per query). Implement a small pool (start with 3 concurrent Steel sessions) so parallel API requests don't queue. Steel bills per session-minute, so size the pool against expected load and cost.
Task 10: Error handling and retry logic
RC will occasionally block, rate-limit, or return empty results. Define explicit failure modes: CAPTCHA hit (Steel handles automatically, but log it), empty results (return empty array, not 500), selector failure after cache bust (retry with fresh AI resolution, max 2 attempts), Steel session timeout (restart session and retry once). All errors return structured JSON with an error field, not raw stack traces.

Phase 5 — Hardening
Task 11: Rate limiting and request throttling
Don't hammer RC. Add configurable delay between filter interactions (500–1500ms randomized), randomize viewport size per session, and cap inbound API requests to avoid drawing attention. This is also self-protective — if RC detects the pattern and blocks your IP range, you lose the whole thing.
Task 12: Monitoring and change detection
RC's UI will change. Add a lightweight smoke test that runs daily: execute one fixed search (e.g., Miami → Caribbean, 7 nights, 2 guests) and assert the response schema matches expectations. If it fails, alert immediately — this is your signal that the Stagehand cache needs to bust and prompts may need updating.
